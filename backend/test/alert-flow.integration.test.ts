import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { signInOperator } from "./helpers/pressroom";
import { NotificationService } from "../src/services/notification";
import { EmailDeliveryService } from "../src/services/email-delivery";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const FLOW_EMAIL = "alert-flow-test@example.com";

// The legacy `/api/subscriptions` and `/api/notifications` routes are
// operator-only; the verify and unsubscribe links a subscriber follows are not.
// The flow below crosses that line twice, which is the shape of the real thing.
let cookie: string;

before(async () => {
  cookie = await signInOperator("alert-flow-suite@example.invalid", "Alert Flow Suite");
});

async function cleanup() {
  await db("notifications").whereIn(
    "subscription_id",
    db("alert_subscriptions").select("id").where({ email: FLOW_EMAIL }),
  ).del();
  await db("alert_subscriptions").where({ email: FLOW_EMAIL }).del();
  await db("anomaly_flags").where({ description: "Flow test flag" }).del();
}

describe("Full alert flow: subscribe → detect anomaly → notification → email queued", () => {
  let subscriptionId: string;
  let verifyToken: string;
  let unsubscribeToken: string;

  before(cleanup);
  after(cleanup);

  afterEach(async () => {
    await db("notifications").whereIn(
      "subscription_id",
      db("alert_subscriptions").select("id").where({ email: FLOW_EMAIL }),
    ).del();
    await db("anomaly_flags").where({ description: "Flow test flag" }).del();
  });

  it("step 1: creates and verifies a subscription via API", async () => {
    const createRes = await request(app)
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ email: FLOW_EMAIL, jurisdiction_id: BOZEMAN_ID })
      .expect(201);

    subscriptionId = createRes.body.id;
    assert.ok(subscriptionId);
    assert.equal(createRes.body.verified, false);
    assert.equal(createRes.body.verify_token, undefined, "the response must not carry the token");

    // Read both tokens the way the subscriber gets them — out of band. The
    // response that creates the row deliberately withholds them.
    const sub = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    verifyToken = sub.verify_token;
    unsubscribeToken = sub.unsubscribe_token;

    await request(app)
      .get(`/api/subscriptions/verify/${verifyToken}`)
      .expect(200);

    const verified = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    assert.equal(verified.verified, true);
  });

  it("step 2: detect anomaly triggers notification creation with correct email_status", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Flow test flag",
        severity: "high",
      })
      .returning("id");

    const immediateIds: string[] = [];
    const service = new NotificationService(db, async (ids) => {
      immediateIds.push(...ids);
    });

    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "Flow test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id });

    assert.equal(notifications.length, 1, "One notification should be created");
    assert.equal(notifications[0].severity, "high");
    assert.equal(notifications[0].email_status, "queued", "High severity = queued for immediate send");
    assert.equal(notifications[0].read, false);
    assert.ok(immediateIds.includes(notifications[0].id), "Notification ID should be in immediate callback");
  });

  it("step 3: EmailDeliveryService sends the queued notification", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Flow test flag",
        severity: "high",
      })
      .returning("id");

    await db("notifications").insert({
      subscription_id: subscriptionId,
      anomaly_flag_id: flag.id,
      severity: "high",
      email_status: "queued",
    });

    const [notif] = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .select("id");

    const emailService = new EmailDeliveryService(db);
    await emailService.sendImmediateAlerts([notif.id]);

    const updated = await db("notifications").where({ id: notif.id }).first();
    // `dry_run`, not `sent`. No RESEND_API_KEY is configured in tests, so
    // nothing left the process — and this assertion used to demand `sent`,
    // which meant the suite was pinning the defect in place. `sent` now
    // requires a provider message id, and there is no provider here.
    assert.equal(
      updated.email_status,
      "dry_run",
      "a send with no provider configured is a dry run, not a delivery",
    );
    assert.equal(
      updated.email_sent_at,
      null,
      "a dry run gets no send timestamp — one would read exactly like a send",
    );
  });

  it("step 4: notification appears in API with correct metadata", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Flow test flag",
        severity: "high",
      })
      .returning("id");

    await db("notifications").insert({
      subscription_id: subscriptionId,
      anomaly_flag_id: flag.id,
      severity: "high",
      email_status: "queued",
    });

    const listRes = await request(app)
      .get(`/api/notifications?email=${FLOW_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);

    assert.ok(listRes.body.data.length >= 1);
    const notif = listRes.body.data[0];
    assert.equal(notif.email, FLOW_EMAIL);
    assert.equal(notif.severity, "high");
    assert.equal(notif.flag_type, "emergency_session");
    assert.equal(notif.read, false);

    const countRes = await request(app)
      .get(`/api/notifications/count?email=${FLOW_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);

    assert.ok(countRes.body.unread >= 1);
  });

  it("step 5: mark notification as read and verify count decreases", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Flow test flag",
        severity: "high",
      })
      .returning("id");

    const [notif] = await db("notifications")
      .insert({
        subscription_id: subscriptionId,
        anomaly_flag_id: flag.id,
        severity: "high",
        email_status: "queued",
      })
      .returning("id");

    const beforeCount = await request(app)
      .get(`/api/notifications/count?email=${FLOW_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);

    await request(app)
      .patch(`/api/notifications/${notif.id}/read`)
      .set("Cookie", cookie)
      .expect(200);

    const afterCount = await request(app)
      .get(`/api/notifications/count?email=${FLOW_EMAIL}`)
      .set("Cookie", cookie)
      .expect(200);

    assert.ok(afterCount.body.unread < beforeCount.body.unread, "Unread count should decrease after marking read");
  });

  it("step 6: unsubscribe prevents future email queuing", async () => {
    await request(app)
      .get(`/api/subscriptions/unsubscribe/${unsubscribeToken}`)
      .expect(200);

    const sub = await db("alert_subscriptions").where({ id: subscriptionId }).first();
    assert.equal(sub.email_enabled, false);

    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "Flow test flag",
        severity: "critical",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "Flow test flag",
      severity: "critical",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "skipped", "Unsubscribed user's notifications should be skipped");

    await db("alert_subscriptions")
      .where({ id: subscriptionId })
      .update({ email_enabled: true });
  });
});

// Detection is a write and is operator-only. This suite drives it over HTTP
// rather than calling the service, which is the point of it.
let operatorCookie: string;

before(async () => {
  operatorCookie = await signInOperator("alert-flow@test.invalid", "Alert Flow Suite");
});

// Not in `cleanup()` — that runs in a `before` hook too, and deleting the
// operator there revokes the session this suite just signed in with.
// `seedFirstOperator` only acts while `operators` is empty, so the row must
// still go, or `operator-auth.test.ts` asserts against a table this suite filled.
after(async () => {
  await db("operators").where({ email: "alert-flow@test.invalid" }).del();
});

describe("Full flow via HTTP: detect-anomalies endpoint triggers notifications", () => {
  let subscriptionId: string;

  before(async () => {
    await cleanup();
    await db("anomaly_flags").where({ meeting_id: COMPLETED_MEETING_ID }).del();

    const [sub] = await db("alert_subscriptions")
      .insert({
        email: FLOW_EMAIL,
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "ft".padEnd(64, "0"),
        unsubscribe_token: "fu".padEnd(64, "0"),
        verified: true,
        email_enabled: true,
      })
      .returning("id");
    subscriptionId = sub.id;
  });

  after(cleanup);

  it("POST /api/meetings/:id/detect-anomalies creates anomalies and triggers notification pipeline", async () => {
    const res = await request(app)
      .post(`/api/meetings/${COMPLETED_MEETING_ID}/detect-anomalies`)
      .set("Cookie", operatorCookie)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));

    interface DetectedFlag {
      id: string;
      flag_type: string;
      review_state: "published" | "held";
    }
    const detected: DetectedFlag[] = res.body.data;
    const published = detected.filter((flag) => flag.review_state === "published");
    const held = detected.filter((flag) => flag.review_state === "held");

    await new Promise((resolve) => setTimeout(resolve, 200));

    /**
     * **B-a split this assertion in two, and the second half is the point.**
     *
     * The detector no longer publishes everything it finds: a finding at or
     * above the review threshold is written `held` and waits for an operator.
     * `IMMEDIATE_SEVERITIES` in the notification service is exactly `critical`
     * and `high` — the severities the default threshold holds — so before the
     * queue landed, the pipeline would have withheld a generated claim from the
     * site and emailed it in the same breath. Nothing is notified about until it
     * is public.
     */
    if (held.length > 0) {
      const heldNotifications = await db("notifications")
        .where({ subscription_id: subscriptionId })
        .whereIn(
          "anomaly_flag_id",
          held.map((flag) => flag.id),
        );
      assert.equal(
        heldNotifications.length,
        0,
        "a held finding must never be notified about — it is not public",
      );
    }

    if (published.length > 0) {
      const notifications = await db("notifications")
        .where({ subscription_id: subscriptionId })
        .whereIn(
          "anomaly_flag_id",
          published.map((flag) => flag.id),
        );

      assert.ok(
        notifications.length > 0,
        "Notifications should be created for published anomalies",
      );

      for (const notif of notifications) {
        assert.ok(
          ["queued", "pending"].includes(notif.email_status),
          `email_status should be queued or pending, got ${notif.email_status}`,
        );
      }
    }
  });
});

// Closes the knex pool.
//
// Without this the process kept an idle connection open forever and the run
// never ended, which is why `--test-force-exit` was on the test script. That
// flag hid a worse problem than it solved: it calls `process.exit()`, which
// drops whatever the child had not yet flushed to the reporter, so the largest
// suite in the repo reported a random subset of its tests — 29, 40 or 44 of 68
// — always green, with nothing to say some had gone unreported. Closing the
// pool properly is what let the flag come off.
after(async () => {
  await db.destroy();
});
