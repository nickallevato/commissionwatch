import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("GET /api/members", () => {
  it("lists all members", async () => {
    const res = await request(app).get("/api/members").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters members by jurisdiction_id", async () => {
    const res = await request(app)
      .get(`/api/members?jurisdiction_id=${BOZEMAN_ID}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    res.body.data.forEach((m: { jurisdiction_id: string }) => {
      assert.equal(m.jurisdiction_id, BOZEMAN_ID);
    });
  });

  it("validates jurisdiction_id format", async () => {
    await request(app)
      .get("/api/members?jurisdiction_id=not-a-uuid")
      .expect(400);
  });

  it("supports pagination", async () => {
    const res = await request(app)
      .get("/api/members?limit=2&offset=0")
      .expect(200);

    assert.ok(res.body.data.length <= 2);
  });
});

describe("POST /api/members", () => {
  it("creates a new member", async () => {
    const res = await request(app)
      .post("/api/members")
      .send({
        jurisdiction_id: BOZEMAN_ID,
        name: "Test Member",
        term_start: "2026-01-01",
      })
      .expect(201);

    assert.equal(res.body.name, "Test Member");
    assert.equal(res.body.jurisdiction_id, BOZEMAN_ID);
    assert.ok(res.body.id);
  });

  it("rejects missing required fields", async () => {
    await request(app)
      .post("/api/members")
      .send({ name: "No Jurisdiction" })
      .expect(400);
  });
});

describe("GET /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    const res = await request(app)
      .get(`/api/members/${NON_EXISTENT_ID}`)
      .expect(404);

    assert.equal(res.body.error, "Member not found");
  });

  it("validates ID format", async () => {
    await request(app).get("/api/members/bad-id").expect(400);
  });
});

describe("PUT /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    await request(app)
      .put(`/api/members/${NON_EXISTENT_ID}`)
      .send({ name: "Updated" })
      .expect(404);
  });
});

describe("DELETE /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    await request(app)
      .delete(`/api/members/${NON_EXISTENT_ID}`)
      .expect(404);
  });
});
