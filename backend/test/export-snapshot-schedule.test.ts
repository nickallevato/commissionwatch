import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import knex from "knex";
import app from "../src/app";
import db from "../src/config/database";
import { listSnapshots } from "../src/services/export/archive";
import { SOURCE_LOCK_NAMESPACE } from "../src/services/ingestion/scheduler";
import {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  ExportSnapshotScheduler,
  SNAPSHOT_LOCK_KEY,
  listSnapshotRuns,
  recordSnapshotRun,
  utcDay,
} from "../src/services/export/snapshot-scheduler";
import { FeatureRegistry, setFeatureRegistry } from "../src/services/features/registry";
import {
  cleanupByPrefix,
  createMeeting,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * G3a — the dated export archive gets a scheduled path.
 *
 * The archive shipped in 0.4.0 with a writer nothing called. `takeSnapshot` was
 * reachable only through `npm run export:snapshot`, so the archive answered 404
 * for every date and would in practice have held one snapshot — taken the day
 * somebody tested it. Publication state is one mutable column, so a day nobody
 * recorded can never be reconstructed: a missed day is missed permanently, which
 * is what makes "a human remembers to run a command" the wrong entry point.
 *
 * What this suite holds:
 *
 * **Off means nothing is recorded, and the skip is visible.** The flag defaults
 * off and must stay off. A gated loop that does nothing quietly is
 * indistinguishable from a broken one, so the cycle writes an
 * `export_snapshot_runs` row and the operator console serves it. Both halves are
 * asserted — a ledger nothing reads is not a disclosure.
 *
 * **On means exactly one snapshot for the day**, and a second cycle that day is
 * a no-op: not a duplicate row, and not an error.
 *
 * **The flag is re-read per cycle.** Modelled on `feature-toggle-live.test.ts`,
 * which holds the same property for the drain and the prerender consumer: the
 * flag is flipped between cycles on one live instance, with no reconstruction, and
 * the behaviour changes. Latching a flag in a constructor is a bug this codebase
 * has already shipped once and must not ship again.
 *
 * Every name here is invented.
 */

const PREFIX = "export-snapshot-schedule-test";
const OPERATOR_EMAIL = "export-snapshot-schedule@example.invalid";

let registry: FeatureRegistry;
let publishedMeeting: string;
let cookie: string;

/**
 * Flips the switch the way the console does: audited, and no restart.
 *
 * `setFlag` refuses a no-op with a 409 — deliberately, so the audit log reads as
 * a list of changes rather than of clicks — so a test that only wants to *be* in
 * a state asks first. The check is on the resolution's source, not on the value:
 * writing `false` where there is no row is a real decision (it records having
 * chosen off) and only a row already saying `false` is the no-op.
 */
async function flip(enabled: boolean): Promise<void> {
  const current = registry.resolve("dated_export_archive");
  if (current.source === "registry" && current.enabled === enabled) return;
  await registry.setFlag(
    "dated_export_archive",
    enabled,
    null,
    `export-snapshot-schedule: ${enabled ? "on" : "off"}`,
  );
}

/**
 * `export_snapshot_datasets` and `export_snapshot_runs` both cascade from the
 * parent, so one delete clears all three — but the runs of a *skipped* cycle
 * have no parent, which is the whole point of them, so they are cleared by name.
 */
async function clearLedgers(): Promise<void> {
  await db("export_snapshot_runs").del();
  await db("export_snapshots").del();
}

async function snapshotCount(): Promise<number> {
  return (await listSnapshots(db)).length;
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  await db("features_audit").where({ key: "dated_export_archive" }).del();
  await db("features").where({ key: "dated_export_archive" }).del();

  cookie = await signInOperator(OPERATOR_EMAIL, "Snapshot Schedule Test");

  const fixture = await createSource(PREFIX, { enabled: false });
  publishedMeeting = await createMeeting(fixture.commissionId, {
    publishedAt: new Date(),
    date: "2026-04-08",
    location: `${PREFIX} chamber`,
  });

  registry = new FeatureRegistry(db, { env: {}, logger: { warn: () => {}, error: () => {} } });
  await registry.refresh();
  setFeatureRegistry(registry);
});

after(async () => {
  setFeatureRegistry(null);
  await clearLedgers();
  await db("features_audit").where({ key: "dated_export_archive" }).del();
  await db("features").where({ key: "dated_export_archive" }).del();
  await db("operators").where({ email: OPERATOR_EMAIL }).del();
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

beforeEach(async () => {
  await clearLedgers();
});

/* --------------------------------------------------------------------------
   1. The flag is off — nothing is written, and the skip is not silent
   -------------------------------------------------------------------------- */

describe("with dated_export_archive off", () => {
  it("writes no snapshot, and records the skip where an operator can see it", async () => {
    await flip(false);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });

    const result = await scheduler.tick();
    assert.equal(result.outcome, "skipped_disabled");

    // Half one: nothing was recorded. The archive has no data for today, and the
    // flag being off is why.
    assert.equal(await snapshotCount(), 0, "a snapshot was taken with the flag off");

    // Half two: and that is written down. A loop that skips silently is
    // indistinguishable from a loop that has stopped, and the operator turning
    // the switch on later needs to be able to tell which they had.
    const runs = await listSnapshotRuns(db);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "skipped_disabled");
    assert.equal(runs[0].run_day, utcDay(new Date()));
    assert.equal(runs[0].snapshot_id, null);
    assert.match(runs[0].detail ?? "", /dated_export_archive feature is off/);
  });

  it("collapses repeated skips into one day's row with a count and a last-seen time", async () => {
    // The loop wakes hourly. A row per cycle would be 24 rows a day saying the
    // same thing forever, and the fact worth keeping is not "it skipped again",
    // it is that the loop is still alive — which is `cycles` and `last_at`.
    await flip(false);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    const runs = await listSnapshotRuns(db);
    assert.equal(runs.length, 1, "a skipped cycle wrote a row per tick");
    assert.equal(runs[0].cycles, 3);
    assert.ok(runs[0].last_at.getTime() >= runs[0].first_at.getTime());
    assert.equal(await snapshotCount(), 0);
  });

  it("serves the skip on the operator console beside the switch", async () => {
    // The ledger is only a disclosure if something reads it. `/api/data/archive`
    // 404s while the flag is off, so the archive cannot report on its own
    // scheduler; the features console is the screen with that switch on it.
    await flip(false);
    await new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    }).tick();

    const res = await request(app)
      .get("/api/admin/features")
      .set("Cookie", cookie)
      .expect(200);
    const runs = res.body.snapshotRuns as Array<{
      day: string;
      outcome: string;
      cycles: number;
      detail: string | null;
    }>;
    assert.ok(Array.isArray(runs), "the console does not serve the snapshot ledger");
    const today = runs.find((run) => run.day === utcDay(new Date()));
    assert.ok(today, "today's skipped cycle is not on the console");
    assert.equal(today.outcome, "skipped_disabled");
    assert.match(today.detail ?? "", /no snapshot was taken/);

    // And the console states how long the loop takes to notice a flip, from the
    // loop's own constant rather than a number typed into a frontend.
    assert.equal(res.body.cycleIntervalMs.dated_export_archive, DEFAULT_SNAPSHOT_INTERVAL_MS);
  });

  it("is off by default, with no row at all", async () => {
    // Not "off because a row says so" — off because nothing says otherwise. This
    // is the state a fresh deployment is in and the state it must stay in.
    await db("features_audit").where({ key: "dated_export_archive" }).del();
    await db("features").where({ key: "dated_export_archive" }).del();
    await registry.refresh();

    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal(scheduler.enabled, false);
    assert.equal((await scheduler.tick()).outcome, "skipped_disabled");
    assert.equal(await snapshotCount(), 0);
  });
});

/* --------------------------------------------------------------------------
   2. The flag is on — one snapshot a day, and a second cycle is a no-op
   -------------------------------------------------------------------------- */

describe("with dated_export_archive on", () => {
  it("takes exactly one snapshot for the day, and records it", async () => {
    await flip(true);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });

    const result = await scheduler.tick();
    assert.equal(result.outcome, "taken");
    assert.ok(result.snapshotId);

    const snapshots = await listSnapshots(db);
    assert.equal(snapshots.length, 1, "a cycle took more or fewer than one snapshot");
    assert.equal(snapshots[0].id, result.snapshotId);
    // A scheduled snapshot has no author, and inventing one would be worse than
    // the null migration 105 allows for exactly this.
    assert.equal(snapshots[0].note, null);

    const runs = await listSnapshotRuns(db);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "taken");
    assert.equal(runs[0].snapshot_id, result.snapshotId);
    assert.match(runs[0].detail ?? "", /dataset\(s\)/);
  });

  it("serves the day it just recorded, through the archive route", async () => {
    // The end of the defect: the archive had a writer nothing called, so every
    // date 404'd. One scheduled cycle is now enough to make today answerable.
    await flip(true);
    await new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    }).tick();

    const day = utcDay(new Date());
    const res = await request(app).get(`/api/data/archive/${day}/meetings.json`).expect(200);
    const rows = res.body.rows as Array<{ id: string }>;
    assert.ok(
      rows.some((row) => row.id === publishedMeeting),
      "the scheduled snapshot did not record the published meeting",
    );
  });

  it("is a no-op on a second cycle the same day: no duplicate row, and no error", async () => {
    await flip(true);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });

    const first = await scheduler.tick();
    assert.equal(first.outcome, "taken");

    // Not a throw, and not a second snapshot. The day is the archive's unit of
    // address, so it is the unit of idempotence.
    const second = await scheduler.tick();
    assert.equal(second.outcome, "skipped_same_day");
    assert.equal(second.snapshotId, first.snapshotId);

    const third = await scheduler.tick();
    assert.equal(third.outcome, "skipped_same_day");

    assert.equal(await snapshotCount(), 1, "a second cycle duplicated the day's snapshot");

    const runs = await listSnapshotRuns(db);
    const outcomes = runs.map((run) => run.outcome).sort();
    assert.deepEqual(outcomes, ["skipped_same_day", "taken"]);
    const repeat = runs.find((run) => run.outcome === "skipped_same_day");
    assert.ok(repeat);
    assert.equal(repeat.cycles, 2, "the repeat cycles were not counted");
  });

  it("records a new day as a new snapshot", async () => {
    // The clock is injected, so "tomorrow" is a test rather than a wait. Without
    // this the same-day guard would be indistinguishable from a loop that takes
    // one snapshot ever.
    await flip(true);
    const days = ["2026-04-08T09:00:00.000Z", "2026-04-09T09:00:00.000Z"];
    let index = 0;
    const scheduler = new ExportSnapshotScheduler(db, {
      now: () => new Date(days[Math.min(index, days.length - 1)]),
      logger: { warn: () => {}, error: () => {} },
    });

    assert.equal((await scheduler.tick()).outcome, "taken");
    index = 1;
    assert.equal((await scheduler.tick()).outcome, "taken");
    assert.equal(await snapshotCount(), 2);

    const runs = await listSnapshotRuns(db);
    assert.deepEqual(
      runs.map((run) => run.run_day).sort(),
      ["2026-04-08", "2026-04-09"],
      "the ledger did not address the two cycles as two days",
    );
  });

  it("takes nothing on start(); the first snapshot is the first tick", async () => {
    // The boot-safety rule `SourceScheduler` states: a crash-looping container
    // must not turn a restart into a full read of every dataset.
    await flip(true);
    const scheduler = new ExportSnapshotScheduler(db, {
      intervalMs: 60_000,
      logger: { warn: () => {}, error: () => {} },
    });
    scheduler.start();
    scheduler.stop();
    assert.equal(await snapshotCount(), 0);
  });
});

/* --------------------------------------------------------------------------
   3. The flag is read per cycle, on a live instance
   -------------------------------------------------------------------------- */

describe("the snapshot scheduler re-reads its flag per cycle", () => {
  it("starts recording within one cycle of the flag going on, with no restart", async () => {
    await flip(false);
    // One object, constructed while the flag is off, used across the flip. This
    // is the whole property: latching the flag in the constructor is the bug
    // 0.4.0 shipped in the drain and the consumer, and a switch that needs a
    // redeploy is the thing the console exists to remove.
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal(scheduler.enabled, false);

    assert.equal((await scheduler.tick()).outcome, "skipped_disabled");
    assert.equal(await snapshotCount(), 0, "precondition: the flag is off");

    await flip(true);

    assert.equal(scheduler.enabled, true, "the flip did not reach the running scheduler");
    assert.equal((await scheduler.tick()).outcome, "taken");
    assert.equal(await snapshotCount(), 1);
  });

  it("stops recording within one cycle of the flag going off", async () => {
    // The direction an operator uses when something is going wrong, so it is the
    // direction that must not need a deploy.
    await flip(true);
    const scheduler = new ExportSnapshotScheduler(db, {
      now: () => new Date("2026-04-08T09:00:00.000Z"),
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal((await scheduler.tick()).outcome, "taken");

    await flip(false);
    // A different day, so the same-day guard cannot be what stops it — the flag
    // has to be.
    const tomorrow = new ExportSnapshotScheduler(db, {
      now: () => new Date("2026-04-09T09:00:00.000Z"),
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal((await tomorrow.tick()).outcome, "skipped_disabled");
    assert.equal(await snapshotCount(), 1, "a snapshot was taken after the flag went off");

    const runs = await listSnapshotRuns(db);
    const skipped = runs.find((run) => run.run_day === "2026-04-09");
    assert.ok(skipped, "the day the loop skipped is not in the ledger");
    assert.equal(skipped.outcome, "skipped_disabled");
  });

  it("logs the transition, not the state", async () => {
    // A line every hour saying nothing happened is how the line that matters gets
    // scrolled past. The durable record of a skip is the ledger row; the log
    // carries the two facts a line is good at.
    const lines: string[] = [];
    await flip(false);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: (message) => lines.push(message), error: () => {} },
    });

    await scheduler.tick();
    await scheduler.tick();
    assert.equal(lines.length, 1, "the disabled state was logged per cycle");
    assert.match(lines[0], /no snapshot will be taken/);

    await flip(true);
    await scheduler.tick();
    assert.equal(lines.length, 2, "the on transition was not logged");
    assert.match(lines[1], /enabled by the dated_export_archive feature/);

    await scheduler.tick();
    assert.equal(lines.length, 2, "the unchanged state was logged again");

    await flip(false);
    await scheduler.tick();
    assert.equal(lines.length, 3, "the off transition was not logged");
    assert.match(lines[2], /no further snapshot will be taken/);
  });

  it("keeps an explicit `enabled` option winning over the registry", async () => {
    await flip(true);
    const pinnedOff = new ExportSnapshotScheduler(db, {
      enabled: false,
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal(pinnedOff.enabled, false);
    assert.equal((await pinnedOff.tick()).outcome, "skipped_disabled");
    assert.equal(await snapshotCount(), 0, "a scheduler pinned off took a snapshot");

    await flip(false);
    assert.equal(
      new ExportSnapshotScheduler(db, { enabled: true }).enabled,
      true,
      "the option must win, or a suite could not pin the loop without a database row",
    );
  });
});

/* --------------------------------------------------------------------------
   4. A failure is recorded, not swallowed
   -------------------------------------------------------------------------- */

describe("a cycle that cannot do its work", () => {
  it("skips rather than duplicating when another process holds the lock", async () => {
    // Two containers both wake on their own timer, and the same-day check is a
    // read followed by a write. The advisory lock is what makes that race a skip
    // instead of two snapshots for one day.
    await flip(true);
    const scheduler = new ExportSnapshotScheduler(db, {
      logger: { warn: () => {}, error: () => {} },
    });

    await db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [
        SOURCE_LOCK_NAMESPACE,
        SNAPSHOT_LOCK_KEY,
      ]);
      const result = await scheduler.tick();
      assert.equal(result.outcome, "skipped_locked");
    });

    assert.equal(await snapshotCount(), 0, "a locked cycle took a snapshot anyway");
    const runs = await listSnapshotRuns(db);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "skipped_locked");

    // And the lock is released with the transaction, so the next cycle works.
    assert.equal((await scheduler.tick()).outcome, "taken");
  });

  it("records a failure in the ledger, with its error text", async () => {
    // The ledger's own guarantee, asserted against the real table: a failed
    // cycle is a row somebody can read, not a log line that scrolls away.
    const day = "2026-04-10";
    await recordSnapshotRun(db, {
      day,
      outcome: "failed",
      detail: "Error: the export could not be read",
    });
    await recordSnapshotRun(db, { day, outcome: "failed", detail: "Error: and again" });

    const runs = await listSnapshotRuns(db);
    const failed = runs.find((run) => run.run_day === day);
    assert.ok(failed);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.cycles, 2);
    // The newest error wins: for a repeated failure the current one is what an
    // operator needs, and the first is not more true for being first.
    assert.equal(failed.detail, "Error: and again");
  });

  it("does not throw into the timer when the database itself is gone", async () => {
    // The failure a scheduler must survive. A rethrow here would become an
    // unhandled rejection inside `setInterval` and take the process with it,
    // which is a worse outcome than a missed snapshot.
    await flip(true);
    const unreachable = knex({
      client: "pg",
      // A port nothing is listening on: `ECONNREFUSED`, immediately.
      connection: "postgresql://postgres:postgres@127.0.0.1:59999/nothing",
      pool: { min: 0, max: 1 },
      acquireConnectionTimeout: 2_000,
    });
    const errors: string[] = [];
    const scheduler = new ExportSnapshotScheduler(unreachable, {
      logger: { warn: () => {}, error: (message) => errors.push(message) },
    });

    try {
      const result = await scheduler.tick();
      assert.equal(result.outcome, "failed");
      assert.notEqual(result.detail, "");
      // Nothing swallowed: both the cycle failure and the fact that even the
      // ledger row could not be written are reported.
      assert.equal(errors.length, 2);
      assert.match(errors[0], /cycle for .* failed/);
      assert.match(errors[1], /could not record the failed cycle/);
    } finally {
      await unreachable.destroy();
    }
  });
});
