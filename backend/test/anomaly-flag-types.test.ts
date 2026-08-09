import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";

// The enum is the contract between the detectors and the database. A detector
// that raises a flag type the enum does not carry fails at insert time, in
// production, on real data — so the permitted set is asserted here rather than
// discovered later.
describe("anomaly_flag_type enum", () => {
  after(async () => {
    await db.destroy();
  });

  it("carries vote_donor_conflict", async () => {
    const { rows } = await db.raw(
      `SELECT unnest(enum_range(NULL::anomaly_flag_type))::text AS value`,
    );
    const values = rows.map((r: { value: string }) => r.value);

    assert.ok(
      values.includes("vote_donor_conflict"),
      `expected vote_donor_conflict in enum, got: ${values.join(", ")}`,
    );
  });

  it("still carries every value migration 011 created", async () => {
    const { rows } = await db.raw(
      `SELECT unnest(enum_range(NULL::anomaly_flag_type))::text AS value`,
    );
    const values = rows.map((r: { value: string }) => r.value);

    for (const original of [
      "emergency_session",
      "closed_door_vote",
      "last_minute_agenda_change",
      "quorum_issue",
      "unanimous_controversial",
      "missing_minutes",
    ]) {
      assert.ok(values.includes(original), `enum lost ${original}`);
    }
  });
});
