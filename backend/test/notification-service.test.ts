import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { NotificationService } from "../src/services/notification";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const TEST_EMAIL_PREFIX = "ns-unit-test";

function testEmail(suffix: string): string {
  return `${TEST_EMAIL_PREFIX}-${suffix}@example.com`;
}

async function cleanup() {
  await db("notifications").whereIn(
    "subscription_id",
    db("alert_subscriptions").select("id").where("email", "like", `${TEST_EMAIL_PREFIX}%`),
  ).del();
  await db("alert_subscriptions").where("email", "like", `${TEST_EMAIL_PREFIX}%`).del();
  await db("anomaly_flags").where({ description: "NS unit test flag" }).del();
}

describe("NotificationService — subscription resolution", () => {
  before(cleanup);
  after(cleanup);

  it("skips unverified subscriptions", async () => {
    const email = testEmail("unverified");
    await db("alert_subscriptions").insert({
      email,
      jurisdiction_id: BOZEMAN_ID,
      verify_token: "u".repeat(64),
      unsubscribe_token: "v".repeat(64),
      verified: false,
    });

    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "high",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .whereIn("subscription_id",
        db("alert_subscriptions").select("id").where({ email }))
      .where({ anomaly_flag_id: flag.id });

    assert.equal(notifications.length, 0, "Unverified subscriptions should not receive notifications");

    await db("anomaly_flags").where({ id: flag.id }).del();
    await db("alert_subscriptions").where({ email }).del();
  });

  it("returns early when no subscriptions match the jurisdiction", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "high",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .where({ anomaly_flag_id: flag.id });
    assert.equal(notifications.length, 0);

    await db("anomaly_flags").where({ id: flag.id }).del();
  });

  it("does nothing for empty flags array", async () => {
    const service = new NotificationService(db);
    await service.processAnomalyEvent([]);
  });
});

describe("NotificationService — severity routing", () => {
  let subscriptionId: string;
  let digestSubscriptionId: string;
  let disabledSubscriptionId: string;

  before(async () => {
    await cleanup();

    const [sub] = await db("alert_subscriptions")
      .insert({
        email: testEmail("severity-normal"),
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "s1".padEnd(64, "0"),
        unsubscribe_token: "s2".padEnd(64, "0"),
        verified: true,
        email_enabled: true,
        digest_only: false,
      })
      .returning("id");
    subscriptionId = sub.id;

    const [digestSub] = await db("alert_subscriptions")
      .insert({
        email: testEmail("severity-digest"),
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "d1".padEnd(64, "0"),
        unsubscribe_token: "d2".padEnd(64, "0"),
        verified: true,
        email_enabled: true,
        digest_only: true,
      })
      .returning("id");
    digestSubscriptionId = digestSub.id;

    const [disabledSub] = await db("alert_subscriptions")
      .insert({
        email: testEmail("severity-disabled"),
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "x1".padEnd(64, "0"),
        unsubscribe_token: "x2".padEnd(64, "0"),
        verified: true,
        email_enabled: false,
        digest_only: false,
      })
      .returning("id");
    disabledSubscriptionId = disabledSub.id;
  });

  afterEach(async () => {
    await db("notifications").whereIn("subscription_id", [
      subscriptionId, digestSubscriptionId, disabledSubscriptionId,
    ]).del();
    await db("anomaly_flags").where({ description: "NS unit test flag" }).del();
  });

  after(cleanup);

  it("queues immediate email for critical severity", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "critical",
      })
      .returning("id");

    const immediateIds: string[] = [];
    const service = new NotificationService(db, async (ids) => {
      immediateIds.push(...ids);
    });

    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "critical",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "queued", "Critical severity should be queued for immediate send");
    assert.ok(immediateIds.length > 0, "onImmediateNotification callback should be invoked");
  });

  it("queues immediate email for high severity", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
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
      description: "NS unit test flag",
      severity: "high",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "queued");
    assert.ok(immediateIds.length > 0);
  });

  it("sets pending status for medium severity (digest)", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "medium",
      })
      .returning("id");

    const immediateIds: string[] = [];
    const service = new NotificationService(db, async (ids) => {
      immediateIds.push(...ids);
    });

    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "medium",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "pending", "Medium severity should be pending for digest");
    assert.equal(immediateIds.length, 0, "No immediate callback for medium severity");
  });

  it("sets pending status for low severity (digest)", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "low",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "low",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: subscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "pending");
  });

  it("digest-only subscriber still gets queued for critical/high severity", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "critical",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "critical",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: digestSubscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "queued", "Digest-only subs still get immediate for critical");
  });

  it("digest-only subscriber gets pending for medium severity", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "medium",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "medium",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: digestSubscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "pending");
  });

  it("skips email for subscribers with email_enabled=false", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "critical",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "critical",
    }]);

    const notif = await db("notifications")
      .where({ subscription_id: disabledSubscriptionId, anomaly_flag_id: flag.id })
      .first();

    assert.equal(notif.email_status, "skipped", "Disabled-email subs should have skipped status");
  });

  it("creates notifications for all matching subscribers at once", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: COMPLETED_MEETING_ID,
        flag_type: "emergency_session",
        description: "NS unit test flag",
        severity: "high",
      })
      .returning("id");

    const service = new NotificationService(db);
    await service.processAnomalyEvent([{
      meeting_id: COMPLETED_MEETING_ID,
      flag_type: "emergency_session",
      description: "NS unit test flag",
      severity: "high",
    }]);

    const notifications = await db("notifications")
      .where({ anomaly_flag_id: flag.id })
      .whereIn("subscription_id", [subscriptionId, digestSubscriptionId, disabledSubscriptionId]);

    assert.equal(notifications.length, 3, "Should create one notification per verified subscriber");
  });
});
