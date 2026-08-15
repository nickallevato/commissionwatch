import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { readGranicusPlayer } from "./ingestion/granicus-player";
import { COMMISSIONWATCH_USER_AGENT } from "./ingestion/adapters/http";

/**
 * Proving that a published recording length was read out of the bytes we say it
 * was.
 *
 * The audio spec asked for a reproducibility manifest — engine, weights hash,
 * decode parameters — so that a stranger could regenerate a transcript and check
 * it. There is no transcript: the media is not obtainable by acceptable means
 * (probed 2026-08-15; the CDN answers a browser string and refuses this project's
 * honest user agent), so nothing was transcribed. But the underlying demand
 * survives the feature that prompted it, and it is the demand this project is
 * built on: **a claim about a public body must be checkable by someone who does
 * not trust us.**
 *
 * `meeting_recordings` makes exactly one class of claim — *the custodian published
 * a recording of this meeting, this long, under this media id* — and this module
 * is the check on it, at two independent levels.
 *
 * **Offline, against our own store.** For each row: the newest artifact of that
 * document is downloaded, hashed, and re-read by the same pure parser the fetch
 * handler used. Four things must agree — the stored bytes hash to what `artifacts`
 * says, `artifacts.sha256` is the sha the row names, and the duration, media id
 * and media URL re-derive to the values in the columns. A row that passes cannot
 * have had its duration typed in, edited by a later migration, or salvaged from a
 * different clip's page.
 *
 * **Online, by anyone.** Every result carries the one-line command that
 * reproduces the hash from the custodian's own server. The page is byte-stable —
 * clip 2775 fetched twice seven minutes apart hashed identically — so this is a
 * real check and not an approximation, and it runs against Granicus rather than
 * against us, which is the half that matters.
 *
 * What this does **not** claim, stated here rather than left to be discovered: it
 * says nothing about the recording's contents. We have not heard the recording and
 * cannot obtain it. The verified claim is precisely that a page published by the
 * custodian, at a hash anyone can reproduce, states this length for this media id.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an artifact's stored bytes by storage key.
 *
 * A port, so the check is testable with no object store — the same arrangement
 * `ArtifactWriter` has on the write side. The script passes `downloadDocument`.
 */
export type ReadStoredArtifact = (storageKey: string) => Promise<Uint8Array>;

export interface RecordingVerification {
  meeting_document_id: string;
  clip_id: string;
  /** The page URL, so the reproduction command names a real address. */
  page_url: string;
  /** What the row says it read. */
  observed_sha256: string;
  /** What the newest stored artifact actually hashes to, or null if none is held. */
  stored_sha256: string | null;
  duration_ms: number;
  /** Empty when the row verified. Each entry names one disagreement. */
  problems: string[];
  /** The command a stranger runs to check the hash against the custodian. */
  reproduce: string;
}

/** The command that reproduces `observed_sha256` from the custodian's server. */
export function reproduceCommand(pageUrl: string): string {
  return `curl -sSL -A '${COMMISSIONWATCH_USER_AGENT}' '${pageUrl}' | sha256sum`;
}

export interface VerifyOptions {
  /** Rows to check. Every row by default; the corpus is one page per meeting. */
  limit?: number;
  /** Restrict to one meeting document, for checking a single reported row. */
  meetingDocumentId?: string;
}

/**
 * Re-derives every `available` recording's facts from the bytes it names.
 *
 * Only `available` rows are checked, because they are the only ones that assert
 * anything about the record. An `unreadable` row asserts that *we* failed, which
 * is a claim about us and needs no independent verification to be safe to publish.
 */
export async function verifyRecordings(
  db: Knex,
  read: ReadStoredArtifact,
  options: VerifyOptions = {},
): Promise<RecordingVerification[]> {
  const query = db("meeting_recordings as mr")
    .join("meeting_documents as md", "md.id", "mr.meeting_document_id")
    .where("mr.state", "available")
    .orderBy("mr.last_checked_at", "desc")
    .select(
      "mr.meeting_document_id",
      "mr.clip_id",
      "mr.media_id",
      "mr.media_url",
      "mr.duration_ms",
      "mr.index_point_count",
      "mr.observed_sha256",
      "md.url as page_url",
      // The newest version's artifact. `document_versions` can hold several
      // versions of one document, and only the newest is the page we currently
      // stand behind — checking an older one would report a disagreement that is
      // really a supersession.
      db.raw(`(
        select a.sha256 from document_versions dv
          join artifacts a on a.id = dv.artifact_id
         where dv.meeting_document_id = mr.meeting_document_id
         order by dv.version_no desc limit 1
      ) as artifact_sha256`),
      db.raw(`(
        select a.storage_key from document_versions dv
          join artifacts a on a.id = dv.artifact_id
         where dv.meeting_document_id = mr.meeting_document_id
         order by dv.version_no desc limit 1
      ) as storage_key`),
    );
  if (options.meetingDocumentId !== undefined) {
    query.where("mr.meeting_document_id", options.meetingDocumentId);
  }
  if (options.limit !== undefined) query.limit(options.limit);

  const rows: unknown = await query;
  const results: RecordingVerification[] = [];

  for (const row of (Array.isArray(rows) ? rows : []).filter(isRecord)) {
    const observedSha = String(row.observed_sha256);
    const pageUrl = String(row.page_url);
    const durationMs = Number(row.duration_ms);
    const problems: string[] = [];
    let storedSha: string | null = null;

    const artifactSha = typeof row.artifact_sha256 === "string" ? row.artifact_sha256 : null;
    const storageKey = typeof row.storage_key === "string" ? row.storage_key : null;

    if (artifactSha === null || storageKey === null) {
      // The row stands on bytes we no longer hold. Not a fabrication, but not
      // independently checkable either, and the difference has to be visible.
      problems.push("no stored artifact for this document; the row cannot be re-derived");
    } else {
      if (artifactSha !== observedSha) {
        problems.push(
          `row names ${observedSha.slice(0, 12)} but the newest stored artifact is ${artifactSha.slice(0, 12)}`,
        );
      }
      let bytes: Uint8Array | null = null;
      try {
        bytes = await read(storageKey);
      } catch (error) {
        problems.push(
          `stored bytes unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (bytes !== null) {
        storedSha = createHash("sha256").update(bytes).digest("hex");
        if (storedSha !== artifactSha) {
          problems.push(
            `stored bytes hash to ${storedSha.slice(0, 12)}, but artifacts says ${artifactSha.slice(0, 12)}`,
          );
        }
        const reading = readGranicusPlayer(bytes);
        if (reading.facts === null) {
          problems.push(`the stored page no longer reads: ${reading.error ?? "unknown"}`);
        } else {
          if (reading.facts.durationMs !== durationMs) {
            problems.push(
              `duration re-derives to ${reading.facts.durationMs}ms, row says ${durationMs}ms`,
            );
          }
          if (reading.facts.mediaId !== row.media_id) {
            problems.push(
              `media id re-derives to ${reading.facts.mediaId}, row says ${String(row.media_id)}`,
            );
          }
          if (reading.facts.mediaUrl !== row.media_url) {
            problems.push("media url re-derives to a different address than the row states");
          }
          if (reading.facts.indexPointCount !== Number(row.index_point_count)) {
            problems.push(
              `index points re-derive to ${reading.facts.indexPointCount}, ` +
                `row says ${String(row.index_point_count)}`,
            );
          }
        }
      }
    }

    results.push({
      meeting_document_id: String(row.meeting_document_id),
      clip_id: String(row.clip_id),
      page_url: pageUrl,
      observed_sha256: observedSha,
      stored_sha256: storedSha,
      duration_ms: durationMs,
      problems,
      reproduce: reproduceCommand(pageUrl),
    });
  }

  return results;
}
