/**
 * Reading the custodian's video-player page.
 *
 * Pure: bytes in, facts out, no I/O and no database handle. That is what lets the
 * fetch handler call it on the bytes it already holds and a verification script
 * call it on the bytes we stored months ago, with no second implementation to
 * drift — the same arrangement `webvtt.ts` has with `transcripts.ts`.
 *
 * ## Why we read this page at all
 *
 * We would rather have the recording. We cannot have it: probed 2026-08-15,
 * `archive-video.granicus.com` answers a Chrome user-agent string with
 * `200 content-length: 6008707697` and answers this project's honest, contactable
 * user agent with `403`. Obtaining the media would mean claiming to be a browser.
 * That is the line, so the media is not fetched and this page is read instead.
 *
 * The page is on `bozeman.granicus.com`, which this project already fetches under
 * the vendor-robots exception of 2026-08-04, at one request every ten seconds with
 * a user agent that names the project. It is the same posture as an agenda.
 *
 * ## What the page actually contains — probed, not assumed
 *
 * Four clips read on 2026-08-15 (2775, 2786, 2325, 1301), all four carrying all
 * three markers:
 *
 *   <script>video_url="https://archive-stream.granicus.com/OnDemand/_definst_/
 *           mp4:archive/bozeman/bozeman_a1f0657c-….mp4/playlist.m3u8"</script>
 *   let maxValInSec = 22788;
 *   cuepoints: [{"time":100,"type":"Agenda","id":"132727"}, …]
 *
 * `maxValInSec` is the ceiling the page puts on its own embed end-time input, i.e.
 * the length of the clip. That reading is corroborated rather than assumed: clip
 * 2325 states 1678 seconds, and the caption file stored for the same clip at
 * `test/fixtures/bozeman-granicus/captions-clip2325.vtt` ends its final cue at
 * 1676 seconds. Two seconds apart, from two independent documents.
 *
 * The page is also byte-stable — clip 2775 fetched twice, seven minutes apart,
 * hashed identically — which is what makes `meeting_recordings.observed_sha256` a
 * hash a stranger can reproduce rather than a hash of whatever we happened to get.
 */

/** Markers that identify a Granicus player page, in the order they are needed. */
const VIDEO_URL = /\bvideo_url\s*=\s*"([^"]+)"/;
const MAX_VAL_IN_SEC = /\bmaxValInSec\s*=\s*(\d{1,9})\b/;
const CUEPOINTS = /\bcuepoints\s*:\s*\[([^\]]*)\]/;
const CUEPOINT_ENTRY = /"time"\s*:\s*\d+/g;

/**
 * The media file's own name, out of the stream URL's path.
 *
 * Read from the URL rather than pattern-matched as a GUID: the tenant prefix and
 * the id format are the vendor's business, and a regex asserting `bozeman_` plus
 * thirty-six hex characters would silently stop matching the day either changes,
 * which is the failure mode this parser is written to avoid.
 */
export function granicusMediaId(mediaUrl: string): string | null {
  const match = /\/([^/]+)\.mp4(?:\/|$)/.exec(mediaUrl);
  const id = match?.[1];
  return id === undefined || id === '' ? null : id;
}

export interface GranicusPlayerFacts {
  /** e.g. `bozeman_a1f0657c-7758-43c1-bb2c-a8450f107cb3`. */
  mediaId: string;
  /** The stream URL verbatim, as the custodian publishes it. */
  mediaUrl: string;
  /** Clip length in milliseconds, from the page's own embed ceiling. */
  durationMs: number;
  /** Agenda cue points the custodian published. Zero is a real answer. */
  indexPointCount: number;
}

export interface GranicusPlayerReading {
  /** Non-null exactly when `error` is null. */
  facts: GranicusPlayerFacts | null;
  /** Non-null exactly when `facts` is null. Operator-facing, names what was missing. */
  error: string | null;
}

/** The first bytes of a response, for an error message a human can act on. */
function firstBytes(bytes: Uint8Array, limit = 60): string {
  return JSON.stringify(new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, limit)));
}

/**
 * True when these bytes look like a Granicus player page.
 *
 * Decided on the bytes and never on the Content-Type, for the reason
 * `document-text.ts` gives and Gallatin proved: a header is only what a server
 * claims about itself. A vendor error page is HTML too, so the signature is the
 * page's own player markup rather than `<html>`.
 */
export function looksLikeGranicusPlayer(bytes: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return VIDEO_URL.test(text) && MAX_VAL_IN_SEC.test(text);
}

/**
 * What one player page states about its recording.
 *
 * Returns a reading rather than throwing, deliberately unlike `parseWebVttCues`.
 * The difference is what a failure would mean. A caption file that will not parse
 * is a record with a hole in it, and skipping the bad cue would publish a
 * transcript that reads exactly like a complete one — so that throws. A player
 * page we cannot read yields no record at all: nothing is dropped, nothing is
 * silently shortened, and the honest output is a row saying we looked and could
 * not read it, with the reason attached. A throw there would put the same fact in
 * `ingestion_jobs.last_error` where the coverage query cannot see it.
 *
 * Nothing here is inferred. A page missing any of the three markers produces an
 * error naming which, never a partial row with a guessed duration — a recording
 * whose length we made up is worse than one whose length we do not publish.
 */
export function readGranicusPlayer(bytes: Uint8Array): GranicusPlayerReading {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  const mediaUrl = VIDEO_URL.exec(text)?.[1];
  if (mediaUrl === undefined) {
    return {
      facts: null,
      error:
        `no video_url in ${bytes.length} bytes beginning ${firstBytes(bytes)}` +
        ' — not a Granicus player page, or the page changed',
    };
  }

  const mediaId = granicusMediaId(mediaUrl);
  if (mediaId === null) {
    return { facts: null, error: `video_url names no media file: ${mediaUrl}` };
  }

  const seconds = MAX_VAL_IN_SEC.exec(text)?.[1];
  if (seconds === undefined) {
    return {
      facts: null,
      error: `no maxValInSec on the player page for ${mediaId}; the recording's length is unstated`,
    };
  }
  const durationMs = Number(seconds) * 1000;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    // A live stream reports zero. It is a real answer to a different question,
    // and recording it as a length would publish a meeting of no duration.
    return { facts: null, error: `player page states a length of ${seconds}s for ${mediaId}` };
  }

  // Absent cuepoints are zero rather than an error: a custodian who indexed no
  // agenda items has told us something true about this recording.
  const block = CUEPOINTS.exec(text)?.[1] ?? '';
  const indexPointCount = block.match(CUEPOINT_ENTRY)?.length ?? 0;

  return { facts: { mediaId, mediaUrl, durationMs, indexPointCount }, error: null };
}

/**
 * A recording's length in the only form this project renders it.
 *
 * Media time, spelled out. Never a clock time and never a range of them: the
 * offset between a recording's start and the meeting's is published nowhere and
 * varies per clip — 29:38 for clip 2775, 01:44 for 2786 — so a duration converted
 * to "the meeting ran until 9:47pm" would be an invention with a timestamp on it.
 */
export function formatRecordingLength(durationMs: number): string {
  const total = Math.max(Math.round(durationMs / 1000), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
