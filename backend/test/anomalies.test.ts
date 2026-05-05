import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

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

describe("GET /api/anomalies/:id", () => {
  it("returns 404 for non-existent anomaly", async () => {
    await request(app)
      .get(`/api/anomalies/${NON_EXISTENT_ID}`)
      .expect(404);
  });
});

describe("POST /api/anomalies", () => {
  it("creates an anomaly flag", async () => {
    const res = await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Test emergency session flag",
        severity: "high",
      })
      .expect(201);

    assert.equal(res.body.flag_type, "emergency_session");
    assert.equal(res.body.severity, "high");
    assert.ok(res.body.id);
  });

  it("rejects invalid flag_type", async () => {
    await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "not_real",
        severity: "low",
      })
      .expect(400);
  });

  it("rejects missing meeting_id", async () => {
    await request(app)
      .post("/api/anomalies")
      .send({
        flag_type: "emergency_session",
        severity: "high",
      })
      .expect(400);
  });
});

describe("POST /api/meetings/:id/detect-anomalies", () => {
  it("runs anomaly detection on a meeting", async () => {
    const res = await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.count, "number");
  });

  it("returns 404 for non-existent meeting", async () => {
    await request(app)
      .post(`/api/meetings/${NON_EXISTENT_ID}/detect-anomalies`)
      .expect(404);
  });
});

describe("GET /api/meetings/:id/anomalies", () => {
  it("returns anomalies for a meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${COMPLETED_MEETING_ID}/anomalies`)
      .expect(200);
    assert.ok(Array.isArray(res.body.data));
  });

  it("returns 404 for non-existent meeting", async () => {
    await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}/anomalies`)
      .expect(404);
  });
});

describe("DELETE /api/anomalies/:id", () => {
  it("returns 404 for non-existent anomaly", async () => {
    await request(app)
      .delete(`/api/anomalies/${NON_EXISTENT_ID}`)
      .expect(404);
  });
});
