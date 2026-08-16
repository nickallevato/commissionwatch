import type { Knex } from "knex";
import { BlockedError, type IngestionQueue } from "../ingestion/queue";
import type { ExtractContext, StageResult } from "../ingestion/worker";
import type { OpenRouterClient } from "./openrouter";
import { ExtractionUnavailable, findMinutesArtifact, runExtraction } from "./run";
import { classifyExtraction, hasSuccessfulExtraction, summariseFailures } from "./runs";

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
 *  - A run where **every** chunk failed *and none of them yielded a claim* is
 *    thrown, so the queue retries it with backoff. That is the throttled case,
 *    and it is the one retrying does fix.
 *
 *    The second clause arrived with the first corpus measurement (2026-08-15).
 *    Most of the archive is one chunk, every failure in the measured corpus was
 *    a `truncated-reply`, and three of those had already salvaged 86 to 127
 *    verified claims — so a one-chunk document classified `failed`, this line
 *    threw, and the queue retried a deterministic outcome five times against a
 *    per-minute rate-limited free tier before failing the job anyway. The
 *    claims were stored the whole time. See `classifyExtraction`.
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
        // Distinguishes "a third of the chunks went unread" from "a third were
        // cut short after yielding most of what they held" on the run ledger
        // the public status page reads.
        extraction_claims_salvaged: summary.recovered,
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

/**
 * The hard ceiling on an operator-triggered batch enqueue.
 *
 * `docs/STATUS.md` item 1f refused a batch route until extraction was a queue
 * stage rather than a loop in a request handler — that precondition is what
 * `enqueueExtraction` above and `EXTRACT_CONCURRENCY` exist for. This ceiling
 * is the second half: even queued, a run costs minutes against a
 * rate-limited free model, so a batch request states a bounded number and an
 * operator asking for more gets a 400 naming the ceiling, never a silent
 * clamp. Silently narrowing the request to "what we felt like doing" is
 * exactly the kind of quiet lie this project refuses everywhere else.
 */
export const MAX_EXTRACT_BATCH = 25;

/** Why a meeting was not enqueued by a batch request. */
export type BatchExtractionSkipReason = "already_queued" | "already_extracted" | "no_minutes_artifact";

export interface BatchExtractionSkip {
  meeting_id: string;
  reason: BatchExtractionSkipReason;
  detail: string;
}

export interface BatchExtractionResult {
  enqueued: EnqueuedExtraction[];
  skipped: BatchExtractionSkip[];
}

/**
 * Classifies an `ExtractionUnavailable` as a skip reason, or says it is not
 * one.
 *
 * `enqueueExtraction` throws 404 for "no minutes artifact" and 409 for
 * "already queued" — see `findMinutesArtifact` and `queuedExtraction` above.
 * Anything else it might one day throw (a 500 opening the run, say) is a
 * real failure, not a benign skip, and returning `null` here is what makes
 * the caller re-throw it instead of mislabelling it "already queued". A
 * batch route that relabels a failure as a skip is exactly the disclosure
 * bug this route exists to refuse.
 */
export function skipReasonFor(error: ExtractionUnavailable): BatchExtractionSkipReason | null {
  if (error.statusCode === 404) return "no_minutes_artifact";
  if (error.statusCode === 409) return "already_queued";
  return null;
}

/**
 * Queue up to `limit` meetings' minutes for extraction, oldest meeting first.
 *
 * A meeting is skipped, never silently dropped, for exactly one of three
 * reasons: it already has a finished run that read something
 * (`hasSuccessfulExtraction`), it already has an `extract` job pending or
 * running (`enqueueExtraction`'s own 409), or it has no stored minutes yet
 * (`enqueueExtraction`'s own 404). Every skip is returned with its reason —
 * a response naming only what succeeded is the failure mode this project
 * exists to refuse.
 *
 * Scans meetings oldest-first and stops as soon as `limit` have been
 * enqueued, so a corpus with a real backlog does not pay for meetings past
 * the point the request asked to reach. If nothing in the corpus is
 * eligible, every meeting scanned comes back in `skipped` — an honest, if
 * long, answer, not a truncated one.
 *
 * **How long, concretely.** `skipped` is bounded by how far into the backlog
 * the scan must walk to find `limit` eligible meetings, not by the corpus
 * size — but the worst case is real and worth stating rather than
 * discovering. When little or nothing is left to extract, the scan walks the
 * entire `meetings` table before giving up and every row becomes a `skipped`
 * entry. Against production's ~520 meetings that is several hundred entries
 * in one response.
 *
 * That is deliberate. The alternative — truncating the list — would report
 * "we skipped 25 meetings" when the true answer is 500, and a caller cannot
 * tell a short list from a shortened one. This is not measured against a
 * corpus of that size: the suite's fixtures are a handful of meetings per
 * test, so the number above is derived from the scan's shape and the corpus
 * count in `docs/STATUS.md`, not observed.
 *
 * Enqueues through `enqueueExtraction`, the single path that opens an
 * `ingestion_runs` row and puts a job on the queue. This function decides
 * *which* meetings to try and reports what happened; it never inserts a job
 * itself.
 */
export async function enqueueExtractionBatch(
  db: Knex,
  queue: IngestionQueue,
  limit: number,
): Promise<BatchExtractionResult> {
  const rows: unknown = await db("meetings")
    .orderBy([{ column: "date", order: "asc" }, { column: "id", order: "asc" }])
    .select<Array<{ id: string }>>("id");
  const meetingIds = Array.isArray(rows)
    ? rows
        .filter((row): row is { id: string } => isRecord(row) && typeof row.id === "string")
        .map((row) => row.id)
    : [];

  const enqueued: EnqueuedExtraction[] = [];
  const skipped: BatchExtractionSkip[] = [];

  for (const meetingId of meetingIds) {
    if (enqueued.length >= limit) break;

    if (await hasSuccessfulExtraction(db, meetingId)) {
      skipped.push({
        meeting_id: meetingId,
        reason: "already_extracted",
        detail: "This meeting already has a finished extraction run that read something.",
      });
      continue;
    }

    try {
      const result = await enqueueExtraction(db, queue, meetingId);
      enqueued.push(result);
    } catch (error) {
      if (error instanceof ExtractionUnavailable) {
        const reason = skipReasonFor(error);
        if (reason === null) throw error;
        skipped.push({ meeting_id: meetingId, reason, detail: error.message });
        continue;
      }
      throw error;
    }
  }

  return { enqueued, skipped };
}
