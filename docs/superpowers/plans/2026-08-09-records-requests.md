# Records Requests Implementation Plan (B-d)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a document obtained by hand — a public-records response, a printout, an emailed PDF — the identical downstream path as a scraped one, and track the request that produced it.

**Source:** `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` § "B-d · FOIA document digger — rebuild against `artifacts`".

**The organising fact.** The archive's `document-digger.ts` predates the `artifacts` table and carried its own notion of document storage, plus migration 027's bespoke FOIA tables. None of that is ported. `origin/main`'s `artifacts` is content-addressed with a `UNIQUE` `sha256` and a format CHECK, and **its migration comment already anticipates this exact use**:

> NULL for documents obtained by hand or public-records request: those flow through the identical pipeline as automatically fetched ones.

The table was designed for this. What crosses over is the *logic* — entity extraction and the three detectors — not the storage.

## Global Constraints

- Never silence a type error; never delete or skip a test to go green.
- The database schema is the source of truth for types.
- **No native/node-gyp dependencies.** No `multer`: uploads arrive as base64 in a JSON body with an explicit size cap. One fewer dependency, and it is trivially testable.
- Tests must never hit the network — and must not need MinIO. The regular suite runs without it (`test:storage` is a separate script), so the ingest service takes an injectable storage interface.
- Register every new test file in `backend/package.json`'s `test` script.
- Migration numbering continues from `025_backfill_subscriber_channels.ts`.
- `ALTER TYPE ... ADD VALUE` needs `export const config = { transaction: false }`.

## The two invariants this feature exists to not break

**1. Nothing naming a person auto-publishes.** Extraction from a records document names people — that is what it is for. `GET /api/anomalies` is a **public** route today, so a records-derived flag would be publicly readable the moment it was written. That is precisely the failure the project's central invariant forbids.

The gate: `anomaly_flags` gains `review_state`, `published | held`, defaulting to `published`. Meeting-derived flags describe a meeting's procedure, carry no extracted personal names, and are what the site publishes today — their behaviour is unchanged, deliberately, because changing it is a different decision than this one. **Every records-derived flag is written `held`**, and the public route filters `held` out. B-a will generalise this column into the review queue; until then, held means held.

The extraction itself — the list of names — is never on a public route at all. Every records surface lives under `/api/admin/records`, behind `requireOperator`.

**2. No unsourced claim reaches the public site.** Every extraction row references the `artifacts` row it came from, and an artifact cannot exist without stored bytes and their SHA-256. There is no path to an extraction with no document behind it.

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/026_add_records_anomaly_flags.ts` | Three enum values, `transaction = false`. |
| `backend/migrations/027_create_records_requests.ts` | `records_requests`, `records_request_artifacts`, `record_extractions`; `anomaly_flags.artifact_id` and `.review_state`. |
| `backend/src/services/records/extraction.ts` | `extractEntities` — people, organisations, amounts, dates, each with a confidence. |
| `backend/src/services/records/detectors.ts` | `no_bid_contract`, `budget_spike`, `fast_tracked_permit`. |
| `backend/src/services/records/requests.ts` | `RecordsService` — request lifecycle, document ingestion, extraction, corrections. |
| `backend/src/routes/admin/records.ts` | Operator-only surface, mounted behind the guard. |
| `backend/src/routes/anomalies.ts` | Public reads exclude `held`. |
| `backend/test/records-extraction.test.ts`, `backend/test/records-requests.test.ts` | New behaviour. |
| `frontend/src/pages/AdminRecordsPage.tsx` (+ test) | Requests, upload, extraction review, correction. |

---

### Task 1: Migration 026 — three flag types

Same shape as A4. `no_bid_contract`, `budget_spike`, `fast_tracked_permit`, each `ADD VALUE IF NOT EXISTS`, `transaction = false`, `down` a documented no-op.

**Non-partisanship check.** These three detectors key on procurement language, budget deltas and approval timelines. None filters on who the counterparty is, and none can — there is no entity-class input. That is the project's standing requirement and it is satisfied by construction here, not by care.

### Task 2: Migration 027 — the schema

- `records_requests`: `id`, `jurisdiction_id` (nullable FK), `subject`, `status`, `submitted_at`, `response_due_at`, `responded_at`, `notes`, timestamps. Status CHECK: `draft | submitted | acknowledged | partially_fulfilled | fulfilled | denied | withdrawn`. **Lifecycle only.** Migration 027's bespoke FOIA document tables from the archive are not ported.
- `records_request_artifacts`: join table. One artifact can satisfy two requests, and one request usually returns several documents, so this is many-to-many rather than a column.
- `record_extractions`: **append-only.** `id`, `artifact_id`, `entities` jsonb, `extractor_version`, `supersedes_id` (nullable self-FK), `corrected_by` (nullable operator FK), `note`, `created_at`. A correction inserts a row pointing at the one it replaces. Nothing is ever updated, so the record of what the machine originally said survives the correction — which is the whole point of an append-only correction path on a transparency project.
- `anomaly_flags.artifact_id` (nullable FK) and `meeting_id` made nullable, with `CHECK (meeting_id IS NOT NULL OR artifact_id IS NOT NULL)`. A flag must be about something.
- `anomaly_flags.review_state` — `published | held`, default `published`. See the invariant above.

### Task 3: Extraction

Ported from the archive's regexes, which are sound, with one addition the archive lacked: **a confidence per field**. The spec's admin surface requires "view extraction with per-field confidence", and a regex that matched two capitalised words is not as good a guess as one that matched an ISO date. Confidence is derived from which pattern matched, and is honest about being a heuristic — the UI says so.

The person heuristic in particular is weak: "Commission Room" matches a two-capitalised-word pattern as readily as a name does. That is exactly why extraction output is operator-reviewed and never published, and it is why the correction path exists.

### Task 4: The detectors

Ported: sole-source language; a budget delta where the largest amount is ≥3× the smallest and ≥$50,000 apart; expedited-permit language with all dates inside 14 days. Each returns evidence, so a flag says what it saw rather than only what it concluded — *describe the record, never the motive.*

### Task 5: Ingestion

`ingestDocument({ filename, contentType, content })`:

1. SHA-256 the bytes.
2. If an `artifacts` row already has that hash, **return it and reprocess nothing.** Free deduplication, exactly as the spec says.
3. Otherwise store the bytes and insert the artifact with `source_url` NULL — the identical row a scraped PDF produces.
4. Extract, write one `record_extractions` row, run the detectors, write `anomaly_flags` rows with `artifact_id` set and `review_state = 'held'`.

Storage is injected. The default implementation is `services/storage.ts`; tests pass an in-memory one, so the suite needs no MinIO.

### Task 6: Routes

All under `/api/admin/records`, behind `requireOperator`:
`GET|POST /requests`, `GET|PATCH /requests/:id`, `POST /requests/:id/documents` (base64 upload, attach), `POST /documents` (upload with no request), `GET /documents/:artifactId/extraction`, `POST /documents/:artifactId/extraction` (correction).

`express.json({ limit })` is raised on this router only — a 20 MB body limit on the public API would be a denial-of-service surface, and on the operator's upload route it is the requirement.

### Task 7: Public route change

`GET /api/anomalies` and the per-meeting variants exclude `review_state = 'held'`. There is a test asserting a held flag is invisible publicly and visible to the operator.

### Task 8: Frontend

`AdminRecordsPage` at `/admin/records`, behind `ProtectedRoute`: the request list with status, a new-request form, upload, and the extraction view with per-field confidence and a correction form. The correction form submits a whole replacement set — it appends, it does not edit in place.

### Acceptance

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test -- --run
```

- Re-uploading identical bytes creates no second artifact and no second extraction.
- A records-derived flag is absent from `GET /api/anomalies` and present to the operator.
- A correction appends and the superseded row still exists.
- Every records route 401s without a session.
- No new runtime dependency; the suite runs without MinIO.
