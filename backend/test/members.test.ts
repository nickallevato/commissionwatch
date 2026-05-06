import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const MEMBER_CUNNINGHAM_ID = "d0e1f2a3-b4c5-6789-abcd-012345678901";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("GET /api/members", () => {
  it("returns list of all members", async () => {
    const res = await request(app).get("/api/members").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, 4);
  });

  it("filters members by jurisdiction_id", async () => {
    const res = await request(app)
      .get(`/api/members?jurisdiction_id=${BOZEMAN_ID}`)
      .expect(200);

    assert.equal(res.body.total, 3);
    res.body.data.forEach((m: { jurisdiction_id: string }) => {
      assert.equal(m.jurisdiction_id, BOZEMAN_ID);
    });
  });

  it("returns 400 for invalid jurisdiction_id", async () => {
    const res = await request(app)
      .get("/api/members?jurisdiction_id=not-a-uuid")
      .expect(400);

    assert.match(res.body.error, /Invalid jurisdiction_id format/);
  });

  it("returns members ordered by name", async () => {
    const res = await request(app)
      .get(`/api/members?jurisdiction_id=${BOZEMAN_ID}`)
      .expect(200);

    const names = res.body.data.map((m: { name: string }) => m.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  });
});

describe("GET /api/members/:id", () => {
  it("returns a single member", async () => {
    const res = await request(app)
      .get(`/api/members/${MEMBER_CUNNINGHAM_ID}`)
      .expect(200);

    assert.equal(res.body.name, "Terry Cunningham");
    assert.equal(res.body.title, "Mayor");
    assert.equal(res.body.jurisdiction_id, BOZEMAN_ID);
  });

  it("returns 404 for non-existent member", async () => {
    const res = await request(app)
      .get(`/api/members/${NON_EXISTENT_ID}`)
      .expect(404);

    assert.equal(res.body.error, "Member not found");
  });

  it("returns 400 for invalid ID format", async () => {
    await request(app).get("/api/members/bad-id").expect(400);
  });
});

describe("POST /api/members", () => {
  it("creates a new member", async () => {
    const res = await request(app)
      .post("/api/members")
      .send({
        name: "Test Member",
        title: "Council Member",
        jurisdiction_id: BOZEMAN_ID,
        term_start: "2026-01-01",
        term_end: "2029-12-31",
      })
      .expect(201);

    assert.equal(res.body.name, "Test Member");
    assert.equal(res.body.title, "Council Member");
    assert.equal(res.body.jurisdiction_id, BOZEMAN_ID);
    assert.ok(res.body.id);
  });

  it("returns 400 when name is missing", async () => {
    await request(app)
      .post("/api/members")
      .send({ jurisdiction_id: BOZEMAN_ID })
      .expect(400);
  });

  it("returns 400 when jurisdiction_id is invalid", async () => {
    await request(app)
      .post("/api/members")
      .send({ name: "Test", jurisdiction_id: "bad" })
      .expect(400);
  });

  it("returns 400 when jurisdiction does not exist", async () => {
    await request(app)
      .post("/api/members")
      .send({ name: "Test", jurisdiction_id: NON_EXISTENT_ID })
      .expect(400);
  });
});

describe("PUT /api/members/:id", () => {
  it("updates a member", async () => {
    const res = await request(app)
      .put(`/api/members/${MEMBER_CUNNINGHAM_ID}`)
      .send({ title: "Former Mayor" })
      .expect(200);

    assert.equal(res.body.title, "Former Mayor");
    assert.equal(res.body.name, "Terry Cunningham");
  });

  it("returns 404 for non-existent member", async () => {
    await request(app)
      .put(`/api/members/${NON_EXISTENT_ID}`)
      .send({ title: "Test" })
      .expect(404);
  });

  it("returns 400 when no fields provided", async () => {
    await request(app)
      .put(`/api/members/${MEMBER_CUNNINGHAM_ID}`)
      .send({})
      .expect(400);
  });
});

describe("DELETE /api/members/:id", () => {
  it("deletes a member", async () => {
    // Create a member to delete
    const created = await request(app)
      .post("/api/members")
      .send({ name: "To Delete", jurisdiction_id: BOZEMAN_ID })
      .expect(201);

    await request(app)
      .delete(`/api/members/${created.body.id}`)
      .expect(204);

    await request(app)
      .get(`/api/members/${created.body.id}`)
      .expect(404);
  });

  it("returns 404 for non-existent member", async () => {
    await request(app)
      .delete(`/api/members/${NON_EXISTENT_ID}`)
      .expect(404);
  });
});
