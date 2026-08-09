# Archive salvage — porting `archive/archived-91-commits` into the deployed lineage

> Date: 2026-08-09
> Status: approved — Tier A and Tier B resolved 2026-08-09; Tier C specced when scheduled
> Target branch: `origin/main` (the deployed lineage, sha `30d1b49`)
> Source branch: `origin/archive/archived-91-commits` (90 commits, never deployed)

## Context

`origin/main` was force-pushed onto a lineage that shares no recent ancestry with the
90-commit local `main`, now archived remotely. The live site serves `origin/main` — verified
by `/api/version` and `/version.json` both reporting sha `30d1b49`. The archive has never
been deployed.

The two are not versions of each other. The archive is an agent-platform build with
authentication, an approvals scaffold and four domain agents but **no working source
adapter**. The deployed lineage has a real Gallatin CivicPlus adapter, an ingestion queue,
content-addressed artifacts and a working SSM deploy, but **no authentication of any kind**.

This document decides, feature by feature, what crosses over and in what shape.

## The deciding measurement

Every archive domain service imports from `backend/src/orchestration/`. Counting call sites
to `acquireLock`, `releaseLock`, `createTask`, `updateTaskStatus`, `HeartbeatExecutor`,
`getAgentByName`, `eventBus`, `setMemory` and `getMemory` produces a bimodal distribution:

| Service | Orchestration call sites |
|---|---|
| `follow-the-money` | 33 |
| `member-profiler` | 29 |
| `vote-tracker` | 26 |
| `alert-briefing` | 26 |
| — porting cliff — | |
| `document-digger` | 6 |
| `execution-policy` | 6 |
| `approval` | 4 |
| `openfec-client` | 3 |
| `budget-tracker` | 3 |

Below the cliff the coupling is incidental: orchestration is being used as a key-value cache
or to emit an event nobody consumes. Those services can be lifted with a small adapter.

Above the cliff the framework *is* the control flow. Porting those four means porting the
orchestration platform — seven modules, three migrations, an agent registry and a heartbeat
executor — into a product that has one operator and a cron. **They are rebuilt, not ported.**

This is the single organising decision of this document.

## Probes — grounding before design

Per the project's development skill: never write a spec that assumes an endpoint exists.

**OpenFEC — `api.open.fec.gov/v1`, probed 2026-08-09. Reachable, and the archive's constants
are correct.**

```
GET /v1/candidates/?api_key=DEMO_KEY&per_page=1
→ HTTP/2 200, 744 bytes, 54,295 candidates reported
   cache-control: public, max-age=3600
   x-ratelimit-limit: 10
   x-ratelimit-remaining: 9
   via: api-umbrella
```

Three things this settles:

- The API is live and the response shape matches the archive's `OpenFecResponse<T>` types —
  `api_version`, `pagination { count, page, pages, per_page }`, `results[]`. No retyping needed.
- The archive's `DEFAULT_MIN_INTERVAL_MS = 3_600` corresponds to 1,000 requests/hour, the
  registered-key allowance. **It was written for a registered key and is correct.**
- `x-ratelimit-limit: 10` is the *unregistered* `DEMO_KEY` ceiling. Tests must therefore run
  against recorded fixtures, never `DEMO_KEY` — a suite that passes on a developer machine
  would rate-limit in CI. A registered key goes in Parameter Store as
  `/commissionwatch/openfec-api-key`.
- The API declares `max-age=3600`, so the archive's 6-hour cache TTL is conservative rather
  than stale. Keep it.

**Not probed, and deliberately not designed against yet:** MT CERS. It is named in the roadmap
but no Tier A or B item touches it, so no assumption about it appears in this document.

## Tier A — port now

Four items. Each is well-bounded, has no dependency on the orchestration framework once a
small shim is written, and closes a gap the deployed lineage actually has.

### A1 · Operator authentication

**Archive source:** `backend/migrations/015_create_users.ts`, `backend/src/routes/auth.ts`,
`backend/src/middleware/auth.ts`, `frontend/src/contexts/AuthContext.tsx`,
`frontend/src/components/ProtectedRoute.tsx`, `frontend/src/pages/LoginPage.tsx`.

**What changes.** The archive models public membership: a `users` table with a
`user_role` enum of `admin | user | viewer`, a JWT in local storage, and a public
`RegisterPage`. This product has one operator and no members. A watchdog site with an open
sign-up form is a liability, and a JWT in local storage is readable by any script that lands
on the page.

**Redesign:**

- Table renamed `operators`. Columns: `id uuid pk`, `email citext not null unique`,
  `password_hash text not null`, `name text not null`, `role operator_role not null default
  'operator'`, `last_login_at timestamptz null`, `failed_attempts int not null default 0`,
  `locked_until timestamptz null`, timestamps.
- `operator_role` enum is created with a single value `operator`. The column exists so a
  second role is an `ALTER TYPE ... ADD VALUE`, not a migration that rewrites every row.
- **argon2id**, not bcrypt. The archive used bcrypt; argon2id is the current default.
- **httpOnly, Secure, SameSite=Lax session cookie** backed by a `sessions` table, not a JWT.
  A server-side session can be revoked; a JWT cannot. Sliding expiry, 12 hours idle,
  7 days absolute.
- **No registration route.** The first operator is seeded from SSM Parameter Store at
  `/commissionwatch/operator-seed`, consumed once at boot and only when the `operators`
  table is empty. Subsequent operators are created by an existing operator.
- Rate limit: 5 failed attempts locks the account for 15 minutes, recorded on the row.
  Every attempt is logged with source IP.
- `ProtectedRoute` and `AuthContext` port with the storage layer swapped from local storage
  to a `/api/admin/session` probe, since an httpOnly cookie is unreadable from JS.
- **Discard** `RegisterPage.tsx` entirely.

**SSO placeholder.** `LoginPage` renders Google and GitHub buttons in a disabled state with
a "Soon" tag, per operator decision 2026-08-09. They are inert markup — no OIDC dependency
is added. Tracked as B1.

**Routes:** `POST /api/admin/session` (sign in), `DELETE /api/admin/session` (sign out),
`GET /api/admin/session` (who am I). All other `/api/admin/*` routes require a valid session
and return 401 without one.

**Acceptance:**
- A request to any `/api/admin/*` route without a session cookie returns 401, never 200.
- Six consecutive wrong passwords produce a locked account, and the sixth response is
  indistinguishable in timing from the first.
- The seed runs exactly once; a second boot with a non-empty `operators` table is a no-op.
- Signing out invalidates the session server-side — replaying the cookie returns 401.

### A2 · OpenFEC client

**Archive source:** `backend/src/services/openfec-client.ts` (8.1 KB, 3 orchestration call
sites).

**What it is.** A typed client for `api.open.fec.gov/v1` covering contributions and
expenditures, with pagination, a minimum request interval of 3.6 s (the published rate
limit), and response caching keyed by a hash of the query.

**What changes.** The three orchestration call sites are `getMemory` / `setMemory` used
purely as a TTL cache. Replace with a dedicated table rather than reaching for the agent
memory subsystem:

```
http_cache ( cache_key text pk, payload jsonb not null,
             fetched_at timestamptz not null, expires_at timestamptz not null )
```

`cache_key` stays the existing SHA-256 of the normalised query string, so the caching logic
is unchanged — only the store swaps. Add an index on `expires_at` and a sweep that deletes
expired rows on each run.

Nothing else in the file changes. It has no other archive dependency.

**Why now, before the feature that uses it.** It is the only piece of external-data
plumbing in either lineage that is already written, rate-limit-correct and typed. Landing it
standalone means the money-tracking work later is domain logic against a client that already
works, rather than both at once.

**Acceptance:**
- Two identical queries inside the TTL produce exactly one outbound request.
- Requests are spaced at least 3.6 s apart under concurrency.
- An expired row is not served, and is deleted on the next sweep.
- The client is exercised against recorded fixtures; no test hits the live API.

### A3 · Embedding client — WITHDRAWN 2026-08-09

**Originally specified as a port.** Withdrawn before implementation after two findings, one
external and one internal. Recorded rather than deleted, because the reasoning is what makes
the eventual decision cheap.

**Finding 1 — the operator has no OpenAI account, and OpenRouter cannot substitute.** The
archive's client is OpenAI-specific: `text-embedding-3-small`, `OPENAI_API_KEY`, posting to
`api.openai.com/v1/embeddings`. OpenRouter was probed as an alternative on 2026-08-09:

```
GET  /api/v1/models     → 200; 400 models, zero with "embed" in id or name
POST /api/v1/embeddings → 401 {"error":{"message":"No cookie auth credentials found"}}
```

That 401 is a *cookie* auth error — the request reached a web route, not an API endpoint.
**OpenRouter proxies chat completions and does not offer embeddings.**

**Finding 2 — the decisive one — nothing consumes embeddings.** Verified on `origin/main`:

- `backend/src/services/embeddings.ts` is imported by **zero** files.
- The only reference to `document_embeddings` outside migrations is that file's own `insert`.
- `backend/.env.example` contains no embedding-related key.

The subsystem is unreachable code on the deployed lineage. Porting a client for it would add a
vendor dependency, a paid account and a Parameter Store secret in exchange for **no
user-visible capability**. The right amount of work here is none.

**Consequence for the schema.** Migration 008 hardcodes `vector(1536)`, which is
`text-embedding-3-small`'s dimension. pgvector columns cannot be dimension-agnostic — a
provider must be chosen before the column can be. Changing it is free at zero rows and
expensive once a corpus is embedded, so **the dimension decision belongs to whichever feature
first needs semantic search**, taken together with the provider choice rather than ahead of it.

**When this returns**, the options not requiring an OpenAI account are: Voyage AI (Anthropic's
recommended embedding partner, 1024 dimensions), Cohere embed v3 (1024), Gemini embedding
(768 or 3072), or a self-hosted model such as `bge-base` (768) — viable here because the stack
already runs Docker, and it removes both the per-call cost and the vendor.

**Tier A is therefore three items: A4, A2, A1.**

### A4 · `vote_donor_conflict` anomaly type

**Archive source:** `backend/migrations/028_add_vote_conflict_anomaly_flag.ts`.

`origin/main`'s `anomaly_flag_type` enum has six values: `emergency_session`,
`closed_door_vote`, `last_minute_agenda_change`, `quorum_issue`,
`unanimous_controversial`, `missing_minutes`. None can express "this official voted on a
matter involving a donor."

One `ALTER TYPE anomaly_flag_type ADD VALUE 'vote_donor_conflict'`. It is a prerequisite for
any money-to-vote correlation and costs nothing to land early.

**Note for the implementer:** `ALTER TYPE ... ADD VALUE` cannot run inside a transaction
block in PostgreSQL before 12, and Knex wraps migrations in transactions by default. Set
`config.transaction = false` on this migration.

**Acceptance:** the enum has seven values; existing rows are untouched; `down` is documented
as irreversible, since PostgreSQL cannot drop an enum value.

## Tier B — resolved 2026-08-09

| # | Feature | Decision |
|---|---|---|
| B-a | Review queue | **Paused.** Confirmed by operator. Resumes once records exist to review. |
| B-b | Execution policies | **Collapsed.** Not ported as a subsystem. See B-b below. |
| B-c | Budget tracking | **Deferred to the first AI feature.** Nothing to meter until then. |
| B-d | FOIA document digger | **Build.** Rebuilt against `artifacts`. See B-d below. |
| B-e | Subscriptions and delivery | **Build.** Scope widened to multi-channel. See B-e below. |

### B-b · Execution policies — collapsed, not ported

**What it was for.** The archive let you define, per detection type and severity, an ordered
list of stages a finding must clear before it publishes — some `auto` (a detector re-runs and
confirms), some `manual` (a human with a required role signs off). `execution_policy_runs`
tracked which stage each finding had reached. It is a configurable approval workflow engine,
the kind of thing an organisation with several reviewers and a compliance obligation needs.

**Why it is not being ported.** This project has one operator. Every `manual` stage resolves
to the same person, and every configurable route through the graph resolves to the same path.
The engine's entire value is expressing *variation* in who approves what — variation that does
not exist here. Two tables, a JSONB stage validator, a run-state machine and a management page,
to encode a rule that fits in a sentence.

**What replaces it.** A single severity threshold on the review queue, stored as one
configuration row: findings at or above the threshold wait for the operator; below it they
publish. That is a column and a comparison, not a subsystem.

**When to revisit.** If a second reviewer with a distinct role ever exists, or a jurisdiction
requires a documented multi-step sign-off. Then the archive's schema is a good starting point
and this section is the record of why it was not adopted sooner.

### B-d · FOIA document digger — rebuild against `artifacts`

**What changes.** The archive's `document-digger.ts` predates the `artifacts` table, so it
carried its own notion of document storage. `origin/main`'s `artifacts` is content-addressed —
`sha256` is `UNIQUE`, with a format CHECK — and its migration comment already anticipates this
use: *"NULL for documents obtained by hand or public-records request: those flow through the
identical pipeline as automatically fetched ones."* The table was designed for this.

**Design:**

- A public-records document is uploaded by the operator, hashed, stored in MinIO, and written
  as an `artifacts` row with `source_url` NULL. **Identical downstream path to a scraped PDF** —
  same parse, same extraction, same anomaly detection, same provenance display.
- Re-uploading the same bytes collides on `sha256` and is never reprocessed. Free deduplication.
- Entity extraction (people, organisations, amounts, dates) and the three flag types from the
  archive — `no_bid_contract`, `budget_spike`, `fast_tracked_permit` — are added to the
  `anomaly_flag_type` enum in the same style as A4, with `transaction = false`.
- Migration 027's bespoke FOIA tables are **not** ported. A `records_requests` table tracks the
  request lifecycle only — jurisdiction, subject, submitted date, status, response date — and
  references `artifacts` for anything received.
- Admin surface: upload, attach to a request, view extraction with per-field confidence,
  correct a bad extraction. The correction path is the append-only one specified for the record
  inspector.

**Invariant.** Extracted entities naming a person do not auto-publish. They raise a flag that
holds for review (B-a), exactly as scraped findings do. The upload route is operator-only.

### B-e · Subscriptions and delivery — extends W7, does not replace it

**This section amends `2026-08-04-delivery-channels-design.md` (W7, approved).** Read that
document first; only the deltas are specified here. Several things this section originally
proposed turned out to be already designed there, and are cited rather than restated:

| Already specified in W7 or launch-readiness | Do not re-derive |
|---|---|
| AES-256-GCM `config_encrypted`, key from `CHANNEL_SECRET_KEY` | W7 § Data model |
| API never returns a webhook URL; reads are masked to host + last four | W7 § Security |
| SSRF defence: allowlist for Discord, private/loopback/link-local rejection for generic webhooks | W7 § Security |
| Admin channel routes require the authenticated session; unmounted until it lands | W7 § Security |
| `alert_subscriptions.verify_token` and `.unsubscribe_token` classified as credentials | launch-readiness § data handling |

**What W7 left undone.** It designed the operator's outbound plumbing. It did not connect that
plumbing to readers. `origin/main` therefore ships `alert_subscriptions`, `notifications` and a
digest scheduler that `/api/health` reports **running right now, delivering to nobody**, beside
a dispatcher that no subscriber can reach. Two implementations of one idea.

**The unification.** Make the delivery layer the single substrate and express a subscription in
its terms:

> A subscription is a **destination** (email, webhook, SMS, Discord) plus a **filter**
> (jurisdiction, event type, minimum severity) plus a **cadence** (immediate, daily, weekly).

**Deltas to W7:**

1. Add `cadence` to `channel_routes` — `immediate | daily | weekly`, default `immediate`.
   W7's routes are implicitly immediate; this is the column that lets the existing digest
   scheduler drive the others instead of running as a parallel system.
2. Add `owner_kind` to `delivery_channels` — `operator | subscriber`. An operator's Discord
   webhook and a reader's email address can share a table but must not share a permission
   model. Every admin route filters to `operator`; every self-serve route to `subscriber`,
   scoped to the token holder.
3. Migrate `alert_subscriptions` onto the unified model. **Per W7's standing constraint the
   existing email path keeps working throughout and its tests stay green at every commit** —
   the old table is retained read-only for one release, then dropped in a separate change.
4. Public self-serve UI, redesigned from the archive's `SubscriptionsPage` into the deployed
   design system. Operator UI in the admin console for `owner_kind = 'operator'`.

**SMS — an explicit reversal, recorded as such.** W7 § Out of scope reads: *"Slack, Teams, SMS.
The channel abstraction makes them small later; building them now is speculation."* That
judgement was correct when written. The operator asked for SMS by name on 2026-08-09, so it is
no longer speculation, and this document supersedes that line for SMS only — Slack and Teams
remain out of scope.

Implementation: extend the `channel_type` CHECK with `sms`; add a Twilio client behind the same
interface the dispatcher already consumes. SMS differs from every existing channel in two ways
that need design, not just a client:

- **It costs money per message.** An SMS route carries a per-day cap, enforced in the
  dispatcher, and exceeding it degrades to queued-for-digest rather than dropping silently.
- **Consent is regulated.** Phone numbers require confirmed opt-in before first send and
  `STOP` must unsubscribe, handled inbound. This is a stricter bar than email, not the same
  one; it is why SMS ships after the email path is proven, never alongside it.

**Invariant.** The archive's `SubscriptionsPage` read channel config back to populate its edit
form. Under W7's masking rule that is not possible and not permitted — the form shows a masked
value and accepts a replacement.

## Tier C — rebuild, do not port

`vote-tracker`, `member-profiler`, `follow-the-money` and `alert-briefing` carry 26–33
orchestration call sites each. The domain logic in them is real and worth having: donor-to-vote
correlation, voting-pattern profiles, contribution ingestion, digest synthesis.

**The logic is the specification; the code is not the implementation.** Each should be
rewritten as a plain service that the ingestion worker invokes after a successful run,
using the existing `SKIP LOCKED` queue for concurrency instead of `acquireLock`, and
`ingestion_runs` for observability instead of `createTask` plus a heartbeat.

Estimated result: the same behaviour in roughly a third of the code, with no framework.

Each gets its own spec when it is scheduled. None is queued by this document.

## Tier D — discard

| Artefact | Reason |
|---|---|
| `backend/src/orchestration/*` (7 modules, migrations 020–023) | An agent platform — registry, task lifecycle, checkout, heartbeat, event bus, skills, memory — for a product with one operator and a cron. The existing `SKIP LOCKED` queue already does the job. |
| `pipeline_runs` (migration 016) | Superseded by `ingestion_runs` / `ingestion_jobs`, which are strictly better: per-source, CHECK-constrained, and carrying a `partial` status so a half-failed sweep cannot report success. |
| `HubPage.tsx`, `lib/hub-stubs.ts` | Populated with real-estate transaction content — inspection contingencies, a lender appraisal, an agent named "Domus". A different product's material inside the civic app. |
| `RegisterPage.tsx` | No public sign-up, by policy. |
| Archive `Layout.tsx`, `LandingPage.tsx`, `DashboardPage.tsx` | Conflict with the shipped newspaper-of-record design system. The deployed versions are the design of record. |
| `anomalyDetection.ts` | The archive carries two rival anomaly detectors, `anomaly-detection.ts` and `anomalyDetection.ts`, differing in both implementation and dependencies. Only the hyphenated one is considered; the ambiguity is not carried across. |

## Sequencing

**Tier A** — A4 first: a one-line enum change that everything touching money-to-vote
correlation depends on. Then A2, standalone, landing the hardest-to-verify piece (rate
limiting) while it is cheap to test. A1 last — largest, spans backend and frontend, and nothing
else in Tier A needs it. A3 is withdrawn; see its section.

**Then B-e, then B-d.** Both depend on A1: B-d's upload route is operator-only, and B-e's
operator channel management lives in the admin console. B-e precedes B-d because it is mostly
wiring an existing, tested delivery layer to an interface, whereas B-d adds extraction logic
and new flag types. Shipping B-e first also makes B-d's output deliverable the day it exists.

```
A4 ──▶ A2 ──▶ A1 ──┬──▶ B-e (subscriptions + delivery)
                   └──▶ B-d (FOIA / records requests)
```

Held: B-a (review queue) until records exist. B-c (budget tracking) until the first AI feature.
Tier C rebuilds are specced individually when scheduled.

### A note on what "done" means here

The operator's stated acceptance criterion is that the end state equals **what is live today
plus the archive's features, whether ported or rebuilt.** Tier D is the explicit exception list:
those artefacts are not features, they are scaffolding, duplicates, or another product's
content. Every Tier D entry names why it is not a loss. If a Tier D item turns out to carry
behaviour someone wanted, that is a spec defect and this document should be corrected rather
than the item quietly reinstated.

## Invariants this work must not break

Carried from `CLAUDE.md` and `.claude/skills/commissionwatch-development/SKILL.md`:

- No unsourced claim reaches the public site.
- Nothing naming a person auto-publishes.
- Seed data never names a real person, and seeds never run in production.
- Never silence a type error; never delete a test to go green.
- The database schema is the source of truth for types.
- CI is Gitea Actions only.

## Open dependency

This document targets `origin/main`. Operator approved the code path 2026-08-09 — the end
state is what is live plus the archive's features — but the automated
`git reset --hard origin/main` was refused by the tooling's permission layer and must be run
by the operator:

```
git reset --hard origin/main && git branch --set-upstream-to=origin/main main
```

The 90 archived commits remain on `origin/archive/archived-91-commits` at `16dfac7`.
The staged workflow edits, both `.dockerignore` files and the loose bundle are backed up
outside the repository. This blocks implementation, not design.
