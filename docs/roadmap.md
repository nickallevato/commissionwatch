# CommissionWatch — Roadmap

> Last updated: 2026-08-16. Statuses in Phases 1–3 were **stale for twelve days** —
> several items reading "Planned" had shipped. Corrected against the tree and against
> production on 2026-08-16. See *Gaps this roadmap does not name*, below.
>
> **Phases 6 and 7 were added later the same day**, from
> [the maturity review](superpowers/specs/2026-08-16-maturity-review.md). That review's finding about
> this document: Phases 1–5 are all *feature* phases, and there was nowhere in it to track
> operations, security, data retention or sustainability — so roughly half of what it found was not
> undone work but **untracked** work.

## Overview

This roadmap outlines the implementation plan for CommissionWatch, an AI-powered civic transparency platform. Work is sequenced in four phases, with each phase building on the prior one.

## Phase 1 — Foundation (MVP)

**Goal:** Ship a working demo with one agent monitoring one jurisdiction.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 1.1 | Repo setup + scaffolding | Public repo, monorepo structure, Docker Compose, CI | Done |
| 1.2 | Public web dashboard (MVP) | React 18 + Vite single-page app — landing page, jurisdiction browser, meeting rundown viewer, agent status overview. Light editorial design, serif headlines, single red accent, mobile-responsive. | Done |
| 1.3 | Core agent orchestrator | Claude Code harness integration, zero-permission security model, explicit tool grants with tests | Done |
| 1.4 | Meeting Monitor Agent | Scrape Bozeman city council agendas/minutes, parse PDF/HTML, generate quick rundown sheets, flag anomalies | Done |
| 1.5 | Data layer setup | PostgreSQL + pgvector schema, MinIO for document storage | Done |
| 1.6 | Docker Compose deployment | Full stack (backend, frontend, db, minio) running via `docker compose up` | Done |
| 1.7 | AWS demo deployment | Single instance on AWS, DNS on Route53, <$20/mo target | Done |

**Dashboard MVP details (1.2):**

> Visual direction is defined by the approved
> [production design spec](superpowers/specs/2026-08-04-commissionwatch-production-design.md).
> That spec supersedes any earlier dark-mode description of this deliverable.

- React 18 + Vite 5 + Tailwind, TypeScript throughout
- Investigative/editorial look: light paper background, serif headlines, sans-serif for data,
  tabular numerals, and a single red accent
- Sourced citation chips on every generated claim
- Landing page with project mission and value proposition
- Jurisdiction browser — select city/county to view commission data
- Meeting rundown sheet viewer — display agent-generated summaries
- Agent status overview — which agents are running, last run time, findings count
- Non-partisan, clean, trustworthy design language
- Mobile-responsive layout
- Starts with mock data; wires up to backend API when available

**Meeting Monitor Agent details (1.4):**
- **Scraper/ingestor:** Fetch agendas and minutes from the Bozeman City Commission website. Handle pagination, session archives, rate limiting.
- **Document parser:** Parse PDF and HTML meeting documents. Extract structured data — date, attendees, agenda items, motions, votes, notable quotes.
- **Quick Rundown Sheet generator:** Auto-generate 1-page structured meeting summaries covering attendance, votes, key items, and notable quotes.
- **Anomaly flagging:** Detect and flag emergency sessions, closed-door votes, last-minute agenda changes, quorum issues.
- **Data model:** PostgreSQL schema for meetings, agenda_items, votes, members, quotes, and flags.
- **Integration tests:** End-to-end tests against real Bozeman commission data validating scraping, parsing, and rundown generation.
- **Data sources:** Bozeman City Commission (primary), Gallatin County Commission (stretch goal).
- **Tools required:** Web scraper (scoped to government sites), PDF parser, database write (meetings tables).
- **Schedule:** After each commission meeting (configurable polling interval).

## Phase 2 — The Money Trail

**Goal:** Connect campaign finance to voting records and surface conflicts of interest.

**Starts when:** Phase 1 ships.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 2.1 | Follow-the-Money Agent | OpenFEC + Montana campaign finance API integration | Partial — OpenFEC live; MT CERS adapter built, registered **disabled** |
| 2.2 | Vote Tracker Agent | Record votes, detect patterns, cross-reference donors | Partial — schema and `vote_events` shipped; **0 votes recorded**, blocked on roster |
| 2.3 | Cross-reference engine | Automated votes ↔ donations correlation | Built — `services/finance/correlation.ts`; no data to correlate yet |
| 2.4 | Money trail visualizations | Interactive graphs showing donor → PAC → candidate → vote → contract flows | Planned |
| 2.5 | Alert system | Email + webhook notifications for flagged items | Built, **shipped dark** behind `EVENT_DRAIN_ENABLED`; email blocked on DNS |

## Phase 3 — Deep Intelligence

**Goal:** Add deep-dive investigation capabilities and expand jurisdiction coverage.

**Starts when:** Phase 2 ships.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 3.1 | Member Profiler Agent | Build and maintain dossiers on commission members | Planned |
| 3.2 | Document Digger Agent | Monitor public records, OCR, entity extraction, anomaly detection | Planned |
| 3.3 | Deep Dive Reports | On-demand investigation reports triggered by pattern detection | Planned |
| 3.4 | Vector search | Semantic search across all ingested documents via pgvector | Done — migration 008 embeddings; full-text live at `/api/search` |
| 3.5 | Jurisdiction expansion | Gallatin County + additional Montana jurisdictions | Partial — Gallatin adapter live and enabled; 0 records collected to date |

## Phase 4 — Scale & Community

**Goal:** Enable community adoption and multi-state expansion.

**Starts when:** Manually promoted from backlog.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 4.1 | Agent SDK | Community-contributed watchdog agent framework | Planned |
| 4.2 | Multi-state expansion | Standardized jurisdiction onboarding for other states | Planned |
| 4.3 | Plugin system | Modular data source connectors | Planned |
| 4.4 | Self-hosting docs | One-click deploy, comprehensive self-hosting guide | Planned |

## Pilot Jurisdiction

**Bozeman, MT (City Council)** and **Gallatin County, MT** are the initial targets. The platform is designed to scale to any of the 90,000+ US local government bodies.

## Phase 5 — Interface

| # | Deliverable | Description | Status |
|---|---|---|---|
| 5.1 | One palette | Point `tailwind.config.ts` colours at the `--cw-*` custom properties, with a guard test, so the palette has one definition instead of two hand-synchronised copies. Worth doing on its own merits. | **Done 2026-08-16** |
| 5.2 | Dark theme — operator console | `/admin/*` first: it is where a person spends hours, and it has a real component library rather than inline class strings. | **Done 2026-08-16** |
| 5.3 | Dark theme — public site | Higher care: prerendered pages, and the light editorial identity is deliberate. Needs an explicit operator decision. | **Done 2026-08-16** — follows `prefers-color-scheme`, no toggle, nothing stored |

**Dark theme (5.1–5.3), added 2026-08-16 at the operator's request.**

> Design of record: [dark theme spec](superpowers/specs/2026-08-16-dark-theme-design.md).

This is **not** reopening the decision that produced the light identity. What the 2026-08-14 roadmap
deleted was *dead config* — `darkMode: "class"` with `<html class="dark">` shipped permanently, so
every `dark:` variant was always on and the shell painted grey before React mounted. That deletion
said a later dark mode would be "a token swap, not a rewrite", and this exercises the option it left
open.

**The premise needs fixing first, which is why 5.1 exists.** Checked 2026-08-16: `index.css` defines
42 `--cw-*` properties and `tailwind.config.ts` defines the same palette again as flat hex literals.
They agree because someone typed the values twice. Swapping the variables under a media query would
restyle the body and leave every `bg-paper` / `text-ink` / `text-accent` class light — worse than no
dark theme at all. **5.1 is a prerequisite, and it is worth shipping even if 5.2 and 5.3 never are.**

Two findings already in hand: a complete dark palette drafted and checked against the production
tokens (the deep red accent `#B03A2E` goes muddy on a dark ground and needs `#E0705E`), and the
observation that severity here is never carried by colour alone — `SeverityMark` uses a numeral and
an `sr-only` span — which removes the usual expensive part of theming a status UI.

## Phase 6 — Operational and security floor

**Added 2026-08-16** from
[the maturity review](superpowers/specs/2026-08-16-maturity-review.md), which assessed this project
against SRE, OWASP ASVS, DORA and TMMi and found that **Phases 1–5 are all feature phases**. Every
piece of operational and security work this project has done lives in `docs/STATUS.md` prose or in
`deploy/README.md`, where it has no status, no owner and no place in a sequence. This phase is that
place.

**Starts:** immediately, in parallel with everything else. Nothing here waits on a feature phase.

**Re-scored 2026-08-16** in
[maturity review 2](superpowers/specs/2026-08-16-maturity-review-2.md), after this phase and Phase 7
were worked. **Six of seven categories now pass**; operational readiness is the one that does not,
on a single item — nothing in this system can tell whether a backup has ever succeeded. That review
verified the header fix, the rate limit, the resource check and the new reader-facing pages against
production, and names five small, unblocked items that should land before the loop stops. Statuses
in the tables below were corrected against the tree on the same pass — four of them were stale.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 6.1 | Off-instance backup, and proof the cron runs | `BACKUP_S3_URI` is unset, so `deploy/backup.sh` writes its archive to the same instance that holds the database and the MinIO objects — a copy, not a backup. The `17 4 * * *` cron entry is also not confirmed installed. Deliverable: a bucket, `BACKUP_S3_URI` set, the cron installed, and a check that fails when the newest off-instance archive is older than its allowance. **`deploy/restore-drill.sh` already exists and has been run** — this is the missing leg, not the whole thing. Needs an operator decision on cost. | **Planned — rank 1** — re-verified 2026-08-16: `BACKUP_S3_URI` is still unset in `deploy/backup.sh` and `deployment.env`; nothing changed here. |
| 6.2 | Dependency and supply-chain hygiene | No dependency scanning exists anywhere in the repo. Measured 2026-08-16: **backend 9 advisories (3 high), frontend 15 (7 high, 1 critical)** — mostly build-time, but including a react-router open redirect shipped in the public SPA, plus `qs` and `body-parser` DoS in the running API. Deliverable: an `npm audit` gate in `.gitea/workflows/deploy.yml` with an explicit, reasoned allow-list; a stated upgrade cadence; and a rotation cadence for secrets (one superseded OpenRouter key is still live in Parameter Store version history). SBOM and image scanning are the stretch half. | **Partially done** — the description undersold what already landed: `.gitea/workflows/deploy.yml`'s `ci-frontend` job runs `npm audit --audit-level=high --omit=dev` and fails the build on it (added in `0b4f0ed`, before this row was last written as fully "Planned"). The **backend** job has no equivalent audit step. No stated upgrade cadence, no secret-rotation cadence, no SBOM or image scanning. |
| 6.3 | Host and resource checks in the external monitor | The monitor checks HTTP, database connectivity, sha agreement, release drift and ingestion staleness. It does not check disk, memory or database size — and on 2026-08-15 the deploy host filled its disk, the release failed, the site stayed up, and nothing alerted. Deliverable: disk, memory and table-growth checks in `external-monitor.ts`, using the same four-state `CheckState` including `blocked`. | **Done** — `c2ce56a`. `/api/health` reports `resources: { disk, memory }` as **coarse states only** (`ok`/`low`/`critical`/`unknown`), never raw capacity, because that endpoint is public and exact free bytes tell an attacker how much to send to fill it. Thresholds 80%/90%, env-overridable. `evaluateResources` in the monitor reuses the existing probe and `CheckOutcome`; an **absent** field reports `blocked`, not `pass` — the exact shape of the 2026-08-15 blindness, and the mutation that proves it reproduces that incident. Measurement honesty documented: disk is the container root, which in *this* deployment is overlayfs on the host volume; memory prefers cgroup v2 and the host-figure fallback is labelled as the host's pressure, not the container's. |
| 6.4 | One owner for security headers, and HSTS on the document | Findings 1 and 2 of `superpowers/specs/2026-08-16-security-review.md`, both re-verified live on 2026-08-16 and both still open. Two layers set conflicting `X-Frame-Options` and `Referrer-Policy`; `GET /` carries no `Strict-Transport-Security`. Deliverable: one nominated owning layer, the others stripped, and a test that asserts the final header set through the real stack. | **Done** — `f1d0ddf`. nginx (`frontend/nginx.conf`) is now the sole owner; Helmet no longer emits the five duplicated headers (`backend/test/security-headers.test.ts`), and `nginx.conf` itself is asserted by `frontend/src/nginx-headers.test.ts`. **Caveat: verified at config and unit level, not end-to-end through the real nginx container** — no test in the tree sends a request through nginx itself and reads the response headers back. |
| 6.5 | An incident record, and the DORA four keys | MTTR cannot be computed today because no incident is recorded with a start and an end — the 2026-08-09 four-hour 502 and the 2026-08-15 disk exhaustion exist only as prose. Deployment frequency and change failure rate *are* computable from the Gitea API and nothing computes them (measured 2026-08-16: **15.7% change failure rate over the last 100 deploys, 48.8% all-time**). Deliverable: an incident log with timestamps and a postmortem template, plus a script that reports the four keys and separates a caught-bad-change failure from a flaky-pipeline failure. | **Done** — `docs/incidents/README.md` (format, DORA measurability table, cancelled-run distortion) and `docs/incidents/TEMPLATE.md`; two incidents backfilled (`docs/incidents/2026-08-09-crash-loop-502.md`, `docs/incidents/2026-08-15-disk-exhaustion.md`). MTTR is still not computable — neither backfilled incident has a complete start→resolution pair, and every genuinely unknown timestamp is recorded as "unknown" rather than estimated. What is now built is the place for the *next* incident to be timestamped when it happens; no script yet reports the four keys automatically. |
| 6.6 | A stated SLO | Nothing in this repository defines what "up" means for this site, so nothing can say whether the four-hour outage was a breach. Deliverable: an availability and freshness objective published where a reader can see it — freshness matters more than uptime for a watchdog, since "denial of collection" is already named as a vulnerability class in `SECURITY.md`. | **Done** — spec at `docs/superpowers/specs/2026-08-16-slo.md`. Targets: 99.0% monthly site availability (measured by the external monitor's health check, not yet aggregated into a rolling percentage), ingestion freshness within 1.5× a source's stated interval 95% of the time (measured via `GET /api/ingestion/sources` and the monitor's own staleness check), and **no publication-latency target** — stated as a deliberate decision, not an omission, until Phase 7.1 gives review throughput a second person. Explicitly states what it does not promise: no on-call, no night paging, no guaranteed dispute response time, no error budget yet. Not yet published where a reader can see it — the spec is the target; a public-facing statement is unbuilt. |
| 6.7 | Backend test coverage measurement | `frontend` has `test:coverage`; `backend` has none, so 2038 tests run against `backend/src` with no idea which modules they never touch. `error-handler.ts` had zero test references until 2026-08-14 and writing tests for it found two real defects; coverage is the instrument that finds the next one. Deliverable: a coverage run and a reported baseline. **Not** a coverage threshold gate — that buys assertion-free tests. | **Done** — `c8032a9`. `backend/package.json` has `test:coverage` using `node --test --experimental-test-coverage`, and `ci-backend` gained the production dependency audit in the same commit. **Verified 2026-08-16 (maturity review 2, H5): the coverage script carries a SECOND hand-typed ~120-file list, and it has already drifted — `test/logger.test.ts`, `test/request-context.test.ts` and `test/admin-errors.test.ts` are in `test` and not in `test:coverage`, so the baseline is blind to 6.8's own code. `event-log-hygiene.test.ts:102` audits the `test` script only.** |
| 6.8 | Structured logging | No `pino`/`winston`/`sentry`/`opentelemetry` in either package; 139 raw `console.*` calls in `backend/src`. Nothing can answer "how many 500s did we serve yesterday, on which route." Deliverable: one structured logger with request ids, and error counts exposed where the monitor can read them. | **Done** — `3eb2ded`. `backend/src/services/logging/logger.ts` emits one structured JSON summary line per request with a request id (`middleware/requestContext.ts`, first in the chain, ahead of CORS and the rate limiter so refused requests are logged too), and `services/logging/error-metrics.ts` counts 5xx by route, read at `GET /api/admin/errors`. **Verified 2026-08-16 (maturity review 2 §1): two halves of the deliverable are not met — the 5xx counts are behind `requireOperator`, so the unauthenticated external monitor cannot read them, and 124 raw `console.*` calls remain in `backend/src` (was 139).** |
| 6.9 | One end-to-end browser test of the review→publish path | No Playwright/Cypress/Puppeteer exists. The paths never exercised by a machine are the highest-stakes ones: operator sign-in → claims review → approve → the claim visible on a public page, and the nginx crawler/prerender split with its `Vary: User-Agent`. Each was verified by hand-curl once and is now protected by nothing. Deliverable: **one** test covering that path, not a suite. | **Done for the API chain, 2026-08-16 — nginx half still open, and split.** The operator sign-in → claims review → approve → public-page half is an API-level chain test, in progress (`backend/test/publish-path.e2e.test.ts`) as of 2026-08-16. The nginx crawler/prerender `Vary: User-Agent` half is **still open**, and **this row's framing of it was wrong — corrected 2026-08-16 by maturity review 2, H6**. It described the split as live-but-untested. It is not live: prerendering is **shipped dark** (`CHANGELOG.md:613`, `docs/STATUS.md:326`/`:346`, `PRERENDER_ENABLED` unset), and a probe of the one published meeting with six user agents — Chrome, Googlebot, curl, `facebookexternalhit`, Twitterbot, Slackbot — returns **byte-identical responses with the same etag to all six**, while `Vary: User-Agent` is emitted unconditionally. That is exactly what `frontend/nginx.conf:388-392` says will happen with the flag off, so nothing here is broken. But it means **this half cannot be meaningfully verified in production until an operator sets the flag** — a production check against a dark feature can only confirm the fall-through. It also means the only published record is currently invisible to search engines and produces no link preview, on a URL `sitemap.xml` advertises. Do not read this row as done until both halves land. |
| 6.10 | Rate limit and cache on the public read surface | `/api/search` and `/api/data` carry a `public, max-age=60` cache-control header (`backend/src/routes/search.ts`), and every public route is rate-limited by `publicRateLimit` (`backend/src/app.ts:137`) — 60/min on the expensive tier (`/api/search`, `/api/data`), 600/min elsewhere. The security review's original finding 3, that `/api/search` was unthrottled, was **my error**: the limiter was already applied globally via `publicRateLimit`, added in `ad83ffa` before the review was written. See the CORRECTED block in `docs/superpowers/specs/2026-08-16-security-review.md` for how the false finding happened (grepped for the wrong symbol, then probed a 60/min ceiling with 12 requests). | **Done** — the operator's number is 60/min on the expensive tier with `max-age=60`, implemented and committed. |

## Phase 7 — Sustainability and stewardship

**Added 2026-08-16.** The maturity review rated this the weakest category in the project — **Level 1
of 5** — and it is the one where *Gaps* §5 below is half-right: it names the risk of an external
source being withdrawn, and not the mirror image, which is this project's own promises.

**Starts:** in parallel. 7.1 is coupled to *Gaps* §1 below — reviewer throughput and reviewer
*count* are the same constraint seen from two ends.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 7.1 | A second reviewer, as a role | `git shortlog -sne --all` returns one human (43 commits) beside the agent identity (431). Every operator-only task in `docs/STATUS.md` — the four open decisions, the backup cron, the key rotation, reading the Montana statute — has exactly one person who can do it, and that person also reviews every claim. Production on 2026-08-16: 215 meetings, **1 published**; 64 claims, **0 approved**; nothing published since 2026-08-11. Making one reviewer twice as fast is a 2× improvement on a resource of size one. Deliverable: a reviewer role distinct from the single operator class, with its own permissions and its own onboarding document. Note this also closes the gap that authorisation *within* an authenticated session has never been tested, because today there is nothing to separate. | **Planned** |
| 7.2 | An API stability and deprecation policy | This project publishes `/api/data`, `/api/data/ocd.json`, `/feed.xml`, `/feed.rss` and an MCP endpoint and invites people to build on them, with **no version prefix, no `Sunset` header support, and no stated stability tier**. The research is already done — the ProPublica Congress API is dead and Open States has been absorbed into commercial Plural (see *Gaps* §5). Deliverable: a published policy naming which endpoints are stable, what notice a withdrawal gets, and that a withdrawal is **announced on the corrections log rather than 404'd**. Decide it now, not at the moment of withdrawal. | **Done** — spec at `docs/superpowers/specs/2026-08-16-api-stability-and-continuity.md`, published on `/data` (`DataLicensePage.tsx`, "API stability" section), tested in `DataLicensePage.test.tsx`. |
| 7.3 | Retention policy — reader PII and internal ledgers | `PrivacyPage.tsx` states plainly that personal information given to the project "has no deletion schedule … indefinitely. That is not a considered retention policy." That honesty is why data governance still passes; it is not a policy. Separately, `record_corrections` holds 14,528 rows in the test database with DELETE forbidden by migration 031, and `export_snapshot_runs`/`export_snapshots` have no policy at all. Deliverable: a retention schedule for subscriber addresses, phone numbers and dispute-filer contact details; a subject-access and deletion path; and a decision on the append-only ledgers **before** something reads them in bounded batches. | **Spec done, nothing implemented yet** — `docs/superpowers/specs/2026-08-16-retention-policy.md`. States plainly: `record_corrections` is never deletable by design (DB-enforced trigger, not an open question); `export_snapshots` deletion is refused per the adopted archive-retention spec; `operator_sessions` had a cleanup method (`sweepExpiredSessions()`) that nothing called — **wired on 2026-08-16 in `52cfd60` (`services/auth/session-sweep.ts`), so this is now built; the retention spec and `PrivacyPage.tsx` both still say it is not, and must be corrected (maturity review 2, H2)**; subscriber channels are disable-only by design, never deleted; dispute contacts have no deletion path today beyond a manual written request. Three concrete gaps named for future work — wiring the session sweep, redacting decided-dispute contacts on request, time-boxing unsubscribed channel destinations — none built. **Not yet reflected on `PrivacyPage.tsx` itself**, which still says "no deletion schedule yet." |
| 7.4 | A funding and continuity statement | `SECURITY.md` says "volunteer watchdog project with no bounty programme"; nothing states who pays for the host, the domain, the model tokens, or the S3 bucket 6.1 needs — and cost is the stated blocker on 6.1, which makes a funding gap into an availability gap. Deliverable: a published statement of what running this costs, who pays, and what happens to the published record if it stops. The two cautionary tales this project already researched are both organisations that could not keep a public data service alive. | **Done** — spec at `docs/superpowers/specs/2026-08-16-api-stability-and-continuity.md`, published on `/data` (`DataLicensePage.tsx`, "Who runs this, and what happens if it stops" section), tested in `DataLicensePage.test.tsx`. States bus factor one plainly. |
| 7.5 | An accessibility statement, and a language-access decision | WCAG 2.2 AA is a stated conformance target with computed contrast ratios — in a design spec no reader will ever open. Deliverable: an `/accessibility` page saying what is claimed, what is known non-conforming, and how to report a barrier; plus keyboard and screen-reader testing of the operator console, which 6.x's `axe-core` sweep cannot cover and which the reviewer-throughput work depends on. Record a language-access position at the same time — English-only is defensible for Bozeman and Gallatin and has never been written down, and Phase 4.2 will meet a jurisdiction that has a legal one. | **Partially done** — `6db1d09` shipped `/accessibility` (`AccessibilityPage.tsx`, wired in `App.tsx`), stating the WCAG 2.2 AA target, what `src/a11y.test.tsx`'s axe-core sweep actually covers, how to report a barrier, and the English-only language-access decision. **Superseded 2026-08-16 by `5a70645`** — `a11y.test.tsx` now sweeps four console screens (dashboard, sources, finding queue, claim queue) mounted through the real console chrome with a signed-in session, **and** asserts Approve, Reject and the subject collapse toggle are reachable and operable by keyboard alone with no mouse event fired. It found three heading-order violations (`h3` under `h1`) on first run, all fixed. `AccessibilityPage.tsx` was updated in the same commit and describes the coverage accurately. Screen-reader testing remains undone; this row is otherwise **Done**. |

### What Phase 6 and 7 deliberately do **not** contain

Refusals and scope decisions, listed so they are not re-filed as gaps: audio recordings and
transcription (reaching the media requires fingerprint spoofing — probed, refused, with a test
asserting the media hosts never enter `allowedOrigins`); weakening the human review gate; on-call
paging for a team of one; a bug bounty; a WAF or managed anti-bot layer; `.github/workflows`; an SSH
deploy path; a Redis queue; adopting a local-meeting data standard (there is not one); a Legistar
adapter; and internationalisation as a *feature*, as opposed to 7.5's decision to record.

### Stale in `docs/STATUS.md`, corrected here

`docs/STATUS.md` §2411 still lists installing the external monitor's cron as an outstanding operator
task. **It is installed and firing** — verified 2026-08-16 against the Gitea Actions API: monitor
runs land on a 15-minute tick at :00/:15/:30/:45, with 580 successful runs to date.

### 6. Dead code that nothing imports, found by the coverage baseline

`backend/src/services/vote-events.ts` is a real service module. **Nothing under `backend/src`
imports it and no test loads it** — found on 2026-08-16 by 6.7's coverage run, which reports it among
twelve `src` files never loaded by any test. Ten of the twelve are CLI scripts and the entrypoint,
which is expected; this one is not.

Two things follow, and the second is the sharper one.

It is the third instance of this shape in a week: two feature flags in 0.5.0 that controlled nothing,
`sweepExpiredSessions()` defined and never called, and now a whole module. **The repository is good at
adding a thing and poor at noticing when nothing reaches it**, and each instance has been found by
accident rather than by a check.

And it exports `VOTE_OPTIONS` — a **third** hand-maintained copy of the `vote_value` vocabulary,
beside the Postgres enum and the frontend's `VOTE_ORDER`. The drift guard added on 2026-08-16 asserts
`pg_enum` against the frontend and does not know this copy exists, **so that guard is narrower than
its name suggests.** A guard that covers two of three copies while reading as though it covers the
vocabulary is worse than one that covers none, because it is trusted.

Deliverable: decide whether `vote-events.ts` is deleted or wired, extend the drift guard to every
copy of the vocabulary it claims to protect, and consider whether "exported but never imported" is
worth a repository-wide check of its own — three findings in a week is a pattern, not a coincidence.

## Gaps this roadmap does not name

Added 2026-08-16. Everything above describes **building capability**. The platform's actual
constraint is no longer capability, and no phase above addresses it.

### 1. Review throughput is the binding constraint, and nothing plans for it

Measured in production on 2026-08-16:

| | |
|---|---:|
| Meetings ingested | 212 |
| Meetings published | **1** |
| Agenda items ingested | 3,160 |
| Agenda items public | **36** |
| Claims extracted | 64 |
| Claims approved | **0** |
| Median days to publish | **28** |

Every one of those gaps is the review gate working as designed — and the gate is a **person**. The
pipeline can ingest faster than anyone can review, so building more ingestion widens the gap rather
than closing it. **Phases 2 and 3 add capability behind a bottleneck that is already saturated.**

This is not an argument for weakening the gate; the gate is the project. It is an argument that the
next real deliverable is *making a reviewer faster* — batching, grouping by subject, keyboard
review, and the governor pass actually being run so a person judges pre-sorted claims instead of raw
ones. None of that is on this roadmap.

### 2. The roster blocks more than it looks like it does

`members` holds seed fixtures. No sourced roster could be found (Bozeman is a blanket Akamai 403,
Granicus publishes no member list, minutes carry no roll call). Consequences the roadmap does not
connect:

- **2.2 Vote Tracker cannot complete** — `member_id` is never populated, so a vote cannot be attached
  to a person.
- **2.3 Cross-reference has nothing to cross-reference** — the code exists and is idle.
- The office gate rejects 283 of 336 extractions, and **a sourced roster would not unlock them**: it
  makes "Commissioner Bode" checkable, not "Dave".

Sourcing a roster is a prerequisite for a whole phase and is filed nowhere as such.

### 3. Delivery is built and cannot deliver

Channels, routes, encryption, Discord, RSS and the record receipt all exist and are dark. Email is
**blocked on DNS**, which is an infrastructure task with no owner and no line item.

### 4. Operator decisions with no due date

Four are open and each blocks something: whether `claim_publication` returns and how; whether a body
whose minutes print no offices should be extracted; whether `dated_export_archive` is switched on
(off, so the archive holds nothing); and the `/api/search` rate limit. They are specced. They are not
scheduled.

### 5. Sustainability is unplanned

Two cautionary precedents found while surveying the field: the ProPublica Congress API is dead, and
Open States has been absorbed into commercial Plural and is deprecating public tooling. This project
publishes an open-data export, feeds and an MCP endpoint and invites people to build on them. **There
is no stated policy for what happens if one is withdrawn** — the recommendation is that it be
announced on the corrections log rather than 404'd, decided now rather than at the moment of
withdrawal.

### What I would put next, if the goal is a site that moves

1. **Reviewer throughput** — grouping, batching, running the governor. Turns 64 claims from a wall
   into five decisions.
2. **Probe for a roster**, as its own piece of work, because a phase depends on it.
3. **Schedule the four operator decisions**, even if the answer to some is "not yet".
4. **Then** return to Phases 2 and 3.

**Revised 2026-08-16 by the maturity review.** Two items belong ahead of all four, because they are
about not losing what already exists rather than about making it move:

0. **6.1 — get a backup off the instance.** The database, the object store and every backup archive
   are on one host. The restore drill has been run; the copy has never left. This is the only
   finding in the maturity review whose failure mode is unrecoverable.
0b. **6.2 — start scanning dependencies.** 24 live advisories, found by running `npm audit` for the
   first time, including a react-router open redirect in the shipped SPA. The finding is not the 24;
   it is that nobody would have known.

And one correction to item 1: the constraint is not only reviewer *speed*, it is reviewer *count*.
See **7.1**.

## Design Principles

- **Non-partisan** — facts over politics, sunlight as disinfectant
- **Citizen-first** — built for people watching government, not sold to government
- **Open source** — MIT licensed, self-hostable, transparent
- **Agent-powered** — proactive monitoring, not passive dashboards
- **Privacy-respecting** — only processes publicly available data
