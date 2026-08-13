import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { NotificationService } from "../src/services/notification";
import { signInOperator } from "./helpers/pressroom";

// Every HTTP route in this router joins `alert_subscriptions` and selects the
// subscriber's email, so all of them are operator-only.
let cookie: string;

before(async () => {
  cookie = await signInOperator("notifications-suite@example.invalid", "Notifications Suite");
});

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
const TEST_EMAIL = "notif-test@example.com";

describe("NotificationService.processAnomalyEvent", () => {
  let subscriptionId: string;
  let flagId: string;

  before(async () => {
    await db("notifications").whereIn("subscription_id",
      db("alert_subscriptions").select("id").where({ email: TEST_EMAIL })).del();
    await db("alert_subscriptions").where({ email: TEST_EMAIL }).del();
    await db("anomaly_flags").where({ meeting_id: COMPLETED_MEETING_ID, flag_type: "emergency_session", description: "Notification test flag" }).del();

    const [sub] = await db("alert_subscriptions")
      .insert({
        email: TEST_EMAIL,
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "n".repeat(64),
        unsubscribe_token: "o".repeat(64),
        verified: true,
      })
      .returning("id");
    subscriptionId = sub.id;

    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Notification test flag",
        severity: "high",
      })
      .returning("id");
    flagId = flag.id;
  });

  after(async () => {
    await db("notifications").whereIn("subscription_id",
      db("alert_subscriptions").select("id").where({ email: TEST_EMAIL })).del();
    await db("alert_subscriptions").where({ email: TEST_EMAIL }).del();
    await db("anomaly_flags").where({ id: flagId }).del();
  });

  it("creates notification records for verified subscribers", async () => {
    const immediateIds: string[] = [];
    const service = new NotificationService(db, async (ids) => {
      immediateIds.push(...ids);
    });

    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "Notification test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].severity, "high");
    assert.equal(notifications[0].email_status, "queued");
    assert.ok(immediateIds.length > 0);
  });

  it("does not create duplicate notifications", async () => {
    const service = new NotificationService(db);

    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "Notification test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId });

    assert.equal(notifications.length, 1);
  });
});

/**
 * The guard, before the behaviour that depends on it.
 *
 * `GET /api/notifications` with no filter was an unauthenticated, paginated
 * dump of which reader was told what — subscriber address included.
 */
describe("/api/notifications authentication", () => {
  const anonymous: [string, () => request.Test][] = [
    ["GET /", () => request(app).get("/api/notifications")],
    ["GET /count", () => request(app).get(`/api/notifications/count?email=${TEST_EMAIL}`)],
    ["PATCH /:id/read", () => request(app).patch(`/api/notifications/${NON_EXISTENT_ID}/read`)],
    ["PATCH /read-all", () =>
      request(app).patch("/api/notifications/read-all").send({ email: TEST_EMAIL })],
  ];

  for (const [label, send] of anonymous) {
    it(`${label} is 401 without a session`, async () => {
      const res = await send().expect(401);
      assert.equal(
        JSON.stringify(res.body).includes(TEST_EMAIL),
        false,
        "the rejection leaked the address it was asked about",
      );
    });
  }
});

describe("GET /api/notifications", () => {
  it("lists notifications", async () => {
    const res = await request(app).get("/api/notifications").set("Cookie", cookie).expect(200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters by email", async () => {
    const res = await request(app)
      .get(`/api/notifications?email=${TEST_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);
    assert.ok(Array.isArray(res.body.data));
  });

  it("rejects invalid severity", async () => {
    await request(app)
      .get("/api/notifications?severity=extreme")
      .set("Cookie", cookie)
      .expect(400);
  });
});

describe("GET /api/notifications/count", () => {
  it("returns unread count for email", async () => {
    const res = await request(app)
      .get(`/api/notifications/count?email=${TEST_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(typeof res.body.unread, "number");
  });

  it("requires email or subscription_id", async () => {
    await request(app)
      .get("/api/notifications/count")
      .set("Cookie", cookie)
      .expect(400);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  it("returns 404 for non-existent notification", async () => {
    await request(app)
      .patch(`/api/notifications/${NON_EXISTENT_ID}/read`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

describe("PATCH /api/notifications/read-all", () => {
  it("requires email or subscription_id", async () => {
    await request(app)
      .patch("/api/notifications/read-all")
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });

  it("marks all as read for email", async () => {
    const res = await request(app)
      .patch("/api/notifications/read-all")
      .set("Cookie", cookie)
      .send({ email: TEST_EMAIL })
      .expect(200);
    assert.equal(typeof res.body.updated, "number");
  });
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
