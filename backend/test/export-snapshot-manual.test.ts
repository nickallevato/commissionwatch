import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { listSnapshots, snapshotOn } from "../src/services/export/archive";
import {
  parseSnapshotArgs,
  takeManualSnapshot,
} from "../src/services/export/manual-snapshot";
import {
  ExportSnapshotScheduler,
  listSnapshotRuns,
  snapshotTakenOn,
  utcDay,
} from "../src/services/export/snapshot-scheduler";

/**
 * G3c — the manual snapshot command stops silently superseding the scheduler.
 *
 * `npm run export:snapshot` predates the scheduler. Run on a day the scheduler
 * had already recorded, it added a second snapshot for that day; `snapshotOn`
 * resolves a date to the latest snapshot on or before it, so the manual one
 * quietly became the archive's answer for that date while the ledger's `taken`
 * row went on naming the earlier one. Nothing was corrupt and nothing said
 * anything: `export_snapshot_runs` and `export_snapshots` simply disagreed about
 * what represented that day.
 *
 * What this suite holds:
 *
 * **A same-day manual run is refused**, names the snapshot that holds the day,
 * and writes nothing at all.
 *
 * **`--force` supersedes deliberately and says so in the ledger** — the day's
 * `taken` row is moved to the new snapshot, so the two tables agree afterwards.
 *
 * **A day with no snapshot behaves as it always did**, and records its own
 * `taken` row rather than leaving a snapshot no ledger row claims.
 *
 * Every assertion about "agreement" is the same explicit check: the snapshot the
 * archive would serve for the day *is* the snapshot the ledger says was taken
 * that day.
 */

const SILENT = { warn: (): void => {}, error: (): void => {} };

async function clearLedgers(): Promise<void> {
  await db("export_snapshot_runs").del();
  await db("export_snapshots").del();
}

/** The `taken` row for a day, if the ledger has one. */
async function takenRow(day: string): Promise<{ snapshot_id: string | null; detail: string | null } | null> {
  const runs = await listSnapshotRuns(db, { days: 2 });
  const row = runs.find((run) => run.run_day === day && run.outcome === "taken");
  return row === undefined ? null : { snapshot_id: row.snapshot_id, detail: row.detail };
}

/**
 * The two tables agree about the day.
 *
 * Read from both sides independently: `snapshotOn` is what a reader of
 * `/api/data/archive/{day}` gets, `takenRow` is what the operator console shows.
 * The bug was exactly that these two could differ with nothing reporting it.
 */
async function assertLedgerAgreesWithArchive(day: string): Promise<void> {
  const served = await snapshotOn(db, day);
  const taken = await takenRow(day);
  assert.notEqual(served, null, `the archive can answer for no snapshot on ${day}`);
  assert.notEqual(taken, null, `the ledger has no taken row for ${day}`);
  assert.equal(
    taken?.snapshot_id,
    served?.id,
    `the ledger names ${String(taken?.snapshot_id)} for ${day} but the archive serves ${String(served?.id)}`,
  );
}

beforeEach(async () => {
  await clearLedgers();
});

after(async () => {
  await clearLedgers();
  await db.destroy();
});

/* --------------------------------------------------------------------------
   1. A day the scheduler already recorded
   -------------------------------------------------------------------------- */

describe("a manual snapshot on a day the scheduler already recorded", () => {
  it("refuses, names the snapshot holding the day, and writes nothing", async () => {
    const day = utcDay(new Date());
    const scheduler = new ExportSnapshotScheduler(db, { enabled: true, logger: SILENT });
    const scheduled = await scheduler.tick();
    assert.equal(scheduled.outcome, "taken");
    assert.notEqual(scheduled.snapshotId, null);

    const result = await takeManualSnapshot(db, { note: "an operator at 2am" });

    assert.equal(result.outcome, "refused_same_day");
    if (result.outcome !== "refused_same_day") return;
    assert.equal(result.day, day);
    assert.equal(result.existing?.id, scheduled.snapshotId);
    // The message has to name the snapshot and the flag, or the refusal is a
    // dead end rather than a decision handed back to the operator.
    assert.match(result.reason, /--force/);
    assert.ok(
      result.reason.includes(String(scheduled.snapshotId)),
      `the refusal does not name the snapshot holding the day: ${result.reason}`,
    );

    // Wrote nothing: still one snapshot, and the ledger untouched.
    assert.equal((await listSnapshots(db)).length, 1);
    const taken = await takenRow(day);
    assert.equal(taken?.snapshot_id, scheduled.snapshotId);
    await assertLedgerAgreesWithArchive(day);
  });

  it("supersedes on --force and moves the ledger's taken row with it", async () => {
    const day = utcDay(new Date());
    const scheduler = new ExportSnapshotScheduler(db, { enabled: true, logger: SILENT });
    const scheduled = await scheduler.tick();
    assert.equal(scheduled.outcome, "taken");

    const result = await takeManualSnapshot(db, { note: "before the bulk publish", force: true });

    assert.equal(result.outcome, "taken");
    if (result.outcome !== "taken") return;
    assert.equal(result.day, day);
    assert.equal(result.superseded?.id, scheduled.snapshotId);
    assert.equal(result.snapshot.note, "before the bulk publish");

    // Two snapshots exist — the earlier one is not deleted, because it happened.
    assert.equal((await listSnapshots(db)).length, 2);

    // The archive's answer for the day is the new one...
    const latest = await snapshotTakenOn(db, day);
    assert.equal(latest?.id, result.snapshot.id);
    assert.notEqual(result.snapshot.id, scheduled.snapshotId);

    // ...and the ledger says so, naming what it displaced.
    const taken = await takenRow(day);
    assert.equal(taken?.snapshot_id, result.snapshot.id);
    assert.ok(
      taken?.detail?.includes(String(scheduled.snapshotId)),
      `the ledger does not record what was superseded: ${String(taken?.detail)}`,
    );
    await assertLedgerAgreesWithArchive(day);
  });
});

/* --------------------------------------------------------------------------
   2. A day with no snapshot
   -------------------------------------------------------------------------- */

describe("a manual snapshot on a day with no snapshot", () => {
  it("takes one exactly as before, and claims the day in the ledger", async () => {
    const day = utcDay(new Date());
    assert.equal(await snapshotTakenOn(db, day), null);

    const result = await takeManualSnapshot(db, { note: "first ever" });

    assert.equal(result.outcome, "taken");
    if (result.outcome !== "taken") return;
    assert.equal(result.superseded, null);
    assert.equal(result.snapshot.note, "first ever");
    assert.ok(result.datasets.length > 0, "no dataset was recorded");
    assert.equal((await listSnapshots(db)).length, 1);
    assert.equal((await snapshotTakenOn(db, day))?.id, result.snapshot.id);
    await assertLedgerAgreesWithArchive(day);
  });

  it("leaves the scheduler's next cycle a no-op rather than a duplicate", async () => {
    const day = utcDay(new Date());
    const manual = await takeManualSnapshot(db, {});
    assert.equal(manual.outcome, "taken");
    if (manual.outcome !== "taken") return;

    const scheduler = new ExportSnapshotScheduler(db, { enabled: true, logger: SILENT });
    const tick = await scheduler.tick();

    assert.equal(tick.outcome, "skipped_same_day");
    assert.equal(tick.snapshotId, manual.snapshot.id);
    assert.equal((await listSnapshots(db)).length, 1);
    await assertLedgerAgreesWithArchive(day);
  });
});

/* --------------------------------------------------------------------------
   3. The flag
   -------------------------------------------------------------------------- */

describe("the command line", () => {
  it("parses --force alongside the flags it already took", () => {
    assert.deepEqual(parseSnapshotArgs([]), { note: null, list: false, force: false });
    assert.deepEqual(parseSnapshotArgs(["--force"]), { note: null, list: false, force: true });
    assert.deepEqual(parseSnapshotArgs(["--note", " a reason ", "--force"]), {
      note: "a reason",
      list: false,
      force: true,
    });
    assert.deepEqual(parseSnapshotArgs(["--list"]), { note: null, list: true, force: false });
    // An empty --note is still refused rather than silently recorded as absent.
    assert.throws(() => parseSnapshotArgs(["--note", "  "]), /--note needs a reason/);
  });
});
