import type { Knex } from "knex";
import { whereFindingPublic, whereMeetingPublished } from "./publication";

/**
 * B3 — the public corrections log.
 *
 * `record_corrections` is append-only and already records who changed what,
 * from what, to what, and why. This is the projection of it that a stranger
 * reads: what was published, what changed, when, and why, in plain words.
 *
 * **Only corrections to records that are public right now appear.** A
 * correction row names a target and quotes a fact about it in `old_value`, so
 * publishing the row for a record an operator has withheld would disclose the
 * withheld record — its existence, its id, and a sentence of its content
 * — through a page that takes no id and therefore cannot be reached only by
 * guessing one. That makes this the second surface after P6's search with a
 * straight path through the publication wall, and it gets the same treatment:
 * the rule is `services/publication.ts`, not a `whereRaw` retyped here, and the
 * test asserts it in both directions.
 *
 * The table-by-table rule:
 *
 * | `target_table`      | public when                                          |
 * |---------------------|------------------------------------------------------|
 * | `meetings`          | that meeting is published                            |
 * | `agenda_items`      | its meeting is published                             |
 * | `meeting_documents` | its meeting is published                             |
 * | `anomaly_flags`     | `whereFindingPublic` — approved *and* meeting public  |
 * | `review_policy`     | never                                                 |
 * | `record_disputes`   | never                                                 |
 *
 * `review_policy` is our operating configuration rather than a record about
 * anybody, and `record_disputes` is a private communication from a member of
 * the public that may name people. Neither is a correction to a published
 * record, which is what this page is.
 *
 * Two consequences that are intended:
 *
 *  - **Unpublishing hides the correction that unpublished it**, because after
 *    it the record is not public and so nothing about it is. The page says that
 *    rather than implying it is a complete history of every edit ever made.
 *  - **A rejected finding never surfaces.** It stays `held`, so
 *    `whereFindingPublic` excludes it with no extra rule here.
 *
 * **The operator's address is not published.** The change and the stated reason
 * are; `operator_id` and `operator_email` stop at the console. The accountable
 * editor is named on the Methodology page, and reprinting a mailbox on every
 * row adds no accountability the masthead does not already carry.
 */

/** Every table a correction may target, and whether a reader may see it. */
const PUBLIC_TARGET_TABLES = [
  "meetings",
  "agenda_items",
  "meeting_documents",
  "anomaly_flags",
] as const;

type PublicTargetTable = (typeof PUBLIC_TARGET_TABLES)[number];

export type CorrectionRecordKind = "meeting" | "agenda_item" | "document" | "finding";

const RECORD_KIND: Record<PublicTargetTable, CorrectionRecordKind> = {
  meetings: "meeting",
  agenda_items: "agenda_item",
  meeting_documents: "document",
  anomaly_flags: "finding",
};

const RECORD_LABEL: Record<CorrectionRecordKind, string> = {
  meeting: "Meeting",
  agenda_item: "Agenda item",
  document: "Document",
  finding: "Finding",
};

/**
 * Field names as a reader would say them.
 *
 * A column name is a fact about our schema, not about the record. "published_at"
 * tells a reader nothing; "publication" tells them what changed. Anything not
 * listed falls back to the column name with its underscores opened out, which
 * is worse than a written label and better than nothing.
 */
const FIELD_LABEL: Record<string, string> = {
  published_at: "publication",
  date: "meeting date",
  time: "meeting time",
  location: "location",
  status: "status",
  agenda_url: "agenda link",
  minutes_url: "minutes link",
  title: "title",
  description: "description",
  category: "category",
  document_type: "document type",
  url: "document link",
  review_state: "review state",
  severity: "severity",
};

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replace(/_/g, " ");
}

export interface PublicCorrection {
  id: string;
  created_at: string;
  record_kind: CorrectionRecordKind;
  record_label: string;
  /** The record this correction is about, for a link. Null when it has no page. */
  meeting_id: string | null;
  field: string;
  field_label: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  /** The dispute that prompted it, if one did — the reference, never the text. */
  dispute_reference: string | null;
  /** The whole change as one sentence, so a reader need not assemble it. */
  summary: string;
}

export interface PublicCorrectionListing {
  data: PublicCorrection[];
  total: number;
}

interface JoinedRow extends Record<string, unknown> {
  id: string;
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

function isPublicTargetTable(value: string): value is PublicTargetTable {
  return (PUBLIC_TARGET_TABLES as readonly string[]).includes(value);
}

/**
 * The change as one sentence.
 *
 * Publication is worded as publication rather than as a diff on a timestamp
 * column: "published_at: null → 2026-08-10T…" is the truth and is not what
 * happened in any sense a reader cares about. Approval of a finding gets the
 * same treatment for the same reason.
 */
function summarise(
  kind: CorrectionRecordKind,
  field: string,
  oldValue: string | null,
  newValue: string | null,
): string {
  const label = RECORD_LABEL[kind];

  if (field === "published_at") {
    return newValue === null
      ? `${label} withdrawn from publication.`
      : `${label} published.`;
  }
  if (field === "review_state") {
    return newValue === "published"
      ? `${label} approved for publication by an operator.`
      : `${label} review state changed to ${newValue ?? "nothing"}.`;
  }

  const from = oldValue === null ? "nothing recorded" : `“${oldValue}”`;
  const to = newValue === null ? "nothing recorded" : `“${newValue}”`;
  return `${label} ${fieldLabel(field)} corrected from ${from} to ${to}.`;
}

function toPublicCorrection(row: JoinedRow): PublicCorrection {
  const targetTable = text(row.target_table);
  // Unreachable through `publicCorrectionsQuery`, which filters on exactly
  // these four. Narrowed rather than cast, because a cast here would be the
  // one place a future sixth table could leak through unnoticed.
  const kind: CorrectionRecordKind = isPublicTargetTable(targetTable)
    ? RECORD_KIND[targetTable]
    : "meeting";
  const field = text(row.field);
  const oldValue = textOrNull(row.old_value);
  const newValue = textOrNull(row.new_value);

  return {
    id: text(row.id),
    created_at: asIso(row.created_at),
    record_kind: kind,
    record_label: RECORD_LABEL[kind],
    meeting_id: textOrNull(row.public_meeting_id),
    field,
    field_label: fieldLabel(field),
    old_value: oldValue,
    new_value: newValue,
    reason: text(row.reason),
    dispute_reference: textOrNull(row.dispute_reference),
    summary: summarise(kind, field, oldValue, newValue),
  };
}

/**
 * The four publicity tests, as one query.
 *
 * Each branch is an `EXISTS` built from `publication.ts` rather than a join,
 * because a join would multiply rows when a target resolves more than once and
 * — worse — a `LEFT JOIN` typo would turn the wall into a decoration. An
 * `EXISTS` that is wrong returns nothing; a join that is wrong returns
 * everything.
 *
 * `public_meeting_id` comes out of the same subqueries so the page can link to
 * the record without a second round trip, and so a correction whose meeting has
 * since gone carries null rather than a dead link.
 */
function publicCorrectionsQuery(db: Knex): Knex.QueryBuilder {
  return db("record_corrections")
    .whereIn("record_corrections.target_table", [...PUBLIC_TARGET_TABLES])
    .where((outer) => {
      outer
        .where((branch) => {
          branch.where("record_corrections.target_table", "meetings").whereExists(
            whereMeetingPublished(
              db("meetings").whereRaw("meetings.id = record_corrections.target_id"),
            ),
          );
        })
        .orWhere((branch) => {
          branch.where("record_corrections.target_table", "agenda_items").whereExists(
            whereMeetingPublished(
              db("agenda_items")
                .join("meetings", "meetings.id", "agenda_items.meeting_id")
                .whereRaw("agenda_items.id = record_corrections.target_id"),
              "meetings.published_at",
            ),
          );
        })
        .orWhere((branch) => {
          branch.where("record_corrections.target_table", "meeting_documents").whereExists(
            whereMeetingPublished(
              db("meeting_documents")
                .join("meetings", "meetings.id", "meeting_documents.meeting_id")
                .whereRaw("meeting_documents.id = record_corrections.target_id"),
              "meetings.published_at",
            ),
          );
        })
        .orWhere((branch) => {
          branch.where("record_corrections.target_table", "anomaly_flags").whereExists(
            whereFindingPublic(
              db,
              db("anomaly_flags").whereRaw("anomaly_flags.id = record_corrections.target_id"),
            ),
          );
        });
    });
}

export interface PublicCorrectionFilters {
  limit?: number;
  offset?: number;
}

/** The public log, newest first. */
export async function listPublicCorrections(
  db: Knex,
  filters: PublicCorrectionFilters = {},
): Promise<PublicCorrectionListing> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const countRow = await publicCorrectionsQuery(db)
    .count("* as total")
    .first<{ total?: string } | undefined>();
  const total = Number(countRow?.total ?? 0);

  const rows = await publicCorrectionsQuery(db)
    // The dispute is joined for its reference only. Nothing a contester wrote
    // reaches this page; migration 039 permits one value of `review_state` and
    // there is no route that publishes a dispute's text.
    .leftJoin("record_disputes", "record_disputes.id", "record_corrections.dispute_id")
    .select<JoinedRow[]>([
      "record_corrections.id",
      "record_corrections.created_at",
      "record_corrections.target_table",
      "record_corrections.target_id",
      "record_corrections.field",
      "record_corrections.old_value",
      "record_corrections.new_value",
      "record_corrections.reason",
      "record_disputes.reference as dispute_reference",
      db.raw(`
        CASE record_corrections.target_table
          WHEN 'meetings' THEN record_corrections.target_id
          WHEN 'agenda_items' THEN
            (SELECT meeting_id FROM agenda_items WHERE agenda_items.id = record_corrections.target_id)
          WHEN 'meeting_documents' THEN
            (SELECT meeting_id FROM meeting_documents WHERE meeting_documents.id = record_corrections.target_id)
          WHEN 'anomaly_flags' THEN
            (SELECT meeting_id FROM anomaly_flags WHERE anomaly_flags.id = record_corrections.target_id)
        END AS public_meeting_id
      `),
    ])
    .orderBy("record_corrections.created_at", "desc")
    .limit(limit)
    .offset(offset);

  return { data: rows.map(toPublicCorrection), total };
}
