import type { Knex } from "knex";
import { EventEmitter } from "node:events";

interface AnomalyFlag {
  id?: string;
  meeting_id: string;
  flag_type: string;
  description: string;
  severity: string;
}

interface Subscription {
  id: string;
  email: string;
  jurisdiction_id: string;
  email_enabled: boolean;
  digest_only: boolean;
  verified: boolean;
}

const IMMEDIATE_SEVERITIES = ["critical", "high"];

export const anomalyEvents = new EventEmitter();

export class NotificationService {
  constructor(
    private db: Knex,
    private onImmediateNotification?: (notificationIds: string[]) => Promise<void>,
  ) {
    anomalyEvents.on("anomaly.detected", (flags: AnomalyFlag[]) => {
      this.processAnomalyEvent(flags).catch((err) => {
        console.error("NotificationService: failed to process anomaly event", err);
      });
    });
  }

  async processAnomalyEvent(flags: AnomalyFlag[]): Promise<void> {
    if (flags.length === 0) return;

    const meetingId = flags[0].meeting_id;

    const jurisdictionRow = await this.db("meetings")
      .join("commissions", "meetings.commission_id", "commissions.id")
      .where("meetings.id", meetingId)
      .select("commissions.jurisdiction_id")
      .first();

    if (!jurisdictionRow) return;

    const subscriptions: Subscription[] = await this.db("alert_subscriptions")
      .where({ jurisdiction_id: jurisdictionRow.jurisdiction_id, verified: true });

    if (subscriptions.length === 0) return;

    // Published only. This re-query resolves by (meeting_id, flag_type) rather
    // than by id, so without the filter a *held* finding of the same type on
    // the same meeting would be notified about — a generated claim about a
    // named person, emailed while the site is still withholding it, which is
    // the exact failure the review queue exists to prevent.
    const flagRows = await this.db("anomaly_flags")
      .where({ meeting_id: meetingId, review_state: "published" })
      .whereIn("flag_type", flags.map((f) => f.flag_type))
      .select("id", "severity", "flag_type");

    if (flagRows.length === 0) return;

    const immediateNotificationIds: string[] = [];

    for (const flag of flagRows) {
      const isImmediate = IMMEDIATE_SEVERITIES.includes(flag.severity);

      const notifications = subscriptions.map((sub) => {
        let emailStatus: string;
        if (!sub.email_enabled) {
          emailStatus = "skipped";
        } else if (sub.digest_only && !IMMEDIATE_SEVERITIES.includes(flag.severity)) {
          emailStatus = "pending";
        } else if (isImmediate) {
          emailStatus = "queued";
        } else {
          emailStatus = "pending";
        }

        return {
          subscription_id: sub.id,
          anomaly_flag_id: flag.id,
          severity: flag.severity,
          email_status: emailStatus,
        };
      });

      for (const notification of notifications) {
        try {
          const [inserted] = await this.db("notifications")
            .insert(notification)
            .onConflict(["subscription_id", "anomaly_flag_id"])
            .ignore()
            .returning("id");

          if (inserted && notification.email_status === "queued") {
            immediateNotificationIds.push(inserted.id);
          }
        } catch {
          // UNIQUE constraint violation — duplicate already handled, skip
        }
      }
    }

    if (immediateNotificationIds.length > 0 && this.onImmediateNotification) {
      await this.onImmediateNotification(immediateNotificationIds);
    }
  }
}
