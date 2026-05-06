import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";

describe("GET /api/votes", () => {
  it("lists votes", async () => {
    const res = await request(app).get("/api/votes").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters by meeting_id", async () => {
    const res = await request(app)
      .get(`/api/votes?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    res.body.data.forEach((v: { meeting_id: string }) => {
      assert.equal(v.meeting_id, COMPLETED_MEETING_ID);
    });
  });

  it("validates meeting_id format", async () => {
    await request(app)
      .get("/api/votes?meeting_id=bad-id")
      .expect(400);
  });
});

describe("POST /api/votes", () => {
  it("rejects invalid vote value", async () => {
    await request(app)
      .post("/api/votes")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        member_id: NON_EXISTENT_ID,
        vote: "maybe",
      })
      .expect(400);
  });

  it("rejects missing meeting_id", async () => {
    await request(app)
      .post("/api/votes")
      .send({
        member_id: NON_EXISTENT_ID,
        vote: "yes",
      })
      .expect(400);
  });
});

describe("POST /api/votes/bulk", () => {
  it("rejects empty array", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .send({ votes: [] })
      .expect(400);
  });

  it("rejects non-array", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .send({ votes: "not-an-array" })
      .expect(400);
  });

  it("validates each vote in bulk", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .send({
        votes: [
          { meeting_id: "bad-id", member_id: NON_EXISTENT_ID, vote: "yes" },
        ],
      })
      .expect(400);
  });
});

describe("DELETE /api/votes/:id", () => {
  it("returns 404 for non-existent vote", async () => {
    await request(app)
      .delete(`/api/votes/${NON_EXISTENT_ID}`)
      .expect(404);
  });

  it("validates ID format", async () => {
    await request(app).delete("/api/votes/bad-id").expect(400);
  });
});
