import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { NotificationService } from "../src/services/notification";
import { EmailDeliveryService } from "../src/services/email-delivery";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const FLOW_EMAIL = "alert-flow-test@example.com";

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
      .send({ email: FLOW_EMAIL, jurisdiction_id: BOZEMAN_ID })
      .expect(201);

    subscriptionId = createRes.body.id;
    verifyToken = createRes.body.verify_token;
    assert.ok(subscriptionId);
    assert.equal(createRes.body.verified, false);

    const sub = await db("alert_subscriptions").where({ id: subscriptionId }).first();
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
    assert.equal(updated.email_status, "sent", "Notification should be marked as sent after email delivery");
    assert.ok(updated.email_sent_at, "email_sent_at should be set");
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
      .expect(200);

    assert.ok(listRes.body.data.length >= 1);
    const notif = listRes.body.data[0];
    assert.equal(notif.email, FLOW_EMAIL);
    assert.equal(notif.severity, "high");
    assert.equal(notif.flag_type, "emergency_session");
    assert.equal(notif.read, false);

    const countRes = await request(app)
      .get(`/api/notifications/count?email=${FLOW_EMAIL}`)
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
      .expect(200);

    await request(app)
      .patch(`/api/notifications/${notif.id}/read`)
      .expect(200);

    const afterCount = await request(app)
      .get(`/api/notifications/count?email=${FLOW_EMAIL}`)
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
      .expect(200);

    assert.ok(Array.isArray(res.body.data));

    if (res.body.count > 0) {
      const flagTypes = res.body.data.map((f: { flag_type: string }) => f.flag_type);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const notifications = await db("notifications")
        .where({ subscription_id: subscriptionId })
        .whereIn("anomaly_flag_id",
          db("anomaly_flags")
            .select("id")
            .where({ meeting_id: COMPLETED_MEETING_ID })
            .whereIn("flag_type", flagTypes),
        );

      assert.ok(notifications.length > 0, "Notifications should be created for detected anomalies");

      for (const notif of notifications) {
        assert.ok(
          ["queued", "pending"].includes(notif.email_status),
          `email_status should be queued or pending, got ${notif.email_status}`,
        );
      }
    }
  });
});
