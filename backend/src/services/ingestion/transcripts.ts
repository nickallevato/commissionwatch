import type { Knex } from "knex";
import { recordArtifactText } from "./handlers";
import { looksLikeWebVtt, parseWebVttCues, projectTranscript, WebVttParseError, type VttCue } from "./webvtt";

/**
 * Transcript state, recorded per meeting document.
 *
 * The design problem this module exists for, stated once: **every empty Granicus
 * caption file is the same eight bytes and therefore the same sha256.**
 * `artifacts.sha256` is uniquely indexed, so one artifact row represents every
 * absence the city will ever publish, `artifacts.source_url` names whichever clip
 * was fetched first, and `parse` is enqueued only when a fetch is new — so the
 * second absence produces no downstream work at all. Anything that recorded
 * absence on the artifact would be attaching a false provenance to a row nobody
 * re-derives.
 *
 * Hence `transcript_status`, written by the **fetch** handler, outside its
 * `isNew` branch. See `migrations/089_create_transcript_status.ts` for the
 * constraints that hold the three states apart, and `090` for the cue index.
 */

export const TRANSCRIPT_STATES = ["published", "absent", "unavailable"] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

/**
 * Days after a meeting before an `absent` transcript stops being re-checked.
 *
 * **This number is a guess and the spec says so.** Granicus generates captions
 * asynchronously, so a meeting held on Tuesday can be empty on Wednesday and
 * present on Friday — an `absent` recorded once and never revisited would publish
 * a false absence. Nobody has measured how long the lag actually is; the honest
 * way to find out is to probe the three most recent clips daily for a fortnight
 * and read the answer off the data. Until then, thirty days.
 *
 * `unavailable` is never settled by this window. That state describes our failure,
 * not their record, and we do not get to stop trying.
 */
export const TRANSCRIPT_SETTLE_DAYS = 30;

// ---------------------------------------------------------------------------
// Reading the bytes
// ---------------------------------------------------------------------------

export interface TranscriptReading {
  state: TranscriptState;
  /** Cues in the file. Null only when the bytes were not readable WebVTT. */
  cues: VttCue[] | null;
  /** Non-null exactly when `state` is `unavailable`. */
  lastError: string | null;
}

/** The first bytes of a response, for an error message a human can act on. */
function firstBytes(bytes: Uint8Array, limit = 60): string {
  return JSON.stringify(
    new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit)),
  );
}

/**
 * What a 200 response actually was.
 *
 * Decided on the bytes, never on the Content-Type. An unknown clip id on this
 * host answers `500 text/html` with a Slim framework error page, and a header is
 * only what a server claims — Gallatin already proved that claim can be wrong.
 *
 * The two failure shapes must not collapse into one: a vendor error page is
 * `unavailable` and describes us, while a valid caption file with no cues is
 * `absent` and describes the custodian's record. "Published nothing" and
 * "published an empty transcript" are different statements about a public body,
 * and the site has to be able to say which.
 */
export function readTranscript(
  bytes: Uint8Array,
  contentType: string | null,
): TranscriptReading {
  if (!looksLikeWebVtt(bytes)) {
    return {
      state: "unavailable",
      cues: null,
      lastError:
        `expected WebVTT, got content-type ${contentType ?? "unknown"}, ` +
        `${bytes.length} bytes beginning ${firstBytes(bytes)}`,
    };
  }
  let cues: VttCue[];
  try {
    cues = parseWebVttCues(bytes);
  } catch (error) {
    if (error instanceof WebVttParseError) {
      // Bytes that announce themselves as WebVTT and are not. Recorded as our
      // failure rather than as an absence: claiming the city published nothing
      // because our parser stopped would be a false statement about the record.
      return { state: "unavailable", cues: null, lastError: error.message };
    }
    throw error;
  }
  return {
    state: cues.length > 0 ? "published" : "absent",
    cues,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `meeting_documents` row a fetch job was aimed at, or null. */
export async function findMeetingDocumentId(
  db: Knex,
  meetingId: string,
  url: string,
): Promise<string | null> {
  const row: unknown = await db("meeting_documents")
    .where({ meeting_id: meetingId, url })
    .first("id");
  return isRecord(row) && typeof row.id === "string" ? row.id : null;
}

export interface TranscriptObservation {
  meetingDocumentId: string;
  clipId: string;
  state: TranscriptState;
  /** The bytes we read, when we read any. Not a foreign key — see migration 089. */
  observedSha256: string | null;
  cueCount: number | null;
  lastError: string | null;
  observedAt: Date | string;
}

/**
 * Records one observation of one document's transcript.
 *
 * `first_checked_at` is written on insert and never touched again;
 * `last_checked_at` moves and `checks` increments on every pass. Those three
 * columns are what let the coverage page say "we re-checked on Friday and it is
 * still empty" rather than restating one stale look as though it were current.
 */
export async function recordTranscriptStatus(
  db: Knex,
  observation: TranscriptObservation,
): Promise<void> {
  await db("transcript_status")
    .insert({
      meeting_document_id: observation.meetingDocumentId,
      state: observation.state,
      clip_id: observation.clipId,
      observed_sha256: observation.observedSha256,
      cue_count: observation.cueCount,
      first_checked_at: observation.observedAt,
      last_checked_at: observation.observedAt,
      checks: 1,
      last_error: observation.lastError,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict("meeting_document_id")
    .merge({
      state: db.raw("excluded.state"),
      clip_id: db.raw("excluded.clip_id"),
      observed_sha256: db.raw("excluded.observed_sha256"),
      cue_count: db.raw("excluded.cue_count"),
      last_checked_at: db.raw("excluded.last_checked_at"),
      last_error: db.raw("excluded.last_error"),
      checks: db.raw("transcript_status.checks + 1"),
      updated_at: db.fn.now(),
    });
}

/**
 * Writes the transcript's text and its cue index, in one transaction.
 *
 * Both halves or neither: `transcript_cues.text_offset` addresses a character in
 * `artifact_texts.text`, and a partial write would leave a timeline pointing into
 * a string that says something else. `recordArtifactText` is the same function
 * every other indexed document goes through — there is deliberately no second
 * text-indexing path for transcripts, because a second one would be a second
 * offset space and `services/extraction/verify.ts` resolves quotes in exactly one.
 *
 * Replaced rather than accumulated on re-parse, matching `artifact_texts`: an
 * artifact is content addressed, so a second reading of the same bytes is a better
 * reading of one document and not a second document.
 */
export async function recordTranscriptProjection(
  db: Knex,
  artifactId: string,
  cues: readonly VttCue[],
): Promise<{ charsIndexed: number; cuesIndexed: number }> {
  const projection = projectTranscript(cues);
  return db.transaction(async (trx) => {
    const charsIndexed = await recordArtifactText(trx, artifactId, projection.text);
    await trx("transcript_cues").where({ artifact_id: artifactId }).delete();
    if (projection.spans.length > 0) {
      await trx("transcript_cues").insert(
        projection.spans.map((span) => ({
          artifact_id: artifactId,
          cue_index: span.cueIndex,
          start_ms: span.startMs,
          end_ms: span.endMs,
          text_offset: span.offset,
          text_length: span.length,
          created_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })),
      );
    }
    return { charsIndexed, cuesIndexed: projection.spans.length };
  });
}

// ---------------------------------------------------------------------------
// Re-fetch policy
// ---------------------------------------------------------------------------

/**
 * True when this document's transcript need not be fetched again.
 *
 * The gate lives in `discover`, which is the first stage with a database
 * connection. It matters because Granicus sends no ETag, no Last-Modified and no
 * Content-Length on this endpoint (probed 2026-08-14), so `fetchDocument`'s
 * conditional request can never receive a 304 and every re-check costs a full
 * download. 1,135 clips at roughly 180 KB, ten seconds apart, is about 200 MB and
 * 3.2 hours of wall clock for one pass — and a caption file for a 2015 meeting is
 * never going to change.
 *
 * Settled means: `published`, or `absent` on a meeting more than
 * {@link TRANSCRIPT_SETTLE_DAYS} in the past. `unavailable` is never settled.
 */
export async function transcriptFetchSettled(
  db: Knex,
  meetingDocumentId: string,
  meetingDate: string,
  now: Date,
  settleDays: number = TRANSCRIPT_SETTLE_DAYS,
): Promise<boolean> {
  const row: unknown = await db("transcript_status")
    .where({ meeting_document_id: meetingDocumentId })
    .first("state");
  if (!isRecord(row)) return false;
  if (row.state === "published") return true;
  if (row.state !== "absent") return false;
  const settledAfter = new Date(`${meetingDate}T00:00:00Z`).getTime() + settleDays * 86_400_000;
  return Number.isFinite(settledAfter) && now.getTime() > settledAfter;
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

export interface CueSpan {
  cueIndex: number;
  startMs: number;
  endMs: number;
}

/**
 * The media-time interval a quotation occupies in a transcript.
 *
 * `[start, start + length)` in the same character space `minute_claims.quote_offset`
 * uses. A quote spanning three cues yields `[first.start_ms, last.end_ms]`,
 * because an interval is what is true — a single point would be a rounding of the
 * record.
 *
 * The result is media time. Per the probes, the recording starts before the
 * meeting does by an amount that varies per clip (00:29:38 for clip 2775,
 * 00:01:44 for 2786) and is published nowhere, so the only honest rendering is
 * "29:38 into the recording". Nothing may convert it to a time of day.
 */
export async function locateCueInterval(
  db: Knex,
  artifactId: string,
  offset: number,
  length: number,
): Promise<{ startMs: number; endMs: number; firstCue: number; lastCue: number } | null> {
  const rows: unknown = await db("transcript_cues")
    .where({ artifact_id: artifactId })
    .where("text_offset", "<=", offset + Math.max(length - 1, 0))
    .whereRaw("text_offset + text_length > ?", [offset])
    .orderBy("cue_index", "asc")
    .select("cue_index", "start_ms", "end_ms");
  const spans: CueSpan[] = (Array.isArray(rows) ? rows : [])
    .filter(isRecord)
    .map((row) => ({
      cueIndex: Number(row.cue_index),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
    }));
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    startMs: first.startMs,
    endMs: last.endMs,
    firstCue: first.cueIndex,
    lastCue: last.cueIndex,
  };
}
