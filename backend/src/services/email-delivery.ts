import type { Knex } from "knex";

interface NotificationWithContext {
  id: string;
  email: string;
  severity: string;
  flag_type: string;
  anomaly_description: string;
  meeting_id: string;
  meeting_date: string;
  jurisdiction_name: string;
  unsubscribe_token: string;
}

interface ResendClient {
  emails: {
    send: (params: {
      from: string;
      to: string;
      subject: string;
      html: string;
    }) => Promise<{ id: string }>;
  };
}

export class EmailDeliveryService {
  private resend: ResendClient | null = null;
  private fromEmail: string;

  constructor(
    private db: Knex,
    apiKey?: string,
    fromEmail?: string,
  ) {
    this.fromEmail = fromEmail || process.env.ALERT_FROM_EMAIL || "alerts@commissionwatch.org";
    const key = apiKey || process.env.RESEND_API_KEY;
    if (key) {
      this.initResend(key);
    }
  }

  private async initResend(apiKey: string): Promise<void> {
    try {
      const { Resend } = await import("resend");
      this.resend = new Resend(apiKey) as unknown as ResendClient;
    } catch {
      console.warn("EmailDeliveryService: resend package not available, emails will be logged only");
    }
  }

  async sendImmediateAlerts(notificationIds: string[]): Promise<void> {
    if (notificationIds.length === 0) return;

    const notifications = await this.getNotificationsWithContext(notificationIds);

    for (const notification of notifications) {
      try {
        const subject = `[${notification.severity.toUpperCase()}] Civic anomaly detected in ${notification.jurisdiction_name}`;
        const html = this.renderImmediateEmail(notification);

        await this.sendEmail(notification.email, subject, html);

        await this.db("notifications")
          .where({ id: notification.id })
          .update({ email_status: "sent", email_sent_at: this.db.fn.now() });
      } catch (err) {
        console.error(`EmailDeliveryService: failed to send notification ${notification.id}`, err);
        await this.db("notifications")
          .where({ id: notification.id })
          .update({ email_status: "failed" });
      }
    }
  }

  async sendDigest(subscriptionIds: string[], severities: string[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (const subscriptionId of subscriptionIds) {
      try {
        const notifications = await this.db("notifications")
          .join("anomaly_flags", "notifications.anomaly_flag_id", "anomaly_flags.id")
          .join("meetings", "anomaly_flags.meeting_id", "meetings.id")
          .join("commissions", "meetings.commission_id", "commissions.id")
          .join("jurisdictions", "commissions.jurisdiction_id", "jurisdictions.id")
          .join("alert_subscriptions", "notifications.subscription_id", "alert_subscriptions.id")
          .where("notifications.subscription_id", subscriptionId)
          .where("notifications.email_status", "pending")
          .whereIn("notifications.severity", severities)
          .select(
            "notifications.id",
            "notifications.severity",
            "anomaly_flags.flag_type",
            "anomaly_flags.description as anomaly_description",
            "anomaly_flags.meeting_id",
            "meetings.date as meeting_date",
            "jurisdictions.name as jurisdiction_name",
            "alert_subscriptions.email",
            "alert_subscriptions.unsubscribe_token",
          );

        if (notifications.length === 0) continue;

        const jurisdiction = notifications[0].jurisdiction_name;
        const email = notifications[0].email;
        const unsubToken = notifications[0].unsubscribe_token;
        const isWeekly = severities.includes("low");

        const subject = isWeekly
          ? `Weekly civic digest for ${jurisdiction}`
          : `Daily civic digest for ${jurisdiction}`;

        const html = this.renderDigestEmail(notifications, jurisdiction, unsubToken, isWeekly);
        await this.sendEmail(email, subject, html);

        const ids = notifications.map((n: { id: string }) => n.id);
        await this.db("notifications")
          .whereIn("id", ids)
          .update({ email_status: "sent", email_sent_at: this.db.fn.now() });

        sent++;
      } catch (err) {
        console.error(`EmailDeliveryService: digest failed for subscription ${subscriptionId}`, err);
        failed++;
      }
    }

    return { sent, failed };
  }

  private async getNotificationsWithContext(ids: string[]): Promise<NotificationWithContext[]> {
    return this.db("notifications")
      .join("anomaly_flags", "notifications.anomaly_flag_id", "anomaly_flags.id")
      .join("meetings", "anomaly_flags.meeting_id", "meetings.id")
      .join("commissions", "meetings.commission_id", "commissions.id")
      .join("jurisdictions", "commissions.jurisdiction_id", "jurisdictions.id")
      .join("alert_subscriptions", "notifications.subscription_id", "alert_subscriptions.id")
      .whereIn("notifications.id", ids)
      .select(
        "notifications.id",
        "notifications.severity",
        "anomaly_flags.flag_type",
        "anomaly_flags.description as anomaly_description",
        "anomaly_flags.meeting_id",
        "meetings.date as meeting_date",
        "jurisdictions.name as jurisdiction_name",
        "alert_subscriptions.email",
        "alert_subscriptions.unsubscribe_token",
      );
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (this.resend) {
      await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject,
        html,
      });
    } else {
      console.log(`EmailDeliveryService [dry-run]: to=${to} subject="${subject}"`);
    }
  }

  private renderImmediateEmail(n: NotificationWithContext): string {
    const flagLabel = n.flag_type.replace(/_/g, " ");
    return `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #dc2626;">Civic Anomaly Alert</h2>
  <p><strong>Jurisdiction:</strong> ${this.escapeHtml(n.jurisdiction_name)}</p>
  <p><strong>Severity:</strong> ${this.escapeHtml(n.severity.toUpperCase())}</p>
  <p><strong>Type:</strong> ${this.escapeHtml(flagLabel)}</p>
  <p><strong>Details:</strong> ${this.escapeHtml(n.anomaly_description)}</p>
  <p><strong>Meeting date:</strong> ${this.escapeHtml(n.meeting_date)}</p>
  <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
  <p style="font-size: 12px; color: #6b7280;">
    You received this because you subscribed to alerts for ${this.escapeHtml(n.jurisdiction_name)}.
    <a href="${this.unsubscribeUrl(n.unsubscribe_token)}">Unsubscribe</a>
  </p>
</body>
</html>`.trim();
  }

  private renderDigestEmail(
    notifications: NotificationWithContext[],
    jurisdiction: string,
    unsubToken: string,
    isWeekly: boolean,
  ): string {
    const items = notifications.map((n) => {
      const flagLabel = n.flag_type.replace(/_/g, " ");
      return `<li><strong>[${this.escapeHtml(n.severity)}]</strong> ${this.escapeHtml(flagLabel)} — ${this.escapeHtml(n.anomaly_description)} (${this.escapeHtml(n.meeting_date)})</li>`;
    }).join("\n");

    const period = isWeekly ? "weekly" : "daily";
    return `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>Your ${period} civic digest for ${this.escapeHtml(jurisdiction)}</h2>
  <p>${notifications.length} anomal${notifications.length === 1 ? "y" : "ies"} detected:</p>
  <ul>${items}</ul>
  <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
  <p style="font-size: 12px; color: #6b7280;">
    <a href="${this.unsubscribeUrl(unsubToken)}">Unsubscribe</a>
  </p>
</body>
</html>`.trim();
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private unsubscribeUrl(token: string): string {
    const base = process.env.APP_BASE_URL || "http://localhost:3001";
    return `${base}/api/subscriptions/unsubscribe/${token}`;
  }
}
