# P5 · Agenda diff timeline — implementation plan

> 2026-08-10. Spec: `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P5.
> Branch `feat/archive-salvage`. Nothing is pushed: production is 502 on `/api/*`.

## What this builds

*What changed in an agenda, and how close to the vote.* Version history for every fetched
document, a diff over **extracted agenda items** between consecutive versions, a
`last_minute_agenda_change` flag that can finally be substantiated, and a two-column diff on the
public meeting page.

## Corrections to the spec, made before writing code

The spec was written from the shape of the data model rather than from the columns. Four things it
says do not exist as written:

1. **`meetings.scheduled_at` does not exist.** Migration 003 gives `meetings` a `date` (a
   `DATE`) and a nullable `time` (a `TIME`). The scheduled instant is composed from the two, and a
   meeting with no `time` has no known hour — so it is **not** flagged rather than being assumed to
   convene at midnight. Assuming a time would manufacture the very number the finding reports.
2. **Migration numbering continues from 034, not 033.** `033_add_source_disabled_reason.ts` landed
   with P2.
3. **The extracted items of a superseded version are not recoverable.** `upsertAgendaItems` merges
   into `agenda_items` keyed on `(meeting_id, item_number)`, so parsing version 2 overwrites
   version 1's rows. Diffing "extracted agenda-item text between consecutive versions" is therefore
   impossible unless each version keeps its own extraction. `document_versions.item_snapshot`
   (jsonb) is added for this. It is a fact about one artifact, written once, never revised.
4. **"Within N hours of `scheduled_at`" is narrowed to "within N hours *before*".** A republication
   after the meeting is a different fact and is not this finding. Stated in the code and in the
   rendered text.

`N` lands as `jurisdictions.agenda_change_window_hours`, `NOT NULL DEFAULT 48`.

## Design

### The version row is a consequence of fetching, not new bookkeeping

`artifacts.sha256` is `UNIQUE`. The fetch handler already inserts an artifact with
`onConflict("sha256").ignore()`. The change is that it now **always** resolves the artifact id —
whether it inserted or collided — and always writes a `document_versions` row for
`(meeting_document, artifact)`.

- unchanged bytes → same artifact → `unique (meeting_document_id, artifact_id)` collides →
  **no new version**
- changed bytes → new artifact → **exactly one new version**

There is deliberately **no** "have I seen this before?" branch. The constraints decide.

`version_no` is `MAX(version_no) + 1` for the document, taken inside a transaction that locks the
parent `meeting_documents` row, so two concurrent fetches of the same document cannot both claim
the same number.

### Schema — migration 034

```
document_versions (
  id                  uuid pk default gen_random_uuid(),
  meeting_document_id uuid not null references meeting_documents on delete cascade,
  artifact_id         uuid not null references artifacts,
  version_no          int  not null,
  first_seen_at       timestamptz not null default now(),
  item_snapshot       jsonb null,              -- agenda items extracted from THIS artifact
  created_at/updated_at,
  unique (meeting_document_id, artifact_id),
  unique (meeting_document_id, version_no),
  check  (version_no >= 1)
)
jurisdictions.agenda_change_window_hours  int not null default 48, check > 0
```

### Backfill, in the same migration

Every `artifacts` row whose `source_url` matches a `meeting_documents.url` becomes version 1 of
that document, `first_seen_at = artifacts.fetched_at`. Written as one `INSERT ... SELECT` with
`ON CONFLICT DO NOTHING`, ordered by `fetched_at` so numbering is chronological. Today that is the
11 Gallatin and 8 Bozeman artifacts. `item_snapshot` is left `NULL` — we do not have those
extractions per artifact and inventing them is not available to us. A `NULL` snapshot renders as
"not extracted", never as "no items".

### Diffing — `src/services/agenda-diff.ts`, pure functions

`diffAgendaItems(from, to)`:

- identity is the **normalised title** (trimmed, whitespace collapsed, case-folded)
- in both → unchanged, not reported
- only in `from` → `removed`; only in `to` → `added`
- an unmatched `removed` and an unmatched `added` sharing an `item_number` → one `retitled`

Ordering changes alone are not reported. Byte-level differences are never consulted.

### The finding

`checkLastMinuteAgendaChange` in `anomaly-detection.ts` is **replaced**, not supplemented. Its
current implementation compares `agenda_items.created_at` — the moment *we ingested* — against the
meeting date, so a meeting swept the day before it convenes flags every one of its items as
"added less than 24 hours before meeting". That is a false statement about the public record on a
public page. It is exactly the unsubstantiated claim P5 exists to retire, and leaving it running
beside a substantiated one would put two contradictory flags of the same type on one meeting.

The replacement raises one flag per `(document, version pair)` where the newer version's
`first_seen_at` falls inside the jurisdiction's window before the scheduled instant. Evidence in
`anomaly_flags.metadata`:

```
{ document_id, document_title, document_url,
  from_version, to_version, from_sha256, to_sha256,
  first_seen_at, scheduled_at, hours_before,
  changes: [{ kind, item_number, title, previous_title? }],
  window_hours }
```

**Both artifact hashes**, per the invariant.

`review_state` is `held` when any changed item title contains the name of a member of the
jurisdiction — nothing naming a person auto-publishes. Otherwise `published`.

Description text states the record and nothing else:
`Agenda "X" was republished 19 hours before the meeting: 2 items added, 1 removed.` No motive, no
adverbs, no implication.

### Public API

`GET /api/meetings/:id/agenda-diff`, behind `findPublishedMeeting` like every other public
meeting route. Returns `{ data: DocumentTimeline[], total }`. Added to the ten paths
`meeting-publication.test.ts` walks, so an unpublished meeting's diff 404s.

### Frontend

`AgendaDiffTimeline.tsx`, rendered on `MeetingDetailPage`. Existing tokens only
(`paper-sunk`, `rule`, `accent`, `muted`, `ink-soft`, `label-sm`, `kicker`, `figure`). No new
dependencies, no new colours.

- **One version — the common case** — renders a single calm line: version 1, its `first_seen_at`,
  its hash. Not an empty comparison, not a "no changes" claim about a comparison that never
  happened.
- Two or more → a two-column diff per consecutive pair, each column headed by its version's
  `first_seen_at` and short hash.
- A `NULL` snapshot on either side renders "Items not extracted for this version" rather than an
  empty column.

## Tasks

| # | Work | Files |
|---|---|---|
| 1 | Migration 034 + backfill | `backend/migrations/034_create_document_versions.ts` |
| 2 | Diff + flag logic, pure | `backend/src/services/agenda-diff.ts` |
| 3 | Version recording in fetch; snapshot in parse | `backend/src/services/ingestion/handlers.ts` |
| 4 | Replace the detector | `backend/src/services/anomaly-detection.ts` |
| 5 | Public route | `backend/src/routes/meetings.ts` |
| 6 | Tests | `backend/test/agenda-diff.test.ts` (register in `package.json`), edits to `anomaly-detection.test.ts`, `meeting-publication.test.ts`, `ingestion-handlers.test.ts` |
| 7 | Frontend types + hook + component + tests | `frontend/src/types/index.ts`, `hooks/useMeetings.ts`, `components/AgendaDiffTimeline.tsx` + `.test.tsx`, `pages/MeetingDetailPage.tsx` |
| 8 | `docs/STATUS.md` | — |

## Verification gate

```
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baseline: backend 660/168, frontend 180/25, deploy 61 passed / 0. No regression.

## Out of scope

Rendering the diff in the operator console (`AdminMeetingDetailPage`); the public status page;
`analyze`-stage automation of the detector. Nothing here enables an ingestion source, installs a
cron, or touches the Caddy gate.
