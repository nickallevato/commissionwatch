# CommissionWatch — production deployment

Deploys onto the shared bmux platform host over **SSM Run Command**. Not SSH.

> The previous version of this file described an Ansible playbook in a your-org repo. That is not
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

### 1. Gitea secrets — repository level, not organisation

**Organisation secrets are NOT inherited by repositories**, whatever the onboarding doc says. This
is the single biggest time sink in onboarding a product here. Add under
**Settings → Actions → Secrets on this repository**:

| Secret | Required | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | yes | ECR push and `ssm:SendCommand` |
| `AWS_SECRET_ACCESS_KEY` | yes | ” |
| `DEPLOY_ENV_FILE_AWS` | no | When set, refreshes the Parameter Store SecureString. A code deploy does not need it. |

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
    {"Effect":"Allow","Action":["ssm:SendCommand"],
     "Resource":["arn:aws:ec2:us-west-2:123456789012:instance/i-0123456789abcdef0",
                 "arn:aws:ssm:us-west-2::document/AWS-RunShellScript"]},
    {"Effect":"Allow","Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations"],
     "Resource":"*"},
    {"Effect":"Allow","Action":["ssm:PutParameter"],
     "Resource":"arn:aws:ssm:us-west-2:123456789012:parameter/commissionwatch/*"},
    {"Effect":"Allow","Action":["kms:Encrypt","kms:GenerateDataKey"],
     "Resource":"*",
     "Condition":{"StringEquals":{"kms:ViaService":"ssm.us-west-2.amazonaws.com"}}}]}'
```

**Understand what the first statement grants before applying it:** the pipeline can run shell
commands as root on a host shared with other tenants. It is the same power the manual script uses,
moved from a person into automation. That is a real decision, not a formality.

`ssm:PutParameter` and the KMS statement are only needed if CI refreshes secrets. Drop them if
`DEPLOY_ENV_FILE_AWS` is never set.

### 3. Instance role — the one grant that is not ours

The **host** reads the secrets, using its own instance role. That role is shared with other
products, so whoever administers `your-org/platform-aws` must add:

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["ssm:GetParameter"],
   "Resource":"arn:aws:ssm:us-west-2:123456789012:parameter/commissionwatch/*"},
  {"Effect":"Allow","Action":["kms:Decrypt"],
   "Resource":"*",
   "Condition":{"StringEquals":{"kms:ViaService":"ssm.us-west-2.amazonaws.com"}}}]}
```

**Until this lands, deploys still work but run DEGRADED**, falling back to the secret file already
on the host and warning loudly on every run. That is deliberate: a working public site should not go
down over an IAM ticket we cannot file ourselves. The run output always names which source it used.

### 4. Seed the parameter

```bash
DEPLOY_ENV_FILE=./prod.env ./deploy/deploy-aws-ssm.sh
```

The file needs `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ACCESS_KEY`,
`MINIO_SECRET_KEY`, `CHANNEL_SECRET_KEY`, `CI_EVENT_TOKEN`. `IMAGE_*` lines are stripped — image
pins are per-deploy, and a stale one in the parameter would override the version being deployed.
Standard-tier parameters cap at 4096 bytes; the script checks and says so.

### 5. Caddy site block

Request `commissionwatch.bmux.sh` → `commissionwatch-web:3000` on the `edge` network, in
`your-org/platform-aws`. To go public, delete the two `@blocked` lines from that block. **Do not**
touch the security group — its 443 allowlist is shared with seven other products, so opening it
exposes all of them at once.

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
- **SSM output truncates at 24000 characters.** Nothing here configures S3 or CloudWatch delivery,
  so a very chatty failure loses its tail. Re-run the failing piece by hand if you need more.

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
