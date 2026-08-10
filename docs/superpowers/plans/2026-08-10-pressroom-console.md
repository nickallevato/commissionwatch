# P2 — The Pressroom console

> Plan for `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P2.
> Written 2026-08-10. Branch `feat/archive-salvage`.

## What this is

Three operator screens under `/admin`, behind the `requireOperator` session guard that A1
landed, plus the schema and API they need. The eight design decisions in the spec are
requirements; each one below names the mechanism that satisfies it and the test that holds it.

| Decision | Mechanism | Test |
|---|---|---|
| 1 · Zero is a failure state | `lifetime_records` computed per source; the sources page renders `0` in the accent (failure) colour with a `data-zero` marker | frontend `AdminSourcesPage.test.tsx` |
| 2 · Silence watch | `silence.verdict` from `expected_interval_hours` vs `last_success_at`, computed server-side | backend `pressroom-sources.test.ts` |
| 3 · Disabled sources stay listed | `ingestion_sources.disabled_reason`; disabled rows are never filtered out of the listing | both |
| 4 · Partial stays green | `outcome.headline` keeps `partial`; failed jobs come back as `failures[]` rows | backend `pressroom-runs.test.ts`, frontend `AdminRunDetailPage.test.tsx` |
| 5 · Re-parse without re-fetching | replays `parse` jobs against stored `sha256`; the `parse` stage has no path back to a URL | backend `pressroom-runs.test.ts` |
| 6 · Confidence per field | `agenda_items.field_confidence jsonb`, written by the extractor | backend `pressroom-meetings.test.ts`, `agenda-extraction.test.ts` |
| 7 · Corrections append-only | `record_corrections` + a trigger that raises on `UPDATE`/`DELETE`; artifacts are never written | backend `pressroom-corrections.test.ts` |
| 8 · `ingested` ≠ `published` | `meetings.published_at`; every public meetings route filters on it | backend `meeting-publication.test.ts` |

## Correction to the brief

The brief says migration numbering continues from **031**. The highest migration in
`backend/migrations/` is **029** (`029_add_meeting_external_id.ts`) — P4's additions were 028 and
029. Numbering therefore continues at **030**, and a gap at 030 would only invite a later
collision. Recorded here rather than silently obeyed.

## Schema

All four are additive. None rewrites a row's meaning; none is destructive on `down`.

**030 · `meetings.published_at timestamptz null`**
Indexed partial (`WHERE published_at IS NOT NULL`) because every public read filters on it.
Existing rows are backfilled to `created_at`: they are already public, and a migration that
silently unpublished the live site would be a data-loss event dressed as a schema change. Rows
created after this migration default to `NULL` — ingestion produces a candidate, an operator
produces a publication.

**031 · `record_corrections`**
`id`, `target_table`, `target_id`, `field`, `old_value text null`, `new_value text null`,
`reason text not null`, `operator_id uuid null`, `operator_email text null`, `created_at`.
`target_table` is checked against `('meetings','agenda_items','meeting_documents')`.

Two deliberate absences:

- **No foreign key to the target.** The reference is polymorphic, and a cascade from `meetings`
  would make `knex('meetings').del()` — which the seed does on every `pretest` — collide with
  the append-only trigger below.
- **No foreign key to `operators`.** `ON DELETE SET NULL` is an `UPDATE`, which the trigger
  forbids; `NO ACTION` would make an operator undeletable. An audit log snapshots its actor, so
  `operator_email` is captured at write time and the row survives the operator's deletion intact.

Append-only is enforced in the database, not by convention: a `BEFORE UPDATE OR DELETE` trigger
raises. The consequence is that tests cannot clean up after themselves, so every correction test
writes against freshly generated target ids and asserts on those.

**032 · `agenda_items.field_confidence jsonb not null default '{}'`**
`{ "<field>": { "level": "high"|"medium"|"low", "reason": string } }`. Per field, never per
record — seven good items and one mangled one is not a low-confidence meeting.

**033 · `ingestion_sources.disabled_reason text null`**
Why a source is off, so `bozemanmt.gov`'s Akamai block lives in the console rather than in
somebody's memory. Backfilled for the two registered adapters where the reason is already known.

## Backend

### `src/services/pressroom/sources.ts`

`listSources(db, now)` → one row per `ingestion_sources` row, **including disabled ones**:

```
{
  id, adapter_key, enabled, disabled_reason, health_status,
  cron_expression, expected_interval_hours, consecutive_failures,
  jurisdiction: { id, name, state },
  last_success_at: string | null,
  lifetime_records: number,
  silence: { verdict: "ok" | "suspect" | "unknown",
             hours_since_success: number | null,
             expected_interval_hours: number | null },
  verdict: "disabled" | "never_run" | "failing" | "suspect" | "healthy",
  latest_run: { id, status, started_at, finished_at, counts, error } | null
}
```

`lifetime_records` sums the success keys of `ingestion_runs.counts` across every run of the
source. It is computed, not stored, so it cannot drift from the runs it claims to summarise.

`silence.verdict` is `unknown` when `expected_interval_hours` is null or nothing has ever
succeeded — an absent expectation is not an expectation of zero. Otherwise `suspect` once
`hours_since_success > expected_interval_hours`.

`verdict` precedence: `disabled` → `never_run` → `failing` (latest run `failed`, or
`consecutive_failures > 0`) → `suspect` → `healthy`. `failing` outranks `suspect` because a named
failure is more informative than an inference from silence.

### `src/services/pressroom/runs.ts`

`getRun(db, id)` → the run, its source, job tallies by stage and status, and every non-terminal
or failed job as a `failures[]` row carrying `last_error` verbatim. `outcome.headline` is the run
status unchanged — `partial` stays `partial`.

`reparseRun(db, queue, runId)` and `reparseMeeting(db, queue, meetingId)`: collect the distinct
`sha256` of the run's (or the meeting's) `parse` jobs, open a **new** `ingestion_runs` row on the
same source, and enqueue one `parse` job per artifact against bytes already held. Nothing
re-fetches, because the `parse` stage cannot dereference a URL — `IngestionQueue.validateTarget`
rejects a post-fetch target carrying a `url`, which is the guarantee rather than a promise.

### `src/services/pressroom/meetings.ts`

`getMeetingDetail(db, id)` → the meeting with `published_at`, its commission and jurisdiction,
agenda items with `field_confidence`, documents, the artifacts reachable through this meeting's
`parse` job targets, and its corrections.

### `src/services/pressroom/corrections.ts`

`recordCorrection({ target_table, target_id, field, new_value, reason, operator })`:

1. reads the current value of the field,
2. inserts the `record_corrections` row (who, when, field, old, new, why),
3. updates the live row.

The artifact is never touched. A test hashes the artifact row before and after and asserts it is
byte-identical.

`publishMeeting` / `unpublishMeeting` route through the same table with
`field: 'published_at'`, so publication gets the audit trail decision 8 asks for without a second
mechanism that could disagree with the first.

### `src/routes/admin/pressroom.ts` → `/api/admin/pressroom`

| Method | Path | Returns |
|---|---|---|
| GET | `/sources` | `{ data, total }` |
| POST | `/sources/:id/sweep` | `202 { outcome }`, `409` when a sweep is already in flight, `503` when no stack is registered |
| GET | `/runs/:id` | run detail |
| POST | `/runs/:id/reparse` | `202 { run_id, enqueued }` |
| GET | `/meetings/:id` | meeting detail |
| POST | `/meetings/:id/reparse` | `202 { run_id, enqueued }` |
| POST | `/meetings/:id/publish` \| `/unpublish` | `{ published_at }` |
| GET | `/corrections` | `{ data, total }`, filtered by `target_table` + `target_id` |
| POST | `/corrections` | `201` correction |

Mounted after `router.use(requireOperator)` in `src/routes/admin/index.ts`, so every path 401s
without a session. The queue and scheduler arrive through a `registerPressroomStack()` seam, the
same shape as `registerDigestStatus` in `routes/health.ts` — the default is unregistered, and an
action route returns 503 rather than constructing a MinIO-backed stack inside a test.

### Public API

`published_at IS NULL` must not appear in any public response. `src/services/publication.ts`
exports `findPublishedMeeting(db, id)` and `filterPublished(query)`; `routes/meetings.ts` uses
them on all seven routes, and `routes/anomalies.ts` uses the finder wherever it resolves a
meeting. The seed sets `published_at` on its meetings, because seed data is a demo of the public
record.

### Tests to register in `backend/package.json`

`test/pressroom-sources.test.ts`, `test/pressroom-runs.test.ts`, `test/pressroom-meetings.test.ts`,
`test/pressroom-corrections.test.ts`, `test/meeting-publication.test.ts`. The `test` script
enumerates files by path — an unregistered file silently never runs.

## Frontend

`frontend/src/components/PressroomShell.tsx` inverts the ground to `paper-sunk` across the copy
well with cards on `paper`, using negative margins that exactly mirror `Layout`'s shell padding.
No new palette, no new dependency.

- `pages/AdminSourcesPage.tsx` — `/admin/sources`. One row per source, disabled ones included
  with their reason. `lifetime_records` of 0 renders in `text-accent`.
- `pages/AdminRunDetailPage.tsx` — `/admin/runs/:id`. A `partial` run's headline is `pass` green;
  its failed jobs are listed below in accent, each with its error text.
- `pages/AdminMeetingDetailPage.tsx` — `/admin/meetings/:id`. Publication state and its control,
  per-field confidence on agenda items, the correction form, and the correction history.

Routes go in `App.tsx` behind `ProtectedRoute`; the three surfaces are added to
`AdminHomePage`'s `SURFACES` list so the console is navigable. Tests are MSW-driven, in the style
of `AdminChannelsPage.test.tsx`.

## Verification gate

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
```

Baseline not to regress: backend 589 tests / 158 suites, frontend 160 / 22, zero lint errors.

## Out of scope

Enabling any ingestion source. Publishing anything. The W3 findings engine and its review queue —
`anomaly_flags.review_state` is untouched here.
