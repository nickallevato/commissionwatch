import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const BOZEMAN_COMMISSION_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
// Bozeman's May 12 meeting — seeded with one document and no agenda items
// (see backend/seeds/001_pilot_data.ts, MEETINGS.bozeman[0]).
const SCHEDULED_MEETING_ID = "e5f6a7b8-c9d0-1234-efab-345678901234";
// Bozeman's April 14 meeting — seeded with two agenda items and no documents
// (MEETINGS.bozeman[2]).
const APRIL_14_MEETING_ID = "a7b8c9d0-e1f2-3456-abcd-567890123456";
const MALFORMED_ID = "not-a-uuid";

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

describe("GET /api/meetings/:id/agenda-items", () => {
  it("returns agenda items ordered by item_number ascending", async () => {
    const res = await request(app)
      .get(`/api/meetings/${COMPLETED_MEETING_ID}/agenda-items`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, res.body.data.length);
    assert.equal(res.body.total, 3);

    const itemNumbers = res.body.data.map(
      (i: { item_number: number }) => i.item_number,
    );
    assert.deepEqual(itemNumbers, [1, 2, 3]);

    res.body.data.forEach((i: { meeting_id: string }) => {
      assert.equal(i.meeting_id, COMPLETED_MEETING_ID);
    });
  });

  it("returns an empty list for a meeting with no agenda items", async () => {
    const res = await request(app)
      .get(`/api/meetings/${SCHEDULED_MEETING_ID}/agenda-items`)
      .expect(200);

    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.total, 0);
  });

  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}/agenda-items`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });

  it("returns 400 for a malformed meeting id", async () => {
    const res = await request(app)
      .get(`/api/meetings/${MALFORMED_ID}/agenda-items`)
      .expect(400);

    assert.equal(res.body.error, "Invalid meeting ID format");
  });
});

describe("GET /api/meetings/:id/documents", () => {
  it("returns documents ordered by created_at descending", async () => {
    const res = await request(app)
      .get(`/api/meetings/${COMPLETED_MEETING_ID}/documents`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, res.body.data.length);
    assert.equal(res.body.total, 2);

    const createdAt = res.body.data.map(
      (d: { created_at: string }) => d.created_at,
    );
    const sortedDesc = [...createdAt].sort().reverse();
    assert.deepEqual(createdAt, sortedDesc);

    res.body.data.forEach((d: { meeting_id: string }) => {
      assert.equal(d.meeting_id, COMPLETED_MEETING_ID);
    });
  });

  it("returns an empty list for a meeting with no documents", async () => {
    const res = await request(app)
      .get(`/api/meetings/${APRIL_14_MEETING_ID}/documents`)
      .expect(200);

    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.total, 0);
  });

  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}/documents`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });

  it("returns 400 for a malformed meeting id", async () => {
    const res = await request(app)
      .get(`/api/meetings/${MALFORMED_ID}/documents`)
      .expect(400);

    assert.equal(res.body.error, "Invalid meeting ID format");
  });
});

/**
 * The rundown route is gone, and this is the test that says so.
 *
 * It used to assert the shape of a 404 body reading "Rundown not yet generated
 * for this meeting" — an assertion that passed for months while being, in
 * substance, a lie: `rundown_sheets` lost its only writer when
 * `agents/meeting-monitor` was deleted, so "not yet" described a thing nothing
 * in this repository was ever going to produce.
 *
 * The premise was invalidated, so the test is rewritten rather than deleted. It
 * now asserts the route is absent — no handler, so the request falls past the
 * router to Express's own 404 — and, importantly, that its removal did not take
 * the sibling routes on the same `:id` with it. A route that vanished by
 * accident and a route that was retired look identical from one assertion.
 */
describe("GET /api/meetings/:id/rundown is retired", () => {
  it("has no handler for a real meeting", async () => {
    const res = await request(app).get(`/api/meetings/${COMPLETED_MEETING_ID}/rundown`);

    assert.equal(res.status, 404);
    // Express's own not-found, not the router's JSON body: nothing answered.
    assert.equal(res.body.error, undefined);
  });

  it("has no handler for a non-existent meeting either", async () => {
    const res = await request(app).get(`/api/meetings/${NON_EXISTENT_ID}/rundown`);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, undefined);
  });

  it("left the rest of the meeting routes standing", async () => {
    await request(app).get(`/api/meetings/${COMPLETED_MEETING_ID}`).expect(200);
    await request(app).get(`/api/meetings/${COMPLETED_MEETING_ID}/agenda-items`).expect(200);
    await request(app).get(`/api/meetings/${COMPLETED_MEETING_ID}/documents`).expect(200);
  });
});

// Closes the knex pool `../src/app` opens on import.
//
// Suites that leaked a pool are why the test script carried
// `--test-force-exit`. That flag calls `process.exit()`, which drops whatever a
// child had not yet flushed to the reporter — so the largest suite in this repo
// silently reported 29, 40 or 44 of its 68 tests depending on timing, always
// green, with nothing to say the rest had gone unreported. Closing the pools is
// what let the flag come off.
after(async () => {
  await db.destroy();
});
