#!/usr/bin/env bash
#
# Tests for deploy/deploy-aws-ssm.sh.
#
# The deploy script cannot be exercised against AWS from CI, so this drives the
# two things that are testable without it and that actually break:
#
#   1. The payload the script builds — that it is valid JSON, that the compose
#      file survives base64 round-tripping byte-for-byte, and above all that no
#      secret material appears in it. SSM retains send-command parameters in
#      plaintext for 30 days, so "no secrets in the payload" is a security
#      property, not a preference, and it deserves a test rather than a comment.
#
#   2. The host-side secret resolution — the branch that decides whether the
#      live site keeps running when the instance role cannot yet read the
#      Parameter Store entry. Driven here against stub `aws` and `docker`.
#
# Run: ./deploy/test-deploy-aws-ssm.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/deploy-aws-ssm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $*" >&2; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi; }

# ── Stub AWS and docker ─────────────────────────────────────────────────────
# `aws ssm get-parameter` succeeds or fails according to STUB_PARAM_OK, which is
# how the degraded paths get exercised.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "ssm" ] && [ "${2:-}" = "get-parameter" ]; then
  if [ "${STUB_PARAM_OK:-}" = "1" ]; then
    printf 'POSTGRES_PASSWORD=from-parameter-store\nMINIO_SECRET_KEY=also-from-ps\n'
    exit 0
  fi
  echo "An error occurred (AccessDeniedException) when calling GetParameter" >&2
  exit 254
fi
if [ "${1:-}" = "ecr" ]; then echo "stub-ecr-token"; exit 0; fi
exit 0
STUB
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Record every docker invocation so the test can assert on the flags used.
printf '%s\n' "$*" >> "${STUB_DOCKER_LOG:?}"
case "$*" in
  # The real `docker login --password-stdin` consumes stdin. A stub that exits
  # without reading it SIGPIPEs the `aws ecr get-login-password` feeding it,
  # and pipefail then fails the deploy with 141 — intermittently, since it is a
  # race. Drain stdin so the stub behaves like the thing it stands in for.
  login*) cat > /dev/null; exit 0 ;;
  "network inspect edge") exit 0 ;;   # pretend the platform network exists
  *"ps -q web") echo "webcid"; exit 0 ;;
  *version.json) printf '{"service":"frontend","sha":"%s"}\n' "${STUB_WEB_SHA-}"; exit 0 ;;
  *"/api/version") printf '{"service":"backend","sha":"%s"}\n' "${STUB_API_SHA-}"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/aws" "$TMP/bin/docker"

# ── Build the payload once ──────────────────────────────────────────────────
echo "payload"
DRY_RUN=1 DRY_RUN_OUT="$TMP/remote.sh" DRY_RUN_OUT_PARAMS="$TMP/params.json" \
  IMAGE_BACKEND="reg/be:testsha" IMAGE_FRONTEND="reg/fe:testsha" \
  "$SCRIPT" > "$TMP/dry.log" 2>&1
check "dry run exits 0" "$?" "0"

bash -n "$TMP/remote.sh" && ok "generated remote script is valid bash" \
  || bad "generated remote script is not valid bash"

# node, not python: actions/checkout is a JavaScript action, so node is present
# wherever this can run at all. node:22-bookworm ships python3 but not PyYAML,
# and a test that needs `pip install` breaks the first time the network hiccups.
node -e '
  const fs = require("fs");
  const [tmp, here] = process.argv.slice(1);
  const p = JSON.parse(fs.readFileSync(tmp + "/params.json", "utf8"));
  if (Object.keys(p).join() !== "commands") throw new Error("unexpected params shape");
  // commands[2] is: printf %s <b64> | base64 -d > ...  — the blob is the 4th
  // single-quoted field.
  const payload = Buffer.from(p.commands[2].split("'"'"'")[3], "base64").toString();
  fs.writeFileSync(tmp + "/roundtrip.sh", payload);
  const line = payload.split("\n").find((l) => l.startsWith("COMPOSE_B64="));
  // Split on the first = only; base64 padding contains = too.
  const inner = line.slice("COMPOSE_B64=".length);
  const same = Buffer.from(inner, "base64")
    .equals(fs.readFileSync(here + "/docker-compose.shared.yml"));
  console.log("COMPOSE_IDENTICAL", same);
  // A password with shell metacharacters must never reach the payload.
  console.log("NO_SECRETS", !["POSTGRES_PASSWORD=", "MINIO_SECRET_KEY=",
    "CHANNEL_SECRET_KEY="].some((k) => payload.includes(k)));
' "$TMP" "$HERE" > "$TMP/py.out" 2>&1 || true
check "params.json is valid JSON with a commands array" \
  "$(grep -c COMPOSE_IDENTICAL "$TMP/py.out")" "1"
check "compose file survives base64 round-trip byte-for-byte" \
  "$(grep -o 'COMPOSE_IDENTICAL true' "$TMP/py.out" | wc -l)" "1"
check "no secret material in the SSM command payload" \
  "$(grep -o 'NO_SECRETS true' "$TMP/py.out" | wc -l)" "1"
bash -n "$TMP/roundtrip.sh" && ok "payload still valid bash after JSON+base64 round-trip" \
  || bad "payload corrupted by JSON+base64 round-trip"

# ── Drive the host-side script ──────────────────────────────────────────────
run_remote() {
  local dir="$1"; shift
  # REMOTE_DIR and EXPECT_SHA are rewritten rather than passed in the
  # environment, because the payload assigns them in its header and that
  # assignment correctly wins over any inherited value — which is the whole
  # point of stamping them at build time. Editing the header is the only
  # faithful way to vary them.
  local body
  body="$(sed -e "s|^REMOTE_DIR=.*|REMOTE_DIR='$dir'|" \
              -e "s|^EXPECT_SHA=.*|EXPECT_SHA='${RUN_EXPECT_SHA-}'|" \
              "$TMP/roundtrip.sh")"
  # Defaults first so "$@" can override them — env applies assignments left to
  # right, last wins. VERSION_POLL_INTERVAL=0 keeps the timeout path from
  # costing 30 seconds.
  STUB_DOCKER_LOG="$TMP/docker.log" PATH="$TMP/bin:$PATH" \
    env STUB_WEB_SHA=deadbeef STUB_API_SHA=deadbeef VERSION_POLL_INTERVAL=0 "$@" \
    bash -c "$body" > "$TMP/run.log" 2>&1
}

echo
echo "secret resolution"

# 1. Parameter Store readable — the intended path.
D="$TMP/case-ps"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 && rc=0 || rc=$?
check "parameter store path exits 0" "$rc" "0"
grep -q "SSM Parameter Store" "$TMP/run.log" \
  && ok "reports Parameter Store as the source" || bad "did not report Parameter Store"
grep -q "^POSTGRES_PASSWORD=from-parameter-store$" "$D/.env" \
  && ok "secrets land in .env" || bad "secrets missing from .env"
grep -q "^IMAGE_BACKEND=reg/be:testsha$" "$D/.env" \
  && ok "image pin appended to .env" || bad "image pin missing"
check ".env.secrets is 0600" "$(stat -c %a "$D/.env.secrets")" "600"
check ".env is 0600" "$(stat -c %a "$D/.env")" "600"

# 2. Parameter unreadable, .env.secrets already on the host — degraded, not dead.
D="$TMP/case-fallback"; mkdir -p "$D"; : > "$TMP/docker.log"
printf 'POSTGRES_PASSWORD=host-resident\n' > "$D/.env.secrets"
run_remote "$D" STUB_PARAM_OK=0 && rc=0 || rc=$?
check "host-resident fallback exits 0" "$rc" "0"
grep -q "DEGRADED" "$TMP/run.log" \
  && ok "fallback is announced as degraded" || bad "degraded fallback was silent"
grep -q "^POSTGRES_PASSWORD=host-resident$" "$D/.env" \
  && ok "host-resident secrets used" || bad "host-resident secrets not used"

# 3. Parameter unreadable, only the pre-SSM combined .env exists — the bridge
#    from the 2026-08-05 hand deploy. Image pins must be stripped, or a stale
#    pin would override the version being deployed.
D="$TMP/case-migrate"; mkdir -p "$D"; : > "$TMP/docker.log"
printf 'POSTGRES_PASSWORD=legacy\nIMAGE_BACKEND=reg/be:STALE\n' > "$D/.env"
run_remote "$D" STUB_PARAM_OK=0 && rc=0 || rc=$?
check "legacy .env migration exits 0" "$rc" "0"
grep -q "STALE" "$D/.env.secrets" \
  && bad "stale image pin survived into .env.secrets" || ok "stale image pin stripped"
check "deployed pin wins" "$(grep -c '^IMAGE_BACKEND=reg/be:testsha$' "$D/.env")" "1"

# 4. Nothing available at all — must fail loudly, and name the IAM fix.
D="$TMP/case-none"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=0 && rc=0 || rc=$?
check "no credentials anywhere fails" "$rc" "3"
grep -q "ssm:GetParameter" "$TMP/run.log" \
  && ok "failure names the required IAM statement" || bad "failure gave no IAM guidance"
[ -f "$D/.env" ] && bad "wrote a .env despite having no secrets" || ok "no .env written on failure"

# ── Version skew ────────────────────────────────────────────────────────────
# `up -d --wait` proves the containers started, not that they are the ones we
# meant. The images roll independently, so a stack serving the old API behind
# the new UI passes every health check. These cases are that detector.
echo
echo "version skew"

D="$TMP/case-skew"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 STUB_WEB_SHA=aaaa111 STUB_API_SHA=bbbb222 && rc=0 || rc=$?
check "mismatched web/api versions fail the deploy" "$rc" "25"
grep -q "version skew" "$TMP/run.log" \
  && ok "skew failure says which side is which" || bad "skew failure was not explained"

D="$TMP/case-match"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 STUB_WEB_SHA=cafe123 STUB_API_SHA=cafe123 && rc=0 || rc=$?
check "matching versions pass" "$rc" "0"
grep -q "both containers serving cafe123" "$TMP/run.log" \
  && ok "reports the deployed version" || bad "did not report the deployed version"
# Both fetches go THROUGH the web container, so a pass also proves the nginx
# proxy reaches the backend — which /api/health alone does not.
grep -q "exec webcid wget -qO- http://127.0.0.1:3000/api/version" "$TMP/docker.log" \
  && ok "api version is fetched through the web container's proxy" \
  || bad "api version was not fetched through the proxy"

D="$TMP/case-stale"; mkdir -p "$D"; : > "$TMP/docker.log"
RUN_EXPECT_SHA=new1111 run_remote "$D" STUB_PARAM_OK=1 STUB_WEB_SHA=old9999 STUB_API_SHA=old9999 \
  && rc=0 || rc=$?
check "agreeing but stale versions fail against EXPECT_SHA" "$rc" "26"
grep -q "stale pull rather than skew" "$TMP/run.log" \
  && ok "stale failure is distinguished from skew" || bad "stale failure not distinguished"

D="$TMP/case-noversion"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 STUB_WEB_SHA= STUB_API_SHA= && rc=0 || rc=$?
check "unreachable version endpoints fail the deploy" "$rc" "24"

# Two unstamped images always agree, so the check would pass while proving
# nothing. That has to be said out loud or it is worse than no check at all.
D="$TMP/case-unstamped"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 STUB_WEB_SHA=unknown STUB_API_SHA=unknown && rc=0 || rc=$?
check "unstamped images still deploy" "$rc" "0"
grep -q "proved" "$TMP/run.log" \
  && ok "warns that an unstamped comparison proves nothing" \
  || bad "silently passed an unstamped comparison"

# ── Runner traps ────────────────────────────────────────────────────────────
echo
echo "runner traps"
grep -q 'export AWS_PAGER=""' "$TMP/roundtrip.sh" \
  && ok "remote payload disables the CLI pager" \
  || bad "remote payload does not set AWS_PAGER (aws v2 hangs on less)"
grep -q 'export AWS_PAGER=""' "$HERE/deploy-aws-ssm.sh" \
  && ok "local script disables the CLI pager" || bad "local script does not set AWS_PAGER"
grep -q "unset AWS_PROFILE" "$TMP/roundtrip.sh" \
  && ok "remote payload clears an empty AWS_PROFILE" || bad "remote payload keeps AWS_PROFILE"

# In this image /etc/hosts maps localhost to both 127.0.0.1 and ::1, busybox
# wget tries ::1 first, and nginx listens only on IPv4 — so a `localhost` URL
# fails with a flat "Connection refused". The old web healthcheck used one,
# which meant the container could never go healthy and `up -d --wait` would
# block until timeout. It looks obviously correct, so it needs a test.
grep -q "http://localhost:" "$TMP/roundtrip.sh" \
  && bad "deploy payload probes localhost (resolves to ::1; nginx is IPv4-only)" \
  || ok "deploy payload probes 127.0.0.1, not localhost"
# Comments are stripped first — the compose file explains this trap in prose,
# and matching that would fail the test for documenting the thing it checks.
grep -v '^[[:space:]]*#' "$HERE/docker-compose.shared.yml" | grep -q "http://localhost:" \
  && bad "a compose healthcheck probes localhost; it can never pass" \
  || ok "no compose healthcheck probes localhost"

# ── Compose networking ──────────────────────────────────────────────────────
# A service declaring `networks:` joins ONLY those. The public service and the
# internal one must therefore share a network explicitly, or the proxy 502s
# with both containers healthy.
echo
echo "compose networking"
# awk rather than a YAML parser: node has none built in and PyYAML is absent
# from the CI image. The structure being read is two levels deep and fully
# under our control, so indentation tracking is honest here rather than clever.
nets_of() {  # $1 = service name -> one network name per line
  awk -v want="$1" '
    /^services:/            { in_svc = 1; next }
    /^[^[:space:]]/         { in_svc = 0 }
    in_svc && /^  [^[:space:]-]/ {
      svc = $0; sub(/^  /, "", svc); sub(/:.*$/, "", svc); in_net = 0; next
    }
    in_svc && svc == want && /^    networks:/ { in_net = 1; next }
    in_svc && in_net && /^      - /           { print $2; next }
    in_svc && in_net && /^    [^[:space:]]/   { in_net = 0 }
  ' "$2"
}

WEB_NETS="$(nets_of web "$HERE/docker-compose.shared.yml")"
API_NETS="$(nets_of backend "$HERE/docker-compose.shared.yml")"
# Guard against the parser silently matching nothing, which would make every
# assertion below pass vacuously.
check "compose parses: web declares networks" "$([ -n "$WEB_NETS" ] && echo yes)" "yes"
check "compose parses: backend declares networks" "$([ -n "$API_NETS" ] && echo yes)" "yes"

comm -12 <(echo "$WEB_NETS" | sort) <(echo "$API_NETS" | sort) | grep -q . \
  && ok "web and backend share a network" \
  || bad "web and backend share NO network (the proxy will 502 with both healthy)"
echo "$WEB_NETS" | grep -qx edge && ok "web is on the platform edge network" \
  || bad "web is not on edge"
echo "$API_NETS" | grep -qx edge && bad "backend is exposed on edge" \
  || ok "backend is kept off edge"
awk '
  /^networks:/          { in_net = 1; next }
  /^[^[:space:]]/       { in_net = 0 }
  in_net && /^  edge:/  { in_edge = 1; next }
  in_net && in_edge && /^    external:[[:space:]]*true/ { found = 1 }
  in_net && in_edge && /^  [^[:space:]]/ { in_edge = 0 }
  END { exit !found }
' "$HERE/docker-compose.shared.yml" \
  && ok "edge is external, never created by this stack" \
  || bad "edge is not declared external"

# ── Shared-host safety ──────────────────────────────────────────────────────
# These are the flags that reach outside our compose project. A regression here
# can stop the platform's Caddy and take down every other site on the box.
echo
echo "shared-host safety"
D="$TMP/case-safety"; mkdir -p "$D"; : > "$TMP/docker.log"
run_remote "$D" STUB_PARAM_OK=1 || true
grep -q -- "--remove-orphans" "$TMP/docker.log" \
  && bad "used --remove-orphans (can delete the platform Caddy container)" \
  || ok "never uses --remove-orphans"
grep -qE -- "(--volumes|[[:space:]]-v[[:space:]])" "$TMP/docker.log" \
  && bad "used --volumes" || ok "never uses --volumes"
check "every compose call is scoped with -p commissionwatch" \
  "$(grep -c 'compose' "$TMP/docker.log")" \
  "$(grep -c 'compose -p commissionwatch' "$TMP/docker.log")"
grep -q "network create edge" "$TMP/docker.log" \
  && bad "recreated the platform-owned edge network" \
  || ok "attaches to the existing edge network without touching it"

# The compose file itself must publish no host ports: 80/443 belong to the
# platform Caddy, and the security group leaves :80 open to the world.
grep -qE '^\s*ports:' "$HERE/docker-compose.shared.yml" \
  && bad "compose publishes host ports" || ok "compose publishes no host ports"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
