/**
 * The two key sets that decide what a run's tallies mean.
 *
 * Mirrored from `backend/src/services/ingestion/scheduler.ts`, which exports
 * `SUCCESS_KEYS` and `FAILURE_KEYS` and is the authority. The backend cannot be
 * imported across the package boundary, so `ingestion-counts.test.ts` reads that
 * file off disk and fails if these lists drift from it.
 *
 * ## What this replaced, and why it mattered
 *
 * This module used to define `countRecords` as *the sum of every value in
 * `counts`*. A run's `counts` is an open map — it carries discovery and fetch
 * tallies, failure and blocked tallies, and any other number a stage chose to
 * record. Summing all of it and calling the result "records" meant the operator
 * console reported **failures as records**.
 *
 * Observed in production on 2026-08-16: both live sources showed
 * *"one sweep on record — partial, 91 records"* while `GET /api/ingestion/sources`
 * reported `records: 0` for the same runs, and Gallatin's own counter beside it
 * read `0` with "No record has ever been ingested from this source." Three
 * numbers for one run, two of them wrong, on the screen an operator uses to
 * decide whether ingestion is working.
 *
 * A transparency project's console overstating what it collected is the failure
 * this project exists to report on, so the number now comes from the same
 * definition the backend uses.
 *
 * ## `processed` and `outstanding` are neither, and that is deliberate
 *
 * Production's real counts look like `{ processed: 90, outstanding: 1 }` — the
 * two keys that produced the bogus 91. Neither belongs in a record count, and
 * the reason is worth writing down because the obvious "fix" is wrong:
 *
 * - **`processed`** is *jobs this sweep completed, whichever run enqueued them.*
 *   A sweep is time-boxed, the queue is claimed oldest-first with no `run_id`
 *   filter, so a sweep routinely drains an older run's backlog. That work is
 *   already counted in the `counts` of the run that **owned** those jobs. Adding
 *   `processed` to `recordsIn` would therefore **double-count**, and it would do
 *   it in `lifetime_records`, which the backend computes by summing `recordsIn`
 *   over every run. Do not "fix" it that way.
 * - **`outstanding`** is the backlog still queued when the clock ran out. It is
 *   work *not* done. Counting it as a record was the larger half of the 91.
 *
 * So both are surfaced on their own below rather than folded into either total.
 * A sweep that processed ninety jobs and landed no new records of its own is a
 * productive sweep draining a backlog, and it must read as that — not as "0
 * records", which looks broken, and not as "91 records", which is a lie.
 */
export const SUCCESS_KEYS = ["discovered", "fetched", "parsed", "analyzed"] as const;
export const FAILURE_KEYS = ["failed", "blocked"] as const;

/** Records attributed to this run. Mirrors the backend's `recordsIn` exactly. */
export function recordsIn(counts: Record<string, number>): number {
  return SUCCESS_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

/** Failures this run recorded. Mirrors the backend's `failuresIn`. */
export function failuresIn(counts: Record<string, number>): number {
  return FAILURE_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

/** Jobs this sweep completed, including ones an earlier run enqueued. */
export function processedIn(counts: Record<string, number>): number {
  return counts.processed ?? 0;
}

/** Jobs still queued when the sweep hit its deadline. Work not done. */
export function outstandingIn(counts: Record<string, number>): number {
  return counts.outstanding ?? 0;
}
