# Deploying over SSM instead of SSH — design

> 2026-08-06. Supersedes the SSH deploy path in `.gitea/workflows/deploy.yml`.
> Runbook and IAM setup live in `deploy/README.md`; this records the reasoning.

## The problem

`deploy-aws` had never completed a green run. It could not, and the reason was not a bug.

The host is `your-org/platform-aws` (`i-0123456789abcdef0`, us-west-2), shared with seven other
products. Its SSH key pair belongs to whoever provisioned it, and **EC2 stores only the key pair's
name — the private half is not retrievable from AWS by anyone.** Port 22 is open, so the failure
presented as a missing secret rather than a missing capability. A job whose first step is
"Configure SSH" against this host will never run, however carefully the rest of it is written.

The answer is not to source the key. It is to stop needing one.

## The decision

Deploy over **SSM Run Command**. It addresses the instance by id, executes through the instance's
own SSM agent, and the host pulls from ECR with its instance role. No key, no host address, no
inbound port.

```
build (dh1 runner)         →  ECR                      →  SSM                →  host
docker buildx              123456789012.dkr.ecr.          send-command           docker compose
  --platform linux/arm64   us-west-2.amazonaws.com        AWS-RunShellScript     -p commissionwatch up -d
```

SSM was already confirmed working on this host — `AmazonSSMManagedInstanceCore` was attached on
2026-08-04, and `aws ssm send-command` has been used since then to inspect and repair it.

## One script, two callers

The deploy lives in `deploy/deploy-aws-ssm.sh`. CI calls it; an operator calls it by hand with the
same arguments. This is the point, not a convenience: every product on this host starts in the
position of having a blocked pipeline, and a manual procedure that diverges from the automated one
is a second thing to be wrong. Here the manual path *is* the automated path.

The script falls back to the `amazon/aws-cli` container when no `aws` binary is present — the
runners here have docker but not the CLI, and laptops are usually the reverse. **Verified
2026-08-06:** with `aws` off `PATH` but docker available, the script selects the container path and
reaches AWS through it. The brief that prompted this work listed that fallback as unexercised.

`IMAGE_BACKEND` / `IMAGE_FRONTEND` pin exact versions. Unset, the script ships `:latest`; set, it
ships one exact build. That is what makes a rollback the same command with an older tag.

## Secrets

**Decision: SSM Parameter Store SecureString, fetched by the host with its instance role.**

Two alternatives were rejected:

- *Embed the env file in the SSM command.* Closest to the old behaviour, and wrong.
  `send-command` parameters are retained **in plaintext in command history for 30 days** and land
  in CloudTrail, readable by anyone in the account holding `ssm:GetCommandInvocation` — on a host
  shared with seven other products. `deploy/test-deploy-aws-ssm.sh` asserts no secret material
  appears in the payload, because a comment is not enough for a property like this.
- *Host-resident secret file, provisioned once.* Safe, but leaves credentials outside any
  managed store and makes rotation a manual host action. `docs/STATUS.md` already names Parameter
  Store as the intended end state.

CI refreshes the parameter only when `DEPLOY_ENV_FILE_AWS` is present. A code deploy does not
require the credentials secret to be set; it redeploys against whatever the parameter already
holds. Image pins are stripped before the value is stored — a stale pin in the parameter would
silently override the version being deployed.

### The instance-role dependency, and why the deploy degrades instead of failing

Reading the parameter requires `ssm:GetParameter` plus `kms:Decrypt` on the instance role. That
role is **shared with other products and we do not administer it**, so the grant lands out of band.

A deploy that hard-failed until then would take a working public site down over an IAM ticket. So
the host-side script resolves secrets in this order, announcing which one it used:

| Order | Source | Result |
|---|---|---|
| 1 | Parameter Store SecureString | normal |
| 2 | `.env.secrets` already on the host | **DEGRADED**, warns, deploys |
| 3 | the combined `.env` left by the 2026-08-05 hand deploy, image pins stripped | **DEGRADED**, warns, deploys |
| 4 | nothing | fails, exit 3, printing the exact IAM statement needed |

This is a deliberate exception to *failures are disclosed, not swallowed* — nothing is swallowed.
Each degraded path prints a warning naming the cause, and the source is echoed on every run. What
is avoided is an outage caused by a permission that is not ours to grant. All four branches are
covered by tests.

## Shared-host safety

Four properties, each of which can take down other tenants if changed:

1. **`-p commissionwatch`** scopes every compose operation. It cannot see or stop another tenant's
   stack.
2. **Never `--remove-orphans`, never `--volumes`.** These are the two flags that reach outside a
   project; `--remove-orphans` can delete the platform's own Caddy container.
3. **No published host ports.** 80/443 belong to the platform Caddy, and the security group leaves
   :80 open to the world for ACME.
4. **`edge` is external** — attached to, never created when it already exists, never reconfigured.

All four are asserted in `deploy/test-deploy-aws-ssm.sh` against a stubbed docker, so a regression
fails CI rather than the platform.

## nginx upstream resolution

Fixed in the same change because it is the same class of defect — a startup-order failure that
looks like something else.

`frontend/nginx.conf` used a literal `proxy_pass http://backend:3001;`. nginx resolves a literal
upstream **once, at config-parse time, and exits** if it does not resolve. Verified against
`nginx:alpine` on 2026-08-06:

| Config | `nginx -t` with backend absent | Behaviour |
|---|---|---|
| literal `proxy_pass http://backend:3001;` | `[emerg] host not found in upstream "backend"` | container exits |
| `resolver 127.0.0.11` + variable upstream | syntax is ok | container starts and stays up |

Functionally verified by starting the proxy with no backend in DNS at all: it stayed `running` with
`restarts=0`, returned 502 on `/api/` while the SPA kept serving, and recovered with **zero
restarts** once the backend appeared. Path and query string pass through unchanged
(`/api/health?x=1` arrived intact), because the variable carries no URI part and nginx only
replaces the request URI when the directive specifies one.

The compose `depends_on` is kept for ordering but is no longer load-bearing — it never helped on a
host reboot anyway.

## Version skew, and two defects found proving it

`up -d --wait` proves the containers started. It does not prove they are the containers we meant to
start. The web and api images roll **independently**, so a stack serving the old API behind the new
UI passes every health check and looks perfectly fine from outside.

Both images are now stamped at build time from one `github.sha` expansion — `GET /version.json`
from the web image, `GET /api/version` from the api. After `up -d`, the deploy fetches both
**through the web container**, so a pass also proves the nginx proxy reaches the backend, which
`/api/health` alone does not. Distinct exit codes, because these have different causes and
different fixes:

| | Meaning | Exit |
|---|---|---|
| web ≠ api | one image rolled, the other did not | 25 |
| both agree but ≠ `EXPECT_SHA` | stale pull — the tag resolved to an older image | 26 |
| either unreadable | image predates the endpoints, or the proxy is broken | 24 |

An unstamped build reports `"unknown"`, never a commit-shaped string: two unstamped images always
agree, so the check would otherwise pass while proving nothing. That case deploys but warns loudly,
and a backend test asserts the unstamped value cannot look like a SHA.

Verified 2026-08-06 against real images: a genuinely skewed pair (`different99` vs `testsha123`)
was detected, and a matched pair reported `testsha123` from both endpoints through the proxy.

### `localhost` resolves to `::1`, and nginx listens only on IPv4

Found while verifying the above. In `nginx:alpine`, `/etc/hosts` maps `localhost` to both
`127.0.0.1` and `::1`; busybox wget tries `::1` first; nginx listens on `0.0.0.0:3000` only. So
`wget http://localhost:3000/` fails with a flat `Connection refused`.

**The `web` healthcheck in `docker-compose.shared.yml` used exactly that URL.** Verified by running
the same image twice with only the healthcheck differing:

| Healthcheck | Result after 25s |
|---|---|
| `wget -qO- http://localhost:3000/` | **unhealthy** |
| `wget -qO- http://127.0.0.1:3000/` | **healthy** |

The container could therefore never become healthy, and `up -d --wait` — used by both the old SSH
job and this one — would have blocked until its timeout and failed the deploy, pointing at a
healthcheck that reads as obviously correct. This would have bitten on the first automated deploy
regardless of anything else in this change. Both the healthcheck and the version probe now use
`127.0.0.1`, and a test asserts neither reverts.

### `AWS_PAGER`

CLI v2 pages output through `less(1)`. On a runner `TERM` is undriveable, so every `aws` call
stalls on "Press RETURN" rather than failing — the step looks merely slow until something times
out. Set on both ends and in the workflow job env. Asserted in tests, because a hang is far harder
to diagnose than an error.

## What is not done here

- **Instance-role grant** for `ssm:GetParameter` + `kms:Decrypt`. Out of band, not ours. Until it
  lands, deploys run degraded per the table above.
- **`:version` image tags.** The brief suggests tagging from `git describe`, which on shallow Gitea
  checkouts silently degrades to a bare SHA that *looks* like a valid answer. We tag `:sha` and
  `:latest` and pin explicitly; adding a fragile version derivation that nobody has exercised would
  trade a real property for a cosmetic one.
- **A green end-to-end run.** Everything testable without AWS credentials is tested and passing.
  The SSM round trip itself is unproven from CI. Treat the first green pipeline with suspicion
  until one full deploy has been observed — the same caution `docs/STATUS.md` already applies.
