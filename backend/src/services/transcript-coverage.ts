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

/**
 * The four things that can be true of one transcript document.
 *
 * `unchecked` is not a `transcript_status` state — the table has three — it is
 * the absence of a row, given the same name the coverage query gives it. Kept in
 * the same vocabulary on purpose: a reader who has seen the coverage page must
 * not have to learn a second set of words for the same four facts.
 */
export const MEETING_TRANSCRIPT_STATES = [
  "published",
  "absent",
  "unavailable",
  "unchecked",
] as const;
export type MeetingTranscriptState = (typeof MEETING_TRANSCRIPT_STATES)[number];

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

export interface TranscriptTotals {
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
}

/**
 * The coverage rows summed across every body and year.
 *
 * `/api/metrics` wants one line about transcripts; the coverage route serves the
 * breakdown a reader drills into. Summing the rows that route already returns is
 * the whole implementation, because a second aggregation over the same tables is
 * a second thing to keep true — and the two would disagree the first time either
 * one's publication predicate changed.
 *
 * All four counts travel together for the reason the coverage header gives:
 * dropping `unchecked` would let a body with two hundred unswept meetings render
 * as fully covered.
 */
export function totalTranscriptCoverage(
  rows: readonly TranscriptCoverageRow[],
): TranscriptTotals {
  return rows.reduce<TranscriptTotals>(
    (total, row) => ({
      published: total.published + row.published,
      absent: total.absent + row.absent,
      unavailable: total.unavailable + row.unavailable,
      unchecked: total.unchecked + row.unchecked,
    }),
    { published: 0, absent: 0, unavailable: 0, unchecked: 0 },
  );
}

/* ---------------------------------------------------------------------------
   One meeting, rather than one body-year.
   --------------------------------------------------------------------------- */

/**
 * What we know about one meeting's transcript documents.
 *
 * The gap this closes: `/api/meetings/:id` returns `meeting_documents` rows, and
 * **the presence of a `transcript` row proves nothing** — it is written at
 * discovery, before anything is fetched, so the eight-byte empty caption file
 * produces exactly the same row as a three-hour transcript. Until this existed a
 * meeting page could only speak when its whole calendar year was unanimous.
 *
 * One entry per document, not one per meeting, because Bozeman's archive files a
 * single sitting as two rows ("City Commission Meeting pt 1") each with its own
 * clip. A meeting whose first half is published and whose second half we could
 * not fetch is two different statements, and a rolled-up state would have to
 * pick one of them to tell.
 *
 * `last_error` is not here and must not be added. It carries a URL, an HTTP
 * status and sometimes an upstream response body; `transcriptCoverage` withholds
 * it deliberately and the same rule applies the moment the same column is read
 * one meeting at a time.
 */
export interface MeetingTranscriptDocument {
  meeting_document_id: string;
  /** The custodian's own identifier for the recording. Null when unchecked. */
  clip_id: string | null;
  state: MeetingTranscriptState;
  /**
   * Cues indexed for this document — what a citation can actually resolve
   * against, counted from `transcript_cues` rather than restated from
   * `transcript_status.cue_count`.
   *
   * Zero for `absent`, and that zero is a fact: the custodian served a
   * well-formed caption file with nothing in it. Null for `unavailable` and
   * `unchecked`, where we do not know — rendering either as 0 would publish our
   * silence as theirs.
   */
  cue_count: number | null;
  /** The bytes we read, so the claim is checkable. Null when unchecked. */
  observed_sha256: string | null;
  last_checked_at: string | null;
}

export interface MeetingTranscript {
  documents: MeetingTranscriptDocument[];
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
  /** Most recent check across this meeting's documents, or null. */
  checked_through: string | null;
}

function toState(value: unknown): MeetingTranscriptState {
  // The absence of a `transcript_status` row is `unchecked`. It is not `absent`:
  // one says we never asked, the other says the custodian answered with nothing,
  // and only the second is a statement about a public body.
  const found = MEETING_TRANSCRIPT_STATES.find((state) => state === value);
  return found ?? "unchecked";
}

/**
 * Transcript state for one meeting's documents.
 *
 * **No publication predicate here.** Every caller is a route that has already
 * resolved the meeting through `findPublishedMeeting`, and a second wall in this
 * function would be a second rule to keep true — `publication.ts` says the
 * absence has to be one rule in one place. Anything calling this with an
 * unresolved id is the defect.
 */
export async function meetingTranscript(
  db: Knex,
  meetingId: string,
): Promise<MeetingTranscript | null> {
  const rows: unknown = await db("meeting_documents as md")
    .leftJoin("transcript_status as ts", "ts.meeting_document_id", "md.id")
    .where("md.meeting_id", meetingId)
    .where("md.document_type", "transcript")
    .orderBy("md.created_at", "asc")
    .select(
      "md.id as meeting_document_id",
      "ts.state",
      "ts.clip_id",
      "ts.observed_sha256",
      "ts.last_checked_at",
      // The cue index of the newest version's artifact. `document_versions` can
      // hold several versions of one document and only the newest is the
      // transcript we currently serve; counting across all of them would add up
      // superseded cues and report a longer recording than exists.
      db.raw(`(
        select count(*)
          from transcript_cues tc
         where tc.artifact_id = (
           select dv.artifact_id
             from document_versions dv
            where dv.meeting_document_id = md.id
            order by dv.version_no desc
            limit 1
         )
      ) as indexed_cues`),
    );

  const documents: MeetingTranscriptDocument[] = (Array.isArray(rows) ? rows : [])
    .filter(isRecord)
    .map((row) => {
      const state = toState(row.state);
      return {
        meeting_document_id: String(row.meeting_document_id),
        clip_id: typeof row.clip_id === "string" ? row.clip_id : null,
        state,
        cue_count:
          state === "published" || state === "absent" ? toCount(row.indexed_cues) : null,
        observed_sha256:
          typeof row.observed_sha256 === "string" ? row.observed_sha256 : null,
        last_checked_at: toIso(row.last_checked_at),
      };
    });

  // Null rather than a row of zeroes: this meeting has no transcript document at
  // all, which is not the same as having one nobody has swept. `unchecked` names
  // a document we have not asked about; there is no document here to ask about,
  // and the coverage query does not count such a meeting either.
  if (documents.length === 0) return null;

  const checked = documents
    .map((document) => document.last_checked_at)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    documents,
    published: documents.filter((document) => document.state === "published").length,
    absent: documents.filter((document) => document.state === "absent").length,
    unavailable: documents.filter((document) => document.state === "unavailable").length,
    unchecked: documents.filter((document) => document.state === "unchecked").length,
    checked_through: checked[checked.length - 1] ?? null,
  };
}
