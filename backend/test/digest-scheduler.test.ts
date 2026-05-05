import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { DigestScheduler } from "../src/services/digest-scheduler";
import { EmailDeliveryService } from "../src/services/email-delivery";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const DIGEST_EMAIL = "digest-test@example.com";

describe("DigestScheduler", () => {
  let subscriptionId: string;
  let emailService: EmailDeliveryService;
  let scheduler: DigestScheduler;

  before(async () => {
    await db("notifications").whereIn(
      "subscription_id",
      db("alert_subscriptions").select("id").where({ email: DIGEST_EMAIL }),
    ).del();
    await db("alert_subscriptions").where({ email: DIGEST_EMAIL }).del();

    const [sub] = await db("alert_subscriptions")
      .insert({
        email: DIGEST_EMAIL,
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "d".repeat(64),
        unsubscribe_token: "e".repeat(64),
        verified: true,
        email_enabled: true,
      })
      .returning("id");
    subscriptionId = sub.id;

    emailService = new EmailDeliveryService(db);
    scheduler = new DigestScheduler(db, emailService);
  });

  after(async () => {
    scheduler.stop();
    await db("notifications").whereIn(
      "subscription_id",
      db("alert_subscriptions").select("id").where({ email: DIGEST_EMAIL }),
    ).del();
    await db("alert_subscriptions").where({ email: DIGEST_EMAIL }).del();
  });

  describe("getStatus", () => {
    it("returns initial status with no runs", () => {
      const status = scheduler.getStatus();
      assert.equal(status.dailyLastRun, null);
      assert.equal(status.weeklyLastRun, null);
      assert.equal(status.running, false);
    });

    it("reports running after start", async () => {
      await scheduler.start();
      const status = scheduler.getStatus();
      assert.equal(status.running, true);
      scheduler.stop();
      assert.equal(scheduler.getStatus().running, false);
    });
  });

  describe("runDailyDigest", () => {
    let flagId: string;

    beforeEach(async () => {
      const [flag] = await db("anomaly_flags")
        .insert({
          meeting_id: COMPLETED_MEETING_ID,
          flag_type: "emergency_session",
          description: "Daily digest test flag",
          severity: "medium",
        })
        .returning("id");
      flagId = flag.id;

      await db("notifications").insert({
        subscription_id: subscriptionId,
        anomaly_flag_id: flagId,
        severity: "medium",
        email_status: "pending",
      });
    });

    afterEach(async () => {
      await db("notifications").where({ subscription_id: subscriptionId }).del();
      await db("anomaly_flags").where({ id: flagId }).del();
    });

    it("sends digest for pending medium-severity notifications", async () => {
      const result = await scheduler.runDailyDigest();
      assert.equal(result.sent, 1);
      assert.equal(result.failed, 0);

      const [notif] = await db("notifications")
        .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId })
        .select("email_status");
      assert.equal(notif.email_status, "sent");

      assert.ok(scheduler.getStatus().dailyLastRun instanceof Date);
    });

    it("skips low-severity notifications", async () => {
      await db("notifications")
        .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId })
        .update({ severity: "low" });

      const result = await scheduler.runDailyDigest();
      assert.equal(result.sent, 0);
    });

    it("returns zero counts when no pending notifications", async () => {
      await db("notifications")
        .where({ subscription_id: subscriptionId })
        .update({ email_status: "sent" });

      const result = await scheduler.runDailyDigest();
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 0);
    });
  });

  describe("runWeeklyDigest", () => {
    let flagId: string;

    beforeEach(async () => {
      const [flag] = await db("anomaly_flags")
        .insert({
          meeting_id: COMPLETED_MEETING_ID,
          flag_type: "quorum_anomaly",
          description: "Weekly digest test flag",
          severity: "low",
        })
        .returning("id");
      flagId = flag.id;

      await db("notifications").insert({
        subscription_id: subscriptionId,
        anomaly_flag_id: flagId,
        severity: "low",
        email_status: "pending",
      });
    });

    afterEach(async () => {
      await db("notifications").where({ subscription_id: subscriptionId }).del();
      await db("anomaly_flags").where({ id: flagId }).del();
    });

    it("sends digest for pending low-severity notifications", async () => {
      const result = await scheduler.runWeeklyDigest();
      assert.equal(result.sent, 1);
      assert.equal(result.failed, 0);

      const [notif] = await db("notifications")
        .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId })
        .select("email_status");
      assert.equal(notif.email_status, "sent");

      assert.ok(scheduler.getStatus().weeklyLastRun instanceof Date);
    });

    it("skips medium-severity notifications", async () => {
      await db("notifications")
        .where({ subscription_id: subscriptionId, anomaly_flag_id: flagId })
        .update({ severity: "medium" });

      const result = await scheduler.runWeeklyDigest();
      assert.equal(result.sent, 0);
    });
  });

  describe("graceful shutdown", () => {
    it("clears jobs on stop", async () => {
      await scheduler.start();
      assert.equal(scheduler.getStatus().running, true);
      scheduler.stop();
      assert.equal(scheduler.getStatus().running, false);
    });

    it("stop is idempotent", () => {
      scheduler.stop();
      scheduler.stop();
      assert.equal(scheduler.getStatus().running, false);
    });
  });
});
