import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAILURE_KEYS,
  SUCCESS_KEYS,
  failuresIn,
  outstandingIn,
  processedIn,
  recordsIn,
} from "@/lib/ingestion-counts";

/**
 * What a run's tallies mean, checked against the backend that defines it.
 *
 * ## The bug this exists to prevent, observed in production
 *
 * `AdminSourcesPage` used to compute a run's record count as *the sum of every
 * value in `counts`*. A run's `counts` is an open map: stages write discovery
 * and fetch tallies into it, failure and blocked tallies into it, and anything
 * else they choose to record. Summing all of it and labelling the result
 * "records" reports failures as records.
 *
 * On 2026-08-16 both live sources rendered
 * *"one sweep on record — partial, 91 records"* while
 * `GET /api/ingestion/sources` reported `records: 0` for those same runs and the
 * counter beside the sentence read `0`, under the caption "No record has ever
 * been ingested from this source." Three numbers for one run, two of them wrong,
 * on the screen an operator reads to decide whether ingestion works.
 *
 * A console that overstates what was collected is the failure this project
 * exists to report on, so the frontend now uses the backend's definition.
 *
 * ## Why this test reads the backend off disk
 *
 * The frontend cannot import from the backend — separate packages, separate
 * tsconfigs, no dependency either way. So the key lists are **mirrored**, and a
 * mirror is only safe if something fails when it stops matching. This reads
 * `scheduler.ts` as text and compares, the same technique
 * `backend/test/workflow-monitor-env.test.ts` uses on the workflow YAML rather
 * than taking on a YAML parser.
 *
 * The cost is stated plainly: this matches on source text, so it verifies the
 * *declarations*. That is why a matcher which finds nothing fails loudly rather
 * than comparing two empty lists and reporting success.
 */

const SCHEDULER = join(
  __dirname,
  "..",
  "..",
  "..",
  "backend",
  "src",
  "services",
  "ingestion",
  "scheduler.ts",
);

/** Pull the string members out of `export const <name> = [...] as const;`. */
function declaredKeys(source: string, name: string): string[] {
  const match = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`,
    "m",
  ).exec(source);
  if (match === null) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the run-tally key lists mirror the backend", () => {
  const source = readFileSync(SCHEDULER, "utf8");

  it("finds both declarations in scheduler.ts", () => {
    expect(
      declaredKeys(source, "SUCCESS_KEYS").length,
      "could not find SUCCESS_KEYS in scheduler.ts — the matcher is broken or the " +
        "declaration moved. That is a failure of this guard, not a pass.",
    ).toBeGreaterThan(0);
    expect(
      declaredKeys(source, "FAILURE_KEYS").length,
      "could not find FAILURE_KEYS in scheduler.ts — the matcher is broken.",
    ).toBeGreaterThan(0);
  });

  it("SUCCESS_KEYS matches the backend exactly, in order", () => {
    expect(
      [...SUCCESS_KEYS],
      "the frontend's SUCCESS_KEYS has drifted from the backend's. The console " +
        "would report a different number of records than the API does for the same run.",
    ).toEqual(declaredKeys(source, "SUCCESS_KEYS"));
  });

  it("FAILURE_KEYS matches the backend exactly, in order", () => {
    expect([...FAILURE_KEYS]).toEqual(declaredKeys(source, "FAILURE_KEYS"));
  });

  it("no key is counted as both a success and a failure", () => {
    const overlap = SUCCESS_KEYS.filter((key) =>
      (FAILURE_KEYS as readonly string[]).includes(key),
    );
    expect(overlap, `counted twice: ${overlap.join(", ")}`).toEqual([]);
  });
});

describe("recordsIn and failuresIn", () => {
  /** The production shape: nothing landed, and other keys carry numbers. */
  const partialRun = { discovered: 0, fetched: 0, skipped: 45, unchanged: 46 };

  it("does not count keys that are neither successes nor failures", () => {
    expect(
      recordsIn(partialRun),
      "a run that landed nothing must report 0 records however many other " +
        "tallies its counts carry. Summing the whole map is what produced " +
        '"91 records" for a run the API reported as 0.',
    ).toBe(0);
    expect(failuresIn(partialRun)).toBe(0);
  });

  it("counts only the success keys as records", () => {
    expect(recordsIn({ discovered: 3, fetched: 4, parsed: 2, analyzed: 1 })).toBe(10);
  });

  it("never counts a failure as a record", () => {
    const run = { fetched: 2, failed: 90, blocked: 1 };
    expect(
      recordsIn(run),
      "a failure counted as a record is an operator console overstating what " +
        "was collected — the exact failure this project reports on elsewhere.",
    ).toBe(2);
    expect(failuresIn(run)).toBe(91);
  });

  it("treats a missing key as zero rather than NaN", () => {
    expect(recordsIn({})).toBe(0);
    expect(failuresIn({})).toBe(0);
    expect(processedIn({})).toBe(0);
    expect(outstandingIn({})).toBe(0);
  });
});

describe("the exact shape production writes", () => {
  /**
   * Read off `GET /api/admin/pressroom/sources` on 2026-08-16. This is what a
   * real sweep of the Bozeman archive records, and it is the case every wrong
   * number in this file's history came from: 90 + 1 = the notorious 91.
   */
  const REAL = { processed: 90, outstanding: 1 };

  it("attributes no records to a sweep that only drained a backlog", () => {
    expect(
      recordsIn(REAL),
      "`processed` counts jobs an EARLIER run enqueued, and that work is already " +
        "counted in that run's own counts. Adding it here would double-count, and " +
        "would do it inside lifetime_records, which sums recordsIn over every run.",
    ).toBe(0);
  });

  it("counts none of it as a failure", () => {
    expect(failuresIn(REAL)).toBe(0);
  });

  it("surfaces the work and the backlog under their own names", () => {
    expect(processedIn(REAL)).toBe(90);
    expect(outstandingIn(REAL)).toBe(1);
  });

  it("never totals 91 again", () => {
    const total =
      recordsIn(REAL) + failuresIn(REAL) + processedIn(REAL) + outstandingIn(REAL);
    expect(
      recordsIn(REAL) + failuresIn(REAL),
      "records plus failures must not absorb the backlog. The console read " +
        '"91 records" for this run while the API reported 0 and the counter beside ' +
        "it read 0 — three numbers for one sweep, two of them wrong.",
    ).toBe(0);
    // The four figures do sum to 91; the point is that no single label claims it.
    expect(total).toBe(91);
  });
});
