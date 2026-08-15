import type { Knex } from "knex";
import { isSuppressed } from "./email-suppression";

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

/**
 * The provider, reduced to the one call this service makes.
 *
 * Exported so a test can supply one. That seam exists because the properties
 * worth asserting here are all properties of what leaves the process — that a
 * suppressed address is never handed to a provider, that a list message carries
 * both RFC 8058 headers and a transactional one carries neither — and none of
 * them can be observed from outside without either a real network call or a way
 * to stand in for the provider. It is the second.
 */
export interface ResendClient {
  emails: {
    send: (params: {
      from: string;
      to: string;
      subject: string;
      html: string;
      headers?: Record<string, string>;
    }) => Promise<{ id?: string } | null | undefined>;
  };
}

/**
 * RFC 8058 one-click unsubscribe.
 *
 * Delivery §5c names both headers as a precondition for the first bulk send:
 * Gmail and Yahoo require them, and the requirement is the right one. They are
 * built here rather than by the callers because a header a caller can forget is
 * a header that will be missing from exactly the message that needed it.
 *
 * `List-Unsubscribe` carries only the https URI and no `mailto:` — a mailto
 * alternative would name an inbox nobody reads, and an unsubscribe address that
 * silently discards is worse than none. `List-Unsubscribe-Post` is what makes it
 * one-click; without it a provider treats the URI as an ordinary link and the
 * one-click button does not appear.
 *
 * A transactional message gets neither, deliberately. There is no list to leave,
 * and offering "unsubscribe" on the acknowledgement of somebody's own dispute
 * would offer to stop a reply they are waiting for.
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
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
  | { delivered: false; reason: "dry_run" | "no_provider_id" | "suppressed" };

/* ---------------------------------------------------------------------------
   The From address
   --------------------------------------------------------------------------- */

/**
 * The mailbox every alert appears to come from.
 *
 * Kept as a local part joined to a host at runtime rather than as a whole
 * address, which is the whole point of the change below.
 */
const ALERT_MAILBOX = "alerts";

/**
 * The domain to fall back on when `PUBLIC_BASE_URL` says nothing.
 *
 * This is the deployed host, and it is written here so that a deployment which
 * has not set `PUBLIC_BASE_URL` still sends from a domain we actually control
 * rather than from one we do not. It has to track the deploy: if the site moves,
 * this moves. `defaultAlertFromEmail` prefers `PUBLIC_BASE_URL` precisely so that
 * this constant is the exception rather than the mechanism.
 */
const DEPLOYED_DOMAIN = "commissionwatch.bmux.sh";

/**
 * The default From address, derived from `PUBLIC_BASE_URL`.
 *
 * **This used to be the literal `alerts@commissionwatch.org`**, and the site
 * deploys at `commissionwatch.bmux.sh`. Those are different organizational
 * domains, so the From header could never align with an SPF or DKIM record for
 * the domain actually sending — DMARC alignment failed *by construction*, on
 * every message, before any DNS was considered. A receiving mail server does not
 * report that as a configuration error; it reports it by putting the message in
 * a spam folder, which is indistinguishable from a subscriber ignoring it.
 *
 * Deriving it from `PUBLIC_BASE_URL` makes alignment a property of the code
 * rather than of two literals in different files agreeing. The same variable
 * already decides every canonical URL, every citation and every unsubscribe link,
 * so a deployment that gets it wrong is already visibly wrong in ways somebody
 * notices — which is exactly what the From address was not.
 *
 * **This does not make mail deliverable.** SPF, DKIM and DMARC records for the
 * sending domain are an operator and DNS task, they are recorded as such in
 * `docs/STATUS.md`, and nothing here creates or checks them. What this removes is
 * a misalignment no DNS record could have fixed.
 */
export function defaultAlertFromEmail(env: NodeJS.ProcessEnv = process.env): string {
  return `${ALERT_MAILBOX}@${alertDomain(env)}`;
}

/**
 * The host of `PUBLIC_BASE_URL`, or the deployed domain.
 *
 * A port is stripped: `localhost:3000` is a host and an authority, and only the
 * host belongs left of nothing and right of an `@`. An unparseable value falls
 * back rather than throwing — this is called from a constructor that runs at
 * boot, and refusing to start over a malformed variable would take the whole site
 * down to protect a dormant mailer.
 */
function alertDomain(env: NodeJS.ProcessEnv): string {
  const raw = env.PUBLIC_BASE_URL;
  if (raw === undefined || raw.trim() === "") return DEPLOYED_DOMAIN;
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return host === "" ? DEPLOYED_DOMAIN : host;
  } catch {
    return DEPLOYED_DOMAIN;
  }
}

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
    /** A stand-in provider. Tests only — see `ResendClient`. */
    private readonly injectedClient?: ResendClient,
  ) {
    // An explicit argument, then the operator's variable, then a default derived
    // from the deployed host — never a literal on a domain we do not deploy.
    this.fromEmail = fromEmail || process.env.ALERT_FROM_EMAIL || defaultAlertFromEmail();
    this.apiKey = apiKey || process.env.RESEND_API_KEY;
  }

  private async client(): Promise<ResendClient | null> {
    if (this.injectedClient !== undefined) return this.injectedClient;
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

        const outcome = await this.sendEmail(
          notification.email,
          subject,
          html,
          notification.unsubscribe_token,
        );
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
        const outcome = await this.sendEmail(email, subject, html, unsubToken);
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
  private async sendEmail(
    to: string,
    subject: string,
    html: string,
    /**
     * The holder's unsubscribe token, when this message is part of a list.
     * Omitted for transactional mail — see `listUnsubscribeHeaders`.
     */
    unsubscribeToken?: string,
  ): Promise<SendOutcome> {
    // The suppression check is **here**, at the one place every message passes
    // through, rather than at each caller. A caller that forgets is the whole
    // failure mode: one complaint damages deliverability for every future
    // recipient, and the address most at risk is a dispute contact — typed into
    // a public form by a stranger who may not be its owner.
    //
    // Checked before the provider is even resolved, so a suppressed address is
    // not written to in a dry run either. A dry-run log line naming someone who
    // asked us to stop is still a record of us preparing to contact them.
    if (await isSuppressed(this.db, to)) {
      return { delivered: false, reason: "suppressed" };
    }

    const resend = await this.client();
    if (!resend) {
      console.log(`EmailDeliveryService [dry-run]: to=${to} subject="${subject}"`);
      return { delivered: false, reason: "dry_run" };
    }

    const result = await resend.emails.send({
      from: this.fromEmail,
      to,
      subject,
      html,
      ...(unsubscribeToken === undefined
        ? {}
        : { headers: listUnsubscribeHeaders(this.unsubscribeUrl(unsubscribeToken)) }),
    });
    const providerId = typeof result?.id === "string" && result.id.length > 0 ? result.id : null;
    if (providerId === null) {
      // The provider answered without an id. That is not a delivery, and
      // recording it as one would put this back where it started.
      console.warn(`EmailDeliveryService: provider returned no message id for ${to}`);
      return { delivered: false, reason: "no_provider_id" };
    }
    return { delivered: true, providerId };
  }

  /**
   * One message, to one person, about their own matter.
   *
   * A thin public door onto `sendEmail` and nothing else — deliberately, because
   * the alternative was a second sender for transactional mail, and a second
   * sender is a second place the suppression check can be forgotten. The
   * dispute reply loop writes to an address a *stranger* typed into a public
   * form; it is the last path in this codebase that should be allowed its own
   * copy of the rules.
   *
   * The caller owns the subject and the body, and owns the decision about what
   * may go in them. This function will not help with that: it does not
   * interpolate, it does not template, and it adds no tracking pixel or wrapped
   * link, so nobody's reading of our reply is logged.
   */
  async sendTransactional(to: string, subject: string, html: string): Promise<SendOutcome> {
    return this.sendEmail(to, subject, html);
  }

  /** What a send resolved to. `email_status` is derived from this, never assumed. */
  private statusFor(outcome: SendOutcome): "sent" | "dry_run" | "skipped" | "failed" {
    if (outcome.delivered) return "sent";
    if (outcome.reason === "dry_run") return "dry_run";
    // `skipped`, not `failed`. Nothing went wrong: we were told not to write to
    // this address and we did not. Recording it as a failure would put it in a
    // retry queue, which is the one thing that must never happen to a
    // suppression.
    if (outcome.reason === "suppressed") return "skipped";
    return "failed";
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

  /**
   * The one-click endpoint, for the header and for the link in the body alike.
   *
   * It used to be `/api/subscriptions/unsubscribe/{token}`, which is a GET that
   * acts — and a GET that acts is unsubscribed by the next link-prefetcher or
   * corporate mail scanner that touches the message, on behalf of a person who
   * never clicked. `routes/list-unsubscribe.ts` answers a GET with a one-button
   * page and only acts on the POST, which is also the shape RFC 8058 requires
   * for the header. The old route is untouched and still works.
   */
  private unsubscribeUrl(token: string): string {
    const base = process.env.APP_BASE_URL || "http://localhost:3001";
    return `${base}/api/list-unsubscribe/${token}`;
  }
}
