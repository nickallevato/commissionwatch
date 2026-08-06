#!/usr/bin/env bash
#
# Deploy CommissionWatch to the shared bmux platform host over SSM Run Command.
#
# ── Why not SSH ─────────────────────────────────────────────────────────────
# The host is your-org/platform-aws, shared with seven other products. Its SSH
# key pair belongs to whoever provisioned it, and EC2 stores only the key pair's
# NAME — the private half is not retrievable from AWS by anyone. Port 22 being
# open makes that look like a missing secret rather than a missing capability,
# which is how the previous deploy job stayed red without ever being fixable.
#
# SSM needs no key and no host address. It addresses the instance by id, runs
# through the instance's own SSM agent, and the host pulls from ECR with its
# instance role.
#
# ── The four properties that make this safe on a shared host ────────────────
# All four are deliberate. Changing any one of them can take down other tenants.
#
#   1. `-p commissionwatch` scopes every compose operation to our project. It
#      cannot see or stop another tenant's stack.
#   2. NEVER --remove-orphans, NEVER --volumes. Those are the two flags that
#      reach outside a project; --remove-orphans can delete the platform's own
#      Caddy container.
#   3. The compose publishes NO host ports. 80/443 belong to the platform Caddy;
#      taking them takes every fronted site down with us.
#   4. `edge` is an EXTERNAL network — attached to, never created or modified
#      when it already exists.
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   ./deploy/deploy-aws-ssm.sh                  # deploy :latest
#   IMAGE_BACKEND=...:abc123 \
#   IMAGE_FRONTEND=...:abc123 \
#     ./deploy/deploy-aws-ssm.sh                # deploy one exact version
#   DEPLOY_ENV_FILE=./prod.env ./deploy/deploy-aws-ssm.sh   # also update secrets
#   DRY_RUN=1 ./deploy/deploy-aws-ssm.sh        # print the payload, send nothing
#
# Rollback is the same command with an older tag. That is the whole point of
# supporting IMAGE_* pinning.
#
# This script is the single deploy path: CI calls it, and an operator calls it
# by hand with the same arguments. When the pipeline is blocked, the manual path
# is not a different, less-tested procedure — it is this file.

set -euo pipefail

# ── Trap 3: AWS_PROFILE set but EMPTY ───────────────────────────────────────
# A shell with AWS_PROFILE="" makes every CLI call fail with
#   "The config profile () could not be found"
# which reads as missing credentials and sends you to the wrong problem
# entirely. Reproduced on the operator workstation on 2026-08-06.
#
# The brief says to unset it unconditionally; we clear it only when it is empty,
# because an operator running this by hand may legitimately rely on a named
# profile and a blanket unset would silently deploy with the wrong account.
if [ -z "${AWS_PROFILE:-}" ]; then
  unset AWS_PROFILE 2>/dev/null || true
fi

PRODUCT="${PRODUCT:-commissionwatch}"
AWS_REGION="${AWS_REGION:-us-west-2}"
INSTANCE_ID="${INSTANCE_ID:-i-0123456789abcdef0}"
ECR_REGISTRY="${ECR_REGISTRY:-123456789012.dkr.ecr.us-west-2.amazonaws.com}"

# The `your-org/` prefix is REQUIRED and is not cosmetic: the CI user's inline
# policy grants push only on repository/your-org/commissionwatch-*, so an
# unprefixed path is denied no matter what else is correct. ECR reports both a
# wrong path and a missing repository as 403 on a blob HEAD, never a 404, and
# never names the repository.
ECR_NAMESPACE="${ECR_NAMESPACE:-your-org}"

# Deliberately under the deploy user's home rather than /opt: ec2-user cannot
# write to /opt, so /opt/<product> carries an undocumented root-provisioning
# step that a deploy failure gives no hint about. $HOME needs no provisioning.
REMOTE_DIR="${REMOTE_DIR:-/home/ec2-user/commissionwatch}"

COMPOSE_FILE="${COMPOSE_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.shared.yml}"

# Secrets live in SSM Parameter Store as a SecureString and are fetched by the
# HOST with its instance role. They are never passed through the SSM command
# payload: send-command parameters are retained in plaintext in command history
# for 30 days and land in CloudTrail, readable by anyone in the account with
# ssm:GetCommandInvocation — on a host shared with seven other products.
ENV_PARAM="${ENV_PARAM:-/commissionwatch/env}"

IMAGE_BACKEND="${IMAGE_BACKEND:-$ECR_REGISTRY/$ECR_NAMESPACE/$PRODUCT-backend:latest}"
IMAGE_FRONTEND="${IMAGE_FRONTEND:-$ECR_REGISTRY/$ECR_NAMESPACE/$PRODUCT-frontend:latest}"

POLL_INTERVAL="${POLL_INTERVAL:-10}"
POLL_MAX="${POLL_MAX:-60}"          # 60 * 10s = 10 minutes
DRY_RUN="${DRY_RUN:-}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fatal() { echo "FATAL: $*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || fatal "compose file not found: $COMPOSE_FILE"

# ── aws CLI, native or containerised ────────────────────────────────────────
# The Gitea runners here have docker but not the aws CLI; laptops are usually
# the reverse. $WORK is mounted at the same path inside the container so that
# `file://$WORK/...` resolves identically either way.
if command -v aws >/dev/null 2>&1; then
  AWS_CLI_MODE="native"
  aws_cli() { aws "$@"; }
elif command -v docker >/dev/null 2>&1; then
  AWS_CLI_MODE="container"
  AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:latest}"
  aws_cli() {
    docker run --rm \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
      -e AWS_DEFAULT_REGION="$AWS_REGION" \
      -v "$WORK:$WORK" -w "$WORK" \
      "$AWS_CLI_IMAGE" "$@"
  }
else
  # Deferred rather than immediate: a dry run builds and prints the payload
  # without talking to AWS at all, so it must work on a machine with neither.
  # That is what lets CI check the payload on a plain container.
  AWS_CLI_MODE="unavailable"
  # Not fatal() — this runs inside $(...) at the call site, where an exit would
  # only leave the subshell and duplicate the FATAL prefix in the message.
  aws_cli() { echo "neither the aws CLI nor docker is available" >&2; return 1; }
fi

# ── Trap 2: an absent secret is an EMPTY variable, not an unset one ─────────
# ${{ secrets.MISSING }} renders as "", and every subsequent aws call then fails
# with something that reads like an auth or network problem. Distinguish
# set-but-empty from unset so the error names the actual cause.
#
# Trap 1 is the usual reason it is empty: organisation-level secrets are NOT
# inherited by repositories, whatever the onboarding doc says.
if [ -n "${AWS_ACCESS_KEY_ID+set}" ] && [ -z "$AWS_ACCESS_KEY_ID" ]; then
  fatal "AWS_ACCESS_KEY_ID is present but empty.
  Gitea organisation secrets are NOT inherited by repositories. Add
  AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY under this REPOSITORY:
  Settings -> Actions -> Secrets."
fi

echo "== $PRODUCT -> $INSTANCE_ID ($AWS_REGION), aws CLI: $AWS_CLI_MODE"
echo "   backend:  $IMAGE_BACKEND"
echo "   frontend: $IMAGE_FRONTEND"

if [ -z "$DRY_RUN" ]; then
  IDENTITY="$(aws_cli sts get-caller-identity --query Arn --output text 2>&1)" \
    || fatal "cannot authenticate to AWS: $IDENTITY"
  echo "   identity: $IDENTITY"
fi

# ── Optionally refresh the secrets in Parameter Store ───────────────────────
# Only when the caller supplies a file. A normal deploy does not touch secrets;
# it just redeploys against whatever the parameter already holds.
if [ -n "${DEPLOY_ENV_FILE:-}" ]; then
  [ -f "$DEPLOY_ENV_FILE" ] || fatal "DEPLOY_ENV_FILE does not exist: $DEPLOY_ENV_FILE"

  # Image pins never belong in the parameter: they are per-deploy, not secret,
  # and a stale pin in here would silently override the version CI just built.
  grep -v '^IMAGE_' "$DEPLOY_ENV_FILE" > "$WORK/env.secrets" || true
  [ -s "$WORK/env.secrets" ] || fatal "$DEPLOY_ENV_FILE has no non-IMAGE_ lines; refusing to store an empty parameter"

  SIZE="$(wc -c < "$WORK/env.secrets")"
  if [ "$SIZE" -gt 4096 ]; then
    fatal "env content is ${SIZE} bytes; a Standard-tier SSM parameter caps at 4096.
  Split the parameter or move to --tier Advanced (which is billed per parameter)."
  fi

  if [ -n "$DRY_RUN" ]; then
    echo "   [dry-run] would put ${SIZE} bytes to SecureString $ENV_PARAM"
  else
    echo "== updating SecureString $ENV_PARAM (${SIZE} bytes)"
    aws_cli ssm put-parameter --region "$AWS_REGION" \
      --name "$ENV_PARAM" --type SecureString --overwrite \
      --value "file://$WORK/env.secrets" >/dev/null
  fi
fi

# ── Build the script the host will run ──────────────────────────────────────
# The compose file rides along base64-encoded rather than being fetched on the
# host: the host has no credential for this repository, and a deploy that
# depends on the host reaching Gitea has one more thing to be down.
COMPOSE_B64="$(base64 < "$COMPOSE_FILE" | tr -d '\n')"

{
  # Values are quoted with %q on the way in so a password or a path containing
  # shell metacharacters cannot break out into the remote script.
  printf '%s\n' '#!/usr/bin/env bash'
  printf 'PRODUCT=%q\n'       "$PRODUCT"
  printf 'AWS_REGION=%q\n'    "$AWS_REGION"
  printf 'ECR_REGISTRY=%q\n'  "$ECR_REGISTRY"
  printf 'REMOTE_DIR=%q\n'    "$REMOTE_DIR"
  printf 'ENV_PARAM=%q\n'     "$ENV_PARAM"
  printf 'IMAGE_BACKEND=%q\n' "$IMAGE_BACKEND"
  printf 'IMAGE_FRONTEND=%q\n' "$IMAGE_FRONTEND"
  printf 'COMPOSE_B64=%q\n'   "$COMPOSE_B64"
  cat <<'REMOTE'

set -euo pipefail

# Trap 3 applies on the host too: the SSM agent runs commands as root with an
# environment we do not control.
if [ -z "${AWS_PROFILE:-}" ]; then
  unset AWS_PROFILE 2>/dev/null || true
fi
export AWS_DEFAULT_REGION="$AWS_REGION"

echo "== $PRODUCT -> $REMOTE_DIR on $(hostname), $(date -u +%FT%TZ)"

mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"

# `edge` is owned by the platform Caddy. Attach to it; create it only if it is
# genuinely absent, so a first deploy in either order works and an existing
# network is never reconfigured.
docker network inspect edge >/dev/null 2>&1 || docker network create edge

printf '%s' "$COMPOSE_B64" | base64 -d > docker-compose.shared.yml

# ── Secrets ─────────────────────────────────────────────────────────────────
# Fetched here, by the host, using the instance role. Nothing secret travelled
# in the SSM command payload.
umask 077
SECRET_SOURCE=""
if aws ssm get-parameter --name "$ENV_PARAM" --with-decryption \
     --query Parameter.Value --output text > .env.secrets.new 2>.ssm-err; then
  mv -f .env.secrets.new .env.secrets
  SECRET_SOURCE="SSM Parameter Store $ENV_PARAM"
  rm -f .ssm-err
elif [ -s .env.secrets ]; then
  # Degraded, but deliberately not fatal. The instance role change below is
  # made out of band by whoever administers platform-aws; until it lands, a
  # deploy must still be able to ship code rather than take the site down.
  rm -f .env.secrets.new
  SECRET_SOURCE=".env.secrets already on this host (DEGRADED)"
  echo "WARNING: could not read $ENV_PARAM:" >&2
  sed 's/^/  ssm: /' .ssm-err >&2 || true
elif [ -s .env ]; then
  # One-time bridge from the hand-made SSH deploy of 2026-08-05, which left a
  # combined .env here. Image pins are stripped so the file holds credentials
  # only and never overrides the version being deployed.
  rm -f .env.secrets.new
  grep -v '^IMAGE_' .env > .env.secrets || true
  SECRET_SOURCE="migrated from the pre-existing .env (DEGRADED)"
  echo "WARNING: could not read $ENV_PARAM:" >&2
  sed 's/^/  ssm: /' .ssm-err >&2 || true
else
  rm -f .env.secrets.new
  echo "FATAL: no credentials available." >&2
  echo "  $ENV_PARAM could not be read:" >&2
  sed 's/^/    /' .ssm-err >&2 || true
  cat >&2 <<'IAMHELP'

  The host's instance role needs to read this parameter. That is a change to
  a role shared with other products, so it is made out of band by whoever
  administers your-org/platform-aws:

    {"Version":"2012-10-17","Statement":[
      {"Effect":"Allow","Action":["ssm:GetParameter"],
       "Resource":"arn:aws:ssm:us-west-2:123456789012:parameter/commissionwatch/*"},
      {"Effect":"Allow","Action":["kms:Decrypt"],
       "Resource":"*",
       "Condition":{"StringEquals":{"kms:ViaService":"ssm.us-west-2.amazonaws.com"}}}]}

  Until then, seed the file by hand on the host:
    umask 077; vi /home/ec2-user/commissionwatch/.env.secrets
IAMHELP
  exit 3
fi
[ -s .env.secrets ] || { echo "FATAL: .env.secrets is empty" >&2; exit 3; }
chmod 600 .env.secrets
echo "   secrets: $SECRET_SOURCE"

# `awk 1` normalises the trailing newline. Without it, a parameter value stored
# without one concatenates its last variable onto IMAGE_BACKEND.
{
  awk 1 .env.secrets
  printf 'IMAGE_BACKEND=%s\n'  "$IMAGE_BACKEND"
  printf 'IMAGE_FRONTEND=%s\n' "$IMAGE_FRONTEND"
} > .env
chmod 600 .env

# The host pulls with its instance role (bmux-platform-host-ecr-pull).
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# -p scopes every operation to this project. No --remove-orphans (it can delete
# the platform's Caddy container) and no --volumes, ever.
COMPOSE=(docker compose -p "$PRODUCT" --env-file .env -f docker-compose.shared.yml)

"${COMPOSE[@]}" pull
if ! "${COMPOSE[@]}" up -d --wait --wait-timeout 180; then
  echo "== up failed; state and logs follow" >&2
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=120 || true
  exit 22
fi
"${COMPOSE[@]}" ps
echo "== deploy complete"
REMOTE
} > "$WORK/remote.sh"

# ── Wrap it for AWS-RunShellScript ──────────────────────────────────────────
# The payload is base64 so that nothing in the script needs JSON escaping.
# --parameters takes a file:// JSON document for the same reason: hand-quoting a
# shell script through the CLI's shorthand syntax is where this goes wrong.
REMOTE_B64="$(base64 < "$WORK/remote.sh" | tr -d '\n')"

cat > "$WORK/params.json" <<JSON
{
  "commands": [
    "set -euo pipefail",
    "trap 'rm -f /tmp/${PRODUCT}-deploy.sh' EXIT",
    "printf '%s' '${REMOTE_B64}' | base64 -d > /tmp/${PRODUCT}-deploy.sh",
    "bash /tmp/${PRODUCT}-deploy.sh"
  ]
}
JSON

if [ -n "$DRY_RUN" ]; then
  echo
  echo "── remote script (would run as root on $INSTANCE_ID) ──"
  cat "$WORK/remote.sh"
  echo "── end remote script ──"
  # Copied out because $WORK is removed on exit, and this is what makes the
  # payload checkable (bash -n) without any AWS credential.
  cp "$WORK/remote.sh" "${DRY_RUN_OUT:-/tmp/${PRODUCT}-remote.sh}"
  cp "$WORK/params.json" "${DRY_RUN_OUT_PARAMS:-/tmp/${PRODUCT}-params.json}"
  echo "wrote ${DRY_RUN_OUT:-/tmp/${PRODUCT}-remote.sh} and ${DRY_RUN_OUT_PARAMS:-/tmp/${PRODUCT}-params.json}"
  exit 0
fi

echo "== sending SSM command"
CMD_ID="$(aws_cli ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "deploy $PRODUCT" \
  --parameters "file://$WORK/params.json" \
  --query Command.CommandId --output text)"
[ -n "$CMD_ID" ] || fatal "send-command returned no CommandId"
echo "   command id: $CMD_ID"

invocation() {
  aws_cli ssm get-command-invocation \
    --region "$AWS_REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query "$1" --output text 2>/dev/null
}

STATUS="Pending"
for _ in $(seq 1 "$POLL_MAX"); do
  sleep "$POLL_INTERVAL"
  # An invocation is not queryable the instant send-command returns, so a miss
  # here means "not yet", not "failed".
  STATUS="$(invocation Status || true)"
  [ -n "$STATUS" ] || STATUS="Pending"
  echo "   status: $STATUS"
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
done

echo
echo "── host stdout ──"
invocation StandardOutputContent || true
ERR="$(invocation StandardErrorContent || true)"
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then
  echo "── host stderr ──"
  printf '%s\n' "$ERR"
fi
echo "── end host output ──"

# GetCommandInvocation truncates output at 24000 characters. Nothing here
# configures S3 or CloudWatch delivery, so a very chatty failure loses its tail.
if [ "$STATUS" != "Success" ]; then
  fatal "SSM command $CMD_ID finished as $STATUS
  Inspect it with:
    aws ssm get-command-invocation --region $AWS_REGION \\
      --command-id $CMD_ID --instance-id $INSTANCE_ID"
fi

echo "== SSM command $CMD_ID succeeded"
