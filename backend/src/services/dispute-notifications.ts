import type { Knex } from "knex";
import {
  createChannel,
  createRoute,
  getChannel,
  type ChannelSummary,
} from "./delivery/channels";
import type { DirectDeliverer, DirectDeliveryOutcome, StoredPayload } from "./delivery/dispatcher";
import { EmailDeliveryService, type SendOutcome } from "./email-delivery";
import { hashAddress } from "./email-suppression";
import { emitEvent, type EventExecutor } from "./events";
import { whereMeetingPublished } from "./publication";

/**
 * The dispute reply loop — three messages, and no fourth.
 *
 * `services/disputes.ts` states as a guarantee that a dispute produces "no edit
 * to the record, no public statement, no email to anyone". Two of those three
 * are protections. The third was a person who found a claim about themselves,
 * wrote out a contested account, left a contact, and then heard nothing — ever.
 * The `CW-XXXXXXXX` reference exists, by its own comment, "to be quoted down a
 * phone line and typed back into an email", and there was no email.
 *
 * | trigger | message |
 * |---|---|
 * | received | the reference, and that we will write once it is reviewed |
 * | upheld   | the reference, that we agreed, and a link to what is public |
 * | declined | the reference, that we made no change, and a link to the record |
 *
 * Six rules carry the risk, and each is a mechanism in this file rather than a
 * promise about how it will be used.
 *
 * **1. The acknowledgement contains no dispute content.** Not the contested
 * text, not the account, not the target, not a name. A dispute contact is an
 * address *a stranger typed into a public form*, and anyone can file a dispute
 * naming a victim's address. If the acknowledgement echoed what was submitted,
 * the dispute form would become a way to send arbitrary text to arbitrary
 * addresses over this project's domain and reputation — an open relay with extra
 * steps, and the fastest available way to lose the sending domain. The rate
 * limits in `disputes.ts` bound quantity; nothing there bounds misuse. So the
 * message is content-free and self-cancelling: someone who receives it in error
 * learns only that a dispute form exists, which is public knowledge.
 *
 * **2. `contact` is parsed, never assumed.** It is 200 characters of whatever
 * the submitter typed — an email, a phone number, a postal address, a sentence.
 * Mail goes out only when it parses as a single valid email address. Anything
 * else is `no_notification_channel`, which is a visible operator task, not a
 * guess. Nothing here attempts SMS from a field never described as a phone
 * number.
 *
 * **3. Suppression applies to transactional mail too.** The check is not
 * repeated here: `EmailDeliveryService.sendEmail` already consults
 * `isSuppressed` at the one point every message passes through, and this module
 * goes through that door rather than opening a second one.
 *
 * **4. One acknowledgement per dispute, ever.** Enforced by migration 092's
 * unique index on `(dispute_id, kind)`, so a retry, a re-submitted form and a
 * re-drained event all collide at the database rather than becoming a second
 * message to somebody's inbox.
 *
 * **5. No open tracking, no click tracking, no pixels.** A person contesting a
 * record about themselves must not have their reading of our reply logged. Same
 * instinct that keeps IP addresses out of `record_disputes`.
 *
 * **6. The outcome message contains only what is already public.** It never
 * quotes the submitter back to themselves and never mentions another person's
 * dispute. The link is resolved through `publication.ts` at render time, so a
 * record withheld between the decision and the send produces a message with no
 * link rather than a link to something a reader cannot see.
 *
 * It rides the event spine and the dispatcher, not a direct `EmailDeliveryService`
 * call from the dispute route, so it inherits the durable `deliveries` row, the
 * dedupe index and the retry ledger. `resolveRoutes` refuses to hand a
 * `dispute.*` event to anything but a `direct` channel — see
 * `DIRECT_ONLY_EVENT_NAMESPACES` in `delivery/channels.ts`, which is the
 * mechanism that stops a dispute being posted into a chat server.
 */

export const DISPUTE_NOTIFICATION_KINDS = ["received", "upheld", "declined"] as const;

export type DisputeNotificationKind = (typeof DISPUTE_NOTIFICATION_KINDS)[number];

export const DISPUTE_NOTIFICATION_STATES = [
  "queued",
  "sent",
  "dry_run",
  "suppressed",
  "no_notification_channel",
  "failed",
] as const;

export type DisputeNotificationState = (typeof DISPUTE_NOTIFICATION_STATES)[number];

/** The event types this loop emits. Nothing else in the namespace exists. */
export const DISPUTE_EVENT_TYPES = [
  "dispute.received",
  "dispute.upheld",
  "dispute.declined",
] as const;

export interface DisputeNotificationRow {
  id: string;
  dispute_id: string;
  kind: DisputeNotificationKind;
  state: DisputeNotificationState;
  detail: string | null;
  event_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function asKind(value: unknown): DisputeNotificationKind {
  return value === "upheld" || value === "declined" ? value : "received";
}

function asState(value: unknown): DisputeNotificationState {
  return (DISPUTE_NOTIFICATION_STATES as readonly string[]).includes(text(value))
    ? (value as DisputeNotificationState)
    : "queued";
}

function toNotificationRow(raw: unknown): DisputeNotificationRow {
  if (!isRecord(raw)) throw new TypeError("dispute_notifications returned no row");
  return {
    id: text(raw.id),
    dispute_id: text(raw.dispute_id),
    kind: asKind(raw.kind),
    state: asState(raw.state),
    detail: textOrNull(raw.detail),
    event_id: textOrNull(raw.event_id),
    sent_at: isoOrNull(raw.sent_at),
    created_at: isoOrNull(raw.created_at) ?? "",
    updated_at: isoOrNull(raw.updated_at) ?? "",
  };
}

/* ---------------------------------------------------------------------------
   Rule 2 — the contact is free text
   --------------------------------------------------------------------------- */

/**
 * One address, or nothing.
 *
 * Deliberately strict, and strict in the direction that sends *less*. A display
 * name (`Jo <jo@example.org>`), a second address after a comma, a trailing
 * sentence, a phone number, a postal address — all of them return null, and null
 * is a visible operator task rather than a best guess. The alternative is
 * extracting "the email-looking part" of a string somebody typed, which is how a
 * reply gets addressed to whichever address appeared first in a sentence about
 * two people.
 *
 * The length ceiling is the RFC's 254 for the whole address. `contact` is capped
 * at 200 by migration 039 anyway, so this is belt and braces on a column that
 * could later widen.
 */
const SINGLE_EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function parseSingleEmailAddress(contact: string): string | null {
  const trimmed = contact.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (!SINGLE_EMAIL.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/* ---------------------------------------------------------------------------
   Rule 6 — the link, resolved through the publication wall
   --------------------------------------------------------------------------- */

const LINKABLE_TABLES = ["agenda_items", "meeting_documents", "anomaly_flags"] as const;

function isLinkableChildTable(value: string): value is (typeof LINKABLE_TABLES)[number] {
  return (LINKABLE_TABLES as readonly string[]).includes(value);
}

/**
 * `PUBLIC_BASE_URL`, falling back to the deployed domain.
 *
 * `routes/feed.ts` and `routes/sitemap.ts` refuse to serve without this variable
 * rather than guessing, and that is right for a document whose every URL would
 * be wrong. A reply to a person waiting on their dispute is a different trade:
 * the message is worth sending even from a deployment that has not set the
 * variable, and the fallback is the one domain this project actually runs on.
 */
function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "https://commissionwatch.bmux.sh").replace(/\/$/, "");
}

/**
 * A link to the contested record, or null.
 *
 * Every target resolves to its **meeting page**, including a finding: the SPA has
 * `/meetings/:id` and `/findings` but no `/findings/:id`, and a link to a listing
 * is not a citation. The meeting page carries the record and the source it rests
 * on, which is what both outcome messages are pointing at.
 *
 * The publication check is re-run here rather than trusted from submission time.
 * A dispute can only be filed against a public record, but the record can be
 * withheld afterwards — and a reply that links a reader to something an operator
 * has since pulled would be this feature leaking the withheld set, in an email,
 * to the one person most motivated to look.
 */
export async function disputeRecordLink(
  db: Knex,
  dispute: { target_table: string; target_id: string },
): Promise<string | null> {
  let meetingId: string | null = null;

  if (dispute.target_table === "meetings") {
    meetingId = dispute.target_id;
  } else if (isLinkableChildTable(dispute.target_table)) {
    const row: unknown = await db(dispute.target_table)
      .where({ id: dispute.target_id })
      .first("meeting_id");
    meetingId = isRecord(row) ? textOrNull(row.meeting_id) : null;
  }

  if (meetingId === null) return null;

  const published: unknown = await whereMeetingPublished(
    db("meetings").where({ id: meetingId }).select("id"),
  ).first();
  if (!isRecord(published)) return null;

  return `${baseUrl()}/meetings/${meetingId}`;
}

/* ---------------------------------------------------------------------------
   Rules 1, 5 and 6 — the three messages
   --------------------------------------------------------------------------- */

export interface DisputeMessage {
  subject: string;
  html: string;
  /** The same words without markup. Asserted against by the content tests. */
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The sentence that makes an acknowledgement sent in error harmless.
 *
 * Somebody whose address was typed into the form by a third party gets a message
 * that names nothing, asks for nothing, and promises not to write again. That is
 * the whole defence against this feature being a text-delivery service, so it is
 * on every message rather than only the first.
 */
const SELF_CANCELLING =
  "If you did not submit this, no action is needed and we will not write again.";

const HOST = "commissionwatch.bmux.sh";

function lines(kind: DisputeNotificationKind, reference: string, link: string | null): string[] {
  if (kind === "received") {
    // Nothing about the record, the submission, or the person. See rule 1 —
    // this message is deliberately useless to anyone who did not send it.
    return [
      `We received a dispute about a record on ${HOST}.`,
      `Your reference is ${reference}.`,
      "We will write once it has been reviewed.",
      SELF_CANCELLING,
    ];
  }

  if (kind === "upheld") {
    // Not "the record has been corrected". `decideDispute` changes no record:
    // upholding says the contest looks right, and the correction that follows is
    // a separate operator act through the corrections path. Telling somebody
    // their record has been fixed at the moment a decision was recorded would be
    // a claim this project cannot vouch for, in writing, to the person best
    // placed to check it.
    const body = [
      `Reference ${reference}: we reviewed this dispute and agreed with it.`,
      `Any resulting change to the record is published in our corrections log at ${baseUrl()}/corrections, which lists every change we make and why.`,
    ];
    if (link !== null) body.push(`The record: ${link}`);
    body.push(SELF_CANCELLING);
    return body;
  }

  const body = [
    `Reference ${reference}: we reviewed this dispute and made no change to the record.`,
  ];
  // The operator's `review_reason` is written for an audit log and for their own
  // future self. A candid internal note read as a reply is how a correction
  // process becomes an argument, so what goes out is the record and its source,
  // not our note about it.
  if (link !== null) body.push(`Here is the record and the source it rests on: ${link}`);
  body.push(
    `If you have further evidence, you can file again at ${baseUrl()}/corrections/dispute.`,
  );
  body.push(SELF_CANCELLING);
  return body;
}

const SUBJECTS: Readonly<Record<DisputeNotificationKind, string>> = {
  received: "We received your dispute",
  upheld: "Your dispute was upheld",
  declined: "Your dispute was reviewed",
};

/**
 * Renders one message. No tracking pixel, no wrapped link, no beacon — see
 * rule 5. The HTML is a paragraph per line and nothing else, so there is
 * nothing in it that could report back.
 */
export function renderDisputeMessage(
  kind: DisputeNotificationKind,
  reference: string,
  link: string | null,
): DisputeMessage {
  const body = lines(kind, reference, link);
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    '<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">',
    ...body.map((line) => `  <p>${escapeHtml(line)}</p>`),
    "</body>",
    "</html>",
  ].join("\n");

  return { subject: `${SUBJECTS[kind]} — ${reference}`, html, text: body.join("\n\n") };
}

/* ---------------------------------------------------------------------------
   Rule 4 — the ledger
   --------------------------------------------------------------------------- */

export interface QueueDisputeNotificationInput {
  id: string;
  reference: string;
  contact: string;
}

export interface QueueResult {
  row: DisputeNotificationRow;
  /** False when this dispute already had a message of this kind. */
  created: boolean;
}

/**
 * Records that a message is owed, and emits the event that will send it.
 *
 * **Call this inside the transaction that wrote the decision**, per the event
 * spine. A notification about a decision that rolled back is worse than none:
 * the person is told an outcome the database does not hold. The ledger row, the
 * event and the decision commit together or not at all.
 *
 * A contact that does not parse as one email address stops here. The row is
 * written `no_notification_channel` and **no event is emitted** — there is
 * nothing to route, and an event that can only ever resolve to "no channel"
 * would be a permanent entry in the delivery ledger describing a message nobody
 * ever intended to send. The operator sees the state on the dispute instead.
 */
export async function queueDisputeNotification(
  db: EventExecutor,
  dispute: QueueDisputeNotificationInput,
  kind: DisputeNotificationKind,
): Promise<QueueResult> {
  const address = parseSingleEmailAddress(dispute.contact);

  const inserted = await db("dispute_notifications")
    .insert({
      dispute_id: dispute.id,
      kind,
      state: address === null ? "no_notification_channel" : "queued",
      address_hash: address === null ? null : hashAddress(address),
      detail:
        address === null
          ? "contact is not a single email address; reply by hand or leave it"
          : null,
    })
    .onConflict(["dispute_id", "kind"])
    .ignore()
    .returning<Array<Record<string, unknown>>>("*");

  if (inserted.length === 0) {
    // The unique index held. That is rule 4 working, not a failure — but the
    // caller still gets the row that already says this.
    const existing: unknown = await db("dispute_notifications")
      .where({ dispute_id: dispute.id, kind })
      .first();
    return { row: toNotificationRow(existing), created: false };
  }

  const row = toNotificationRow(inserted[0]);
  if (row.state !== "queued") return { row, created: true };

  // The payload carries nothing about the dispute. `dispute.received` for a
  // stranger's submission travels through `events` and `deliveries`, and the
  // deliverer re-reads the live row anyway — so there is no reason for the
  // contested text, the account or the reference to sit in two more tables.
  const emitted = await emitEvent(db, {
    event_type: `dispute.${kind}`,
    subject_kind: "dispute",
    subject_id: dispute.id,
    severity: "info",
    payload: {},
  });

  await db("dispute_notifications")
    .where({ id: row.id })
    .update({ event_id: emitted.id, updated_at: db.fn.now() });

  return { row: { ...row, event_id: emitted.id }, created: true };
}

/** Every message owed or attempted for a dispute. The operator's view of the loop. */
export async function listDisputeNotifications(
  db: Knex,
  disputeId: string,
): Promise<DisputeNotificationRow[]> {
  const rows = await db("dispute_notifications")
    .where({ dispute_id: disputeId })
    .orderBy("created_at", "asc")
    .select<Array<Record<string, unknown>>>("*");
  return rows.map(toNotificationRow);
}

/* ---------------------------------------------------------------------------
   The channel
   --------------------------------------------------------------------------- */

export const DISPUTE_REPLY_CHANNEL_NAME = "Dispute replies";

/**
 * The one channel dispute events may resolve to, created idempotently.
 *
 * `audience: 'ops'` because migration 088's trigger refuses a `dispute.*` route
 * on a public channel, and `owner_kind: 'direct'` because that is what makes
 * `resolveRoutes` willing to hand it a dispute at all. Both are required; either
 * one alone leaves the event either unroutable or routable to a webhook.
 *
 * The config is empty and stays empty. A direct channel holds no destination at
 * rest — the recipient comes from `record_disputes.contact` at send time, so
 * this row is not a place anybody's address can accumulate.
 */
export async function ensureDisputeReplyChannel(db: Knex): Promise<ChannelSummary> {
  const existing = await db("delivery_channels")
    .where({ name: DISPUTE_REPLY_CHANNEL_NAME, owner_kind: "direct" })
    .first<{ id: string } | undefined>("id");

  const channelId =
    existing?.id ??
    (
      await createChannel(db, {
        channel_type: "email",
        name: DISPUTE_REPLY_CHANNEL_NAME,
        config: {},
        audience: "ops",
        owner_kind: "direct",
      })
    ).id;

  const route = await db("channel_routes")
    .where({ channel_id: channelId, event_type: "dispute.*" })
    .first<{ id: string } | undefined>("id");
  if (route === undefined) {
    await createRoute(db, { channel_id: channelId, event_type: "dispute.*" });
  }

  const loaded = await getChannel(db, channelId);
  if (loaded === null) throw new Error("ensureDisputeReplyChannel: channel vanished");
  return loaded;
}

/* ---------------------------------------------------------------------------
   The sender
   --------------------------------------------------------------------------- */

/** Just enough of `EmailDeliveryService` to send one message, so tests can stand in. */
export interface TransactionalMailer {
  sendTransactional(to: string, subject: string, html: string): Promise<SendOutcome>;
}

interface DisputeSubject {
  id: string;
  reference: string;
  contact: string;
  target_table: string;
  target_id: string;
}

function parseKind(eventType: string): DisputeNotificationKind | null {
  const suffix = eventType.split(".")[1];
  return (DISPUTE_NOTIFICATION_KINDS as readonly string[]).includes(suffix ?? "")
    ? (suffix as DisputeNotificationKind)
    : null;
}

/**
 * The `direct` transport for `dispute.*`, driven by the dispatcher.
 *
 * It resolves its own recipient — the dispatcher never sees an address, which is
 * what lets the channel row hold none. Everything it can decide, it decides from
 * live rows at send time rather than from the payload it was handed: the contact
 * as it stands now, the publication state of the record as it stands now, and
 * the ledger state as it stands now.
 */
export class DisputeMailer implements DirectDeliverer {
  private readonly mailer: TransactionalMailer;

  constructor(
    private readonly db: Knex,
    mailer?: TransactionalMailer,
  ) {
    this.mailer = mailer ?? new EmailDeliveryService(db);
  }

  async deliver(eventType: string, payload: StoredPayload): Promise<DirectDeliveryOutcome> {
    const kind = parseKind(eventType);
    if (kind === null) {
      return { status: "failed", detail: `not a dispute event type: ${eventType}`, retryable: false };
    }

    const subjectId = payload.data.subject_id;
    if (typeof subjectId !== "string" || subjectId === "") {
      return { status: "failed", detail: "dispute event carried no subject_id", retryable: false };
    }

    const raw: unknown = await this.db("record_disputes")
      .where({ id: subjectId })
      .first("id", "reference", "contact", "target_table", "target_id");
    if (!isRecord(raw)) {
      // The dispute was deleted between the emit and the send. There is nobody
      // to write to and no reference to quote; recording why is the whole job.
      return { status: "skipped", detail: "the dispute no longer exists" };
    }
    const dispute: DisputeSubject = {
      id: text(raw.id),
      reference: text(raw.reference),
      contact: text(raw.contact),
      target_table: text(raw.target_table),
      target_id: text(raw.target_id),
    };

    const ledgerRaw: unknown = await this.db("dispute_notifications")
      .where({ dispute_id: dispute.id, kind })
      .first();
    if (!isRecord(ledgerRaw)) {
      return { status: "skipped", detail: "no ledger row for this dispute and kind" };
    }
    const ledger = toNotificationRow(ledgerRaw);

    // Rule 4's second lock. The unique index stops a second row; this stops a
    // second *send* off the one row, which is what a re-drained event after a
    // crash between dispatch and mark would otherwise produce.
    if (ledger.state !== "queued") {
      return { status: "skipped", detail: `already resolved as ${ledger.state}` };
    }

    const address = parseSingleEmailAddress(dispute.contact);
    if (address === null) {
      await this.settle(ledger.id, "no_notification_channel", "contact is not a single email address");
      return { status: "skipped", detail: "contact is not a single email address" };
    }

    // The acknowledgement never links, because it never says what the dispute is
    // about. The outcome messages resolve the link through the publication wall.
    const link = kind === "received" ? null : await disputeRecordLink(this.db, dispute);
    const message = renderDisputeMessage(kind, dispute.reference, link);

    // Suppression lives inside this call, at the one point every message in this
    // codebase passes through. See rule 3 — there is no second check here on
    // purpose.
    const outcome = await this.mailer.sendTransactional(address, message.subject, message.html);

    if (outcome.delivered) {
      await this.settle(ledger.id, "sent", `provider message ${outcome.providerId}`);
      return { status: "sent" };
    }

    if (outcome.reason === "dry_run") {
      // `dry_run`, never `sent`. Telling a disputant "we replied" when nothing
      // left the process is the lie migration 086 exists to remove, and it is
      // worse here than anywhere else in the product.
      await this.settle(ledger.id, "dry_run", "no mail provider is configured");
      return { status: "skipped", detail: "dry run: no mail provider is configured" };
    }

    if (outcome.reason === "suppressed") {
      await this.settle(ledger.id, "suppressed", "address is on the suppression list");
      return { status: "skipped", detail: "address is on the suppression list" };
    }

    await this.settle(ledger.id, "failed", "the provider returned no message id");
    return { status: "failed", detail: "the provider returned no message id", retryable: false };
  }

  /**
   * The terminal write, guarded on `state = 'queued'`.
   *
   * Two drains racing the same event would both have read `queued`; only one
   * update lands, and the loser has already been stopped by `deliveries`'
   * `(channel_id, dedupe_key)` index before it got here. The guard is the cheap
   * third lock on a rule whose failure mode is mail somebody did not ask for.
   */
  private async settle(
    id: string,
    state: DisputeNotificationState,
    detail: string,
  ): Promise<void> {
    await this.db("dispute_notifications")
      .where({ id, state: "queued" })
      .update({
        state,
        detail,
        // Only a real delivery gets a timestamp — migration 092's CHECK enforces
        // it, for the same reason `notifications.email_sent_at` does.
        sent_at: state === "sent" ? this.db.fn.now() : null,
        updated_at: this.db.fn.now(),
      });
  }
}
