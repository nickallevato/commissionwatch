import { randomInt } from "node:crypto";
import type { Knex } from "knex";
import { appendCorrectionRow } from "./pressroom/corrections";
import { whereFindingPublic, whereMeetingPublished } from "./publication";
import { FixedWindowLimiter } from "./rate-limit";

/**
 * B3 — the dispute route.
 *
 * A person named in a record can contest it. What that produces is a row in
 * `record_disputes` and an entry in the one audit log, and nothing else: no
 * edit to the record, no public statement, no email to anyone.
 *
 * Five properties, each of which is a mechanism below rather than a promise:
 *
 *  1. **You can only contest what is public.** The target is resolved through
 *     `services/publication.ts`. An unpublished record and a record that does
 *     not exist answer identically, so this route is not an oracle for what has
 *     been ingested and withheld.
 *  2. **It never edits a record.** Upholding a dispute records the decision.
 *     The correction that follows is a separate, deliberate operator act
 *     through the corrections path, carrying `dispute_id` so the two are
 *     joinable.
 *  3. **It is never published.** Migration 039's CHECK permits one value of
 *     `review_state`, and there is no public read route for this table.
 *  4. **It is bounded three ways** — see `RATE_LIMITS` — because it is an
 *     unauthenticated public write and the only thing standing between it and
 *     the operator's queue is arithmetic.
 *  5. **It stores nothing about the submitter but the contact they typed.** No
 *     IP address, no user agent, no identity document, no account. The
 *     per-client limit lives in process memory and is gone with the process.
 */

export class DisputeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DisputeError";
  }
}

export const DISPUTABLE_TABLES = [
  "meetings",
  "agenda_items",
  "meeting_documents",
  "anomaly_flags",
] as const;

export type DisputableTable = (typeof DISPUTABLE_TABLES)[number];

export type DisputeStatus = "received" | "upheld" | "declined";

export const DISPUTE_STATUSES: readonly DisputeStatus[] = ["received", "upheld", "declined"];

/** Mirrors migration 039's CHECK constraints. The column is the guarantee. */
export const FIELD_LIMITS = { contested: 300, account: 4000, contact: 200 } as const;

/**
 * The three bounds, and why there are three.
 *
 * `perClient` is memory and disappears on restart. `globalPerHour` and
 * `perTargetOpen` are queries against durable rows, so they survive a deploy
 * and they bound a *distributed* flood, which a per-client limit cannot see at
 * all. One of these alone would be theatre.
 */
export const RATE_LIMITS = {
  perClientPerHour: 3,
  perClientPerDay: 10,
  globalPerHour: 30,
  perTargetOpen: 5,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const hourlyLimiter = new FixedWindowLimiter({
  limit: RATE_LIMITS.perClientPerHour,
  windowMs: HOUR_MS,
});
const dailyLimiter = new FixedWindowLimiter({
  limit: RATE_LIMITS.perClientPerDay,
  windowMs: DAY_MS,
});

/** Clears the in-memory windows. Exported for tests; nothing else calls it. */
export function resetDisputeRateLimits(): void {
  hourlyLimiter.reset();
  dailyLimiter.reset();
}

/* ---------------------------------------------------------------------------
   The reference
   --------------------------------------------------------------------------- */

/**
 * Crockford base32 minus the letters that are read wrong.
 *
 * A reference is quoted down a phone line and typed back into an email. `I`,
 * `L`, `O` and `U` are out — the first three because they are read as digits,
 * the last because of what it spells given three more characters.
 */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const REFERENCE_LENGTH = 8;

/**
 * `CW-XXXXXXXX`, from `node:crypto`.
 *
 * Random rather than sequential on purpose: a sequence tells anyone holding one
 * reference how many disputes this project has received and roughly when
 * theirs arrived relative to others', which is a fact about other people's
 * contests that we have no business publishing to a stranger.
 */
export function generateReference(): string {
  let body = "";
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    body += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `CW-${body}`;
}

/* ---------------------------------------------------------------------------
   Rows
   --------------------------------------------------------------------------- */

export interface DisputeRow {
  id: string;
  reference: string;
  target_table: string;
  target_id: string;
  contested: string;
  account: string;
  contact: string;
  status: DisputeStatus;
  review_state: string;
  reviewer_operator_id: string | null;
  reviewer_email: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the submitter is handed back. The reference, and what we did with it. */
export interface DisputeReceipt {
  reference: string;
  status: DisputeStatus;
  received_at: string;
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

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function asStatus(value: unknown): DisputeStatus {
  return value === "upheld" || value === "declined" ? value : "received";
}

function toDisputeRow(raw: unknown): DisputeRow {
  if (!isRecord(raw)) throw new DisputeError("record_disputes returned no row", 500);
  return {
    id: text(raw.id),
    reference: text(raw.reference),
    target_table: text(raw.target_table),
    target_id: text(raw.target_id),
    contested: text(raw.contested),
    account: text(raw.account),
    contact: text(raw.contact),
    status: asStatus(raw.status),
    review_state: text(raw.review_state),
    reviewer_operator_id: textOrNull(raw.reviewer_operator_id),
    reviewer_email: textOrNull(raw.reviewer_email),
    review_reason: textOrNull(raw.review_reason),
    reviewed_at: asIsoOrNull(raw.reviewed_at),
    created_at: asIso(raw.created_at),
    updated_at: asIso(raw.updated_at),
  };
}

/* ---------------------------------------------------------------------------
   Submission
   --------------------------------------------------------------------------- */

export interface SubmitDisputeInput {
  targetTable: string;
  targetId: string;
  contested: string;
  account: string;
  contact: string;
  /**
   * An opaque key for the per-client window — the caller's IP as Express
   * resolves it. It is counted and never stored.
   */
  clientKey: string;
}

function isDisputableTable(value: string): value is DisputableTable {
  return (DISPUTABLE_TABLES as readonly string[]).includes(value);
}

function requireField(name: keyof typeof FIELD_LIMITS, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new DisputeError(`${name} is required`, 400);
  }
  if (trimmed.length > FIELD_LIMITS[name]) {
    throw new DisputeError(
      `${name} must be ${FIELD_LIMITS[name]} characters or fewer`,
      400,
    );
  }
  return trimmed;
}

/**
 * Does the target exist *and* is it public?
 *
 * Every branch routes through `services/publication.ts` rather than retyping
 * the wall. An agenda item and a document reach it through their meeting; a
 * finding has its own rule, which already covers the case of an approved
 * finding hanging off an unpublished meeting.
 */
async function targetIsPublic(
  db: Knex,
  targetTable: DisputableTable,
  targetId: string,
): Promise<boolean> {
  if (targetTable === "meetings") {
    const row: unknown = await whereMeetingPublished(
      db("meetings").where({ id: targetId }),
    ).first();
    return isRecord(row);
  }

  if (targetTable === "anomaly_flags") {
    const row: unknown = await whereFindingPublic(
      db,
      db("anomaly_flags").where("anomaly_flags.id", targetId).select("anomaly_flags.id"),
    ).first();
    return isRecord(row);
  }

  const row: unknown = await whereMeetingPublished(
    db(targetTable)
      .join("meetings", "meetings.id", `${targetTable}.meeting_id`)
      .where(`${targetTable}.id`, targetId)
      .select(`${targetTable}.id`),
    "meetings.published_at",
  ).first();
  return isRecord(row);
}

/**
 * Files a dispute.
 *
 * The order matters. Shape and length are checked before anything touches the
 * database; the client window is counted before the target is resolved, so a
 * scripted client cannot use malformed submissions as free lookups; and the
 * durable caps are checked inside the same transaction as the insert, so two
 * simultaneous submissions cannot both read a count under the ceiling.
 */
export async function submitDispute(
  db: Knex,
  input: SubmitDisputeInput,
  now: Date = new Date(),
): Promise<DisputeReceipt> {
  if (!isDisputableTable(input.targetTable)) {
    throw new DisputeError(
      `target_table must be one of ${DISPUTABLE_TABLES.join(", ")}`,
      400,
    );
  }
  const contested = requireField("contested", input.contested);
  const account = requireField("account", input.account);
  const contact = requireField("contact", input.contact);

  const hourly = hourlyLimiter.check(input.clientKey, now);
  if (!hourly.allowed) {
    throw new DisputeError(
      "Too many disputes from this address. Try again later, or write to the corrections address on the Methodology page.",
      429,
      hourly.retryAfterSeconds,
    );
  }
  const daily = dailyLimiter.check(input.clientKey, now);
  if (!daily.allowed) {
    throw new DisputeError(
      "Too many disputes from this address today. Try again tomorrow, or write to the corrections address on the Methodology page.",
      429,
      daily.retryAfterSeconds,
    );
  }

  // Unpublished and non-existent answer identically. Distinguishing them would
  // let anyone enumerate what has been ingested and withheld — the same reason
  // `findPublishedMeeting` collapses both into one 404.
  if (!(await targetIsPublic(db, input.targetTable, input.targetId))) {
    throw new DisputeError("No published record with that id", 404);
  }

  return db.transaction(async (trx) => {
    const [{ count: recentCount }] = await trx("record_disputes")
      .where("created_at", ">=", new Date(now.getTime() - HOUR_MS))
      .count<Array<{ count: string }>>("* as count");
    if (Number(recentCount) >= RATE_LIMITS.globalPerHour) {
      throw new DisputeError(
        "This route is at capacity right now. Try again later, or write to the corrections address on the Methodology page.",
        429,
        Math.ceil(HOUR_MS / 1000),
      );
    }

    const [{ count: openCount }] = await trx("record_disputes")
      .where({ target_table: input.targetTable, target_id: input.targetId, status: "received" })
      .count<Array<{ count: string }>>("* as count");
    if (Number(openCount) >= RATE_LIMITS.perTargetOpen) {
      // Deliberately says nothing about *this record* having disputes. That a
      // particular record has been contested is a fact about other people's
      // submissions, and this route answers strangers.
      throw new DisputeError(
        "This route is at capacity right now. Try again later, or write to the corrections address on the Methodology page.",
        429,
        Math.ceil(HOUR_MS / 1000),
      );
    }

    const reference = generateReference();
    const [inserted] = await trx("record_disputes")
      .insert({
        reference,
        target_table: input.targetTable,
        target_id: input.targetId,
        contested,
        account,
        contact,
      })
      .returning<Array<Record<string, unknown>>>("*");
    const row = toDisputeRow(inserted);

    // The one audit log. The actor is nobody — this is the public writing to
    // us, and naming an operator here would put a name against an act they did
    // not perform.
    await appendCorrectionRow(trx, {
      targetTable: "record_disputes",
      targetId: row.id,
      field: "status",
      oldValue: null,
      newValue: "received",
      reason: `Dispute ${reference} received through the public dispute route.`,
      actor: { id: null, email: null },
      disputeId: row.id,
    });

    return { reference: row.reference, status: row.status, received_at: row.created_at };
  });
}

/* ---------------------------------------------------------------------------
   The operator surface
   --------------------------------------------------------------------------- */

export interface DisputeContext {
  meeting_id: string | null;
  meeting_date: string | null;
  commission_name: string | null;
  jurisdiction_name: string | null;
  /** One line describing the contested record, for the queue row. */
  record_summary: string;
}

export interface DisputeItem {
  dispute: DisputeRow;
  context: DisputeContext;
}

export interface DisputeFilters {
  status?: DisputeStatus;
  limit?: number;
  offset?: number;
}

export interface DisputeListing {
  data: DisputeItem[];
  total: number;
  counts: { received: number; upheld: number; declined: number };
}

/**
 * The contested record, described from the tables the dispute points at.
 *
 * Every query here is unconstrained by the publication wall on purpose: this
 * runs behind `requireOperator`, and the operator console reads the same tables
 * and must see what a reader cannot. The wall was applied at submission, so a
 * dispute cannot exist against an unpublished record in the first place — but
 * a record can be *unpublished afterwards*, and an operator deciding a dispute
 * about a record they have since withheld still needs to see it.
 */
async function describeTarget(db: Knex, row: DisputeRow): Promise<DisputeContext> {
  const empty: DisputeContext = {
    meeting_id: null,
    meeting_date: null,
    commission_name: null,
    jurisdiction_name: null,
    record_summary: "That record is no longer in the database.",
  };

  const meetingId = await resolveMeetingId(db, row);
  if (row.target_table === "anomaly_flags") {
    const flag: unknown = await db("anomaly_flags").where({ id: row.target_id }).first();
    if (!isRecord(flag)) return empty;
    const context = await meetingContext(db, meetingId);
    return { ...context, record_summary: `Finding · ${text(flag.flag_type)}` };
  }

  if (row.target_table === "meetings") {
    const meeting: unknown = await db("meetings").where({ id: row.target_id }).first();
    if (!isRecord(meeting)) return empty;
    const context = await meetingContext(db, row.target_id);
    return { ...context, record_summary: `Meeting · ${asIso(meeting.date).slice(0, 10)}` };
  }

  if (row.target_table === "agenda_items") {
    const item: unknown = await db("agenda_items").where({ id: row.target_id }).first();
    if (!isRecord(item)) return empty;
    const context = await meetingContext(db, meetingId);
    return { ...context, record_summary: `Agenda item · ${text(item.title)}` };
  }

  const document: unknown = await db("meeting_documents").where({ id: row.target_id }).first();
  if (!isRecord(document)) return empty;
  const context = await meetingContext(db, meetingId);
  return { ...context, record_summary: `Document · ${text(document.title)}` };
}

async function resolveMeetingId(db: Knex, row: DisputeRow): Promise<string | null> {
  if (row.target_table === "meetings") return row.target_id;
  const table = row.target_table;
  if (table !== "agenda_items" && table !== "meeting_documents" && table !== "anomaly_flags") {
    return null;
  }
  const found: unknown = await db(table).where({ id: row.target_id }).select("meeting_id").first();
  return isRecord(found) ? textOrNull(found.meeting_id) : null;
}

async function meetingContext(
  db: Knex,
  meetingId: string | null,
): Promise<Omit<DisputeContext, "record_summary">> {
  if (meetingId === null) {
    return {
      meeting_id: null,
      meeting_date: null,
      commission_name: null,
      jurisdiction_name: null,
    };
  }
  const row: unknown = await db("meetings")
    .leftJoin("commissions", "commissions.id", "meetings.commission_id")
    .leftJoin("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id")
    .where("meetings.id", meetingId)
    .select("meetings.date as meeting_date", "commissions.name as commission_name", "jurisdictions.name as jurisdiction_name")
    .first();
  if (!isRecord(row)) {
    return {
      meeting_id: meetingId,
      meeting_date: null,
      commission_name: null,
      jurisdiction_name: null,
    };
  }
  return {
    meeting_id: meetingId,
    meeting_date: asIsoOrNull(row.meeting_date),
    commission_name: textOrNull(row.commission_name),
    jurisdiction_name: textOrNull(row.jurisdiction_name),
  };
}

/** Undecided first, then oldest first — the order somebody working a backlog wants. */
export async function listDisputes(
  db: Knex,
  filters: DisputeFilters = {},
): Promise<DisputeListing> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const base = db("record_disputes");
  if (filters.status !== undefined) base.where({ status: filters.status });

  const countRow = await base.clone().count("* as total").first<{ total?: string } | undefined>();
  const total = Number(countRow?.total ?? 0);

  const rows = await base
    .clone()
    .select<Array<Record<string, unknown>>>("*")
    .orderByRaw("(status = 'received') DESC")
    .orderBy("created_at", "asc")
    .limit(limit)
    .offset(offset);

  const data: DisputeItem[] = [];
  for (const raw of rows) {
    const dispute = toDisputeRow(raw);
    data.push({ dispute, context: await describeTarget(db, dispute) });
  }

  const tallies = await db("record_disputes")
    .select<Array<{ status: string; count: string }>>("status")
    .count("* as count")
    .groupBy("status");
  const counts = { received: 0, upheld: 0, declined: 0 };
  for (const tally of tallies) {
    const n = Number(tally.count);
    if (tally.status === "upheld") counts.upheld += n;
    else if (tally.status === "declined") counts.declined += n;
    else counts.received += n;
  }

  return { data, total, counts };
}

export async function getDispute(db: Knex, id: string): Promise<DisputeItem | null> {
  const raw: unknown = await db("record_disputes").where({ id }).first();
  if (!isRecord(raw)) return null;
  const dispute = toDisputeRow(raw);
  return { dispute, context: await describeTarget(db, dispute) };
}

export interface DisputeDecisionInput {
  id: string;
  decision: "upheld" | "declined";
  reason: string;
  actor: { id: string | null; email: string | null };
}

/**
 * An operator's decision on a dispute.
 *
 * **It changes no record.** Upholding says the contest looks right; the
 * correction that follows is a separate act through the corrections path,
 * carrying this dispute's id, so the record's own change keeps its own reason
 * and its own actor. A route that both agreed with a stranger and rewrote the
 * record in one call would make the audit log unable to say which of the two a
 * person actually decided.
 */
export async function decideDispute(db: Knex, input: DisputeDecisionInput): Promise<DisputeItem> {
  if (input.reason.trim() === "") {
    throw new DisputeError(
      "reason is required: a decision without one is not a decision anyone can review",
      400,
    );
  }

  await db.transaction(async (trx) => {
    const raw: unknown = await trx("record_disputes").where({ id: input.id }).forUpdate().first();
    if (!isRecord(raw)) throw new DisputeError("No dispute with that id", 404);
    const current = toDisputeRow(raw);
    if (current.status !== "received") {
      throw new DisputeError(`That dispute was already ${current.status}`, 409);
    }

    await appendCorrectionRow(trx, {
      targetTable: "record_disputes",
      targetId: current.id,
      field: "status",
      oldValue: "received",
      newValue: input.decision,
      reason: input.reason,
      actor: input.actor,
      disputeId: current.id,
    });

    await trx("record_disputes")
      .where({ id: current.id })
      .update({
        status: input.decision,
        reviewer_operator_id: input.actor.id,
        reviewer_email: input.actor.email,
        review_reason: input.reason,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
  });

  const item = await getDispute(db, input.id);
  if (item === null) throw new DisputeError("No dispute with that id", 404);
  return item;
}
