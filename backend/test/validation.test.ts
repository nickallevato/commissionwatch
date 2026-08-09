import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

describe("Input validation", () => {
  it("returns 400 for invalid UUID in jurisdiction_id filter", async () => {
    const res = await request(app)
      .get("/api/meetings?jurisdiction_id=not-a-uuid")
      .expect(400);

    assert.equal(res.body.statusCode, 400);
    assert.match(res.body.error, /Invalid jurisdiction_id format/);
  });

  it("returns 400 for invalid UUID in meeting ID param", async () => {
    const res = await request(app)
      .get("/api/meetings/not-a-valid-uuid")
      .expect(400);

    assert.equal(res.body.statusCode, 400);
    assert.match(res.body.error, /Invalid meeting ID format/);
  });

  it("returns 400 for invalid date_from format", async () => {
    const res = await request(app)
      .get("/api/meetings?date_from=13-01-2026")
      .expect(400);

    assert.equal(res.body.statusCode, 400);
    assert.match(res.body.error, /Invalid date_from format/);
  });

  it("returns 400 for invalid date_to format", async () => {
    const res = await request(app)
      .get("/api/meetings?date_to=2026/05/01")
      .expect(400);

    assert.equal(res.body.statusCode, 400);
    assert.match(res.body.error, /Invalid date_to format/);
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
