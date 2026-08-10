import type { Knex } from "knex";
import { listCorrections, type CorrectionRow } from "./corrections";

/**
 * The meeting screen: one record, everything behind it, and its history.
 *
 * This is the only surface on which an *unpublished* meeting is visible. That
 * asymmetry is the point of decision 8 — the public API cannot see it, and the
 * person whose job is to decide whether it should be public must.
 *
 * `artifacts` is resolved through the meeting's `parse` jobs rather than a
 * foreign key. `meeting_documents` records a URL; `artifacts` records the bytes
 * that URL produced, addressed by their hash. The job target is what relates
 * the two, and it is what the re-parse action replays — so the console shows
 * exactly the artifacts a re-parse would act on, rather than a second list that
 * could quietly differ from it.
 */

export interface FieldConfidenceEntry {
  level: string;
  reason: string;
}

export interface PressroomAgendaItem {
  id: string;
  meeting_id: string;
  item_number: number;
  title: string;
  description: string | null;
  category: string | null;
  field_confidence: Record<string, FieldConfidenceEntry>;
  created_at: string | null;
  updated_at: string | null;
}

export interface PressroomArtifact {
  id: string;
  sha256: string;
  storage_key: string;
  content_type: string | null;
  source_url: string | null;
  byte_size: number;
  fetched_at: string | null;
}

export interface MeetingDetail {
  meeting: Record<string, unknown>;
  commission: { id: string; name: string };
  jurisdiction: { id: string; name: string; state: string };
  agenda_items: PressroomAgendaItem[];
  documents: Array<Record<string, unknown>>;
  artifacts: PressroomArtifact[];
  corrections: CorrectionRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

/**
 * `agenda_items.field_confidence` as a map this screen can render.
 *
 * Entries that are not `{ level, reason }` are dropped rather than passed
 * through. A malformed mark rendered as an empty chip would read as "assessed
 * and fine", which is the one thing an unreadable mark does not mean.
 */
export function readFieldConfidence(value: unknown): Record<string, FieldConfidenceEntry> {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!isRecord(source)) return {};

  const marks: Record<string, FieldConfidenceEntry> = {};
  for (const [field, raw] of Object.entries(source)) {
    if (!isRecord(raw)) continue;
    const level = raw.level;
    const reason = raw.reason;
    if (typeof level !== "string" || level === "") continue;
    marks[field] = { level, reason: typeof reason === "string" ? reason : "" };
  }
  return marks;
}

/** Content addresses this meeting's documents were parsed from, in job order. */
async function meetingArtifactHashes(db: Knex, meetingId: string): Promise<string[]> {
  const rows: unknown = await db("ingestion_jobs")
    .whereIn("stage", ["parse", "analyze"])
    .whereRaw("target ->> 'meetingId' = ?", [meetingId])
    .orderBy("created_at", "asc")
    .select("target");

  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    let target: unknown = row.target;
    if (typeof target === "string") {
      try {
        target = JSON.parse(target);
      } catch {
        continue;
      }
    }
    if (!isRecord(target)) continue;
    const sha256 = asString(target.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256) || seen.has(sha256)) continue;
    seen.add(sha256);
    hashes.push(sha256);
  }
  return hashes;
}

/** One meeting, everything behind it, and every correction ever made to it. */
export async function getMeetingDetail(db: Knex, meetingId: string): Promise<MeetingDetail | null> {
  const meeting: unknown = await db("meetings").where({ id: meetingId }).first();
  if (!isRecord(meeting)) return null;

  const commissionRow: unknown = await db("commissions as c")
    .join("jurisdictions as j", "c.jurisdiction_id", "j.id")
    .where("c.id", asString(meeting.commission_id))
    .first(
      "c.id as commission_id",
      "c.name as commission_name",
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      "j.state as jurisdiction_state",
    );

  const [agendaRows, documentRows] = await Promise.all([
    db("agenda_items").where({ meeting_id: meetingId }).orderBy("item_number", "asc"),
    db("meeting_documents").where({ meeting_id: meetingId }).orderBy("created_at", "asc"),
  ]);

  const hashes = await meetingArtifactHashes(db, meetingId);
  const artifactRows: unknown =
    hashes.length === 0
      ? []
      : await db("artifacts")
          .whereIn("sha256", hashes)
          .select("id", "sha256", "storage_key", "content_type", "source_url", "byte_size", "fetched_at");

  const artifacts = (Array.isArray(artifactRows) ? artifactRows : [])
    .filter(isRecord)
    .map(
      (row): PressroomArtifact => ({
        id: asString(row.id),
        sha256: asString(row.sha256),
        storage_key: asString(row.storage_key),
        content_type: typeof row.content_type === "string" ? row.content_type : null,
        source_url: typeof row.source_url === "string" ? row.source_url : null,
        byte_size: asNumber(row.byte_size, 0),
        fetched_at: asIsoOrNull(row.fetched_at),
      }),
    )
    // Job order, so the list matches the order a re-parse would replay.
    .sort((a, b) => hashes.indexOf(a.sha256) - hashes.indexOf(b.sha256));

  const agenda_items = (Array.isArray(agendaRows) ? agendaRows : []).filter(isRecord).map(
    (row): PressroomAgendaItem => ({
      id: asString(row.id),
      meeting_id: asString(row.meeting_id),
      item_number: asNumber(row.item_number, 0),
      title: asString(row.title),
      description: typeof row.description === "string" ? row.description : null,
      category: typeof row.category === "string" ? row.category : null,
      field_confidence: readFieldConfidence(row.field_confidence),
      created_at: asIsoOrNull(row.created_at),
      updated_at: asIsoOrNull(row.updated_at),
    }),
  );

  const corrections = await listCorrections(db, {
    targetTable: "meetings",
    targetId: meetingId,
  });

  return {
    meeting,
    commission: isRecord(commissionRow)
      ? { id: asString(commissionRow.commission_id), name: asString(commissionRow.commission_name) }
      : { id: asString(meeting.commission_id), name: "" },
    jurisdiction: isRecord(commissionRow)
      ? {
          id: asString(commissionRow.jurisdiction_id),
          name: asString(commissionRow.jurisdiction_name),
          state: asString(commissionRow.jurisdiction_state),
        }
      : { id: "", name: "", state: "" },
    agenda_items,
    documents: (Array.isArray(documentRows) ? documentRows : []).filter(isRecord),
    artifacts,
    corrections,
  };
}

// ---------------------------------------------------------------------------
// Browsing what a sweep produced
// ---------------------------------------------------------------------------

/**
 * The ingested-but-not-yet-public list, per source.
 *
 * The console could open one meeting by id and could see nothing else, which
 * is workable when a sweep lands three records and impossible when it lands the
 * Bozeman archive. Publication is a per-record decision (decision 8), so the
 * operator needs the set of records awaiting one.
 *
 * Scoped by source rather than by run because `meetings` has no `run_id`:
 * identity is `(commission_id, external_id)` and a re-sweep revises a row
 * rather than inserting a second one, so "the meetings this run produced" is
 * not a question the schema can answer. "The meetings from this source that
 * nobody has published" is, and it is the question the operator actually has.
 */
export interface PressroomMeetingSummary {
  id: string;
  date: string;
  time: string | null;
  status: string;
  location: string | null;
  external_id: string | null;
  agenda_url: string | null;
  minutes_url: string | null;
  published_at: string | null;
  commission: { id: string; name: string };
  document_count: number;
}

export interface ListMeetingsFilter {
  sourceId: string;
  /** `false` for the review backlog, `true` for what is live, omitted for all. */
  published?: boolean;
  limit?: number;
}

/** A hard ceiling, so a source with a decade of archive cannot hang the screen. */
export const MEETING_PAGE_MAX = 500;

function asIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value !== "" ? value : null;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export async function listMeetingsForSource(
  db: Knex,
  filter: ListMeetingsFilter,
): Promise<{ meetings: PressroomMeetingSummary[]; unpublished_total: number }> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), MEETING_PAGE_MAX);

  const base = () =>
    db("meetings as m")
      .join("commissions as c", "m.commission_id", "c.id")
      .join("ingestion_sources as s", "s.jurisdiction_id", "c.jurisdiction_id")
      .where("s.id", filter.sourceId);

  // Counted independently of `limit`, so the screen can say "showing 100 of
  // 512" rather than implying the backlog is exactly what fits on it.
  const countRow: unknown = await base().whereNull("m.published_at").count({ total: "m.id" }).first();
  const unpublishedTotal =
    isRow(countRow) && countRow.total !== undefined ? Number(countRow.total) : 0;

  const query = base()
    .select(
      "m.id as id",
      "m.date as date",
      "m.time as time",
      "m.status as status",
      "m.location as location",
      "m.external_id as external_id",
      "m.agenda_url as agenda_url",
      "m.minutes_url as minutes_url",
      "m.published_at as published_at",
      "c.id as commission_id",
      "c.name as commission_name",
    )
    .orderBy([
      { column: "m.date", order: "desc" },
      { column: "m.id", order: "asc" },
    ])
    .limit(limit);

  if (filter.published === true) query.whereNotNull("m.published_at");
  if (filter.published === false) query.whereNull("m.published_at");

  const rows: unknown = await query;
  const list = (Array.isArray(rows) ? rows : []).filter(isRow);

  const ids = list.map((row) => String(row.id));
  const documentCounts = new Map<string, number>();
  if (ids.length > 0) {
    const docRows: unknown = await db("meeting_documents")
      .whereIn("meeting_id", ids)
      .groupBy("meeting_id")
      .select("meeting_id")
      .count({ total: "id" });
    for (const row of Array.isArray(docRows) ? docRows : []) {
      if (!isRow(row)) continue;
      documentCounts.set(String(row.meeting_id), Number(row.total ?? 0));
    }
  }

  const meetings = list.map((row): PressroomMeetingSummary => {
    const id = String(row.id);
    return {
      id,
      // `date` is a DATE column: the driver hands back a Date at UTC midnight,
      // and rendering it as an ISO instant would shift the day backwards for
      // anyone west of Greenwich — which is everyone this project covers.
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date ?? ""),
      time: text(row.time),
      status: String(row.status ?? ""),
      location: text(row.location),
      external_id: text(row.external_id),
      agenda_url: text(row.agenda_url),
      minutes_url: text(row.minutes_url),
      published_at: asIso(row.published_at),
      commission: { id: String(row.commission_id), name: String(row.commission_name ?? "") },
      document_count: documentCounts.get(id) ?? 0,
    };
  });

  return { meetings, unpublished_total: unpublishedTotal };
}
