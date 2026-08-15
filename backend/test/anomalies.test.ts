import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { signInOperator } from "./helpers/pressroom";

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

/**
 * Every write on these routers is operator-only. They were unauthenticated
 * until the guard landed, which is why these fixtures used to build
 * themselves with a bare POST.
 */
let operatorCookie: string;

before(async () => {
  operatorCookie = await signInOperator("anomalies@test.invalid", "Anomalies Suite");
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
      .set("Cookie", operatorCookie)
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
      .set("Cookie", operatorCookie)
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
      .set("Cookie", operatorCookie)
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
      .set("Cookie", operatorCookie)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.count, "number");
  });

  it("returns 404 for non-existent meeting", async () => {
    await request(app)
      .post(`/api/meetings/${NON_EXISTENT_ID}/detect-anomalies`)
      .set("Cookie", operatorCookie)
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
      .set("Cookie", operatorCookie)
      .expect(404);
  });
});

describe("POST /api/anomalies/detect-batch", () => {
  it("runs batch detection and returns summary", async () => {
    const res = await request(app)
      .post("/api/anomalies/detect-batch")
      .set("Cookie", operatorCookie)
      .send({})
      .expect(200);

    assert.equal(typeof res.body.meetings_scanned, "number");
    assert.equal(typeof res.body.flags_created, "number");
    assert.ok(typeof res.body.flags_by_type === "object");
  });

  it("accepts date filters", async () => {
    const res = await request(app)
      .post("/api/anomalies/detect-batch")
      .set("Cookie", operatorCookie)
      .send({ date_from: "2020-01-01", date_to: "2030-12-31" })
      .expect(200);

    assert.equal(typeof res.body.meetings_scanned, "number");
  });

  it("rejects invalid commission_id", async () => {
    await request(app)
      .post("/api/anomalies/detect-batch")
      .set("Cookie", operatorCookie)
      .send({ commission_id: "not-a-uuid" })
      .expect(400);
  });

  it("rejects invalid date format", async () => {
    await request(app)
      .post("/api/anomalies/detect-batch")
      .set("Cookie", operatorCookie)
      .send({ date_from: "Jan 1 2025" })
      .expect(400);
  });
});

describe("Idempotency", () => {
  it("does not duplicate flags when detection runs twice", async () => {
    await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .set("Cookie", operatorCookie)
      .expect(200);

    const after1 = await request(app)
      .get(`/api/anomalies?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);
    const count1 = after1.body.total;

    await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .set("Cookie", operatorCookie)
      .expect(200);

    const after2 = await request(app)
      .get(`/api/anomalies?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.equal(after2.body.total, count1, "Flag count should not change on re-run");
  });

  it("preserves manually created flags when detection re-runs", async () => {
    const createRes = await request(app)
      .post("/api/anomalies")
      .set("Cookie", operatorCookie)
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
      .set("Cookie", operatorCookie)
      .expect(200);

    // Read the row, not the public route. A hand-entered finding is `held`, so
    // `GET /api/anomalies/:id` answers 404 for it — correctly, and that is
    // asserted on its own above. This test's subject is whether re-detection
    // destroys a manual flag, which is a question about the table.
    const survivor = await db("anomaly_flags").where({ id: manualId }).first();
    assert.ok(survivor, "Manual flag should survive re-detection");
    assert.equal(survivor.description, "Manually created test flag");
  });
});

/**
 * The guard, asserted from the attacker's side.
 *
 * Every route below was unauthenticated and mounted on the public `/api`
 * surface. `POST /` was the sharp one: it applied the severity threshold but
 * passed `alwaysHold: false` unconditionally, so a stranger could post a
 * `medium`- or `low`-severity finding naming a living official and have it
 * published under this project's byline without any operator seeing it. The
 * Caddy IP allowlist was the only thing standing in front of it.
 *
 * Absence of a 401 is not enough to prove a guard — a route that 500s before
 * reaching its handler also fails to publish. So each case asserts the status
 * *and*, for the write, that the record is unchanged either side of the call.
 */
describe("the mutating routes refuse an unauthenticated caller", () => {
  it("refuses POST /api/anomalies, and writes nothing", async () => {
    const before = Number(
      (await db("anomaly_flags").count("* as n").first())?.n ?? 0,
    );

    await request(app)
      .post("/api/anomalies")
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Posted by nobody",
        severity: "low",
      })
      .expect(401);

    const after_ = Number(
      (await db("anomaly_flags").count("* as n").first())?.n ?? 0,
    );
    assert.equal(after_, before, "an unauthenticated POST inserted a row");
  });

  it("refuses DELETE /api/anomalies/:id, and deletes nothing", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Guard fixture",
        severity: "low",
        source: "manual",
        review_state: "held",
      })
      .returning("*");

    await request(app).delete(`/api/anomalies/${flag.id}`).expect(401);

    const survivor = await db("anomaly_flags").where({ id: flag.id }).first();
    assert.ok(survivor, "an unauthenticated DELETE removed a finding");
  });

  it("refuses both detection routes", async () => {
    await request(app).post("/api/anomalies/detect-batch").send({}).expect(401);
    await request(app)
      .post(`/api/anomalies/meeting/${COMPLETED_MEETING_ID}/detect`)
      .expect(401);
  });

  it("leaves the public reads open", async () => {
    await request(app).get("/api/anomalies").expect(200);
    await request(app).get(`/api/anomalies/${NON_EXISTENT_ID}`).expect(404);
  });
});

/**
 * The invariant the route exists to serve. A hand-entered finding has no
 * detector, no rule version and no citation behind it, so it is held at every
 * severity — including the ones the default threshold would otherwise let
 * through. This asserts the *lowest* severity, because that is the one a
 * threshold set to `high` publishes.
 */
describe("a hand-entered finding is held at every severity", () => {
  for (const severity of ["low", "medium", "high", "critical"]) {
    it(`holds a ${severity} finding`, async () => {
      const res = await request(app)
        .post("/api/anomalies")
        .set("Cookie", operatorCookie)
        .send({
          meeting_id: COMPLETED_MEETING_ID,
          flag_type: "emergency_session",
          description: `Hand-entered ${severity} finding`,
          severity,
        })
        .expect(201);

      assert.equal(
        res.body.review_state,
        "held",
        `a ${severity} manual finding did not go to the review queue`,
      );
    });
  }
});

// The suite's own operator goes with it. `seedFirstOperator` only acts while
// `operators` is empty, so a row left behind here makes
// `operator-auth.test.ts` assert against a table this suite filled.
after(async () => {
  await db("operators").where({ email: "anomalies@test.invalid" }).del();
});

// Closes the knex pool so the run can end on its own.
//
// These six suites each held an idle connection open forever, which is why the
// test script carried `--test-force-exit`. That flag calls `process.exit()`,
// dropping whatever a child had not yet flushed to the reporter — so the
// largest suite in the repo silently reported a random subset of its tests.
// Closing the pool is what let the flag come off.
after(async () => {
  await db.destroy();
});


/**
 * `review_state = 'published'` says a finding is public. It does not say
 * anybody read it.
 *
 * `resolveReviewState` holds a flag only when a detector marked it `alwaysHold`
 * or when its severity reaches the review threshold — `high` by default — so a
 * low or medium flag naming nobody is published by rule with no human in the
 * loop. That distinction was invisible to a reader, and the findings page filled
 * the gap by claiming every entry had been reviewed by a person. It had a test
 * asserting those words, so the page and its test agreed with each other and
 * both disagreed with the code.
 *
 * These assert the distinction is now visible per finding, so the page can stop
 * generalising.
 */
describe("GET /api/anomalies · was it read by a person", () => {
  const NAME = "Review Provenance County";
  let ruleId: string;
  let approvedId: string;

  before(async () => {
    await db("jurisdictions").where({ name: NAME }).del();
    const [j] = await db("jurisdictions")
      .insert({ name: NAME, state: "MT", type: "county" })
      .returning("id");
    const jid = typeof j === "string" ? j : j.id;
    const [c] = await db("commissions")
      .insert({ jurisdiction_id: jid, name: "Provenance Board" })
      .returning("id");
    const cid = typeof c === "string" ? c : c.id;
    const [m] = await db("meetings")
      .insert({ commission_id: cid, date: "2026-07-07", published_at: new Date() })
      .returning("id");
    const mid = typeof m === "string" ? m : m.id;

    // Published by rule: low severity, no approval_requests row, exactly what
    // resolveReviewState produces below the threshold.
    const [rule] = await db("anomaly_flags")
      .insert({
        meeting_id: mid,
        flag_type: "unanimous_controversial",
        description: "Published by rule, read by nobody.",
        severity: "low",
        review_state: "published",
      })
      .returning("id");
    ruleId = typeof rule === "string" ? rule : rule.id;

    const [approved] = await db("anomaly_flags")
      .insert({
        meeting_id: mid,
        flag_type: "quorum_issue",
        description: "Approved by a named operator.",
        severity: "critical",
        review_state: "published",
      })
      .returning("id");
    approvedId = typeof approved === "string" ? approved : approved.id;

    await db("approval_requests").insert({
      anomaly_flag_id: approvedId,
      meeting_id: mid,
      status: "approved",
      severity: "critical",
      reviewed_at: new Date("2026-07-10T09:00:00Z"),
      expires_at: new Date("2026-07-20T09:00:00Z"),
    });
  });

  after(async () => {
    await db("jurisdictions").where({ name: NAME }).del();
  });

  /**
   * `review_state = 'published'` says a finding is public. It does not say
   * anybody read it. A low or medium flag naming nobody is published by rule
   * with no human in the loop — and the findings page filled that gap by
   * claiming every entry had been reviewed by a person, with a test asserting
   * the words, so page and test agreed while both disagreed with the code.
   */
  it("distinguishes a rule-published finding from one an operator approved", async () => {
    const res = await request(app).get("/api/anomalies?limit=200").expect(200);
    const rows: Array<{ id: string; operator_reviewed: boolean; reviewed_at: string | null }> =
      res.body.data;

    const byRule = rows.find((r) => r.id === ruleId);
    const byOperator = rows.find((r) => r.id === approvedId);

    assert.ok(byRule, "the rule-published finding must be public");
    assert.equal(byRule.operator_reviewed, false, "nobody approved it; it must not claim they did");

    assert.ok(byOperator, "the approved finding must be public");
    assert.equal(byOperator.operator_reviewed, true);
  });

  it("carries an approval date only where there was an approval", async () => {
    const res = await request(app).get("/api/anomalies?limit=200").expect(200);
    const rows: Array<{ id: string; reviewed_at: string | null }> = res.body.data;

    // A date on an unreviewed finding would read like a decision nobody made.
    assert.equal(rows.find((r) => r.id === ruleId)?.reviewed_at ?? null, null);
    assert.ok(rows.find((r) => r.id === approvedId)?.reviewed_at);
  });
});
