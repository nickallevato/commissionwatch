import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { findPublishedMeeting } from "../src/services/publication";
import {
  cleanupByPrefix,
  createMeeting,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * Decision 8 — `ingested` and `published` are different states.
 *
 * The acceptance criterion is one sentence: **a meeting with
 * `published_at IS NULL` must not appear in any public API response.** The
 * public meetings router has eight routes that take a meeting id — seven, plus
 * P5's agenda diff — and the anomalies router has three more, so the test walks
 * all of them rather than checking the two that were easy to remember.
 *
 * A 404 rather than a 403 on an unpublished meeting is deliberate. Telling an
 * anonymous caller "this exists but you may not see it" would let them
 * enumerate what has been ingested and withheld, which is precisely the state
 * an operator has not finished deciding about.
 */

const PREFIX = "meeting-publication-test";
const EMAIL = "meeting-publication-test@example.invalid";

describe("published meetings and the public API", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let unpublishedId: string;
  let publishedId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    fixture = await createSource(PREFIX, { enabled: false });
    unpublishedId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-04",
    });
    publishedId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-05",
    });
    cookie = await signInOperator(EMAIL, "Publication Operator");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db("operators").where({ email: EMAIL }).del();
    await db.destroy();
  });

  it("keeps an unpublished meeting out of the public list, and out of its total", async () => {
    const res = await request(app)
      .get(`/api/meetings?commission_id=${fixture.commissionId}`)
      .expect(200);
    const ids = res.body.data.map((row: { id: string }) => row.id);
    assert.equal(ids.includes(unpublishedId), false);
    assert.equal(ids.includes(publishedId), true);
    // A total that counts rows the caller cannot reach is a leak dressed as a
    // number.
    assert.equal(res.body.total, 1);
  });

  it("404s an unpublished meeting on every public route that takes its id", async () => {
    const paths = [
      `/api/meetings/${unpublishedId}`,
      `/api/meetings/${unpublishedId}/rundown`,
      `/api/meetings/${unpublishedId}/votes`,
      `/api/meetings/${unpublishedId}/anomalies`,
      `/api/meetings/${unpublishedId}/agenda-items`,
      `/api/meetings/${unpublishedId}/documents`,
      // P5's agenda diff is the most quotable thing this project produces, so
      // it is the worst possible place for the wall to have a hole.
      `/api/meetings/${unpublishedId}/agenda-diff`,
      `/api/anomalies/meeting/${unpublishedId}`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      assert.equal(res.status, 404, `${path} exposed an unpublished meeting`);
    }
  });

  it("404s the public write-ish routes for an unpublished meeting too", async () => {
    await request(app).post(`/api/meetings/${unpublishedId}/detect-anomalies`).expect(404);
    await request(app).post(`/api/anomalies/meeting/${unpublishedId}/detect`).expect(404);
    // The manual-flag route validates the meeting the same way, and answers 400.
    const res = await request(app).post("/api/anomalies").send({
      meeting_id: unpublishedId,
      flag_type: "missing_minutes",
      description: "x",
      severity: 3,
    });
    assert.equal(res.status, 400);
  });

  it("serves a published meeting on the same routes", async () => {
    await request(app).get(`/api/meetings/${publishedId}`).expect(200);
    await request(app).get(`/api/meetings/${publishedId}/agenda-items`).expect(200);
    await request(app).get(`/api/anomalies/meeting/${publishedId}`).expect(200);
  });

  it("finds only published meetings through the shared helper", async () => {
    assert.equal(await findPublishedMeeting(db, unpublishedId), undefined);
    assert.ok(await findPublishedMeeting(db, publishedId));
  });

  it("publishes with a reason, and the meeting appears", async () => {
    const res = await request(app)
      .post(`/api/admin/pressroom/meetings/${unpublishedId}/publish`)
      .set("Cookie", cookie)
      .send({ reason: "Agenda and minutes both verified against the stored PDF." })
      .expect(200);
    assert.ok(typeof res.body.published_at === "string");
    await request(app).get(`/api/meetings/${unpublishedId}`).expect(200);
  });

  it("records publication in the append-only correction log", async () => {
    // Publication gets its audit trail from the same table as corrections. A
    // second mechanism would be a second log, and two logs can disagree.
    const rows = await db("record_corrections")
      .where({ target_table: "meetings", target_id: unpublishedId, field: "published_at" })
      .orderBy("created_at", "desc")
      .select<Array<{ new_value: string | null; reason: string; operator_email: string | null }>>(
        "new_value",
        "reason",
        "operator_email",
      );
    assert.ok(rows.length >= 1);
    assert.match(rows[0].reason, /verified against the stored PDF/);
    assert.equal(rows[0].operator_email, EMAIL);
  });

  it("unpublishes with a reason, and the meeting disappears again", async () => {
    const res = await request(app)
      .post(`/api/admin/pressroom/meetings/${unpublishedId}/unpublish`)
      .set("Cookie", cookie)
      .send({ reason: "The minutes URL points at the wrong meeting; withdrawn pending a fix." })
      .expect(200);
    assert.equal(res.body.published_at, null);
    await request(app).get(`/api/meetings/${unpublishedId}`).expect(404);
  });

  it("refuses to publish without a reason", async () => {
    await request(app)
      .post(`/api/admin/pressroom/meetings/${unpublishedId}/publish`)
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });

  it("is closed without a session", async () => {
    await request(app)
      .post(`/api/admin/pressroom/meetings/${publishedId}/publish`)
      .send({ reason: "no session" })
      .expect(401);
  });
});
