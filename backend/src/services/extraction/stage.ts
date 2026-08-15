import type { Knex } from "knex";
import { BlockedError, type IngestionQueue } from "../ingestion/queue";
import type { ExtractContext, StageResult } from "../ingestion/worker";
import type { OpenRouterClient } from "./openrouter";
import { ExtractionUnavailable, findMinutesArtifact, runExtraction } from "./run";
import { classifyExtraction, summariseFailures } from "./runs";

/**
 * Extraction as a queue stage.
 *
 * It used to be `void runExtraction(...)` inside a request handler. That is an
 * unawaited promise owning nothing: a deploy or a restart mid-run lost the
 * work, and `extraction_runs` was left `running` forever because
 * `CHECK ((status = 'running') = (finished_at IS NULL))` makes an unfinished
 * row permanent. There was no concurrency control over a per-minute
 * rate-limited free tier, no backpressure, and no queue depth — so "how much of
 * the corpus is unread" was unanswerable.
 *
 * Everything this file needed already existed. `ingestion_jobs` gives restart
 * safety, retry with backoff, a visible `blocked` state and an error string the
 * public status page already reads. The route enqueues; the worker runs it.
 *
 * **Two ledgers, two questions.** `ingestion_jobs` records the work — was it
 * claimed, did it retry, is it stuck. `extraction_runs` records the model —
 * chunks, proposed, verified, stored, rejected, which models actually served.
 * Each attempt on the job writes its own run row, so a retried extraction has a
 * history rather than a rewritten one.
 */

/**
 * How many extract jobs may be in flight at once.
 *
 * One. The free tier is rate-limited *per minute*, and a set of minutes is
 * nine-ish chunks of sequential calls — two concurrent extractions do not go
 * twice as fast, they take turns being throttled and both record chunks as
 * unread. The unread fraction is the number this whole design exists to drive
 * down, and raising this knob is the fastest way to inflate it.
 *
 * It is the extraction worker's batch size, so raising it is one edit here and
 * nothing else.
 */
export const EXTRACT_CONCURRENCY = 1;

export interface ExtractHandlerDeps {
  client: OpenRouterClient;
}

/**
 * The `extract` stage handler.
 *
 * Failure classification is the point of the wrapper:
 *
 *  - `ExtractionUnavailable` is `blocked`. No key on the deployment, an
 *    artifact that is not a PDF, a scan with no text layer — none of those are
 *    fixed by trying again, and burning five attempts to discover that would
 *    hide the reason behind an "attempts exhausted" message.
 *  - A run where **every** chunk failed is thrown, so the queue retries it with
 *    backoff. That is the throttled case, and it is the one retrying does fix.
 *  - A partial run completes. Some of the document was read, the claims are
 *    stored, and `extraction_runs.failed_chunks` says what went unread. Failing
 *    the job would re-run the chunks that already worked.
 */
export function createExtractHandler(
  deps: ExtractHandlerDeps,
): (ctx: ExtractContext) => Promise<StageResult> {
  return async (ctx) => {
    let result;
    try {
      result = await runExtraction(
        { db: ctx.db, client: deps.client },
        {
          meetingId: ctx.target.meetingId,
          sha256: ctx.artifact.sha256,
          contentType: ctx.artifact.contentType,
          bytes: ctx.content,
        },
      );
    } catch (error) {
      if (error instanceof ExtractionUnavailable) {
        throw new BlockedError(error.message);
      }
      throw error;
    }

    const summary = summariseFailures(result.outcome.chunks, result.outcome.failedChunks);
    if (classifyExtraction(result.outcome) === "failed") {
      const breakdown = Object.entries(summary.by_reason)
        .map(([reason, count]) => `${reason}=${count}`)
        .sort()
        .join(" ");
      throw new Error(
        `Extraction run ${result.run_id} read none of ${summary.chunks} chunk(s): ${breakdown}`,
      );
    }

    return {
      counts: {
        extraction_claims_stored: result.stored,
        extraction_chunks_unread: summary.failed,
      },
    };
  };
}

export interface EnqueuedExtraction {
  job_id: string;
  /** The `ingestion_runs` row the job belongs to — the work ledger. */
  run_id: string;
  meeting_id: string;
  artifact_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The extract job already queued or running for this meeting, if there is one. */
export async function queuedExtraction(db: Knex, meetingId: string): Promise<string | null> {
  const row: unknown = await db("ingestion_jobs")
    .where("stage", "extract")
    .whereIn("status", ["pending", "running"])
    .whereRaw("target ->> 'meetingId' = ?", [meetingId])
    .first("id");
  if (!isRecord(row) || typeof row.id !== "string") return null;
  return row.id;
}

/**
 * Queue this meeting's minutes for extraction.
 *
 * A fresh `ingestion_runs` row per request, for `reparseMeeting`'s reason: the
 * original run is a record of what happened on a date, and reopening it to say
 * something else about that date is the mutation this project refuses
 * everywhere else.
 *
 * The source comes from the parse job that captured the bytes rather than from
 * the meeting's jurisdiction — `ingestion_runs.source_id` is NOT NULL, and the
 * queue already knows the answer without a second lookup that could disagree.
 */
export async function enqueueExtraction(
  db: Knex,
  queue: IngestionQueue,
  meetingId: string,
): Promise<EnqueuedExtraction> {
  const artifact = await findMinutesArtifact(db, meetingId);
  if (artifact === null) {
    throw new ExtractionUnavailable(
      "No minutes document has been fetched for this meeting. Minutes are a separate " +
        "document from the agenda, and a meeting can be ingested long before they are published.",
      404,
    );
  }

  const queued = await queuedExtraction(db, meetingId);
  if (queued !== null) {
    throw new ExtractionUnavailable(
      `An extraction of this meeting is already queued (job ${queued}).`,
      409,
    );
  }

  const inserted: unknown = await db("ingestion_runs")
    .insert({
      source_id: artifact.source_id,
      status: "running",
      counts: JSON.stringify({ extract_queued: 1 }),
    })
    .returning("id");
  const row: unknown = Array.isArray(inserted) ? inserted[0] : undefined;
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new ExtractionUnavailable("Could not open a run for the extraction", 500);
  }

  const jobId = await queue.enqueue(
    "extract",
    { sha256: artifact.sha256, meetingId },
    row.id,
  );

  return {
    job_id: jobId,
    run_id: row.id,
    meeting_id: meetingId,
    artifact_sha256: artifact.sha256,
  };
}
