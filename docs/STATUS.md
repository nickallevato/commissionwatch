# CommissionWatch — Status, Gaps and Next Steps

> Last updated: 2026-08-09, after landing Tier A of the archive salvage.
> Read this before starting work. It records what is true, not what was planned.

## Archive salvage — what has landed

Working from `docs/superpowers/specs/2026-08-09-archive-salvage-design.md`.

| Item | State |
|---|---|
| A4 · `vote_donor_conflict` anomaly type | **Landed.** Migration 020. The enum carries seven values. |
| A2 · OpenFEC client | **Landed.** Migrations 021, plus `HttpCache` and `OpenFecClient`. No orchestration framework came with it. Needs `OPENFEC_API_KEY` to make a live call; every test is fixture-based. |
| A1 · Operator authentication | **Landed.** Migrations 022–023, scrypt passwords, server-side sessions in an httpOnly cookie, `/api/admin/*` closed by default, CORS split. |
| A3 · Embedding client | **Withdrawn.** Nothing consumes embeddings; see the spec. |
| B-e · Subscriptions and delivery | **Landed.** Migrations 024–025. A subscription is a destination, a filter and a cadence. SMS added with consent and a per-day cap. |
| B-d · Records requests | **Landed.** Migrations 026–027. A hand-obtained document takes the identical path as a scraped one, and records-derived flags are held, never published. |

**The dispatcher still sends no email.** That is deliberate and load-bearing.
`alert_subscriptions` is retained read-only for one release and the legacy
`EmailDeliveryService` remains email's only sender, which is what makes B-e's
back-fill of those rows onto `delivery_channels` incapable of double-sending.
`test/subscriptions-unified.test.ts` asserts it. Cutting email over to the
dispatcher and dropping `alert_subscriptions` is a separate change, and the two
must happen in the same commit.

Per `CLAUDE.md`, nothing in the delivery layer sends product events yet —
including SMS. The substrate exists; the review queue is still what opens it.

**There is no operator account until one is seeded.** The backend creates the first
operator at boot from `OPERATOR_SEED_EMAIL` / `OPERATOR_SEED_PASSWORD` /
`OPERATOR_SEED_NAME`, once, and only while `operators` is empty. Those reach the container
from `/commissionwatch/env` in Parameter Store like every other secret. Clear them after the
first boot: leaving them set does nothing except keep a password in the environment. Without
them the admin console exists and cannot be entered, which is the correct default.

`ADMIN_ORIGINS` gates credentialed requests to `/api/admin`. The public read-only API stays
open to any origin — that is deliberate, and open data is the point.

## Live state

**https://commissionwatch.bmux.sh returns 200.** Verified from outside the host, with a valid Let's Encrypt certificate.

| | |
|---|---|
| Host | `i-0123456789abcdef0`, shared `*.bmux.sh` platform, t4g.medium (arm64), 4 GB |
| Containers | `commissionwatch-web`, `-backend`, `-db` (pgvector pg16), `-minio` — all healthy |
| Footprint | ~144 MB actual against 1408 MB of declared limits |
| Deploy dir | `/home/ec2-user/commissionwatch` on the host |
| Access | Gated at the Caddy layer to `184.166.213.70`. Everyone else gets 403 |
| Data | **Empty.** `members`, `meetings`, `votes` all zero rows |

### The site has no data in it

This is the single most important thing to understand. It is a working, well-built shell. The Gallatin adapter exists and passes 68 tests, but **nothing schedules it**, so no public record has ever been ingested. Making that true is the highest-value next task.

### The running deployment now comes from CI

As of 2026-08-06 the live containers are the ones `deploy-aws` shipped over SSM, serving `71217e2`. Before that they had been started by hand over SSH on 2026-08-05, and the SSH version of the job could never have replaced them: the shared host's SSH private key is not retrievable from AWS by anyone, so it was blocked on a secret that does not exist to be supplied.

**Rewritten on 2026-08-06 to deploy over SSM Run Command** (`deploy/deploy-aws-ssm.sh`), which needs no key and no host address. Everything testable without AWS credentials is tested and green — payload construction, secret resolution, shared-host safety flags. Design: `docs/superpowers/specs/2026-08-06-ssm-deploy-design.md`.

**First real run, 2026-08-06.** `SHARED_STACK_LIVE` was set and `deploy-aws` executed. It authenticated as `commissionwatch-ci`, resolved both image pins to `25ba8b9`, and failed at `ssm:PutParameter` — the optional secret refresh. Diagnosis from the account: the CI user held exactly one inline policy, `commissionwatch-ecr-push-pull`, so `ssm:SendCommand` was missing as well; `/commissionwatch/env` had never been created; and `platform-aws-host` had no Parameter Store grant. **None of these are code defects** — the script did what it was told with the permissions it had.

**Second run, 2026-08-06 (`af7097f`, v0.2.0).** Failed at the same line, and that was informative: it proved `DEPLOY_ENV_FILE_AWS` was still set even though the IAM grants had landed. The Gitea *Variables* tab had been cleared, but the value is a **secret**, and secrets are a separate tab. The diagnostic block printed as designed and the job died before touching the host, so nothing on the box changed.

**Third run, 2026-08-06 (`71217e2`). The SSM round trip works end to end.** The host pulled both images, recreated `backend` and `web`, waited on `db` and `minio` health, and reported both containers serving `71217e2`. Secrets came from `/commissionwatch/env` — no DEGRADED fallback. Verified independently: `https://commissionwatch.bmux.sh/api/health`, `/api/version` and `/version.json` all return 200, and `/api/version` reports sha `71217e2`, built `2026-08-06T22:40:39Z`.

**The job still reported failure**, after the deploy had fully succeeded. Cause was in the workflow, not the deploy script: `cleanup() { [ -n "$TMPENV" ] && rm -f "$TMPENV"; }` as an `EXIT` trap. When a `&&` chain is the *last command of an EXIT trap* and its test fails, bash makes that the script's exit status — so a completely successful deploy exited 1 whenever `TMPENV` was empty. That is precisely the path taken when `DEPLOY_ENV_FILE_AWS` is unset, i.e. the normal one, which is why deleting the secret is what exposed a latent bug rather than causing a new one. Fixed with an `if`, which returns 0 with no else branch.

## Operational facts

Learned the hard way; each cost a failed deploy.

- **ECR repositories are `your-org/` prefixed** — `your-org/commissionwatch-backend`, `your-org/commissionwatch-frontend`. The CI user's IAM policy scopes to `repository/your-org/commissionwatch-*`, so an unprefixed path is denied. ECR reports both a wrong path and a missing repository as **403 on a blob HEAD**, never a 404, and never names the repository — so a 403 means check the path first, not the credentials.
- **Images must be `linux/arm64`.** The host is Graviton. An amd64 image builds cleanly and dies at startup with `exec format error`.
- **The host's instance role needed `ecr:BatchGetImage` on `your-org/*`.** The other products' repos are unprefixed, so `bmux-platform-host-ecr-pull` never covered ours. Fixed 2026-08-05 by adding that ARN pattern.
- **`ec2-user` cannot write to `/opt`.** `platform-aws` deploys to `/opt/platform-aws`, which must have been root-provisioned out of band. We deploy under `$HOME` instead, so no manual step is required per product.
- **Gitea `act_runner` runs jobs inside containers**, so a `services:` database answers to its service name (`postgres`), not `localhost`. The workflow probes both.
- **`actions/setup-node` had a corrupt runner cache**, failing with an `lstat` error naming a file from the action's own repo. Replaced with `container: node:22-bookworm`.
- **CI is Gitea Actions only.** Never add `.github/workflows/` — it does not run.
- **`POSTGRES_PASSWORD` is fixed at volume initialisation.** Changing the secret later will not change the database; rotation is an `ALTER ROLE` on the running instance.
- **SSM works on the host** (`AmazonSSMManagedInstanceCore` attached 2026-08-04). This is now the deploy path, not just a repair tool.
- **The shared host's SSH private key is unobtainable.** EC2 stores only the key pair's *name*; the private half belongs to whoever provisioned `platform-aws` and cannot be retrieved from AWS. Port 22 being open makes this look like a missing secret rather than a missing capability. Do not try to source it — that is a dead end, and it is why the old `deploy-aws` job could never go green.
- **`AWS_PROFILE` set but empty** makes every CLI call fail with *"The config profile () could not be found"*, which reads as missing credentials. Reproduced on the operator workstation 2026-08-06. `deploy-aws-ssm.sh` clears it when empty on both ends.
- **Secrets belong in SSM Parameter Store**, fetched by the host with its instance role. Never in the SSM command payload — `send-command` parameters sit in plaintext in command history for 30 days and in CloudTrail, readable by anyone in the account with `ssm:GetCommandInvocation`.
- **The instance role reads `/commissionwatch/*`, and only reads it.** The role is `platform-aws-host`, shared with the other products on the box, so the grant is an **inline** policy (`commissionwatch-param-read`) scoped to our path — it touches no managed policy and no other tenant. Applied and verified 2026-08-06. An earlier version of this file said the grant "is not ours to make"; **that was wrong** — the account holder has `AdministratorAccess`. See `deploy/README.md` §3. If the parameter is ever missing, deploys fall back to the `.env` on the host and run **DEGRADED**, loudly, rather than failing.
- **CI must not hold `ssm:PutParameter`.** The parameter is seeded once by hand and read by the host; the pipeline only sends commands. Setting `DEPLOY_ENV_FILE_AWS` reverses that — it makes every deploy push the secret through a runner and need a write grant. Verified 2026-08-06: with the secret set and no SSM policy on the CI user, the first failure is `PutParameter`, which reads as a broken deploy while concealing that `ssm:SendCommand` was also missing.
- **Nobody holds the plaintext of the env file, and nobody needs to.** It exists in `/home/ec2-user/commissionwatch/.env` on the host and, until 2026-08-06, in a Gitea Actions secret that is write-only. The host seeded Parameter Store from its own copy without anyone reading it — `deploy/README.md` §4. `/commissionwatch/env` is now a SecureString at version 1, 419 bytes, 8 keys, and the seed grant was revoked in the same session. Rotation means repeating that procedure, not recovering a copy from somewhere.
- **The `amazon/aws-cli` container fallback works** — verified 2026-08-06 with `aws` off `PATH`. The runners have docker but not the CLI.
- **`AWS_PAGER` must be set to `""`.** CLI v2 pages through `less(1)` and on a runner `TERM` is undriveable, so every `aws` call stalls on "Press RETURN" rather than failing. A deploy that looks slow rather than broken. Set on both ends and in the workflow job env.
- **Inside these containers, probe `127.0.0.1`, never `localhost`.** `/etc/hosts` maps `localhost` to `::1` too, busybox wget tries `::1` first, and nginx listens only on IPv4 — so `localhost` gives a flat `Connection refused`. **The `web` healthcheck used one**, so the container could never go healthy and `up -d --wait` would have blocked until timeout and failed the first automated deploy. Verified 2026-08-06 with the same image twice: `localhost` → unhealthy, `127.0.0.1` → healthy. Fixed.
- **Both images serve their build SHA** — `/version.json` from web, `/api/version` from the api, stamped from one `github.sha`. The deploy compares them through the web container and fails on skew (25), stale pull (26) or unreachable (24). The images roll independently, so a stack serving the old API behind the new UI is healthy by every other measure.

### Going public

Delete the two `@blocked` lines from the `commissionwatch.bmux.sh` block in `your-org/platform-aws`'s `caddy/Caddyfile`. **Do not** change the security group — its 443 allowlist is shared with seven other products, so opening it exposes all of them at once. Per-product exposure belongs in Caddy.

## Gaps — what is not built

Ordered by how much each blocks the product being real.

1. **Nothing ingests.** The queue, worker and Gallatin adapter exist; no scheduler runs them. Zero records on the live site.
2. **W3 findings engine and review queue.** The core product. `anomaly_flags.review_state` now exists (B-d) and is the column the queue generalises: records-derived flags are written `held` and the public API filters them out. Generated narrative, mechanical claim-to-citation binding, operator approval before anything naming a person publishes. Not started. Spec exists in the production design.
3. **Bozeman adapter.** Route identified and validated: `bozeman.granicus.com/ViewPublisher.php?view_id=1` carries **520 City Commission meetings spanning 2013–2026**, 507 with agendas, 434 with minutes. `bozemanmt.gov` is a blanket Akamai deny and must not be retried. Operator decision 2026-08-04: crawl Granicus politely and publish the public-records-request route alongside. See `docs/exploration/bozeman-access-spike.md`.
4. **MT CERS campaign finance** (`cers-ext.mt.gov/CampaignTracker`). Not started.
5. **W6 funding network layer.** Specced only — `docs/superpowers/specs/2026-08-04-funding-network-layer-design.md`.
6. ~~**W7 delivery channels.**~~ Built. Channels, routes, encryption, the Discord transport, and — as of B-e — cadence, SMS, and a self-serve subscriber surface on the same substrate. Nothing dispatches product events yet, because nothing ingests.
7. **Launch readiness**: corrections and dispute policy, public data export and licensing, backups with a tested restore, accessibility and shareability. Specced only.
8. **No database backups.** Nothing is backed up today. Once ingestion runs, this becomes urgent.
9. **No monitoring.** Nothing alerts if the site goes down or ingestion silently stops.
10. ~~**No admin authentication.**~~ Closed 2026-08-09 by A1. One operator class, `scrypt` from
    `node:crypto`, revocable server-side sessions in an httpOnly cookie, no public registration.
    The review queue is no longer blocked on it.

## Known defects and debt

- **CI `deploy-aws` unverified.** The SSM round trip has not yet completed once from a runner. See above.
- ~~**Deploy pattern is push-based SSH**~~ — resolved 2026-08-06. No SSH key in CI, no rsync; secrets live in Parameter Store and are fetched by the host. Still push-based; a pull-based rollout watching ECR remains the better end state but is not blocking anything.
- **The instance-role grant for Parameter Store is outstanding**, so deploys run degraded. Not a defect in this repo — it needs whoever administers `your-org/platform-aws`. `deploy/README.md` §3 has the exact policy.
- **Images are tagged `:sha` and `:latest` only.** No `:version` tag: deriving one from `git describe` is unsafe on Gitea's shallow checkouts, where `--always` silently degrades to a bare SHA that looks like a valid answer. Rollback is by explicit pin instead, which works today.
- **Homepage findings section is a placeholder constant** in `HomePage.tsx` with a TODO naming W3. It must not be filled with invented content about a real person.
- **`Layout.tsx` hardcodes "Last sweep 12 min ago."** Once real data exists this is a false statement on a transparency site. Wire it to the real sweep timestamp or remove it.
- **`meetings` has no `adjourned_at` or `meeting_type`.** `MeetingDetailPage` prints "Adjourned — Not recorded" verbatim.
- **No tests** for `MeetingDetailPage`, `StatusBadge`, `RundownViewer`.
- **`VoteBreakdown.tsx` may be unused** by any page — verify and delete or wire up.
- **W1 critic findings were never fully cleared.** An orchestration bug capped repairs at 5 of 19. The remaining ones were partly fixed incidentally. Re-run the critics rather than trusting the old list.

## Invariants — do not break these

Full detail in `.claude/skills/commissionwatch-development/SKILL.md`.

- No unsourced claim reaches the public site. `funding_edges.source_artifact_id` is `NOT NULL` for this reason.
- Nothing naming a person auto-publishes. It goes to the operator review queue.
- Seed data never names a real person, and **seeds never run in production** — the seed deletes every row first, so an automatic seed would destroy ingested records. `docker-entrypoint.sh` refuses to seed when `NODE_ENV=production`.
- Describe the record, never the motive. No assertion of intent, corruption or illegality.
- Detection logic applies identically to every entity class. No detector may filter on entity type to select targets.
- Never silence a type error; never delete a test to go green.
- The database schema is the source of truth for types.

## Next steps, in order

1. **Schedule Gallatin ingestion.** Wire the queue worker to a cron, run a sweep, confirm real meetings appear on the live site. This turns a shell into a civic-transparency site.
2. **Prove CI deploy end to end.** Run `deploy-aws` and watch it succeed, so the manual deployment is no longer the only path that has ever worked.
3. **Backups.** Postgres and MinIO snapshots with a restore that has actually been executed, before there is data worth losing.
4. **W3 findings engine and review queue**, with admin auth. The core product, and the highest-stakes component.
5. **Bozeman Granicus adapter**, plus the public-records-request page.
6. **Status page** reading `ingestion_runs`, so a silently stalled scraper is visible rather than reading as a quiet month at City Hall.
7. Then W5 correlation, W6 funding network, W7 delivery channels, and the launch-readiness work.

## For future agents

- Read `.claude/skills/commissionwatch-development/SKILL.md` first. It holds the process and the invariants.
- **Probe external sources before designing against them.** Every significant plan change in this project came from a `curl`, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended.
- **Verify by running commands.** Do not report success from an agent's claim or a green pipeline. Both have lied in this project.
- When fanning out, give agents disjoint file ownership and forbid concurrent git writes — a shared index lock corrupts work.
- A check that could not run is `blocked`, never `pass`.
