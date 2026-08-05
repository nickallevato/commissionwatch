# CommissionWatch — Production Design

> Status: approved 2026-08-04
> Supersedes the frontend and backend claims in `docs/spec/architecture.md`, which describe a Next.js + FastAPI stack that was never built.

## Goal

Take CommissionWatch from a partially-built repo with a red build to a public, professionally designed, continuously-updating civic transparency site at **commissionwatch.bmux.sh**, covering Bozeman City Commission, Gallatin County, and Montana campaign finance.

## Current state (verified 2026-08-04)

### The build is broken

`main` does not compile on either side. These are merge artifacts — parallel feature branches were merged without a CI gate that could block them.

| Location | Problem |
|---|---|
| `frontend/src/mocks/data.ts` | `members`, `votes`, `anomalyFlags` each declared twice; several literals don't match their types |
| `frontend/src/components/Layout.tsx` | `UsersIcon` and `AlertIcon` each defined twice; unused `CheckCircleIcon` |
| `frontend/src/pages/VotesPage.tsx` | Uses a `vote` field and `"yes"`/`"no"` values absent from the `Vote` type |
| `backend/src/routes/anomalies.ts` | References undefined `created` and `detectAnomalies` — a live 500 on a served route |
| `backend/test/votes.test.ts` | References undefined fixture constants |
| `backend/src/services/` | Two rival implementations: `anomaly-detection.ts` and `anomalyDetection.ts` |

Frontend: 30 type errors. Backend: 4.

### The data sources

| Source | Reality | Difficulty |
|---|---|---|
| **Bozeman City Commission** | `bozeman.net` now redirects to `bozemanmt.gov`. Every request — including `/robots.txt` — returns `403 Access Denied` from Akamai (`errors.edgesuite.net`). The scraper's hardcoded `baseUrl` is stale and its selectors are unvalidated guesses. | Hard — edge-blocked |
| **Gallatin County** | CivicPlus + eSCRIBE. Standard **AgendaCenter** at `/agendacenter` with predictable URLs. `robots.txt` disallows only admin paths. | Easy |
| **Montana campaign finance** | COPP publishes through **CERS** (`cers-ext.mt.gov/CampaignTracker`) plus a Tableau dashboard at `campaignreport.mt.gov`. Structured system, not PDF scraping. | Medium |

**Consequence:** the designated pilot jurisdiction is the hardest to ingest. Gallatin ships first; Bozeman is de-risked by a spike and does not gate anything.

### What already works

14 migrations, an Express API with routes for meetings/members/votes/anomalies/subscriptions/notifications, a Playwright scraper skeleton, PDF/HTML parsers, a six-detector anomaly engine, a rundown generator, MinIO storage, pgvector embeddings, and a React/Vite frontend with pages and tests. The bones are real; the joins are broken.

## Design decisions

| Question | Decision |
|---|---|
| Visual direction | **Investigative/editorial** — light paper, serif headlines, one red accent, sourced citation chips |
| Homepage | **Front page** — lead finding plus the latest meeting's real votes in the main column; live flags and upcoming meetings in the rail |
| Publication gate | **Human review queue.** No generated narrative naming a person publishes without operator approval |
| Launch data scope | Bozeman + Gallatin + Montana campaign finance, sequenced across three launches |
| Hosting | Existing AWS/Caddy/Docker infrastructure, retargeted to `commissionwatch.bmux.sh` |
| Frontend stack | React 19 + Vite (keep). Docs claiming Next.js are wrong and get corrected |
| Backend stack | Node + Express + TypeScript (keep). Docs claiming FastAPI are wrong and get corrected |
| Queue | Postgres `SKIP LOCKED`. No Redis |
| `legacy-platform` | Removed from the repo entirely |

## Architecture

### Source adapters

Ingestion today is a Bozeman-shaped function. It becomes an interface:

```ts
interface SourceAdapter {
  key: string;                                        // 'gallatin-civicplus'
  describeSource(): SourceDescriptor;                 // jurisdiction, bodies, base URLs, politeness
  discoverMeetings(since: Date): Promise<MeetingRef[]>;
  fetchDocument(ref: DocumentRef): Promise<FetchedArtifact>;
}
```

One module per source: `gallatin-civicplus`, `bozeman-akamai`, `mt-cers`. Adding a jurisdiction never touches core code, and every adapter is contract-tested against captured fixtures.

### Ingestion queue and run tracking

A durable Postgres-backed job system. At tens of documents a day, Redis would be infrastructure for its own sake.

- `ingestion_sources` — jurisdiction, adapter key, config, enabled, health status
- `ingestion_runs` — one row per sweep: started, finished, status, counts, error
- `ingestion_jobs` — stage (`discover` | `fetch` | `parse` | `analyze`), target, attempts, `next_attempt_at`, last error
- `artifacts` — content-addressed by SHA-256 against the MinIO object key, with source URL and fetch time

**Critical property: every stage after `fetch` reads from stored artifacts, never from the network.** `parse` and `analyze` therefore develop and test at full speed against captured documents regardless of whether live fetching works for a given source. A Bozeman agenda obtained by hand or by public-records request flows through the identical pipeline as an automatically fetched one. Bozeman's adapter can sit visibly in `blocked` state while everything downstream of it is complete and tested.

Content hashing gives idempotency: re-fetching an unchanged agenda is a no-op, and any job can be replayed without duplicating data.

**Failures are visible.** Exhausted retries mark a source degraded and surface on a public status page. A transparency project that silently stops ingesting is worse than one that says "Bozeman: last successful sweep 6 days ago."

### Findings

Generated narrative becomes a first-class entity rather than rendered text.

- `findings` — status `draft` → `approved` → `published`, jurisdiction, generated_at, model, prompt version
- `finding_claims` — one row per assertion, each with a foreign key to its source document plus a locator (page, character offset)

The citation chips in the approved design are `finding_claims` rendered.

**Invariant, enforced in code and by an explicit test:** a claim without a source cannot be persisted, and a finding containing an unsourced claim cannot be published.

Generation is constrained to describe *what the record shows* — votes, timing, procedure, patterns — and never to assert motive, intent, or illegality.

### Review queue

An authenticated admin surface, single operator, session auth. Drafts land there. Nothing naming a person reaches the public site without an operator clicking approve.

### Provenance

Every fact displayed publicly traces to an artifact in MinIO. Every sweep is recorded. The public status page reads from those records.

### Design system

A real token layer — type scale, spacing, color, editorial serif for headlines, sans for data, tabular numerals throughout — replacing the current ad-hoc Tailwind grays. The public site is light; the admin queue reuses the same tokens.

## Workstreams

| | Workstream | Depends on |
|---|---|---|
| **W0** | Stabilize: green typecheck/test/build both sides, delete duplicate modules, CI that blocks merge | — (blocks all) |
| **W1** | Design system and front-page rebuild | W0 |
| **W2** | Ingestion: queue, run tracking, adapter interface, Gallatin adapter, Bozeman spike, CERS adapter | W0 |
| **W3** | Findings engine: synthesis, citations, review queue, admin auth | W2 |
| **W4** | Public launch: strip `legacy-platform`, retarget to `commissionwatch.bmux.sh`, drop IP allowlist, TLS, backups, monitoring | W0 |
| **W5** | Correlation: donor ↔ member entity resolution, money-trail graph | W2, W3 |

### Launch gates

1. **Launch 1** — public site, real Gallatin data, rundown sheets and anomaly flags. No narrative findings.
2. **Launch 2** — Bozeman ingestion plus reviewed, published findings.
3. **Launch 3** — campaign finance and the money trail.

## Testing

- **Adapter contract tests** — every adapter runs one shared suite against captured fixtures. Adding a jurisdiction means passing an existing suite, not writing a new one.
- **Parser fixtures from real documents** — captured Gallatin agendas and minutes committed as fixtures; parser regressions caught without network access.
- **Publication invariant test** — the "no unsourced claim reaches the public" rule is tested explicitly, because it is the rule with legal consequences.
- **CI gates merge** — typecheck, test, and build must pass. The broken `main` exists precisely because this was not enforced.

## Error handling

Every failure path terminates in an `ingestion_jobs` or `ingestion_runs` row carrying the error text. Nothing is swallowed. The public status page reads from those rows, so degradation is disclosed rather than hidden.

## Scraping ethics

All targeted material is public record. Fetching is polite: a real browser at low rate, honest user agent identifying the project, aggressive caching, and no re-fetching of unchanged documents.

For Bozeman specifically: the spike establishes whether ordinary browser automation is sufficient. **If it turns out to require fingerprint spoofing or proxy rotation, that work is not done** — the operator is consulted, and the fallback is a public-records request to the City Clerk for the same documents.

## Existing code kept but dormant

Alert subscriptions, the digest scheduler, and email delivery already exist in `backend/src/services/`. They stay in the codebase and must keep compiling and passing tests, but no email is sent to anyone until Launch 2 — sending generated claims about named officials to subscribers before the review queue exists would bypass the publication gate.

## Out of scope

- Additional jurisdictions beyond Bozeman and Gallatin
- Meeting video transcription and speaker identification
- The community agent SDK and plugin system
- Public user accounts (the only account is the operator's)
