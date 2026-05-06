import type { Knex } from "knex";
import { EmailDeliveryService } from "./email-delivery";

interface CronJob {
  stop: () => void;
}

export class DigestScheduler {
  private dailyJob: CronJob | null = null;
  private weeklyJob: CronJob | null = null;
  private lastDailyRun: Date | null = null;
  private lastWeeklyRun: Date | null = null;

  constructor(
    private db: Knex,
    private emailService: EmailDeliveryService,
  ) {}

  async start(): Promise<void> {
    try {
      const cron = await import("node-cron");

      // Daily digest at 06:00 UTC for medium severity
      this.dailyJob = cron.schedule("0 6 * * *", () => {
        this.runDailyDigest().catch((err) => {
          console.error("DigestScheduler: daily digest failed", err);
        });
      }, { timezone: "UTC" });

      // Weekly digest on Mondays at 06:00 UTC for low severity
      this.weeklyJob = cron.schedule("0 6 * * 1", () => {
        this.runWeeklyDigest().catch((err) => {
          console.error("DigestScheduler: weekly digest failed", err);
        });
      }, { timezone: "UTC" });

      console.log("DigestScheduler: started (daily 06:00 UTC, weekly Monday 06:00 UTC)");
    } catch {
      console.warn("DigestScheduler: node-cron not available, digest scheduling disabled");
    }
  }

  stop(): void {
    this.dailyJob?.stop();
    this.weeklyJob?.stop();
    this.dailyJob = null;
    this.weeklyJob = null;
  }

  async runDailyDigest(): Promise<{ sent: number; failed: number }> {
    console.log("DigestScheduler: running daily digest");

    const subscriptionIds = await this.getPendingSubscriptions(["medium"]);
    const result = await this.emailService.sendDigest(subscriptionIds, ["medium"]);

    this.lastDailyRun = new Date();
    console.log(`DigestScheduler: daily digest complete — sent=${result.sent} failed=${result.failed}`);
    return result;
  }

  async runWeeklyDigest(): Promise<{ sent: number; failed: number }> {
    console.log("DigestScheduler: running weekly digest");

    const subscriptionIds = await this.getPendingSubscriptions(["low"]);
    const result = await this.emailService.sendDigest(subscriptionIds, ["low"]);

    this.lastWeeklyRun = new Date();
    console.log(`DigestScheduler: weekly digest complete — sent=${result.sent} failed=${result.failed}`);
    return result;
  }

  getStatus(): { dailyLastRun: Date | null; weeklyLastRun: Date | null; running: boolean } {
    return {
      dailyLastRun: this.lastDailyRun,
      weeklyLastRun: this.lastWeeklyRun,
      running: this.dailyJob !== null,
    };
  }

  private async getPendingSubscriptions(severities: string[]): Promise<string[]> {
    const rows = await this.db("notifications")
      .join("alert_subscriptions", "notifications.subscription_id", "alert_subscriptions.id")
      .where("notifications.email_status", "pending")
      .where("alert_subscriptions.email_enabled", true)
      .where("alert_subscriptions.verified", true)
      .whereIn("notifications.severity", severities)
      .distinct("notifications.subscription_id")
      .select("notifications.subscription_id");

    return rows.map((r: { subscription_id: string }) => r.subscription_id);
  }
}
