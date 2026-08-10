import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  CorrectionError,
  listCorrections,
  recordCorrection,
} from "../src/services/pressroom/corrections";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * Decision 7 — corrections are append-only, and the artifact is never mutated.
 *
 * A transparency project that edits its own evidence has nothing left to stand
 * on. These tests hold both halves: the log cannot be rewritten, and the bytes
 * a claim came from are byte-identical either side of a correction to it.
 *
 * Nothing here deletes a `record_corrections` row. It cannot — migration 031
 * forbids it, which is exactly what the first test proves — so every assertion
 * is scoped to ids this suite generated rather than to a table-wide count.
 */

const PREFIX = "pressroom-corrections-test";
const EMAIL = "pressroom-corrections-test@example.invalid";
const SHA = sha256Of("pressroom-corrections");

const ACTOR = { id: null, email: "operator@example.invalid" };

describe("record corrections", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingId: string;
  let agendaItemId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA]);

    fixture = await createSource(PREFIX, { enabled: true });
    meetingId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      location: "Community Room",
    });
    const [item] = await db("agenda_items")
      .insert({
        meeting_id: meetingId,
        item_number: 1,
        title: "Resolution 5432 - Water Infrastructur Bond",
        category: null,
      })
      .returning<Array<{ id: string }>>("id");
    agendaItemId = item.id;

    await createArtifact(SHA, "https://example.invalid/pressroom-corrections/agenda.pdf");
    cookie = await signInOperator(EMAIL, "Corrections Operator");
  });

  after(async () => {
    // record_corrections is deliberately not cleaned: the trigger refuses, and
    // the rows are keyed on ids only this run generated.
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA]);
    await db("operators").where({ email: EMAIL }).del();
    await db.destroy();
  });

  it("is closed without a session", async () => {
    await request(app).get("/api/admin/pressroom/corrections").expect(401);
    await request(app).post("/api/admin/pressroom/corrections").send({}).expect(401);
  });

  it("appends a row carrying who, when, field, old, new and why", async () => {
    const correction = await recordCorrection(db, {
      targetTable: "agenda_items",
      targetId: agendaItemId,
      field: "title",
      newValue: "Resolution 5432 - Water Infrastructure Bond",
      reason: "The agenda PDF spells it Infrastructure; the parse dropped a letter.",
      actor: ACTOR,
    });

    assert.equal(correction.old_value, "Resolution 5432 - Water Infrastructur Bond");
    assert.equal(correction.new_value, "Resolution 5432 - Water Infrastructure Bond");
    assert.equal(correction.field, "title");
    assert.equal(correction.operator_email, ACTOR.email);
    assert.match(correction.reason, /dropped a letter/);
  });

  it("applies the correction to the live row", async () => {
    const row = await db("agenda_items")
      .where({ id: agendaItemId })
      .first<{ title: string } | undefined>("title");
    assert.equal(row?.title, "Resolution 5432 - Water Infrastructure Bond");
  });

  it("leaves the artifact byte-identical — the evidence is never edited", async () => {
    const before_ = await db("artifacts").where({ sha256: SHA }).first();
    await recordCorrection(db, {
      targetTable: "meetings",
      targetId: meetingId,
      field: "location",
      newValue: "Commission Chambers",
      reason: "The agenda names Commission Chambers; the listing was stale.",
      actor: ACTOR,
    });
    const after_ = await db("artifacts").where({ sha256: SHA }).first();
    assert.deepEqual(after_, before_);
  });

  it("refuses to let a correction be rewritten", async () => {
    // The whole claim rests on this. Enforced by a trigger, not a convention,
    // because a convention is what an agent in a hurry edits around.
    const [row] = await listCorrections(db, {
      targetTable: "agenda_items",
      targetId: agendaItemId,
    });
    await assert.rejects(
      () => db("record_corrections").where({ id: row.id }).update({ reason: "something else" }),
      /append-only/,
    );
  });

  it("refuses to let a correction be deleted", async () => {
    const [row] = await listCorrections(db, {
      targetTable: "agenda_items",
      targetId: agendaItemId,
    });
    await assert.rejects(
      () => db("record_corrections").where({ id: row.id }).del(),
      /append-only/,
    );
  });

  it("keeps superseded corrections rather than replacing them", async () => {
    await recordCorrection(db, {
      targetTable: "agenda_items",
      targetId: agendaItemId,
      field: "category",
      newValue: "action",
      reason: "The item sat under NEW BUSINESS; the parse found no heading.",
      actor: ACTOR,
    });
    const history = await listCorrections(db, {
      targetTable: "agenda_items",
      targetId: agendaItemId,
    });
    assert.equal(history.length, 2);
    // Newest first.
    assert.equal(history[0].field, "category");
    assert.equal(history[1].field, "title");
  });

  it("rejects a correction with no stated reason — that is an edit", async () => {
    await assert.rejects(
      () =>
        recordCorrection(db, {
          targetTable: "agenda_items",
          targetId: agendaItemId,
          field: "title",
          newValue: "Anything",
          reason: "   ",
          actor: ACTOR,
        }),
      (error: unknown) => error instanceof CorrectionError && error.statusCode === 400,
    );
  });

  it("rejects a field that is not correctable, and a table that is not either", async () => {
    // The field name reaches an UPDATE from an HTTP body. The set of columns an
    // operator has any business rewriting is small and worth writing down.
    await assert.rejects(
      () =>
        recordCorrection(db, {
          targetTable: "agenda_items",
          targetId: agendaItemId,
          field: "meeting_id",
          newValue: "00000000-0000-4000-8000-000000000000",
          reason: "Identity is not a correction.",
          actor: ACTOR,
        }),
      (error: unknown) => error instanceof CorrectionError && error.statusCode === 400,
    );
    await assert.rejects(
      () =>
        recordCorrection(db, {
          targetTable: "operators",
          targetId: agendaItemId,
          field: "email",
          newValue: "x@example.invalid",
          reason: "Not a record.",
          actor: ACTOR,
        }),
      (error: unknown) => error instanceof CorrectionError && error.statusCode === 400,
    );
  });

  it("refuses to clear a NOT NULL column rather than letting the driver 500", async () => {
    await assert.rejects(
      () =>
        recordCorrection(db, {
          targetTable: "agenda_items",
          targetId: agendaItemId,
          field: "title",
          newValue: null,
          reason: "An item with no title is not a correction.",
          actor: ACTOR,
        }),
      (error: unknown) => error instanceof CorrectionError && error.statusCode === 400,
    );
  });

  it("404s a target row that does not exist", async () => {
    await assert.rejects(
      () =>
        recordCorrection(db, {
          targetTable: "meetings",
          targetId: "00000000-0000-4000-8000-000000000000",
          field: "location",
          newValue: "Nowhere",
          reason: "There is no such meeting.",
          actor: ACTOR,
        }),
      (error: unknown) => error instanceof CorrectionError && error.statusCode === 404,
    );
  });

  it("accepts a correction over the API and returns 201, because it appended", async () => {
    const res = await request(app)
      .post("/api/admin/pressroom/corrections")
      .set("Cookie", cookie)
      .send({
        target_table: "meetings",
        target_id: meetingId,
        field: "minutes_url",
        new_value: "https://example.invalid/pressroom-corrections/minutes.pdf",
        reason: "Minutes were published after the sweep ran.",
      })
      .expect(201);
    assert.equal(res.body.old_value, null);
    assert.match(res.body.new_value, /minutes\.pdf$/);
    assert.equal(res.body.operator_email, EMAIL);
  });

  it("requires a reason over the API too", async () => {
    await request(app)
      .post("/api/admin/pressroom/corrections")
      .set("Cookie", cookie)
      .send({
        target_table: "meetings",
        target_id: meetingId,
        field: "location",
        new_value: "Anywhere",
      })
      .expect(400);
  });

  it("serves one target's history, newest first", async () => {
    const res = await request(app)
      .get(`/api/admin/pressroom/corrections?target_table=meetings&target_id=${meetingId}`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(res.body.total, res.body.data.length);
    assert.ok(res.body.total >= 2);
    assert.equal(res.body.data[0].field, "minutes_url");
  });
});
