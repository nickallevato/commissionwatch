import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

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
