import type { Knex } from "knex";

/**
 * Corrections, and publication — which is recorded through the same table.
 *
 * **The artifact is never mutated.** A correction changes what the site says a
 * document contains; it does not change the document. The bytes stay exactly as
 * fetched, addressed by the hash they were fetched under, and a test asserts the
 * `artifacts` row is byte-identical either side of a correction. A transparency
 * project that edits its own evidence has nothing left to stand on.
 *
 * **Corrections are append-only.** Migration 031 enforces it with a trigger, not
 * a convention, because a convention is what gets edited around. What the
 * machine originally said is part of the record on a project whose subject is
 * the public record.
 *
 * Publication routes through here too, as a correction to `meetings.published_at`
 * with a stated reason. Decision 8 asks for an audit trail; giving publication
 * its own second mechanism would mean two logs that can disagree about what
 * happened, and the one that disagreed would be believed at random.
 */

export class CorrectionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CorrectionError";
  }
}

/**
 * What may be corrected, by table.
 *
 * A whitelist rather than "any column": this endpoint takes a column name from
 * an HTTP body and puts it in an UPDATE, and the set of columns an operator has
 * any business rewriting is small, knowable and worth writing down. `id`,
 * `commission_id`, `meeting_id`, `created_at` and `external_id` are absent on
 * purpose — those are identity, and changing identity is not a correction.
 */
export const CORRECTABLE_FIELDS = {
  meetings: ["date", "time", "location", "status", "agenda_url", "minutes_url"],
  agenda_items: ["title", "description", "category"],
  meeting_documents: ["title", "document_type", "url"],
} as const;

export type CorrectableTable = keyof typeof CORRECTABLE_FIELDS;

export const CORRECTABLE_TABLES = Object.keys(CORRECTABLE_FIELDS) as CorrectableTable[];

/** `meetings.status` is a native enum; an invalid value is a 400, not a 500. */
const MEETING_STATUSES = ["scheduled", "completed", "cancelled"];

/**
 * Correctable fields the schema declares NOT NULL.
 *
 * Clearing one is a 400 rather than a driver error rendered as a 500. The
 * database is the source of truth for types, so this list mirrors the
 * migrations; it does not decide anything on its own.
 */
const NOT_NULL_FIELDS: Record<CorrectableTable, readonly string[]> = {
  meetings: ["date", "status"],
  agenda_items: ["title"],
  meeting_documents: ["title", "document_type", "url"],
};

/**
 * `published_at` is correctable, but only through publish/unpublish.
 *
 * It is deliberately absent from `CORRECTABLE_FIELDS` so that a free-text
 * correction cannot set it to an arbitrary string, while still being a legal
 * value in the log.
 */
export const PUBLICATION_FIELD = "published_at";

export interface CorrectionActor {
  id: string | null;
  email: string | null;
}

export interface CorrectionRow {
  id: string;
  target_table: string;
  target_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  operator_id: string | null;
  operator_email: string | null;
  created_at: string;
}

export interface RecordCorrectionInput {
  targetTable: string;
  targetId: string;
  field: string;
  newValue: string | null;
  reason: string;
  actor: CorrectionActor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCorrectableTable(value: string): value is CorrectableTable {
  return (CORRECTABLE_TABLES as string[]).includes(value);
}

/**
 * The stored value as text, for the log.
 *
 * `null` stays `null` — "was empty" and "was not recorded" are different facts,
 * and flattening them is the kind of small loss that makes an audit trail
 * useless three months later. A Date is written as ISO-8601 rather than as
 * whatever the local `toString` produces.
 */
export function asLogValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function toCorrectionRow(raw: unknown): CorrectionRow {
  if (!isRecord(raw)) throw new CorrectionError("record_corrections insert returned no row", 500);
  const createdAt = raw.created_at;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    target_table: typeof raw.target_table === "string" ? raw.target_table : "",
    target_id: typeof raw.target_id === "string" ? raw.target_id : "",
    field: typeof raw.field === "string" ? raw.field : "",
    old_value: typeof raw.old_value === "string" ? raw.old_value : null,
    new_value: typeof raw.new_value === "string" ? raw.new_value : null,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    operator_id: typeof raw.operator_id === "string" ? raw.operator_id : null,
    operator_email: typeof raw.operator_email === "string" ? raw.operator_email : null,
    created_at:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : typeof createdAt === "string"
          ? createdAt
          : new Date(0).toISOString(),
  };
}

/** Appends the log row. Never updates one; migration 031 would refuse anyway. */
async function appendCorrection(
  executor: Knex | Knex.Transaction,
  input: {
    targetTable: string;
    targetId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string;
    actor: CorrectionActor;
  },
): Promise<CorrectionRow> {
  const inserted: unknown = await executor("record_corrections")
    .insert({
      target_table: input.targetTable,
      target_id: input.targetId,
      field: input.field,
      old_value: input.oldValue,
      new_value: input.newValue,
      reason: input.reason,
      operator_id: input.actor.id,
      // Snapshotted, not joined. The log must still name who acted after the
      // operator row is gone, and there is no foreign key to keep it honest.
      operator_email: input.actor.email,
    })
    .returning("*");
  return toCorrectionRow(Array.isArray(inserted) ? inserted[0] : undefined);
}

/**
 * Corrects one field of one row, and logs it.
 *
 * The read of the old value and the write of the new one happen in the same
 * transaction as the log insert, so there is no window in which the record says
 * one thing and the log says it always did.
 */
export async function recordCorrection(
  db: Knex,
  input: RecordCorrectionInput,
): Promise<CorrectionRow> {
  const { targetTable, targetId, field, newValue, reason, actor } = input;

  if (!isCorrectableTable(targetTable)) {
    throw new CorrectionError(
      `target_table must be one of ${CORRECTABLE_TABLES.join(", ")}`,
      400,
    );
  }
  const allowed: readonly string[] = CORRECTABLE_FIELDS[targetTable];
  if (!allowed.includes(field)) {
    throw new CorrectionError(
      `${field} is not correctable on ${targetTable}; correctable fields are ${allowed.join(", ")}`,
      400,
    );
  }
  if (reason.trim() === "") {
    throw new CorrectionError("reason is required: a correction without one is an edit", 400);
  }
  if (newValue === null && NOT_NULL_FIELDS[targetTable].includes(field)) {
    throw new CorrectionError(`${targetTable}.${field} cannot be cleared: the column is NOT NULL`, 400);
  }
  if (targetTable === "meetings" && field === "status") {
    if (newValue === null || !MEETING_STATUSES.includes(newValue)) {
      throw new CorrectionError(
        `meetings.status must be one of ${MEETING_STATUSES.join(", ")}`,
        400,
      );
    }
  }

  return db.transaction(async (trx) => {
    const current: unknown = await trx(targetTable).where({ id: targetId }).first();
    if (!isRecord(current)) {
      throw new CorrectionError(`No ${targetTable} row with that id`, 404);
    }

    const oldValue = asLogValue(current[field]);
    const correction = await appendCorrection(trx, {
      targetTable,
      targetId,
      field,
      oldValue,
      newValue,
      reason,
      actor,
    });

    await trx(targetTable)
      .where({ id: targetId })
      .update({ [field]: newValue, updated_at: trx.fn.now() });

    return correction;
  });
}

/** One target's correction history, newest first. */
export async function listCorrections(
  db: Knex,
  filter: { targetTable?: string; targetId?: string } = {},
): Promise<CorrectionRow[]> {
  const query = db("record_corrections").orderBy("created_at", "desc").limit(200);
  if (filter.targetTable !== undefined) query.where({ target_table: filter.targetTable });
  if (filter.targetId !== undefined) query.where({ target_id: filter.targetId });
  const rows: unknown = await query.select("*");
  return (Array.isArray(rows) ? rows : []).map(toCorrectionRow);
}

export interface PublicationResult {
  published_at: string | null;
  correction: CorrectionRow;
}

/**
 * Publishing and unpublishing, both of which are decisions with a time on them.
 *
 * Publishing over a known defect is permitted — the spec says so — and the
 * reason is what records that it was done knowingly. So an already-published
 * meeting can be published again with a new reason, and the log grows rather
 * than the operation being refused as a no-op.
 */
async function setPublication(
  db: Knex,
  meetingId: string,
  publishedAt: Date | null,
  reason: string,
  actor: CorrectionActor,
): Promise<PublicationResult> {
  if (reason.trim() === "") {
    throw new CorrectionError(
      "reason is required: publication is a decision, and a decision has a reason",
      400,
    );
  }

  return db.transaction(async (trx) => {
    const current: unknown = await trx("meetings").where({ id: meetingId }).first();
    if (!isRecord(current)) throw new CorrectionError("Meeting not found", 404);

    const correction = await appendCorrection(trx, {
      targetTable: "meetings",
      targetId: meetingId,
      field: PUBLICATION_FIELD,
      oldValue: asLogValue(current[PUBLICATION_FIELD]),
      newValue: publishedAt === null ? null : publishedAt.toISOString(),
      reason,
      actor,
    });

    await trx("meetings")
      .where({ id: meetingId })
      .update({ published_at: publishedAt, updated_at: trx.fn.now() });

    return { published_at: publishedAt === null ? null : publishedAt.toISOString(), correction };
  });
}

export function publishMeeting(
  db: Knex,
  meetingId: string,
  reason: string,
  actor: CorrectionActor,
  now: Date = new Date(),
): Promise<PublicationResult> {
  return setPublication(db, meetingId, now, reason, actor);
}

export function unpublishMeeting(
  db: Knex,
  meetingId: string,
  reason: string,
  actor: CorrectionActor,
): Promise<PublicationResult> {
  return setPublication(db, meetingId, null, reason, actor);
}
