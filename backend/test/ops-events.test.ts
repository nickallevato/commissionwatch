import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  asOpsEvent,
  lastOpsEventOccurredAt,
  OPS_EVENTS,
  opsEventPayload,
  parseOpsEventArgs,
  recordOpsEvent,
} from "../src/services/delivery/ops-events";
import db from "../src/config/database";

/**
 * The argument surface `deploy/backup.sh` calls across.
 *
 * It is a shell script passing strings to a compiled binary, which is the least
 * type-safe boundary in the whole product, so it gets an explicit test rather
 * than a hope.
 */

describe("asOpsEvent", () => {
  it("accepts every declared event", () => {
    for (const event of OPS_EVENTS) {
      assert.equal(asOpsEvent(event), event);
    }
  });

  it("refuses anything else, including a near miss", () => {
    // A typo must be a refusal, not a deliveries row nobody has a route for.
    assert.equal(asOpsEvent("ops.backup_suceeded"), null);
    assert.equal(asOpsEvent("anomaly.detected"), null);
    assert.equal(asOpsEvent(undefined), null);
  });
});

describe("parseOpsEventArgs", () => {
  it("reads the flags backup.sh sends", () => {
    const args = parseOpsEventArgs([
      "--event",
      "ops.backup_succeeded",
      "--detail",
      "archive 1810268 bytes",
      "--source",
      "backup.sh",
    ]);
    assert.equal(args.event, "ops.backup_succeeded");
    assert.equal(args.detail, "archive 1810268 bytes");
    assert.equal(args.source, "backup.sh");
  });

  it("makes a failure critical and a success low without being told", () => {
    assert.equal(parseOpsEventArgs(["--event", "ops.backup_failed"]).severity, "critical");
    assert.equal(parseOpsEventArgs(["--event", "ops.backup_succeeded"]).severity, "low");
    assert.equal(parseOpsEventArgs(["--event", "ops.restore_drill_failed"]).severity, "critical");
  });

  it("lets an explicit severity win", () => {
    const args = parseOpsEventArgs(["--event", "ops.backup_failed", "--severity", "medium"]);
    assert.equal(args.severity, "medium");
  });

  it("requires an event", () => {
    assert.throws(() => parseOpsEventArgs([]), /--event is required/);
  });

  it("refuses an unknown event by name", () => {
    assert.throws(
      () => parseOpsEventArgs(["--event", "ops.everything_is_fine"]),
      /--event must be one of/,
    );
  });

  it("refuses a flag with no value rather than silently dropping it", () => {
    assert.throws(
      () => parseOpsEventArgs(["--event", "ops.backup_failed", "--detail"]),
      /--detail needs a value/,
    );
  });

  it("refuses a bare positional argument", () => {
    assert.throws(() => parseOpsEventArgs(["ops.backup_failed"]), /expected a --flag/);
  });
});

describe("opsEventPayload", () => {
  it("carries the detail, the source and the host", () => {
    const args = parseOpsEventArgs(["--event", "ops.backup_failed", "--detail", "disk full"]);
    assert.deepEqual(opsEventPayload(args, "i-0123456789abcdef0"), {
      detail: "disk full",
      source: "ops",
      host: "i-0123456789abcdef0",
    });
  });
});

/**
 * `ops_event_log` — the durable, unconditional record `/api/health` reads and
 * `external-monitor.ts`'s `evaluateBackupFreshness` judges. Unlike
 * `deliveries`, a row here does not depend on any channel being configured,
 * which is the whole point: see migration `107_create_ops_event_log`.
 */
describe("recordOpsEvent / lastOpsEventOccurredAt", () => {
  afterEach(async () => {
    await db("ops_event_log").where({ source: "ops-events.test" }).del();
  });

  after(async () => {
    await db.destroy();
  });

  it("returns null when nothing of that type has ever been recorded", async () => {
    const at = await lastOpsEventOccurredAt(db, "ops.restore_drill_succeeded");
    assert.equal(at, null);
  });

  it("records an event unconditionally, with no delivery channel required", async () => {
    const occurredAt = new Date("2026-08-16T04:17:03Z");
    await recordOpsEvent(db, {
      event: "ops.backup_succeeded",
      detail: "archive 1810268 bytes",
      source: "ops-events.test",
      severity: "low",
      host: "test-host",
      occurredAt,
    });

    const at = await lastOpsEventOccurredAt(db, "ops.backup_succeeded");
    assert.ok(at !== null);
    assert.equal(at?.toISOString(), occurredAt.toISOString());
  });

  it("returns the most recent occurrence when several are recorded", async () => {
    const older = new Date("2026-08-14T04:17:00Z");
    const newer = new Date("2026-08-16T04:17:00Z");
    for (const occurredAt of [older, newer]) {
      await recordOpsEvent(db, {
        event: "ops.backup_succeeded",
        detail: "archive",
        source: "ops-events.test",
        severity: "low",
        host: "test-host",
        occurredAt,
      });
    }

    const at = await lastOpsEventOccurredAt(db, "ops.backup_succeeded");
    assert.equal(at?.toISOString(), newer.toISOString());
  });
});
