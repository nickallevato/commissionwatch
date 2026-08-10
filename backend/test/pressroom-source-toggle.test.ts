import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { setSourceEnabled } from "../src/services/pressroom/sources";
import { cleanupByPrefix, createSource, signInOperator } from "./helpers/pressroom";

/**
 * Turning a source on, from the console.
 *
 * This closes the gap that kept the live site empty: every source registers
 * disabled — deliberately, since a source that sweeps the moment it deploys is
 * a source nobody chose — and until now nothing but `src/scripts/sweep.ts`
 * could flip the flag back. That script is not in the production image, which
 * ships `dist/` and `migrations/` and never `src/`. So the only way to go live
 * was hand-written SQL on the host, which is exactly what
 * `services/ingestion/registration.ts` says it exists to avoid.
 *
 * The toggle is a decision with a reason, and it leaves a row. It lands in
 * `operator_actions` rather than `record_corrections`: the first attempt used
 * the corrections log and the database refused it, because migration 031 CHECKs
 * `target_table` against the three record tables. That refusal was right —
 * `record_corrections` is published as the public corrections log, and a
 * configuration change listed there would read as a correction to the record.
 * See migration 071.
 */

const PREFIX = "pressroom-toggle-test";
const EMAIL = "pressroom-toggle-test@example.invalid";

let cookie = "";

before(async () => {
  cookie = await signInOperator(EMAIL, "Toggle Tester");
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db("operators").where({ email: EMAIL }).del();
  // `operator_actions` is append-only by trigger, so this suite's rows stay.
  // They are keyed to suite-generated source ids and assert nothing table-wide,
  // which is the same accommodation `record_corrections` already requires.
  await db.destroy();
});

describe("enabling a source", () => {
  it("flips enabled and clears the reason it was off", async () => {
    const { sourceId } = await createSource(PREFIX, {
      enabled: false,
      disabledReason: "Registered disabled, as every source is.",
    });

    const result = await setSourceEnabled(db, sourceId, {
      enabled: true,
      reason: "Operator reviewed the adapter and authorised first light.",
      actor: { id: null, email: EMAIL },
    });

    assert.equal(result.enabled, true);
    // The reason a source *was* disabled is not the reason it is enabled, and
    // leaving the old text on an enabled row makes the console read as though
    // it were still blocked.
    assert.equal(result.disabled_reason, null);

    const row = await db("ingestion_sources").where({ id: sourceId }).first("enabled", "disabled_reason");
    assert.equal(row.enabled, true);
    assert.equal(row.disabled_reason, null);
  });

  it("records the decision in the append-only operator log", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });

    await setSourceEnabled(db, sourceId, {
      enabled: true,
      reason: "First light for Gallatin.",
      actor: { id: null, email: EMAIL },
    });

    const logged = await db("operator_actions")
      .where({ target_table: "ingestion_sources", target_id: sourceId })
      .orderBy("created_at", "desc")
      .first();

    assert.ok(logged, "enabling a source wrote no operator_actions row");
    assert.equal(logged.action, "source.enabled");
    assert.equal(logged.old_value, "false");
    assert.equal(logged.new_value, "true");
    assert.equal(logged.reason, "First light for Gallatin.");
    assert.equal(logged.operator_email, EMAIL);
  });

  it("keeps that log append-only, in the database", async () => {
    // The property migration 071 exists to guarantee. A convention is what an
    // agent in a hurry edits around; a trigger is not.
    const { sourceId } = await createSource(PREFIX, { enabled: false });
    await setSourceEnabled(db, sourceId, {
      enabled: true,
      reason: "Authorised.",
      actor: { id: null, email: EMAIL },
    });

    await assert.rejects(
      () =>
        db("operator_actions")
          .where({ target_table: "ingestion_sources", target_id: sourceId })
          .update({ reason: "rewritten" }),
      /append-only/,
    );
    await assert.rejects(
      () =>
        db("operator_actions")
          .where({ target_table: "ingestion_sources", target_id: sourceId })
          .del(),
      /append-only/,
    );
  });

  it("refuses to log an action the schema does not name", async () => {
    // The CHECK on `action` is what keeps this log a small, readable set rather
    // than whatever string the last caller happened to pass.
    const { sourceId } = await createSource(PREFIX, { enabled: false });
    await assert.rejects(
      () =>
        db("operator_actions").insert({
          action: "source.fiddled_with",
          target_table: "ingestion_sources",
          target_id: sourceId,
          reason: "not a named action",
        }),
      /operator_actions_action_check/,
    );
  });

  it("refuses a toggle with no reason", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });

    await assert.rejects(
      () =>
        setSourceEnabled(db, sourceId, {
          enabled: true,
          reason: "   ",
          actor: { id: null, email: EMAIL },
        }),
      /reason is required/,
    );

    const row = await db("ingestion_sources").where({ id: sourceId }).first("enabled");
    assert.equal(row.enabled, false, "a refused toggle still changed the row");
  });

  it("keeps the stated reason when disabling", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: true });

    const result = await setSourceEnabled(db, sourceId, {
      enabled: false,
      reason: "Custodian asked us to stop while they migrate the portal.",
      actor: { id: null, email: EMAIL },
    });

    assert.equal(result.enabled, false);
    // Decision 3 on the sources screen: a disabled source stays listed and the
    // reason travels with it. That is only true if disabling writes one.
    assert.equal(
      result.disabled_reason,
      "Custodian asked us to stop while they migrate the portal.",
    );
  });

  it("404s on a source that does not exist", async () => {
    await assert.rejects(
      () =>
        setSourceEnabled(db, "00000000-0000-0000-0000-000000000000", {
          enabled: true,
          reason: "nothing to enable",
          actor: { id: null, email: EMAIL },
        }),
      /not found/i,
    );
  });
});

describe("PATCH /api/admin/pressroom/sources/:id", () => {
  it("is closed to anyone without a session", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });
    await request(app)
      .patch(`/api/admin/pressroom/sources/${sourceId}`)
      .send({ enabled: true, reason: "should never apply" })
      .expect(401);

    const row = await db("ingestion_sources").where({ id: sourceId }).first("enabled");
    assert.equal(row.enabled, false);
  });

  it("enables a source for a signed-in operator", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });

    const res = await request(app)
      .patch(`/api/admin/pressroom/sources/${sourceId}`)
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "Authorised for first light." })
      .expect(200);

    assert.equal(res.body.enabled, true);
    const row = await db("ingestion_sources").where({ id: sourceId }).first("enabled");
    assert.equal(row.enabled, true);
  });

  it("rejects a missing reason with 400, not a silent default", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });

    await request(app)
      .patch(`/api/admin/pressroom/sources/${sourceId}`)
      .set("Cookie", cookie)
      .send({ enabled: true })
      .expect(400);
  });

  it("rejects a non-boolean enabled with 400", async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: false });

    await request(app)
      .patch(`/api/admin/pressroom/sources/${sourceId}`)
      .set("Cookie", cookie)
      .send({ enabled: "yes", reason: "a string is not a decision" })
      .expect(400);
  });

  it("rejects a malformed id with 400", async () => {
    await request(app)
      .patch("/api/admin/pressroom/sources/not-a-uuid")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "malformed" })
      .expect(400);
  });

  it("404s on an unknown source", async () => {
    await request(app)
      .patch("/api/admin/pressroom/sources/00000000-0000-0000-0000-000000000000")
      .set("Cookie", cookie)
      .send({ enabled: true, reason: "unknown" })
      .expect(404);
  });
});
