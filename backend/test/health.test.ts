import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

describe("GET /api/health", () => {
  it("returns status ok with database connected", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.status, "ok");
    assert.equal(res.body.database, "connected");
    assert.ok(res.body.timestamp);
  });
});
