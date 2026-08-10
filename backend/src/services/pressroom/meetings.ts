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
