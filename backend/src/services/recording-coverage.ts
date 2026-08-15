import type { Knex } from "knex";
import { whereMeetingPublished } from "./publication";
import { formatRecordingLength } from "./ingestion/granicus-player";

/**
 * How much recorded meeting there is, and how much of it nobody can read.
 *
 * The sentence this exists to let the site state, both halves sourced:
 *
 *   Bozeman City Commission, 2015: 24 meetings, 24 recordings, 61 hours of them,
 *   and 0 transcripts. The city's video system serves an empty caption file for
 *   every meeting that year, and the recordings themselves are not accessible to
 *   this project by acceptable means.
 *
 * `transcript-coverage.ts` can already say the second half. It cannot say the
 * first, and the first is what turns "we have no transcript" from a gap in our
 * pipeline into a quantified gap in the public record — which is the argument for
 * a records request rather than a shrug. A year with no transcripts and no
 * recordings is a body that met and was not recorded; a year with no transcripts
 * and sixty-one hours of recording is sixty-one hours of public meeting that
 * exists and cannot be searched. Those are different facts and the site must be
 * able to tell them apart.
 *
 * **Inside the publication wall**, through the same `whereMeetingPublished` helper
 * every other meeting-derived projection uses. Recording coverage describes
 * meetings, not our ingestion.
 *
 * `meeting_recordings.last_error` is never selected here, and must not be. It is
 * an operator-facing string carrying a URL and the first bytes of a response, and
 * the leak rule `toPublicSource` and `transcriptCoverage` are both held to applies
 * the moment a public projection reads the same column.
 */

/** The three things that can be true of one recording document. */
export const MEETING_RECORDING_COVERAGE_STATES = [
  "available",
  "unreadable",
  "unchecked",
] as const;
export type MeetingRecordingCoverageState =
  (typeof MEETING_RECORDING_COVERAGE_STATES)[number];

export interface RecordingCoverageRow {
  jurisdiction: string;
  body: string;
  year: number;
  /** Recordings whose length and media id we read off the custodian's page. */
  available: number;
  /** Pages we fetched and could not read. Ours, never theirs. */
  unreadable: number;
  /** A `recording` document with no `meeting_recordings` row: never swept. */
  unchecked: number;
  /** Summed length of the `available` recordings, milliseconds. */
  recorded_ms: number;
  /**
   * Of the `available` recordings, how many have no published transcript of the
   * same clip. The headline figure: recorded public meeting nobody can search.
   */
  without_transcript: number;
  /** Most recent check in this group, ISO 8601, or null if nothing was checked. */
  checked_through: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `count(*) filter (...)` and `sum(...)` come back as bigint strings. */
function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return new Date(value).toISOString();
  return null;
}

/**
 * Does this clip have a published transcript?
 *
 * Matched on the **clip id within the same meeting**, not on the meeting alone
 * and not on the clip id alone. Bozeman files one sitting as two rows each with
 * its own clip, so a meeting-level match would call the unrecorded half covered
 * because the other half was captioned; and clip ids are the vendor's, unique per
 * tenant rather than per universe, so matching on the id alone would join across
 * jurisdictions the day a second Granicus tenant is registered.
 */
const HAS_PUBLISHED_TRANSCRIPT = `exists (
  select 1
    from transcript_status ts
    join meeting_documents tmd on tmd.id = ts.meeting_document_id
   where tmd.meeting_id = m.id
     and ts.clip_id = mr.clip_id
     and ts.state = 'published'
)`;

export async function recordingCoverage(db: Knex): Promise<RecordingCoverageRow[]> {
  const rows: unknown = await whereMeetingPublished(
    db("meeting_documents as md")
      .join("meetings as m", "m.id", "md.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
      .leftJoin("meeting_recordings as mr", "mr.meeting_document_id", "md.id"),
    "m.published_at",
  )
    .where("md.document_type", "recording")
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
      db.raw("count(*) filter (where mr.state = 'available') as available"),
      db.raw("count(*) filter (where mr.state = 'unreadable') as unreadable"),
      db.raw("count(*) filter (where mr.meeting_document_id is null) as unchecked"),
      db.raw("coalesce(sum(mr.duration_ms) filter (where mr.state = 'available'), 0) as recorded_ms"),
      db.raw(
        `count(*) filter (where mr.state = 'available' and not ${HAS_PUBLISHED_TRANSCRIPT}) as without_transcript`,
      ),
      db.raw("max(mr.last_checked_at) as checked_through"),
    );

  return (Array.isArray(rows) ? rows : []).filter(isRecord).map((row) => ({
    jurisdiction: String(row.jurisdiction),
    body: String(row.body),
    year: toCount(row.year),
    available: toCount(row.available),
    unreadable: toCount(row.unreadable),
    unchecked: toCount(row.unchecked),
    recorded_ms: toCount(row.recorded_ms),
    without_transcript: toCount(row.without_transcript),
    checked_through: toIso(row.checked_through),
  }));
}

export interface RecordingTotals {
  available: number;
  unreadable: number;
  unchecked: number;
  recorded_ms: number;
  without_transcript: number;
}

/**
 * The coverage rows summed across every body and year.
 *
 * Summing rows the coverage query already returned, rather than aggregating the
 * tables a second time, for the reason `totalTranscriptCoverage` gives: two
 * aggregations over the same tables are two things to keep true, and they
 * disagree the first time either one's publication predicate changes.
 */
export function totalRecordingCoverage(
  rows: readonly RecordingCoverageRow[],
): RecordingTotals {
  return rows.reduce<RecordingTotals>(
    (total, row) => ({
      available: total.available + row.available,
      unreadable: total.unreadable + row.unreadable,
      unchecked: total.unchecked + row.unchecked,
      recorded_ms: total.recorded_ms + row.recorded_ms,
      without_transcript: total.without_transcript + row.without_transcript,
    }),
    { available: 0, unreadable: 0, unchecked: 0, recorded_ms: 0, without_transcript: 0 },
  );
}

/* ---------------------------------------------------------------------------
   One meeting, rather than one body-year.
   --------------------------------------------------------------------------- */

/**
 * What we know about one meeting's recordings.
 *
 * One entry per document, for the reason `meetingTranscript` gives: a sitting
 * filed as two clips is two recordings, and rolling them up would have to pick one
 * of two true statements to tell.
 *
 * `length` is the rendered form and it is media time. Never a clock time: the
 * offset between a recording's start and the meeting's is published nowhere and
 * varies per clip, so "the meeting ran until 9:47pm" would be an invention.
 */
export interface MeetingRecordingDocument {
  meeting_document_id: string;
  /** The custodian's own identifier for the recording. Null when unchecked. */
  clip_id: string | null;
  state: MeetingRecordingCoverageState;
  /** The custodian's name for the media bytes. Null unless `available`. */
  media_id: string | null;
  /** Where the custodian serves it. Published so a reader can go there. */
  media_url: string | null;
  duration_ms: number | null;
  /** `duration_ms` in the words the site uses, e.g. `2h 56m`. */
  length: string | null;
  /** The player-page bytes every other field was read out of, so it is checkable. */
  observed_sha256: string | null;
  last_checked_at: string | null;
}

function toState(value: unknown): MeetingRecordingCoverageState {
  // The absence of a row is `unchecked` — we never asked. It is not a statement
  // that the custodian recorded nothing; a meeting nobody recorded has no
  // `recording` document at all, because the archive row carried no clip id.
  const found = MEETING_RECORDING_COVERAGE_STATES.find((state) => state === value);
  return found ?? "unchecked";
}

/**
 * Recording state for one meeting's documents.
 *
 * **No publication predicate here**, matching `meetingTranscript`: every caller is
 * a route that has already resolved the meeting through `findPublishedMeeting`,
 * and a second wall would be a second rule to keep true.
 */
export async function meetingRecordings(
  db: Knex,
  meetingId: string,
): Promise<MeetingRecordingDocument[]> {
  const rows: unknown = await db("meeting_documents as md")
    .leftJoin("meeting_recordings as mr", "mr.meeting_document_id", "md.id")
    .where("md.meeting_id", meetingId)
    .where("md.document_type", "recording")
    .orderBy("md.created_at", "asc")
    .select(
      "md.id as meeting_document_id",
      "mr.state",
      "mr.clip_id",
      "mr.media_id",
      "mr.media_url",
      "mr.duration_ms",
      "mr.observed_sha256",
      "mr.last_checked_at",
    );

  return (Array.isArray(rows) ? rows : []).filter(isRecord).map((row) => {
    const state = toState(row.state);
    const durationMs =
      state === "available" && row.duration_ms !== null ? toCount(row.duration_ms) : null;
    return {
      meeting_document_id: String(row.meeting_document_id),
      clip_id: typeof row.clip_id === "string" ? row.clip_id : null,
      state,
      media_id: typeof row.media_id === "string" ? row.media_id : null,
      media_url: typeof row.media_url === "string" ? row.media_url : null,
      duration_ms: durationMs,
      length: durationMs === null ? null : formatRecordingLength(durationMs),
      observed_sha256: typeof row.observed_sha256 === "string" ? row.observed_sha256 : null,
      last_checked_at: toIso(row.last_checked_at),
    };
  });
}
