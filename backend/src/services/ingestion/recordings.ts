import type { Knex } from "knex";
import { readGranicusPlayer } from "./granicus-player";

/**
 * Recording state, recorded per meeting document.
 *
 * ## What this module is instead of
 *
 * `docs/superpowers/specs/2026-08-14-audio-transcription-design.md` asked for
 * audio ingestion, self-hosted ASR and a reproducibility manifest. Its own §5 open
 * question — *"whether the media itself is fetchable under the same posture as the
 * captions is unprobed"* — was probed on 2026-08-15 and the answer closed the
 * spec:
 *
 *   honest UA  → https://archive-video.granicus.com/bozeman/bozeman_….mp4 → 403
 *   Chrome UA  → the same URL                                            → 200, 6.0 GB
 *   curl's own default UA                                                → 403
 *
 * `DownloadFile.php`, the custodian's own download link on the tenant host,
 * redirects onto that CDN and inherits the 403. So the media is reachable only by
 * claiming to be a browser, which is the access control this project does not
 * defeat, and there is no audio to transcribe for either jurisdiction — Gallatin's
 * AV Capture All remains behind an AWS WAF challenge, re-probed the same day and
 * unchanged.
 *
 * What survives the probe is smaller and still worth having. The player page is
 * fetchable under the existing posture and states the recording's identity and its
 * length, so the site can say *a 2h 56m recording of this meeting exists, there is
 * no transcript of it, and here is where it lives* — three facts it could not
 * state before, one of which is the argument for making a records request.
 *
 * ## Where the write happens, and why here rather than in `parse`
 *
 * In the **fetch** handler, outside its `isNew` branch, exactly as
 * `transcript_status` is written and for the second of that design's two reasons.
 * The first reason does not apply — player pages are distinct per clip, so they do
 * not collapse onto one artifact the way the eight-byte caption stub does. The
 * second does: re-fetching an unchanged page leaves `isNew` false and enqueues no
 * `parse` job, so a `parse`-side write could never bump `last_checked_at`, and
 * "we looked again on Friday and it still says 2h 56m" is exactly the statement
 * these three columns exist to support.
 */

export const MEETING_RECORDING_STATES = ["available", "unreadable"] as const;
export type MeetingRecordingState = (typeof MEETING_RECORDING_STATES)[number];

/**
 * Days after a meeting before an `available` recording stops being re-checked.
 *
 * Same shape as `TRANSCRIPT_SETTLE_DAYS` and the same honesty about it: the number
 * is a guess. What is known is that Granicus publishes a clip's page as soon as
 * the clip exists and that a 2015 page will never change again; what is not known
 * is how long after a meeting the length settles, because a clip can be
 * re-encoded. Thirty days, and an operator can force a re-check.
 *
 * `unreadable` is never settled by this window. That state describes our failure
 * to read a page, not the custodian's record, and we do not get to stop trying.
 */
export const RECORDING_SETTLE_DAYS = 30;

// ---------------------------------------------------------------------------
// Reading the bytes
// ---------------------------------------------------------------------------

export interface RecordingReading {
  state: MeetingRecordingState;
  mediaId: string | null;
  mediaUrl: string | null;
  durationMs: number | null;
  indexPointCount: number | null;
  /** Non-null exactly when `state` is `unreadable`. */
  lastError: string | null;
}

/**
 * What a 200 from the player URL actually was.
 *
 * Two states, not three. There is no `absent` here and there must not be one: a
 * row exists only for a meeting the archive gave a clip id, so "the custodian
 * published no recording" is the absence of a row — the adapter already logs that
 * case at discovery — and `unreadable` describes us. Giving our parse failure and
 * their unrecorded meeting the same word is the mistake `transcript_status` was
 * built to avoid one table over.
 */
export function readRecording(bytes: Uint8Array): RecordingReading {
  const reading = readGranicusPlayer(bytes);
  if (reading.facts === null) {
    return {
      state: "unreadable",
      mediaId: null,
      mediaUrl: null,
      durationMs: null,
      indexPointCount: null,
      lastError: reading.error,
    };
  }
  return {
    state: "available",
    mediaId: reading.facts.mediaId,
    mediaUrl: reading.facts.mediaUrl,
    durationMs: reading.facts.durationMs,
    indexPointCount: reading.facts.indexPointCount,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RecordingObservation {
  meetingDocumentId: string;
  clipId: string;
  reading: RecordingReading;
  /**
   * The bytes every other column was read out of. Not a foreign key to
   * `artifacts`, for the reason migration 072 gives — the row records what was
   * served on a date and must outlive the artifact — and the whole of what makes
   * a duration on this site checkable rather than asserted.
   */
  observedSha256: string;
  observedAt: Date | string;
}

/**
 * Records one observation of one meeting document's recording.
 *
 * `first_checked_at` is written on insert and never touched again;
 * `last_checked_at` moves and `checks` increments on every pass.
 */
export async function recordMeetingRecording(
  db: Knex,
  observation: RecordingObservation,
): Promise<void> {
  const { reading } = observation;
  await db("meeting_recordings")
    .insert({
      meeting_document_id: observation.meetingDocumentId,
      state: reading.state,
      clip_id: observation.clipId,
      media_id: reading.mediaId,
      media_url: reading.mediaUrl,
      duration_ms: reading.durationMs,
      index_point_count: reading.indexPointCount,
      observed_sha256: observation.observedSha256,
      first_checked_at: observation.observedAt,
      last_checked_at: observation.observedAt,
      checks: 1,
      last_error: reading.lastError,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict("meeting_document_id")
    .merge({
      state: db.raw("excluded.state"),
      clip_id: db.raw("excluded.clip_id"),
      media_id: db.raw("excluded.media_id"),
      media_url: db.raw("excluded.media_url"),
      duration_ms: db.raw("excluded.duration_ms"),
      index_point_count: db.raw("excluded.index_point_count"),
      observed_sha256: db.raw("excluded.observed_sha256"),
      last_checked_at: db.raw("excluded.last_checked_at"),
      last_error: db.raw("excluded.last_error"),
      checks: db.raw("meeting_recordings.checks + 1"),
      updated_at: db.fn.now(),
    });
}

// ---------------------------------------------------------------------------
// Re-fetch policy
// ---------------------------------------------------------------------------

/**
 * True when this document's player page need not be fetched again.
 *
 * The gate lives in `discover`, the first stage with a database connection, for
 * the reason the transcript gate gives: this host sends no ETag on these paths, so
 * every re-check is a full download of roughly 76 KB at one request per ten
 * seconds. 1,135 clips is about 86 MB and 3.2 hours of wall clock for one pass,
 * and the player page for a 2015 meeting will never change again.
 *
 * Settled means `available` on a meeting more than {@link RECORDING_SETTLE_DAYS}
 * in the past. `unreadable` is never settled.
 */
export async function recordingFetchSettled(
  db: Knex,
  meetingDocumentId: string,
  meetingDate: string,
  now: Date,
  settleDays: number = RECORDING_SETTLE_DAYS,
): Promise<boolean> {
  const row: unknown = await db("meeting_recordings")
    .where({ meeting_document_id: meetingDocumentId })
    .first("state");
  if (!isRecord(row) || row.state !== "available") return false;
  const settledAfter = new Date(`${meetingDate}T00:00:00Z`).getTime() + settleDays * 86_400_000;
  return Number.isFinite(settledAfter) && now.getTime() > settledAfter;
}
