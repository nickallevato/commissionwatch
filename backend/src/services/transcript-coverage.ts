import type { Knex } from "knex";
import { whereMeetingPublished } from "./publication";

/**
 * How much of a body's record we hold a transcript for, per calendar year.
 *
 * The sentence this exists to let the site render, both halves sourced:
 *
 *   Bozeman City Commission, 2026: 12 of 12 meetings have a published transcript.
 *   2015: 0 of 24 — the city's video system serves an empty caption file for
 *   every meeting that year.
 *
 * Four states, not three, and the fourth is the one that would otherwise flatter
 * us: `unchecked` is a meeting document of kind `transcript` with no
 * `transcript_status` row at all. Omitting it would let a body with two hundred
 * unswept meetings read as 100% covered.
 *
 * `absent` and `unavailable` are kept apart for the whole length of this query
 * because they are statements about different parties. `absent` is the custodian
 * serving a well-formed caption file with nothing in it — a fact about Bozeman's
 * record, and one that is era-shaped rather than random. `unavailable` is us
 * failing to get an answer. Collapsing them would let our outage be published as
 * the city's silence.
 *
 * **Inside the publication wall.** `buildPublicStatus` is deliberately outside it
 * because ingestion-run metadata describes *us*; transcript coverage describes
 * *meetings*, so it goes through the same `whereMeetingPublished` helper every
 * other public path uses. A meeting an operator has not published contributes to
 * no figure here.
 *
 * `transcript_status.last_error` is never selected. It is an operator-facing
 * string that can quote a URL from an unpublished meeting, and the leak rule
 * `toPublicSource` is held to applies here whether or not today's error text
 * happens to be safe.
 */

export interface TranscriptCoverageRow {
  jurisdiction: string;
  body: string;
  year: number;
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
  /** Most recent check in this group, ISO 8601, or null if nothing was checked. */
  checked_through: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `count(*) filter (...)` comes back as a bigint string. */
function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return new Date(value).toISOString();
  return null;
}

export async function transcriptCoverage(db: Knex): Promise<TranscriptCoverageRow[]> {
  const rows: unknown = await whereMeetingPublished(
    db("meeting_documents as md")
      .join("meetings as m", "m.id", "md.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
      .leftJoin("transcript_status as ts", "ts.meeting_document_id", "md.id"),
    "m.published_at",
  )
    .where("md.document_type", "transcript")
    .groupBy("j.name", "c.name", db.raw("extract(year from m.date)"))
    .orderBy([
      { column: "j.name", order: "asc" },
      { column: "c.name", order: "asc" },
      { column: db.raw("extract(year from m.date)"), order: "desc" },
    ])
    .select(
      "j.name as jurisdiction",
      "c.name as body",
      db.raw("extract(year from m.date)::int as year"),
      db.raw("count(*) filter (where ts.state = 'published') as published"),
      db.raw("count(*) filter (where ts.state = 'absent') as absent"),
      db.raw("count(*) filter (where ts.state = 'unavailable') as unavailable"),
      db.raw("count(*) filter (where ts.meeting_document_id is null) as unchecked"),
      db.raw("max(ts.last_checked_at) as checked_through"),
    );

  return (Array.isArray(rows) ? rows : []).filter(isRecord).map((row) => ({
    jurisdiction: String(row.jurisdiction),
    body: String(row.body),
    year: toCount(row.year),
    published: toCount(row.published),
    absent: toCount(row.absent),
    unavailable: toCount(row.unavailable),
    unchecked: toCount(row.unchecked),
    checked_through: toIso(row.checked_through),
  }));
}
