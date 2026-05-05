import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";

describe("GET /api/anomalies", () => {
  it("lists anomaly flags", async () => {
    const res = await request(app).get("/api/anomalies").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters by meeting_id", async () => {
    const res = await request(app)
      .get(`/api/anomalies?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
  });

  it("filters by flag_type", async () => {
    const res = await request(app)
      .get("/api/anomalies?flag_type=emergency_session")
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
  });

  it("filters by severity", async () => {
    const res = await request(app)
      .get("/api/anomalies?severity=high")
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
  });

  it("rejects invalid flag_type", async () => {
    await request(app)
      .get("/api/anomalies?flag_type=invalid_type")
      .expect(400);
  });

  it("rejects invalid severity", async () => {
    await request(app)
      .get("/api/anomalies?severity=extreme")
      .expect(400);
  });
});

describe("POST /api/anomalies", () => {
  it("rejects missing required fields", async () => {
    await request(app)
      .post("/api/anomalies")
      .send({ meeting_id: COMPLETED_MEETING_ID })
      .expect(400);
  });

  it("rejects invalid flag_type", async () => {
    await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "invalid",
        description: "test",
        severity: "high",
      })
      .expect(400);
  });

  it("rejects invalid severity", async () => {
    await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "test",
        severity: "extreme",
      })
      .expect(400);
  });
});

describe("DELETE /api/anomalies/:id", () => {
  it("returns 404 for non-existent flag", async () => {
    await request(app)
      .delete(`/api/anomalies/${NON_EXISTENT_ID}`)
      .expect(404);
  });

  it("validates ID format", async () => {
    await request(app).delete("/api/anomalies/bad-id").expect(400);
  });
});

describe("GET /api/anomalies/meeting/:id", () => {
  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .get(`/api/anomalies/meeting/${NON_EXISTENT_ID}`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });
});

describe("POST /api/anomalies/meeting/:id/detect", () => {
  it("returns 404 for non-existent meeting", async () => {
    const res = await request(app)
      .post(`/api/anomalies/meeting/${NON_EXISTENT_ID}/detect`)
      .expect(404);

    assert.equal(res.body.error, "Meeting not found");
  });

  it("detects anomalies for a valid meeting", async () => {
    const res = await request(app)
      .post(`/api/anomalies/meeting/${COMPLETED_MEETING_ID}/detect`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });
});
