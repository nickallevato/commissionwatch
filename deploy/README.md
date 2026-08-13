# CommissionWatch — production deployment

Deploys onto the shared bmux platform host over **SSM Run Command**. Not SSH.

> The previous version of this file described an Ansible playbook in a private infrastructure repo. That is not
> how this deploys and was never how it deployed. Design reasoning:
> `docs/superpowers/specs/2026-08-06-ssm-deploy-design.md`.

## Files

| File | What it is |
|---|---|
| `deploy-aws-ssm.sh` | The deploy. CI calls it; you call it by hand. Same code either way. |
| `test-deploy-aws-ssm.sh` | Tests for the payload and the host-side secret resolution. Runs in CI. |
| `docker-compose.shared.yml` | The production stack on the shared host. |
| `Caddyfile` | Reference copy of the site block. The live one lives in `your-org/platform-aws`. |
| `docker-compose.yml` | Local development, not production. |
| `backup.sh` | Nightly `pg_dump` + MinIO mirror, retention, off-instance copy, ops event. |
| `restore-drill.sh` | Restores a backup into a scratch database and compares row counts. |

## Deploy

```bash
# ship :latest
./deploy/deploy-aws-ssm.sh

# ship one exact build (this is also how you roll back — same command, older tag)
IMAGE_BACKEND=123456789012.dkr.ecr.us-west-2.amazonaws.com/your-org/commissionwatch-backend:<sha> \
IMAGE_FRONTEND=123456789012.dkr.ecr.us-west-2.amazonaws.com/your-org/commissionwatch-frontend:<sha> \
  ./deploy/deploy-aws-ssm.sh

# see exactly what would run on the host, send nothing, need no credentials
DRY_RUN=1 ./deploy/deploy-aws-ssm.sh

# also refresh the secrets in Parameter Store
DEPLOY_ENV_FILE=./prod.env ./deploy/deploy-aws-ssm.sh
```

CI does the same thing from `.gitea/workflows/deploy.yml`, pinned to the commit's SHA, gated on the
repository variable `SHARED_STACK_LIVE == 'true'`.

## What is shared vs ours

| Shared, already exists | Ours to provide |
|---|---|
| The EC2 instance `i-0123456789abcdef0`, us-west-2, t4g.medium (**arm64**) | ECR repos `your-org/commissionwatch-{backend,frontend}` |
| The instance role that pulls from ECR | A `commissionwatch-ci` IAM user with inline policies |
| The `edge` network, owned by the platform Caddy | A Caddy site block for `commissionwatch.bmux.sh` |
| The SSM agent | `docker-compose.shared.yml` |
| | Repo-level Gitea secrets |

## Setup

### 0. Your own account, instance and registry

This repository is public and names none of them. Every account number, instance id, registry host
and namespace in the files below is a placeholder, and a deploy against the placeholders fails at
the first AWS call rather than doing something surprising.

For an operator working locally:

```bash
cp deploy/deployment.env.example deploy/deployment.env
$EDITOR deploy/deployment.env
```

`deployment.env` is gitignored. `deploy-aws-ssm.sh` and `monitor-trigger.sh` read it, filling in
only variables the environment has not already set — so `INSTANCE_ID=i-… ./deploy/deploy-aws-ssm.sh`
still deploys where you said, not where the file says.

None of this is secret. They are identifiers, and every action against them still needs an IAM
principal you control. They are kept out of the repository because an account number beside an
instance id beside a registry host is a free inventory of your infrastructure. Real secrets live in
Parameter Store (§4) and never appear in either file.

For CI, the same four values are Gitea **variables** (not secrets), added under
**Settings → Actions → Variables**:

| Variable | Example | Purpose |
|---|---|---|
| `AWS_ACCOUNT_ID` | `123456789012` | Builds `ECR_REGISTRY` |
| `AWS_REGION` | `us-west-2` | Region for every `aws` call |
| `ECR_NAMESPACE` | `your-org` | The required repository path prefix (§2) |
| `INSTANCE_ID` | `i-0123456789abcdef0` | The SSM target |

An unset variable renders as `""`, so `ECR_REGISTRY` would become `.dkr.ecr..amazonaws.com` and the
failure would arrive several steps later as an unresolvable host. The **Log in to ECR** step
preflights all four and names the missing one.

### 1. Gitea secrets — repository level, not organisation

**Organisation secrets are NOT inherited by repositories**, whatever the onboarding doc says. This
is the single biggest time sink in onboarding a product here. Add under
**Settings → Actions → Secrets on this repository**:

| Secret | Required | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | yes | ECR push and `ssm:SendCommand` |
| `AWS_SECRET_ACCESS_KEY` | yes | ” |
| `DEPLOY_ENV_FILE_AWS` | **leave unset** | When set, CI refreshes the Parameter Store SecureString on every deploy — which needs `ssm:PutParameter` and sends the secret through a runner. Seed out of band instead (§4). If it is set and the policy is absent, the deploy stops at the refresh. |

An absent secret renders as `""`, not as unset, and every `aws` call then fails with something that
reads like an auth or network problem. Both the workflow and the script preflight for exactly this
and say so by name.

### 2. IAM for the CI user

Use **inline** policies. The managed policies `bmux-platform-ci-ecr` and
`bmux-platform-host-ecr-pull` are at the **5-version limit**, so the next product onboarded by
editing them hits `LimitExceeded`. Inline policies are not versioned and scope cleanly to one
product.

```bash
aws iam put-user-policy --user-name commissionwatch-ci --policy-name commissionwatch-ci-ecr \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
    {"Effect":"Allow","Action":["ecr:DescribeRepositories","ecr:DescribeImages",
      "ecr:BatchCheckLayerAvailability","ecr:InitiateLayerUpload","ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload","ecr:PutImage","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],
     "Resource":["arn:aws:ecr:us-west-2:123456789012:repository/your-org/commissionwatch-backend",
                 "arn:aws:ecr:us-west-2:123456789012:repository/your-org/commissionwatch-frontend"]}]}'
```

`ecr:GetAuthorizationToken` cannot be resource-scoped — an AWS limitation, not an oversight. It
only yields a token; what the token can do is bounded by the second statement.

```bash
aws iam put-user-policy --user-name commissionwatch-ci --policy-name commissionwatch-ci-ssm \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Sid":"SendCommandToTheSharedHost","Effect":"Allow","Action":"ssm:SendCommand",
     "Resource":["arn:aws:ec2:us-west-2:123456789012:instance/i-0123456789abcdef0",
                 "arn:aws:ssm:us-west-2::document/AWS-RunShellScript"]},
    {"Sid":"ReadBackTheResult","Effect":"Allow",
     "Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations"],"Resource":"*"}]}'
```

**Understand what the first statement grants before applying it:** the pipeline can run shell
commands as root on a host shared with other tenants. It is the same power the manual script uses,
moved from a person into automation. That is a real decision, not a formality.

**CI is deliberately not granted `ssm:PutParameter` or `kms:Encrypt`.** The secret is seeded out of
band (§4) and read by the host, so the pipeline never writes it and the value never traverses a
runner. Add those two only if you want CI to refresh secrets on every deploy, and set
`DEPLOY_ENV_FILE_AWS` to match — otherwise the deploy stops at the refresh with a message naming
both ways out.

> **This bit the first real run.** On 2026-08-06 `commissionwatch-ci` had
> `commissionwatch-ecr-push-pull` and nothing else, while `DEPLOY_ENV_FILE_AWS` *was* set. So the
> first call to fail was `PutParameter` — the optional half — which reads like a broken deploy and
> hides the fact that `ssm:SendCommand` was missing too. Grant the policy above and clear the
> secret, and both go away at once.

### 3. Instance role — the host reads its own secrets

The **host** reads the secrets, using its own instance role, `platform-aws-host`. That role is
shared with the other products on this box, so add an **inline** policy scoped to our path rather
than editing anything already attached to it:

```bash
aws iam put-role-policy --role-name platform-aws-host \
  --policy-name commissionwatch-param-read \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Sid":"ReadCommissionwatchSecrets","Effect":"Allow",
     "Action":["ssm:GetParameter","ssm:GetParameters"],
     "Resource":"arn:aws:ssm:us-west-2:123456789012:parameter/commissionwatch/*"},
    {"Sid":"DecryptThroughSsmOnly","Effect":"Allow","Action":"kms:Decrypt","Resource":"*",
     "Condition":{"StringEquals":{"kms:ViaService":"ssm.us-west-2.amazonaws.com"}}}]}'
```

> An earlier version of this file said this grant "is not ours to make" and had to come from
> whoever administers `your-org/platform-aws`. **That was wrong** — the account holder has
> `AdministratorAccess`, and an inline policy on the role is additive: it touches no managed policy
> and no other tenant's access. Verified 2026-08-06: before this, `platform-aws-host` carried only
> `bmux-platform-host-ecr-pull` and `AmazonSSMManagedInstanceCore`, and no inline policies at all.

**Applied 2026-08-06.** `platform-aws-host` now carries `commissionwatch-param-read` as its only
inline policy, and the host has been observed reading the decrypted parameter with no write grant.

Before it landed, deploys still worked but ran DEGRADED, falling back to the secret file already
on the host and warning loudly on every run. That fallback is deliberate and still in place: a
working public site should not go down over an IAM grant that has not happened yet. The run output
always names which source it used.

### 4. Seed the parameter, out of band

The parameter is written **once, by a human**, and read by the host from then on. CI never writes
it. If you hold the plaintext:

```bash
DEPLOY_ENV_FILE=./prod.env ./deploy/deploy-aws-ssm.sh
```

The file needs `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ACCESS_KEY`,
`MINIO_SECRET_KEY`, `CHANNEL_SECRET_KEY`, `CI_EVENT_TOKEN`. `IMAGE_*` lines are stripped — image
pins are per-deploy, and a stale one in the parameter would override the version being deployed.
Standard-tier parameters cap at 4096 bytes; the script checks and says so.

#### When nobody holds the plaintext

This is the normal case here, and it is not a dead end. The secret lives in a Gitea Actions secret,
which is **write-only** — the UI will replace or delete a value, never show it — and in the `.env`
the 2026-08-05 hand deploy left on the host.

So let the host seed the parameter from its own copy. Grant `ssm:PutParameter` **temporarily**:

```bash
aws iam put-role-policy --role-name platform-aws-host --policy-name commissionwatch-param-seed \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":"ssm:PutParameter",
     "Resource":"arn:aws:ssm:us-west-2:123456789012:parameter/commissionwatch/*"},
    {"Effect":"Allow","Action":["kms:Encrypt","kms:GenerateDataKey"],"Resource":"*",
     "Condition":{"StringEquals":{"kms:ViaService":"ssm.us-west-2.amazonaws.com"}}}]}'

aws ssm send-command --region us-west-2 --instance-ids i-0123456789abcdef0 \
  --document-name AWS-RunShellScript --parameters 'commands=[
    "set -euo pipefail",
    "umask 077",
    "T=$(mktemp)",
    "trap \"rm -f $T\" EXIT",
    "grep -v \"^IMAGE_\" /home/ec2-user/commissionwatch/.env > $T",
    "test -s $T",
    "aws ssm put-parameter --region us-west-2 --name /commissionwatch/env --type SecureString --overwrite --value file://$T > /dev/null",
    "echo seeded $(wc -c < $T) bytes"]'

# then take the write back — the host only needs to read
aws iam delete-role-policy --role-name platform-aws-host --policy-name commissionwatch-param-seed
```

The value goes **host → SSM API directly**. It is not in the command text and not in the command
output, so it stays out of CloudTrail and out of the 30-day command history — the same property
that keeps secrets out of the deploy payload. Only the byte count is echoed.

**Done 2026-08-06.** `/commissionwatch/env` is a SecureString at version 1: 419 bytes, 8 keys
(`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`,
`MINIO_BUCKET`, `CHANNEL_SECRET_KEY`, `CI_EVENT_TOKEN`). The seed grant was revoked in the same
session and the host was then made to read the value back to prove read-without-write works.
Re-run this procedure only to rotate — it needs the temporary grant again each time, because the
host deliberately holds no standing write.

Note `MINIO_BUCKET` is present but is not in §4's required list above; the list understates what
the compose file actually consumes. Trust the parameter over the prose.

### 5. Caddy site block

Request `commissionwatch.bmux.sh` → `commissionwatch-web:3000` on the `edge` network, in
`your-org/platform-aws`. To go public, delete the two `@blocked` lines from that block. **Do not**
touch the security group — its 443 allowlist is shared with seven other products, so opening it
exposes all of them at once.

## Backups and the restore drill

Ingestion landed on 2026-08-09 and the database stopped being reproducible from a seed file the
moment it did. Some of the bytes now held were fetched at a point in time from sources that rewrite
their own pages, so what is being protected here is the evidence, not the schema.

### Nightly backup

```bash
cd /home/ec2-user/commissionwatch
./deploy/backup.sh
```

Writes `backups/daily/commissionwatch-<UTC stamp>.tar.gz`, containing:

| Member | What it is |
|---|---|
| `database.dump` | `pg_dump -Fc` of the application database |
| `objects.tar` | every object in the MinIO bucket, taken with `mc mirror` |
| `rowcounts.csv` | row counts per table at dump time — what the drill checks against |
| `manifest.txt` | stamp, host, database, byte sizes, object count, server version |

Retention is 7 daily and 4 weekly; Sunday's archive is hard-linked into `backups/weekly/`, so a
weekly copy costs no extra bytes until the daily one is pruned. Success and failure emit
`ops.backup_succeeded` / `ops.backup_failed` through the application's own `DeliveryDispatcher`, so
they arrive over channels the operator already configured. A failure to *notify* is itself printed
to stderr — a silent notifier is the exact failure this is supposed to prevent.

Install it as a cron job on the host:

```
17 4 * * *  cd /home/ec2-user/commissionwatch && ./deploy/backup.sh >> backups/backup.log 2>&1
```

### Off-instance

**`BACKUP_S3_URI` is unset by default, and while it is unset the archive never leaves the
instance.** That is a copy, not a backup: it survives a bad migration and nothing else. Set it and
the script also runs `aws s3 cp` under the host's existing instance role — no new credential, and
the only outstanding decision is the bucket, which costs money and is therefore the operator's to
make:

```
BACKUP_S3_URI=s3://your-org-backups/commissionwatch
```

The instance role needs `s3:PutObject` on that prefix. Nothing else changes.

### The restore drill — run it, do not read it

```bash
./deploy/restore-drill.sh                      # newest daily archive
./deploy/restore-drill.sh --archive path.tar.gz
./deploy/restore-drill.sh --keep               # leave the scratch database behind
```

It creates `commissionwatch_restore_drill` on the running instance, `pg_restore`s into it, and
compares every table against `rowcounts.csv`. A table that had rows and came back empty is `LOST`,
a short table is `SHORT`, and either exits non-zero. `pg_restore`'s own exit status is deliberately
**not** the pass condition: it complains about ownership on a perfectly good dump and stays quiet
about an empty one. The row counts decide.

**Executed 2026-08-09, against the first archive taken after the first real Gallatin sweep.**
28 tables compared, 137 rows restored, no LOST or SHORT rows, and the object archive carried 11
objects — matching `meetings` 7, `agenda_items` 40, `meeting_documents` 11, `artifacts` 11,
`ingestion_jobs` 23, `commissions` 12, `jurisdictions` 1, `ingestion_runs` 1, `ingestion_sources` 1,
`knex_migrations` 29. The drill passed.

Re-run it after any schema change, any Postgres upgrade, and any change to `backup.sh`. A drill's
result expires; the script exists so the evidence can be refreshed rather than remembered.

### The `POSTGRES_PASSWORD` trap

`POSTGRES_PASSWORD` is read by the postgres image **only when it initialises an empty data volume**.
Changing the secret afterwards does not change the database — the role keeps the password its volume
was born with. This has already cost this project a deploy.

The drill sidesteps it entirely by restoring into a scratch database on the already-running
instance, using the credentials that instance actually answers to.

A real restore into a **fresh volume** does not get to sidestep it:

1. The new volume initialises with whatever `POSTGRES_PASSWORD` is set at that moment — not with the
   password the old volume had.
2. So either set `POSTGRES_PASSWORD` in `/commissionwatch/env` to the value you want *before*
   creating the volume and let `DATABASE_URL` match it, or bring the volume up and then
   `ALTER ROLE postgres WITH PASSWORD '<the value DATABASE_URL uses>'` on the running instance.
3. Restore with `pg_restore --no-owner --no-acl`, because the dump's ownership refers to roles the
   fresh volume has not necessarily got.
4. Restore the objects by untarring `objects.tar` and `mc mirror`ing it back into the bucket.

## Traps

Each of these cost a failed deploy.

- **The host is arm64.** A plain `docker build` on an x86_64 runner produces an amd64 image that
  pushes and pulls perfectly, then dies with `exec format error`. CI uses
  `docker buildx build --platform linux/arm64` after `tonistiigi/binfmt --install arm64`.
- **The `your-org/` ECR prefix is required.** The CI policy scopes to those exact repositories.
  ECR reports both a wrong path and a missing repository as **403 on a blob HEAD**, never a 404,
  and never names the repository — so a 403 means check the path first, not the credentials.
- **`AWS_PROFILE` set but empty** makes the CLI fail with *"The config profile () could not be
  found"*, which reads as missing credentials and sends you to the wrong problem. Reproduced on the
  operator workstation 2026-08-06. The script clears it when empty, on both ends.
- **`ec2-user` cannot write to `/opt`.** We deploy under `$HOME`, so no per-product root
  provisioning step is needed.
- **`POSTGRES_PASSWORD` is fixed at volume initialisation.** Changing the parameter will not change
  the database; rotation is an `ALTER ROLE` on the running instance.
- **Never `--remove-orphans`, never `--volumes`.** They reach outside our compose project;
  `--remove-orphans` can delete the platform's Caddy container. Asserted in the tests.
- **`AWS_PAGER` must be `""`.** CLI v2 pages through `less(1)`; on a runner `TERM` is undriveable,
  so every `aws` call stalls on "Press RETURN" instead of failing. The step looks merely slow.
  Set in the script, in the remote payload, and in the workflow job env.
- **Probe `127.0.0.1`, never `localhost`, inside these containers.** `/etc/hosts` maps `localhost`
  to `::1` as well, busybox wget tries `::1` first, and nginx listens only on IPv4 — so a
  `localhost` URL gives a flat `Connection refused`. The `web` healthcheck used one, which meant it
  could never go healthy and `up -d --wait` would block until timeout. Verified 2026-08-06: same
  image, `localhost` → unhealthy, `127.0.0.1` → healthy.
- **SSM output truncates at 24000 characters.** Nothing here configures S3 or CloudWatch delivery,
  so a very chatty failure loses its tail. Re-run the failing piece by hand if you need more.

## Version skew

Both images are stamped at build time and serve their build SHA — `/version.json` from the web
image, `/api/version` from the api. The deploy fetches both through the web container and fails if
they disagree. The images roll independently, so a stack serving the old API behind the new UI is
healthy by every other measure; this is the only thing that makes it visible.

| Exit | Meaning | What to do |
|---|---|---|
| 25 | web and api report different SHAs | redeploy with both `IMAGE_*` pinned to one commit |
| 26 | both agree but differ from `EXPECT_SHA` | a stale pull — the tag resolved to an older image |
| 24 | an endpoint was unreadable | image predates the endpoints, or the `/api/` proxy is broken |

Checking by hand:

```bash
curl -s https://commissionwatch.bmux.sh/version.json
curl -s https://commissionwatch.bmux.sh/api/version
```

An unstamped image reports `"unknown"` rather than anything commit-shaped, and the deploy says
outright that comparing two unstamped images proves nothing.

## When something breaks

```bash
# what the host would be told to do, without sending anything
DRY_RUN=1 ./deploy/deploy-aws-ssm.sh

# re-read a finished command
aws ssm get-command-invocation --region us-west-2 \
  --command-id <id> --instance-id i-0123456789abcdef0

# poke the host directly
aws ssm send-command --region us-west-2 --instance-ids i-0123456789abcdef0 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker compose -p commissionwatch -f /home/ec2-user/commissionwatch/docker-compose.shared.yml ps"]'
```
