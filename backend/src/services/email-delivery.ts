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
    }) => Promise<{ id?: string } | null | undefined>;
  };
}

/**
 * What a send resolved to.
 *
 * A discriminated union rather than a boolean, because "nothing was configured"
 * and "the provider answered but told us nothing" are different facts and only
 * one of them is a failure worth retrying.
 */
/**
 * What a digest run did.
 *
 * `dryRun` is separate from both `sent` and `failed` because it is neither. A
 * deployment with no provider configured processes its whole queue correctly
 * and delivers nothing; folding that into `sent` is the lie this change exists
 * to remove, and folding it into `failed` would put a retry behind a
 * configuration choice.
 */
export interface DigestResult {
  sent: number;
  failed: number;
  dryRun: number;
}

export type SendOutcome =
  | { delivered: true; providerId: string }
  | { delivered: false; reason: "dry_run" | "no_provider_id" };

export class EmailDeliveryService {
  private resend: ResendClient | null = null;
  private fromEmail: string;
  private readonly apiKey: string | undefined;
  /** Memoised so N concurrent sends import the provider once, not N times. */
  private loading: Promise<void> | undefined;

  /**
   * The provider is loaded on first send, not in the constructor.
   *
   * It used to be `if (key) this.initResend(key)` — an `async` method called
   * without `await` from a synchronous constructor. `this.resend` was therefore
   * null for some window *after* construction even when `RESEND_API_KEY` was
   * set, so the earliest sends silently took the dry-run path and were recorded
   * as delivered. A constructor cannot await, so the fix is to stop pretending
   * it can: `client()` resolves once, memoises the promise, and every send goes
   * through it.
   */
  constructor(
    private db: Knex,
    apiKey?: string,
    fromEmail?: string,
  ) {
    this.fromEmail = fromEmail || process.env.ALERT_FROM_EMAIL || "alerts@commissionwatch.org";
    this.apiKey = apiKey || process.env.RESEND_API_KEY;
  }

  private async client(): Promise<ResendClient | null> {
    if (!this.apiKey) return null;
    this.loading ??= (async () => {
      try {
        const { Resend } = await import("resend");
        this.resend = new Resend(this.apiKey) as unknown as ResendClient;
      } catch {
        console.warn(
          "EmailDeliveryService: resend package not available, emails will be logged only",
        );
      }
    })();
    await this.loading;
    return this.resend;
  }

  async sendImmediateAlerts(notificationIds: string[]): Promise<void> {
    if (notificationIds.length === 0) return;

    const notifications = await this.getNotificationsWithContext(notificationIds);

    for (const notification of notifications) {
      try {
        const subject = `[${notification.severity.toUpperCase()}] Civic anomaly detected in ${notification.jurisdiction_name}`;
        const html = this.renderImmediateEmail(notification);

        const outcome = await this.sendEmail(notification.email, subject, html);
        const status = this.statusFor(outcome);

        await this.db("notifications")
          .where({ id: notification.id })
          .update({
            email_status: status,
            // Only a real delivery gets a timestamp. A dry run with a send time
            // on it reads, to anyone querying this table later, exactly like a
            // send.
            email_sent_at: status === "sent" ? this.db.fn.now() : null,
          });
      } catch (err) {
        console.error(`EmailDeliveryService: failed to send notification ${notification.id}`, err);
        await this.db("notifications")
          .where({ id: notification.id })
          .update({ email_status: "failed" });
      }
    }
  }

  async sendDigest(subscriptionIds: string[], severities: string[]): Promise<DigestResult> {
    let sent = 0;
    let failed = 0;
    let dryRun = 0;

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
        const outcome = await this.sendEmail(email, subject, html);
        const status = this.statusFor(outcome);

        const ids = notifications.map((n: { id: string }) => n.id);
        await this.db("notifications")
          .whereIn("id", ids)
          .update({
            email_status: status,
            email_sent_at: status === "sent" ? this.db.fn.now() : null,
          });

        // The counter reports digests actually delivered. It used to count
        // every loop iteration, which meant a dry-run deployment reported a
        // day's work it had not done.
        if (status === "sent") sent++;
        else if (status === "dry_run") dryRun++;
        else failed++;
      } catch (err) {
        console.error(`EmailDeliveryService: digest failed for subscription ${subscriptionId}`, err);
        failed++;
      }
    }

    return { sent, failed, dryRun };
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

  /**
   * Sends, or reports that it did not.
   *
   * The old signature was `Promise<void>`, which made "delivered to a provider"
   * and "written to stdout" indistinguishable to the caller — and both callers
   * then wrote `email_status: 'sent'`. `DigestScheduler` ran that daily in
   * production, so the notifications table has been recording sends that never
   * happened. A transparency project cannot keep a delivery log it knows is
   * false.
   *
   * `sent` now requires a provider message id. Nothing else is allowed to
   * produce it: an id is the only evidence available here that a message left
   * this process, and inferring delivery from the absence of an exception is
   * how the lie got in.
   */
  private async sendEmail(to: string, subject: string, html: string): Promise<SendOutcome> {
    const resend = await this.client();
    if (!resend) {
      console.log(`EmailDeliveryService [dry-run]: to=${to} subject="${subject}"`);
      return { delivered: false, reason: "dry_run" };
    }

    const result = await resend.emails.send({ from: this.fromEmail, to, subject, html });
    const providerId = typeof result?.id === "string" && result.id.length > 0 ? result.id : null;
    if (providerId === null) {
      // The provider answered without an id. That is not a delivery, and
      // recording it as one would put this back where it started.
      console.warn(`EmailDeliveryService: provider returned no message id for ${to}`);
      return { delivered: false, reason: "no_provider_id" };
    }
    return { delivered: true, providerId };
  }

  /** What a send resolved to. `email_status` is derived from this, never assumed. */
  private statusFor(outcome: SendOutcome): "sent" | "dry_run" | "failed" {
    if (outcome.delivered) return "sent";
    return outcome.reason === "dry_run" ? "dry_run" : "failed";
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

  private escapeHtml(value: unknown): string {
    const str = String(value ?? "");
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
