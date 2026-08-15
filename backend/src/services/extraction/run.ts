import type { Knex } from "knex";
import { extractPdfText, looksLikePdf } from "../ingestion/pdf-text";
import { OpenRouterClient } from "./openrouter";
import {
  extractClaims,
  persistClaims,
  pruneDisallowedClaims,
  type ExtractionOutcome,
} from "./extractor";
import { failRun, finishRun, startRun, summariseFailures } from "./runs";

/**
 * Extract one meeting's minutes, end to end.
 *
 * Deliberately a service rather than a CLI script. The lesson cost this project
 * a live outage: `npm run sweep` is `tsx src/scripts/sweep.ts`,
 * `backend/Dockerfile` copies `dist/` and `migrations/` and never `src/`, and
 * so the only lever for enabling a source did not exist inside the container.
 * An operator action that cannot be taken on the deployment is not an operator
 * action.
 *
 * It is no longer called *from a request*. `services/extraction/stage.ts` runs
 * it as the queue's `extract` stage, so the work owns an `ingestion_jobs` row
 * and survives a restart. That is why the bytes arrive as an argument: the
 * worker has already resolved the content address and loaded them, and this
 * module keeps no way to read anything else.
 *
 * Reads stored bytes only. Nothing here reaches the source — the artifact was
 * fetched by the `fetch` stage, is addressed by its hash, and is what the
 * citations will point at.
 */

export class ExtractionUnavailable extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExtractionUnavailable";
  }
}

export interface MinutesArtifact {
  sha256: string;
  content_type: string | null;
  /** The source whose sweep captured these bytes. The enqueuer needs it. */
  source_id: string;
}

/**
 * The minutes for a meeting, or null.
 *
 * Chosen by `meeting_documents.document_type`, not by guessing at the newest
 * artifact: an agenda and a set of minutes for the same meeting are both PDFs
 * from the same host, and extracting officials' votes from an *agenda* would
 * produce claims about things that had not happened yet.
 *
 * It also carries back the source, because `ingestion_runs.source_id` is NOT
 * NULL and an `extract` job needs a run to belong to. The parse job that
 * captured the bytes already knows which source they came from, so the answer
 * is joined out of the queue rather than guessed from the jurisdiction — the
 * same reasoning `reparseMeeting` uses.
 */
export async function findMinutesArtifact(
  db: Knex,
  meetingId: string,
): Promise<MinutesArtifact | null> {
  const row: unknown = await db("ingestion_jobs as j")
    .join("artifacts as a", db.raw("a.sha256 = j.target ->> 'sha256'"))
    .join("ingestion_runs as r", "j.run_id", "r.id")
    .where("j.stage", "parse")
    .whereRaw("j.target ->> 'meetingId' = ?", [meetingId])
    .whereRaw("lower(coalesce(j.target ->> 'documentType', '')) = 'minutes'")
    .orderBy("j.created_at", "desc")
    .first("a.sha256 as sha256", "a.content_type as content_type", "r.source_id as source_id");

  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.sha256 !== "string" || typeof value.source_id !== "string") return null;
  return {
    sha256: value.sha256,
    content_type: typeof value.content_type === "string" ? value.content_type : null,
    source_id: value.source_id,
  };
}

export interface RunExtractionDeps {
  db: Knex;
  client: OpenRouterClient;
}

/** The bytes to read, already resolved and loaded by the worker. */
export interface StoredMinutes {
  meetingId: string;
  /** Content address of those bytes. Every citation is recorded against it. */
  sha256: string;
  contentType: string | null;
  bytes: Buffer;
}

export interface RunExtractionResult {
  /** The `extraction_runs` row this attempt wrote. */
  run_id: string;
  meeting_id: string;
  artifact_sha256: string;
  outcome: ExtractionOutcome;
  stored: number;
}

/**
 * Run the extractor over a meeting's minutes and store what survives.
 *
 * Every failure here is a distinct, stated condition rather than an empty
 * result: "no minutes have been fetched for this meeting" and "the model was
 * rate-limited" and "nothing in the document could be verified" are three
 * different facts, and collapsing them into "0 claims" is how a transparency
 * project ends up quietly asserting that a meeting had no votes.
 */
export async function runExtraction(
  deps: RunExtractionDeps,
  minutes: StoredMinutes,
): Promise<RunExtractionResult> {
  const runId = await startRun(deps.db, minutes.meetingId);
  try {
    const result = await extractOnce(deps, minutes);
    await finishRun(deps.db, runId, {
      artifactSha256: result.artifact_sha256,
      outcome: result.outcome,
      stored: result.stored,
    });
    reportUnread(runId, result.outcome);
    return { ...result, run_id: runId };
  } catch (error) {
    // Recorded before rethrowing. The caller may be a background task with
    // nobody listening — that is exactly the case this row exists for.
    await failRun(deps.db, runId, error);
    throw error;
  }
}

/**
 * Say out loud how much of the document went unread.
 *
 * The row carries this either way; the line exists because the console is where
 * an operator watches a live extraction, and "9 chunks, 0 claims" was for
 * months the only thing they saw. A refusal gets its own sentence: it is the
 * one outcome that no retry, no larger ceiling and no waiting will change.
 */
function reportUnread(runId: string, outcome: ExtractionOutcome): void {
  const summary = summariseFailures(outcome.chunks, outcome.failedChunks);
  if (summary.failed === 0) return;
  const breakdown = Object.entries(summary.by_reason)
    .map(([reason, count]) => `${reason}=${count}`)
    .sort()
    .join(" ");
  console.log(
    `Extraction ${runId}: ${summary.failed}/${summary.chunks} chunks unread ` +
      `(${Math.round(summary.unread_fraction * 100)}%) — ${breakdown}`,
  );
  if (summary.refused) {
    console.log(`Extraction ${runId}: the model refused part of this document; it was not read.`);
  }
}

async function extractOnce(
  deps: RunExtractionDeps,
  minutes: StoredMinutes,
): Promise<Omit<RunExtractionResult, "run_id">> {
  if (!deps.client.configured) {
    throw new ExtractionUnavailable(
      "OPENROUTER_API_KEY is not set on this deployment, so nothing was extracted.",
      503,
    );
  }

  const { meetingId, bytes } = minutes;
  if (!looksLikePdf(bytes)) {
    throw new ExtractionUnavailable(
      `The stored minutes artifact is not a PDF (content type ${minutes.contentType ?? "unknown"}).`,
      422,
    );
  }

  const { lines } = await extractPdfText(bytes);
  // Rejoined with newlines, which is the text the citations index into. The
  // verifier matches whitespace-insensitively for exactly this reason: a line
  // break here is an artefact of glyph positions, not of the record.
  const text = lines.join("\n");
  if (text.trim() === "") {
    // A scanned image of a page has no text layer. That is a real finding about
    // the document — and the honest answer is a records request, not an OCR
    // guess presented as a citation.
    throw new ExtractionUnavailable(
      "The minutes PDF carries no extractable text layer, so there is nothing to cite. " +
        "It is likely a scan; the records-request route is the way to obtain a text copy.",
      422,
    );
  }

  const outcome = await extractClaims(deps.client, { documentText: text });
  const persistOptions = { meetingId, artifactSha256: minutes.sha256 };
  const stored = await persistClaims(deps.db, outcome, persistOptions);
  // After storing, not before: a run that fails partway should not have
  // stripped claims it was about to replace.
  const pruned = await pruneDisallowedClaims(deps.db, persistOptions);
  if (pruned > 0) {
    console.log(`Extraction ${meetingId}: removed ${pruned} held claim(s) no longer permitted`);
  }

  return { meeting_id: meetingId, artifact_sha256: minutes.sha256, outcome, stored };
}
