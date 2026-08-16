# Retention for the dated export archive — measured, and mostly refused

**Written 2026-08-16 during the third autonomous loop.** Filed as G3d in the 0.5.0 plan
("no retention policy on `export_snapshot_runs` / `export_snapshots`") and carried forward as H3.

**Outcome: no deletion is implemented, and the reason is not caution — it is that deletion would
destroy the only thing this archive is for.** What follows is the measurement, so the next reader
argues with numbers rather than with an instinct.

---

## The two tables are not the same kind of thing, and the filed task treated them as one

`export_snapshot_runs` is an **operational ledger**: one row per cycle outcome, recording that a
snapshot was taken or skipped and why.

`export_snapshots` (with `export_snapshot_datasets`) is the **archive**: what the open-data export
contained on a given day.

Filing them together under one "retention policy" is what made the task look like routine hygiene.
They need opposite answers.

## `export_snapshot_runs` needs no policy, because the schema already bounds it

Migration 106 puts a unique constraint on `(run_day, outcome)`. There are four outcomes. So the
table cannot exceed **four rows per UTC day** — a hard ceiling of ~1,460 rows a year, forever,
whatever the corpus does. Repeat cycles increment `cycles` and move `last_at` on the existing row;
they do not insert.

**The growth this task was filed against does not exist in this table.** A retention policy here
would be code that runs forever to delete nothing worth deleting. Not building it is the finding.

## `export_snapshots` grows, and deleting from it is not a retention policy — it is an amputation

Migration 105 states the design plainly: the archive is **forward-only**, because publication state
is one mutable nullable column (`meetings.published_at`, set to NULL on withdrawal) and
`anomaly_flags.review_state` is the same shape. A day nobody snapshotted **cannot be reconstructed,
ever**, by any query, because the evidence it would need was overwritten.

The consequence for retention is sharp and worth stating in one sentence:

> **Every retention policy deletes oldest-first, and oldest-first is exactly the order of
> irreplaceability.**

The archive answers "what did this site say, then" for dates from the first snapshot onward. Delete
the oldest snapshots and the archive's horizon moves *forward* — permanently, silently, and most
damagingly for the withdrawn material, which is the case the archive exists to cover and the only
case where nothing else can answer. A 90-day retention window would convert a growing historical
record into a rolling 90-day window that merely looks like a historical record.

So: **deletion from `export_snapshots` is an operator decision, and the recommendation is to
refuse it.** If storage ever forces the question, the answers to reach for are structural, not
destructive — see below.

## The measurement

Growth is `published rows × ~39 bytes × days`. `row_ids` is a `jsonb` array of UUIDs; a UUID plus
quotes and a comma is ~39 bytes before storage. Postgres TOASTs and compresses large `jsonb`, and a
sorted array of UUIDs compresses poorly but not not-at-all, so **treat these as upper bounds**.

Measured against production on 2026-08-16 by fetching every dataset from `/api/data/*.csv` and
counting rows — the public export is the archive's own input, so this is the real denominator:

| Dataset | Published rows |
|---|---:|
| jurisdictions | 3 |
| commissions | 31 |
| meetings | 1 |
| agenda_items | 36 |
| meeting_documents | 2 |
| members | 0 |
| votes | 0 |
| findings | 0 |
| claims | 0 |
| artifact_references | 2 |
| artifacts | 2 |
| **Total** | **77** |

**77 rows.** At ~39 bytes that is **~3 KB per daily snapshot**, or **~1.1 MB per year**. The dated
archive could run untouched for a decade and cost about eleven megabytes.

### Why the number is 77, and why that is the real finding

Production has ingested **520 meetings**. The export contains **one**. The gap is the review gate
doing its job: only what an operator has published appears. **The archive's growth rate is therefore
governed by the publication rate, which is an operator's manual throughput, not by the ingestion
rate, which is a machine's.**

That is the load-bearing fact for anyone sizing this later. A projection built from "520 meetings
ingested" would be wrong by more than two orders of magnitude, in the direction of alarm.

### The upper bound worth writing down

If every ingested meeting were eventually published — 520 meetings at the observed ~36 agenda items
each, plus documents and artifacts — the corpus lands around **25,000 rows**: roughly **975 KB per
snapshot**, **~356 MB per year**, and rising as ingestion continues. That is the point at which the
question becomes real. It is not close, and nothing about it requires a decision today.

## If storage ever does force the question

In preference order. None of these lose a day.

1. **Deduplicate identical consecutive snapshots.** On a day when nothing was published or withdrawn,
   the row-id set is byte-identical to yesterday's. Store a reference instead of a copy. A quiet
   archive would then cost almost nothing, and quiet is the normal state.
2. **Store a delta against the previous snapshot.** Strictly better than (1) and strictly more code;
   worth it only if (1) proves insufficient.
3. **Compress `row_ids`** to a packed binary form of the 16-byte UUIDs, ~2.4× smaller than the JSON
   text before any TOAST compression.
4. **Only then**, and only as an operator decision taken in the open, consider thinning old snapshots
   — and if it is ever done, the archive must *say so on `/data`*, because an archive with a hole it
   does not disclose is worse than no archive.

## What this loop implemented

Nothing. That is the deliverable.

The one thing that would be wrong is to add a `DELETE` to a forward-only archive because a task list
contained the word "retention". **Migration 083 is already "Retention: never delete"** for the event
log; this table has the same character and had not been reasoned about, only filed.

## For the operator

No action needed. The archive is still off (`dated_export_archive` is disabled), so today it holds
nothing at all. When it is turned on, it will cost about three kilobytes a day at the current
publication level, and the number to watch is not the size — it is the **published** row count, which
is visible any time by counting `/api/data/*.csv`.
