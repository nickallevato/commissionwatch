import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const BOZEMAN_COMMISSION_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("GET /api/meetings", () => {
  it("lists all meetings without filters", async () => {
    const res = await request(app).get("/api/meetings").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, 5);
  });

  it("filters meetings by jurisdiction_id", async () => {
    const res = await request(app)
      .get(`/api/meetings?jurisdiction_id=${BOZEMAN_ID}`)
      .expect(200);

    assert.equal(res.body.total, 3);
    res.body.data.forEach((m: { commission_id: string }) => {
      assert.equal(m.commission_id, BOZEMAN_COMMISSION_ID);
    });
  });

  it("filters meetings by date range", async () => {
    const res = await request(app)
      .get("/api/meetings?date_from=2026-04-20&date_to=2026-04-30")
      .expect(200);

    assert.ok(res.body.total >= 2);
    res.body.data.forEach((m: { date: string }) => {
      assert.ok(m.date >= "2026-04-20");
      assert.ok(m.date <= "2026-04-30");
    });
  });

  it("returns meetings ordered by date descending", async () => {
    const res = await request(app).get("/api/meetings").expect(200);

    const dates = res.body.data.map((m: { date: string }) => m.date);
    const sorted = [...dates].sort().reverse();
    assert.deepEqual(dates, sorted);
  });
});

describe("GET /api/meetings/:id", () => {
  it("returns meeting with agenda items and documents", async () => {
    const res = await request(app)
      .get(`/api/meetings/${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.equal(res.body.id, COMPLETED_MEETING_ID);
    assert.ok(Array.isArray(res.body.agenda_items));
    assert.ok(res.body.agenda_items.length > 0);
    assert.ok(Array.isArray(res.body.documents));
  });

  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });
});

describe("GET /api/meetings/:id/rundown", () => {
  it("returns 404 when no rundown exists", async () => {
    const res = await request(app)
      .get(`/api/meetings/${COMPLETED_MEETING_ID}/rundown`)
      .expect(404);

    assert.equal(res.body.error, "Rundown not yet generated for this meeting");
  });

  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}/rundown`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });
});
