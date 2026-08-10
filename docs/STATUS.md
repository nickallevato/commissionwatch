# CommissionWatch — Status, Gaps and Next Steps

> Last updated: 2026-08-10, after landing P2 (the Pressroom console) and the deploy healthcheck
> fix. Previously 2026-08-09, after P1 (ingestion scheduling), P3 (backups) and P4 (the Bozeman
> Granicus adapter).
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

## P2 — the Pressroom console has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P2 and
`docs/superpowers/plans/2026-08-10-pressroom-console.md`. Migrations 030–033.

Three operator screens behind `requireOperator`: `/admin/sources`, `/admin/runs/:id`,
`/admin/meetings/:id`, served by `/api/admin/pressroom/*`.

**`ingested` and `published` are now different states.** `meetings.published_at` exists, and a
meeting with `published_at IS NULL` **does not appear in any public API response** — ten public
paths take a meeting id and a test walks all ten. Existing rows were backfilled to `created_at`,
so nothing that was public stopped being public. **Rows ingested from here on default to NULL**:
a sweep produces a candidate, an operator produces a publication, and the seed sets the column
explicitly because seed data demonstrates the public record. An unpublished meeting 404s rather
than 403s, so nobody can enumerate what has been ingested and withheld.

**Corrections are append-only, in the database.** `record_corrections` records who, when, field,
old, new and why, and a trigger raises on `UPDATE` and on `DELETE`. **The artifact is never
mutated** — a test hashes the `artifacts` row either side of a correction. The table has no
foreign key to its target and none to `operators`: a cascade from `meetings` would collide with
the trigger on every `pretest` seed, and `ON DELETE SET NULL` is itself an `UPDATE` the trigger
forbids, so the actor is snapshotted as `operator_email`. **A consequence: tests cannot clean up
`record_corrections`.** Rows accumulate in the test database, keyed on ids each run generates.
That is intended, not a leak.

**Confidence is per field.** `agenda_items.field_confidence` is a jsonb map of
`{ level, reason }` per column, written by the extractor: a title truncated by the
255-character column, an item with no section heading above it, a description cut at its limit.
Seven good items and one mangled one is not a low-confidence meeting.

**Silence is watched, and zero is a failure state.** A source past its own
`expected_interval_hours` since its last success reads *Suspect*. Lifetime ingested records is
computed from every run's `counts` and renders in the failure colour at 0. Disabled sources stay
listed with `disabled_reason`, seeded from the adapter's own notes — the Akamai block on
`bozemanmt.gov` is now in the console rather than in a code comment.

**Re-parse without re-fetching** opens a *new* `ingestion_runs` row and queues one `parse` job
per stored artifact. It cannot reach the network: parse targets carry a `sha256`, the queue
rejects a post-fetch target carrying a `url`, and the parse stage has no path back to a URL. It
is a separate action from "sweep now".

The two action routes need the live queue and scheduler, handed over by
`registerPressroomStack` from `index.ts`. **In a process where ingestion is not running they
answer 503**, which is why the test suite sees 503 rather than a constructed MinIO client.

Counts after P2: backend **660 tests / 168 suites**, frontend **180 / 25**, both green, zero
lint errors.

## Live state

**https://commissionwatch.bmux.sh returns 200.** Verified from outside the host, with a valid Let's Encrypt certificate.

| | |
|---|---|
| Host | `i-0123456789abcdef0`, shared `*.bmux.sh` platform, t4g.medium (arm64), 4 GB |
| Containers | `commissionwatch-web`, `-backend`, `-db` (pgvector pg16), `-minio` — all healthy |
| Footprint | ~144 MB actual against 1408 MB of declared limits |
| Deploy dir | `/home/ec2-user/commissionwatch` on the host |
| Access | Gated at the Caddy layer to `184.166.213.70`. Everyone else gets 403 |
| Data | Live host not yet swept. Locally, the first real sweep landed 7 meetings, 40 agenda items, 11 artifacts (2026-08-09) |

### Ingestion runs — the first public records have been fetched

**"Nothing ingests" stopped being true on 2026-08-09.** It was the single most important sentence
in this file for the product's whole life, and it is now wrong, so it is gone rather than softened.

`SourceScheduler` (`backend/src/services/ingestion/scheduler.ts`) is started from `index.ts`. It
reads `ingestion_sources.cron_expression` and `.enabled`, arms one `node-cron` job per enabled
source, takes a Postgres advisory lock keyed on the source id so one sweep runs at a time, writes
an `ingestion_runs` row **before** any work, and closes it `succeeded`, `partial` or `failed` with
every error text in the row. It **does not sweep on process start** — the first execution of any
source is its first cron tick, because a crash-looping container must never become a crawl of a
county web server. `SCHEDULER_ENABLED` defaults off under `NODE_ENV=test`.

**A real sweep ran against Gallatin County on 2026-08-09**, rate-limited to one request every two
seconds with the project's honest user agent. What landed locally:

| | |
|---|---|
| `meetings` | **7** (Weed Board ×4, Study Commission ×2, plus one more) |
| `agenda_items` | **40**, extracted from real agenda PDFs |
| `meeting_documents` | 11 |
| `artifacts` | 11, content-addressed, bytes in MinIO |
| `ingestion_runs` | 1, status `succeeded` |
| `ingestion_jobs` | 23, all terminal |

Two things the sweep taught us, both now in the spec:

- **AgendaCenter has been reorganised.** It rendered **three** categories on 2026-08-09
  (`cat3`, `cat2`, `cat4`) where the 2026-08-04 fixture captured twelve. The adapter's hardcoded
  body list is now mostly wrong about what the site serves; it skips an unknown category loudly, so
  the failure mode is safe, but the list belongs in `ingestion_sources.config` and is P2's job.
- **Not every document is a PDF.** `/AgendaCenter/ViewFile/Agenda/_08062026-108` is a Word
  document. Parse records that as `parse_unsupported` and completes — the bytes are still stored
  and still citable. That meeting has 0 agenda items and the reason is recorded.

### Bozeman is the second source, and it has swept too

**A real sweep ran against `bozeman.granicus.com` on 2026-08-09**, 14-day lookback, one request
every **ten seconds**. What landed locally:

| | |
|---|---|
| `jurisdictions` | 1 — City of Bozeman |
| `commissions` | **16** |
| `meetings` | **18** (6 completed, 12 scheduled) |
| `agenda_items` | **88**, extracted from real agenda **HTML** |
| `meeting_documents` / `artifacts` | 8 |
| `ingestion_runs` | 2, both `succeeded` |

The second sweep re-fetched nothing — `artifacts_unchanged: 8` — which is the content address
doing its job.

Four things this source taught us:

- **The whole archive is one request.** `ViewPublisher.php?view_id=1` is 5.9 MB holding 1,135
  meetings across 16 bodies, 2013→2026, plus 17 upcoming. The year tabs are client-side. There is
  no per-year endpoint, which is the opposite of Gallatin.
- **`bozeman-access-spike.md` was wrong about several counts.** 519 City Commission meetings, not
  520; **16 bodies in total**, not "20+ others"; and 507/434 were City-Commission-only figures
  against 1,102/956 across all bodies. Corrections are inline in that document and in
  `backend/test/fixtures/bozeman-granicus/PROVENANCE.md`. Its **access** analysis held up exactly.
- **The archive's time column is the video clip's start, not the meeting's.** The 2026-08-04 City
  Commission row says 1:17 PM; that meeting's own agenda states an early start of 2:00 PM. Only
  upcoming meetings carry a time.
- **Agendas are HTML.** The parse stage only read PDFs, so every Bozeman agenda would have landed
  `parse_unsupported` with zero items. `services/ingestion/document-text.ts` now dispatches on the
  bytes, and `agenda-items.ts` learned dotted `G.1` markers and rejoins a marker the source put in
  its own element. The 2026-08-04 agenda yields 30 items.

**The robots.txt exception is now in force and is disclosed.** `bozeman.granicus.com/robots.txt`
is `Disallow: /` for this agent. We fetch anyway under the operator decision of 2026-08-04, at the
10-second `Crawl-delay` the file itself publishes, with the project's honest user agent. The
Methodology page carries the disclosure as of the same release, and three tests assert it is there.
**If that disclosure comes down, the adapter must be disabled with it** —
`respectRobotsTxt: true` makes it obey the file and discover nothing, which is the switch.

Enabling Bozeman is the same deliberate act as Gallatin, with one caveat:

```bash
npm run sweep -- --adapter bozeman-granicus --enable --lookback-days 14
```

**Use a short lookback the first time.** At 10 s per document a 365-day sweep runs for hours and
will blow the scheduler's 15-minute `sweepTimeoutMs`, leaving the run `failed` and its jobs queued
for the next tick until it catches up. Agenda packets (28 MB, 439 pages, 724 of them) are **not**
fetched unless `includePackets` is set.

The live host has **not** been swept: `ingestion_sources` rows are created **disabled**, so nothing
sweeps because a container started. Enabling Gallatin in production is a deliberate act:

```bash
npm run sweep -- --list                                    # what exists
npm run sweep -- --adapter gallatin-civicplus --enable     # enable and sweep once, now
```

**The adapter moved.** `agents/meeting-monitor/src/adapters/` is now
`backend/src/services/ingestion/adapters/`, with its contract suite in `backend/test/adapters/` and
its fixtures in `backend/test/fixtures/gallatin/`. `backend/Dockerfile`'s build context is
`./backend`, so a production image cannot contain a file from `agents/` — and the scheduler runs in
the backend. Those 68 contract tests had **never run in CI**; they do now.

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

1. ~~**Nothing ingests.**~~ Closed 2026-08-09 by P1. The scheduler is wired, a real sweep has run, and the pipeline lands meetings, documents, artifacts and agenda items. Remaining: enable the source on the live host, and move the body list out of the adapter into `ingestion_sources.config`.
2. **W3 findings engine and review queue.** The core product. `anomaly_flags.review_state` now exists (B-d) and is the column the queue generalises: records-derived flags are written `held` and the public API filters them out. Generated narrative, mechanical claim-to-citation binding, operator approval before anything naming a person publishes. Not started. Spec exists in the production design.
3. ~~**Bozeman adapter.**~~ Closed 2026-08-09 by P4. `backend/src/services/ingestion/adapters/bozeman-granicus.ts`, registered **disabled**, swept for real (below). `bozemanmt.gov` is still a blanket Akamai deny and is never fetched. Outstanding from the same backlog item: the **public-records-request page**, which is P7 and is not built.
4. **MT CERS campaign finance** (`cers-ext.mt.gov/CampaignTracker`). Not started.
5. **W6 funding network layer.** Specced only — `docs/superpowers/specs/2026-08-04-funding-network-layer-design.md`.
6. ~~**W7 delivery channels.**~~ Built. Channels, routes, encryption, the Discord transport, and — as of B-e — cadence, SMS, and a self-serve subscriber surface on the same substrate. Nothing dispatches product events yet, because nothing ingests.
7. **Launch readiness**: corrections and dispute policy, public data export and licensing, backups with a tested restore, accessibility and shareability. Specced only.
8. ~~**No database backups.**~~ Closed 2026-08-09 by P3. `deploy/backup.sh` takes a nightly
   `pg_dump -Fc` plus a MinIO mirror with 7 daily / 4 weekly retention and emits
   `ops.backup_succeeded` / `ops.backup_failed` through the delivery dispatcher.
   `deploy/restore-drill.sh` **has been executed**: 28 tables compared against the manifest,
   137 rows restored, no losses, 11 objects in the archive. Runbook: `deploy/README.md` §5.
   **Outstanding:** `BACKUP_S3_URI` is unset, so an archive currently never leaves the instance —
   that is a copy, not a backup. Setting it needs a bucket, which costs money and is the operator's
   call. The cron entry also still has to be installed on the host.
9. **No monitoring.** Nothing alerts if the site goes down or ingestion silently stops. P2's
   console makes a stalled scraper *visible to an operator who looks*; it does not page anyone.
10. ~~**No admin authentication.**~~ Closed 2026-08-09 by A1. One operator class, `scrypt` from
    `node:crypto`, revocable server-side sessions in an httpOnly cookie, no public registration.
    The review queue is no longer blocked on it.

## Known defects and debt

- **PRODUCTION IS DOWN as of 2026-08-09.** Deployed sha `1fb246f`. The frontend serves; the
  backend does not — `/api/health`, `/api/version` and `/api/meetings` all return 502. The host,
  the workflow log and ECR are not reachable from this repo, so the cause is not diagnosed here.
  Everything reproducible locally is green: migrations apply 1→33 on a fresh database, the image
  builds, the backend boots with only `DATABASE_URL`, and it uses 115 MB against a 512 MB limit.
  **Nothing has been pushed since**, deliberately — every push triggers a deploy onto the broken
  stack.
- ~~**A crash-looping backend deployed as a success.**~~ Fixed 2026-08-10, and it is why the
  incident above went out green. `docker compose up -d --wait` treats a service with **no
  healthcheck** as ready the instant its process starts; `backend` had none while `web`, `db` and
  `minio` all did, `web` depended on it with `condition: service_started`, and
  `restart: unless-stopped` restarted the dead container forever. The deploy script's
  version-skew check (24/25/26) never ran, because by then the deploy believed it had won.
  `backend` now has a healthcheck on its own `/api/health` — **127.0.0.1, never `localhost`** —
  `web` waits on `service_healthy`, the entrypoint names a migration failure instead of exiting
  silently, and `deploy/test-deploy-aws-ssm.sh` asserts every service in the deployed compose
  file declares a healthcheck. 53 assertions before, **61** now.
- **CI `deploy-aws` unverified.** The SSM round trip has not yet completed once from a runner. See above.
- ~~**Deploy pattern is push-based SSH**~~ — resolved 2026-08-06. No SSH key in CI, no rsync; secrets live in Parameter Store and are fetched by the host. Still push-based; a pull-based rollout watching ECR remains the better end state but is not blocking anything.
- **The instance-role grant for Parameter Store is outstanding**, so deploys run degraded. Not a defect in this repo — it needs whoever administers `your-org/platform-aws`. `deploy/README.md` §3 has the exact policy.
- **Images are tagged `:sha` and `:latest` only.** No `:version` tag: deriving one from `git describe` is unsafe on Gitea's shallow checkouts, where `--always` silently degrades to a bare SHA that looks like a valid answer. Rollback is by explicit pin instead, which works today.
- **Homepage findings section is a placeholder constant** in `HomePage.tsx` with a TODO naming W3. It must not be filled with invented content about a real person.
- ~~**`Layout.tsx` hardcodes "Last sweep 12 min ago."**~~ Fixed 2026-08-09. The masthead reads
  `GET /api/ingestion/status`, which reports the newest `finished_at` of a `succeeded` or
  `partial` run, and says **"No sweep yet"** whenever there is nothing to report — including
  while the request is in flight and when it fails. Seven tests, where there were none.
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

1. **Enable Gallatin on the live host and install the backup cron.** The code for both landed
   2026-08-09; neither is switched on in production. `npm run sweep -- --adapter gallatin-civicplus
   --enable`, then the `17 4 * * *` entry from `deploy/README.md` §5. Set `BACKUP_S3_URI` at the
   same time, or accept that the backup has not left the instance.
2. **Prove CI deploy end to end.** Run `deploy-aws` and watch it succeed, so the manual deployment is no longer the only path that has ever worked.
3. **Move both body lists into `ingestion_sources.config`.** AgendaCenter served three
   categories on 2026-08-09 against twelve in the adapter's hardcoded list. Bozeman has the same
   shape of problem from the other side: its Upcoming Events table names bodies differently from
   its own archive — "Tax Increment Finance Advisory Board" against the panel's "Tax Increment
   Financing Board" — so five upcoming meetings are skipped, loudly, every sweep. Both adapters
   already take a `bodies` option; nothing reads it from the database yet. A city standing up a
   committee should not need a deploy.
4. **W3 findings engine and review queue**, with admin auth. The core product, and the highest-stakes component.
5. ~~**Bozeman Granicus adapter**~~, landed 2026-08-09 and registered disabled. The
   **public-records-request page** that goes with it is still outstanding — it is P7, and the
   vendor-robots exception is written on the promise that the statutory route is offered alongside.
6. ~~**Status page** reading `ingestion_runs`~~ — closed 2026-08-10 by P2 for the *operator*.
   `/admin/sources` reads the runs and marks a source past its expected interval as Suspect. A
   **public** status page is still outstanding.
7. Then W5 correlation, W6 funding network, W7 delivery channels, and the launch-readiness work.

## For future agents

- Read `.claude/skills/commissionwatch-development/SKILL.md` first. It holds the process and the invariants.
- **Probe external sources before designing against them.** Every significant plan change in this project came from a `curl`, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended.
- **Verify by running commands.** Do not report success from an agent's claim or a green pipeline. Both have lied in this project.
- When fanning out, give agents disjoint file ownership and forbid concurrent git writes — a shared index lock corrupts work.
- A check that could not run is `blocked`, never `pass`.
