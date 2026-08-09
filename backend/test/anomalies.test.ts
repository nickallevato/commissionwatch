import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * This file creates anomaly flags on a seeded meeting — some directly, some by
 * calling the detector — and used never to remove them. That was invisible
 * while the file was not registered in the `test` script, and became a failure
 * in `notification-service.test.ts` the moment it was: NotificationService
 * resolves flags by (meeting_id, flag_type), so a leftover high-severity
 * `emergency_session` on this meeting makes a later medium-severity assertion
 * see an immediate send that its own fixtures did not cause.
 *
 * The seed inserts no anomaly_flags at all, so removing every flag on this
 * meeting restores exactly the post-seed state.
 */
after(async () => {
  await db("anomaly_flags").where({ meeting_id: COMPLETED_MEETING_ID }).del();
});

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

describe("POST /api/anomalies/detect-batch", () => {
  it("runs batch detection and returns summary", async () => {
    const res = await request(app)
      .post("/api/anomalies/detect-batch")
      .send({})
      .expect(200);

    assert.equal(typeof res.body.meetings_scanned, "number");
    assert.equal(typeof res.body.flags_created, "number");
    assert.ok(typeof res.body.flags_by_type === "object");
  });

  it("accepts date filters", async () => {
    const res = await request(app)
      .post("/api/anomalies/detect-batch")
      .send({ date_from: "2020-01-01", date_to: "2030-12-31" })
      .expect(200);

    assert.equal(typeof res.body.meetings_scanned, "number");
  });

  it("rejects invalid commission_id", async () => {
    await request(app)
      .post("/api/anomalies/detect-batch")
      .send({ commission_id: "not-a-uuid" })
      .expect(400);
  });

  it("rejects invalid date format", async () => {
    await request(app)
      .post("/api/anomalies/detect-batch")
      .send({ date_from: "Jan 1 2025" })
      .expect(400);
  });
});

describe("Idempotency", () => {
  it("does not duplicate flags when detection runs twice", async () => {
    await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .expect(200);

    const after1 = await request(app)
      .get(`/api/anomalies?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);
    const count1 = after1.body.total;

    await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .expect(200);

    const after2 = await request(app)
      .get(`/api/anomalies?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.equal(after2.body.total, count1, "Flag count should not change on re-run");
  });

  it("preserves manually created flags when detection re-runs", async () => {
    const createRes = await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Manually created test flag",
        severity: "low",
      })
      .expect(201);

    const manualId = createRes.body.id;

    await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .expect(200);

    const flagRes = await request(app)
      .get(`/api/anomalies/${manualId}`)
      .expect(200);

    assert.equal(flagRes.body.id, manualId, "Manual flag should survive re-detection");
  });
});
