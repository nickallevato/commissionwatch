# Plan — P1 ingestion scheduling, and P3 backups with a tested restore

> Date: 2026-08-09
> Spec: `docs/superpowers/specs/2026-08-09-phase-2-design.md`, sections P1 and P3
> Branch: `feat/archive-salvage`
> Baseline that must not regress: backend 346 tests / 103 suites, frontend 150 tests / 22 files

P1 and P3 ship together. P1 is what creates the data P3 protects.

---

## Grounding — probed 2026-08-09 before any code was written

Every design decision below that touches Gallatin came from a request, not from reasoning.

| Probe | Result |
|---|---|
| `GET https://www.gallatinmt.gov/robots.txt` | 200, 816 bytes. `User-agent: *` disallows `/admin`, `/search*`, `/map*`, `/RSS.aspx` and friends. **`/AgendaCenter` is not disallowed.** No crawl-delay for `*`. |
| `GET /AgendaCenter` | 200, 116,939 bytes. |
| Categories rendered | **Three**, not the twelve captured on 2026-08-04: `cat3`, `cat2`, `cat4` (Big Sky Meadow Trails district, Study Commission, Weed Board). The county has reorganised AgendaCenter since the fixture was recorded. |
| Agenda rows on the index | 9 (`tr.catAgendaRow`). 8 distinct agendas, 4 distinct minutes. |
| `GET /AgendaCenter/ViewFile/Agenda/_06042026-107` | 200, 114,469 bytes, `application/pdf`, PDF 1.7. |
| `GET /AgendaCenter/ViewFile/Agenda/_08062026-108` | 200, 61,358 bytes, **`application/vnd.openxmlformats-officedocument.wordprocessingml.document`** — a Word file behind a `ViewFile/Agenda` path. |

Three consequences, all load-bearing:

1. The adapter's hardcoded twelve-body list is now mostly wrong about what the site serves. It
   already warns and skips on an unknown category, so the failure mode is safe, but a sweep will
   only see bodies the list declares. Not fixed here — that is a config change, and P2's console
   is where it belongs.
2. **Not every document is a PDF.** The parse stage must handle "content type I cannot read" as a
   recorded skip, not as a failure and not as a silent success.
3. The record is small. A real sweep is single-digit meetings, which is exactly the right size for
   a first polite run.

## Correction to the spec

`docs/superpowers/specs/2026-08-09-phase-2-design.md` P1 says to "add `cron_expression` and
`enabled` to `ingestion_sources`". **`enabled` has existed since migration 016** (`boolean not
null default true`, and it is half of `idx_ingestion_sources_enabled_health`). Only
`cron_expression` and `expected_interval_hours` are new. The spec document is amended in place.

---

## Architecture decision — where the adapter lives

The scheduler runs in `backend/`. The Gallatin adapter lives in `agents/meeting-monitor/`. They
cannot see each other: `backend/Dockerfile`'s build context is `./backend`, so a production image
literally cannot contain a file from `agents/`, and `backend/tsconfig.json` sets `rootDir: "."`.

Duplicating the adapter is not an option — one module per source is the contract.

**Decision: the adapter layer moves into the backend**, which is the runtime that needs it.

- `agents/meeting-monitor/src/adapters/{types,registry,gallatin-civicplus}.ts`
  → `backend/src/services/ingestion/adapters/`
- `agents/meeting-monitor/src/adapters/{contract,gallatin-civicplus}.test.ts`
  → `backend/test/adapters/`, converted from `vitest` to `node:test`
- `agents/meeting-monitor/tests/fixtures/gallatin/` → `backend/test/fixtures/gallatin/`
- `cheerio` becomes a backend dependency (pure JS, no node-gyp, arm64-safe)

This is the point of the move: those 68 contract tests have **never run in CI** — `.gitea/workflows/ci.yml`
builds `backend` and `frontend` only, and the agents package is not in it. Promoting the adapter to
production code without promoting its tests would repeat the exact defect that left four suites and
135 tests unrun in this repo. Both files get registered in `backend/package.json`'s `test` script.

The vitest matchers used across the two files are a bounded set (`toBe`, `toEqual`, `toMatch`,
`toContain`, `toHaveLength`, `toBeNull`, `toBeUndefined`, `toBeInstanceOf`, `toBeGreaterThan`,
`toBeGreaterThanOrEqual`, `toThrow`, and `.not.` on some), so conversion is a small local `expect`
shim over `node:assert/strict` plus changed import lines — not 1,100 lines of rewriting.

`agents/meeting-monitor` keeps its scraper, parser, anomaly and rundown code. Only the adapter
layer, which nothing in that package consumed, moves.

## Architecture decision — text extraction

`agents/meeting-monitor/src/parser/extractors.ts` splits on `\n` and requires an item number at
line start. `pdfjs-dist` `getTextContent()` joins a page's items with a single space and pages with
`\n\n`, so that extractor sees one enormous line per page and returns **zero** agenda items. It is
not reusable here; it is not a duplicate to replace it.

The backend gets `pdf-text.ts`: a `Buffer`-in, lines-out extractor that reconstructs lines from the
text items' `transform` y-coordinates, so an agenda's numbering survives. `agenda-items.ts` then
reads those lines. `pdfjs-dist` is pure JS with one optional prebuilt dependency
(`@napi-rs/canvas`) that text extraction never loads — no node-gyp, arm64 safe.

---

## P1 — tasks

### 1. Migration 028 — scheduling columns on `ingestion_sources`

`backend/migrations/028_add_source_scheduling.ts`

- `cron_expression text not null default '17 7 * * *'` — a per-source five-field cron. Default is
  07:17 UTC, off the hour on purpose so several sources never fire simultaneously.
- `expected_interval_hours integer null` — null means "no expectation stated". A source with a
  value and no success inside it is Suspect. Silence is failure until proven otherwise.
- `CHECK (expected_interval_hours IS NULL OR expected_interval_hours > 0)`
- Partial index on `enabled` for the scheduler's reload query.

`enabled` is **not** added; it exists.

### 2. Migration 029 — `meetings.external_id`

`backend/migrations/029_add_meeting_external_id.ts`

A nightly sweep re-reads the same index every night. Without an identity, night two duplicates
every meeting from night one. `meetings` has no natural key: `(commission_id, date)` is not unique
because a body can meet twice in a day.

- `external_id text null` on `meetings` — the source's own id, e.g. `06042026-107`.
- `UNIQUE (commission_id, external_id)` as a partial unique index where `external_id IS NOT NULL`,
  so hand-entered and seeded meetings without one are unaffected.

Also `UNIQUE (meeting_id, url)` on `meeting_documents`, for the same reason.

Recorded as an amendment to the spec, which did not anticipate it.

### 3. Move the adapter layer

As decided above. No behaviour change to the adapter itself.

### 4. `backend/src/services/ingestion/pdf-text.ts`

`extractPdfLines(bytes: Uint8Array): Promise<string[]>` — pdfjs, y-grouped lines, page breaks
preserved as blank lines. Throws a typed `UnsupportedDocumentError` for bytes that are not a PDF.

### 5. `backend/src/services/ingestion/agenda-items.ts`

`extractAgendaItems(lines: string[]): AgendaItemDraft[]` — numbered/lettered items, section
headings become `category`, continuation lines become `description`. Pure, fully unit-tested, no IO.

### 6. `backend/src/services/ingestion/handlers.ts`

The three stage handlers the worker dispatches to, built over an injected `SourceAdapter`.

- **discover** — `adapter.discoverMeetings(since)`; upsert jurisdiction, commissions (one per
  body), meetings (on `(commission_id, external_id)`), `meeting_documents` (on `(meeting_id, url)`);
  enqueue one `fetch` per document. Counts `meetings_seen`, `meetings_inserted`, `documents_seen`.
- **fetch** — `adapter.fetchDocument(ref)`; put bytes in MinIO under `artifacts/<sha256>`; insert
  `artifacts` `ON CONFLICT (sha256) DO NOTHING` — an unchanged document collides here and is never
  reprocessed, which is the politeness rule expressed as a constraint; enqueue `parse`.
- **parse** — reads the stored artifact through the worker's `ArtifactStore` (no network in scope,
  by construction); PDF → lines → agenda items → upsert `agenda_items`. A content type the extractor
  cannot read is counted `skipped_unsupported` and completes, because "I cannot read a .docx" is a
  fact about the record, not a fetch failure.

### 7. `backend/src/services/ingestion/scheduler.ts` — `SourceScheduler`

- Reads `ingestion_sources` where `enabled`, schedules one `node-cron` job per row from
  `cron_expression`, timezone UTC.
- **Never sweeps on start.** First execution is the first tick. A crash loop must not become a
  crawl of a county web server.
- Every tick, in order:
  1. `pg_try_advisory_lock(key, hashSourceId(id))` on a dedicated connection. Failure → log and
     return. No second run row, no second sweep.
  2. Insert `ingestion_runs` **before any work**, status `running`.
  3. Enqueue the `discover` job, drain the worker until the run's jobs are terminal or a deadline
     passes.
  4. Close the run: `succeeded` (work, no errors), `partial` (work **and** errors), `failed` (no
     work, or the sweep threw). The enum is not collapsed to a boolean.
  5. Errors land in `ingestion_runs.error` as text. `ingestion_sources.last_success_at`,
     `consecutive_failures` and `health_status` are updated from the outcome.
  6. Release the advisory lock in a `finally`.
- `SCHEDULER_ENABLED` — defaults to **off** when `NODE_ENV === "test"`, on otherwise. The suite
  schedules nothing.
- `sweepNow(sourceId)` is the same code path without cron, so tests and the future console button
  drive it directly.

### 8. `backend/src/services/ingestion/registration.ts`

`registerSources(db, adapters)` — from `describeSource()` alone (pure, no network) ensure a
`jurisdictions` row, a `commissions` row per body, and an `ingestion_sources` row per adapter.
Idempotent, safe on every boot, and the reason an operator never has to hand-write a UUID.

### 9. Wire `backend/src/index.ts`

Construct queue, worker, adapters, scheduler. `registerSources` then `scheduler.start()` after
`listen`. `shutdown()` stops the scheduler and the worker.

### 10. Tests, all registered in `backend/package.json`

| File | Asserts |
|---|---|
| `test/adapters/contract.test.ts` | moved; the shared adapter contract |
| `test/adapters/gallatin-civicplus.test.ts` | moved; fixture-driven, no network |
| `test/agenda-extraction.test.ts` | line-aware item extraction, numbering, categories, empty input |
| `test/source-scheduler.test.ts` | no sweep on start; a run row reaches a terminal status; a second tick under the advisory lock starts no second run; a throwing adapter yields `failed` with the error text and the process survives; work-plus-errors yields `partial`; `SCHEDULER_ENABLED` off under `NODE_ENV=test` |
| `test/ingestion-handlers.test.ts` | discover upserts and is idempotent across two sweeps; fetch collides on sha256; parse writes agenda items; unsupported content type is skipped, not failed |

### 11. The real sweep

`docker compose up -d db minio`, register the source, `sweepNow`, one page, ≥2s between requests,
honest user agent. Then count `meetings` and `agenda_items`. If Gallatin is unreachable the result
is **blocked**, and it is reported as blocked.

### 12. `docs/STATUS.md`

"Nothing ingests" stops being true. Record what actually landed, with counts.

---

## P3 — tasks

### 13. `deploy/backup.sh`

Nightly. `pg_dump -Fc` of the application database plus a mirror of the MinIO bucket, written to a
staging directory and then pushed **off the instance** into a separate MinIO bucket
(`commissionwatch-backups`) — off-instance in the sense that matters here: not on the container's
own volume, and restorable without the source database existing. Retention 7 daily / 4 weekly,
pruned by age from the object listing, never by a `rm -rf` of a directory a variable might have
left empty.

Emits `ops.backup_succeeded` / `ops.backup_failed` through the existing
`DeliveryDispatcher` by invoking `node dist/src/scripts/emit-ops-event.js` inside the backend
container — the script is the only thing that knows about the dispatcher, and the shell script is
the only thing that knows about `pg_dump`.

### 14. `backend/src/scripts/emit-ops-event.ts`

Argument-driven, typed payload, exits non-zero on a dispatch failure so `backup.sh` can tell the
difference between "backup failed" and "backup failed and nobody was told".

### 15. `deploy/restore-drill.sh` — **and it gets run**

Takes a dump, creates a scratch database, restores into it, and compares row counts table by table
against the source. Prints a table and exits non-zero on any mismatch. Handles the
`POSTGRES_PASSWORD`-is-fixed-at-volume-initialisation trap explicitly: the drill restores into a
scratch database on the **running** instance using the running instance's credentials, and the
runbook states that a restore into a fresh volume must be initialised with the password the dump
expects, because changing the secret later does not change the database.

### 16. `deploy/README.md` §5 — the runbook

Exact commands, verified by running them, plus what the drill compared and when it was last run.

---

## Verification gate

Nothing is pushed until all of this has been seen, not assumed:

```
docker compose up -d db
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test -- --run
```

Backend ≥ 346 tests / ≥ 103 suites, frontend 150 / 22, both green, plus the real sweep's row
counts and the restore drill's output.
