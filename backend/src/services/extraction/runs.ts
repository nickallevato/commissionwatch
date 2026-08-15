import type { Knex } from "knex";
import type { ChunkFailureReason, ExtractionOutcome, FailedChunk } from "./extractor";

/**
 * Reading and writing `extraction_runs`.
 *
 * The point of this module is that an extraction which produced no claims must
 * be able to say WHY. "0 claims" covers a meeting where nobody voted, a model
 * that was throttled on every chunk, a model that quietly stopped being free,
 * and a proxy that hung up while the work carried on — and those need four
 * different responses from an operator.
 */

export type ExtractionRunStatus = "running" | "succeeded" | "partial" | "failed";

/**
 * How much of the document went unread, and why — from the row alone.
 *
 * Derived on read rather than stored, so it is right for rows written before
 * the taxonomy existed as well as after it. The question an operator actually
 * has is "what fraction of this document did we not read", and answering it
 * used to require opening a log and counting error strings by eye.
 */
export interface ExtractionFailureSummary {
  chunks: number;
  failed: number;
  /** failed / chunks, to three decimals. 0 when the run had no chunks. */
  unread_fraction: number;
  /** A tally, not prose. `unclassified` is a row written before the taxonomy. */
  by_reason: Partial<Record<ChunkFailureReason | "unclassified", number>>;
  /**
   * At least one chunk was refused by the model's content filter.
   *
   * Surfaced on its own because it is a different statement from "some of this
   * failed": "this document could not be read by the model" is a fact the
   * status page can state, and it is not fixed by waiting, retrying, or a
   * larger token ceiling.
   */
  refused: boolean;
  /**
   * Claims salvaged out of the chunks that failed.
   *
   * Non-zero means the unread fraction overstates the loss: a truncated reply
   * was cut off *after* emitting complete, verifiable claims. Stated separately
   * rather than folded into the fraction, because the tail of that chunk still
   * went unread and rounding it away is the optimistic lie.
   */
  recovered: number;
}

export interface ExtractionRun {
  id: string;
  meeting_id: string;
  artifact_sha256: string | null;
  model: string | null;
  served_models: string[];
  prompt_version: string | null;
  chunks: number;
  proposed: number;
  verified: number;
  stored: number;
  rejected: Array<{ reason: string; detail: string }>;
  failed_chunks: FailedChunk[];
  status: ExtractionRunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** Computed from `chunks` and `failed_chunks`. Never stored. */
  failure_summary: ExtractionFailureSummary;
}

/**
 * Every failure reason, as data.
 *
 * Keyed by the union, so adding a member to `ChunkFailureReason` and forgetting
 * it here fails to compile. `asReason` below has to list them a second time to
 * narrow a `jsonb` string without a cast; the test walks these keys through it,
 * which is what keeps the two lists from drifting.
 */
export const CHUNK_FAILURE_REASONS: Record<ChunkFailureReason, true> = {
  "upstream-error": true,
  truncated: true,
  refused: true,
  "reasoning-only": true,
  "no-choices": true,
  "malformed-payload": true,
  "empty-content": true,
  "request-failed": true,
  "unreadable-reply": true,
  "truncated-reply": true,
};

/**
 * A stored status.
 *
 * The column has a CHECK constraint listing exactly these four, so anything
 * else means the row was written by something that is not this application —
 * and `failed` is the honest reading of a row we cannot interpret. This
 * replaced a bare cast, which asserted the constraint held rather than checking.
 */
function toStatus(value: unknown): ExtractionRunStatus {
  switch (value) {
    case "running":
    case "succeeded":
    case "partial":
    case "failed":
      return value;
    default:
      return "failed";
  }
}

/** A stored reason string, or null for anything this version does not know. */
export function asReason(value: unknown): ChunkFailureReason | null {
  switch (value) {
    case "upstream-error":
    case "truncated":
    case "refused":
    case "reasoning-only":
    case "no-choices":
    case "malformed-payload":
    case "empty-content":
    case "request-failed":
    case "unreadable-reply":
    case "truncated-reply":
      return value;
    default:
      return null;
  }
}

/**
 * How a finished run should be labelled.
 *
 * A run with failed chunks is `partial`, never `succeeded`, even when it stored
 * claims — some part of the document was never read, and a reviewer looking at
 * the claims list has no way to see that from the claims alone. If EVERY chunk
 * failed **and none of them yielded a claim**, there is no evidence the document
 * was read at all, so that is `failed`, not `partial`.
 *
 * That second clause was added on 2026-08-15, after the corpus was measured for
 * the first time. Every failed chunk in it was a `truncated-reply`, and a
 * one-chunk document — which most of the archive is — therefore landed
 * `failed` while holding verified, stored claims out of the very bytes it was
 * said not to have read. Worse, `stage.ts` throws on `failed` so the queue
 * retries: a deterministic truncation burned five attempts of a per-minute
 * rate-limited free tier and ended `failed` anyway, on four of ten documents.
 * The rule is unchanged in substance — "no evidence the document was read" —
 * and salvaged claims are exactly that evidence.
 *
 * The diagnosis taxonomy did not change this rule, deliberately. A refusal is a
 * chunk that went unread exactly like a truncation or a 429 does, and the four
 * statuses are constrained by a CHECK in migration 073 and rendered by an
 * operator console — a fifth value would be a schema and a UI change carrying
 * information the row already holds. What distinguishes a refusal is
 * `failure_summary.refused` and the `by_reason` tally, which is where "this
 * document could not be read by the model" is stated.
 */
export function classifyExtraction(outcome: ExtractionOutcome): ExtractionRunStatus {
  const failed = outcome.failedChunks.length;
  if (failed === 0) return "succeeded";
  if (outcome.chunks > 0 && failed >= outcome.chunks && recoveredFrom(outcome.failedChunks) === 0) {
    return "failed";
  }
  return "partial";
}

/**
 * Claims salvaged out of chunks that failed.
 *
 * A `truncated-reply` is a reply that arrived, was cut off, and had complete
 * claims recovered from the part before the cut. Those claims are verified
 * against the document like any other and are stored — so a document they came
 * from was demonstrably read in part, whatever the chunk tally says.
 *
 * Legacy rows carry `null` here and count as zero, which preserves the old
 * classification for every run written before the field existed.
 */
export function recoveredFrom(failed: FailedChunk[]): number {
  return failed.reduce((total, chunk) => total + (chunk.recovered ?? 0), 0);
}

export async function startRun(db: Knex, meetingId: string): Promise<string> {
  const inserted: unknown = await db("extraction_runs")
    .insert({ meeting_id: meetingId, status: "running" })
    .returning("id");
  const row: unknown = Array.isArray(inserted) ? inserted[0] : undefined;
  if (typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string") {
    return (row as { id: string }).id;
  }
  throw new Error("extraction_runs insert returned no id");
}

export interface FinishRunInput {
  artifactSha256: string | null;
  outcome: ExtractionOutcome;
  stored: number;
}

export async function finishRun(db: Knex, runId: string, input: FinishRunInput): Promise<void> {
  const { outcome } = input;
  await db("extraction_runs")
    .where({ id: runId })
    .update({
      artifact_sha256: input.artifactSha256,
      model: outcome.model,
      served_models: outcome.served_models,
      prompt_version: outcome.prompt_version,
      chunks: outcome.chunks,
      proposed: outcome.proposed,
      verified: outcome.result.verified.length,
      stored: input.stored,
      rejected: JSON.stringify(
        outcome.result.rejected.map((entry) => ({ reason: entry.reason, detail: entry.detail })),
      ),
      failed_chunks: JSON.stringify(outcome.failedChunks),
      status: classifyExtraction(outcome),
      finished_at: db.fn.now(),
    });
}

/** Record a run that died before producing an outcome, with its message intact. */
export async function failRun(db: Knex, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db("extraction_runs")
    .where({ id: runId })
    .update({ status: "failed", error: message, finished_at: db.fn.now() });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One stored failure, validated rather than asserted.
 *
 * `failed_chunks` is `jsonb`: what comes back is whatever some earlier version
 * of this code wrote, and rows written before the diagnosis existed carry only
 * `{ index, error }`. Those read back with nulls in the new fields and are
 * tallied as `unclassified` — which is the truth about them, and is why
 * widening this column needed no migration.
 */
export function toFailedChunk(value: unknown): FailedChunk | null {
  if (!isRecord(value)) return null;
  const index = typeof value.index === "number" && Number.isFinite(value.index) ? value.index : null;
  const error = typeof value.error === "string" ? value.error : null;
  if (index === null || error === null) return null;
  return {
    index,
    error,
    reason: asReason(value.reason),
    finish_reason: asText(value.finish_reason),
    native_finish_reason: asText(value.native_finish_reason),
    recovered:
      typeof value.recovered === "number" && Number.isFinite(value.recovered)
        ? value.recovered
        : null,
  };
}

function toRejected(value: unknown): { reason: string; detail: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.reason !== "string") return null;
  return { reason: value.reason, detail: typeof value.detail === "string" ? value.detail : "" };
}

/** The unread fraction and its breakdown, from the row's own columns. */
export function summariseFailures(chunks: number, failed: FailedChunk[]): ExtractionFailureSummary {
  const by_reason: ExtractionFailureSummary["by_reason"] = {};
  for (const chunk of failed) {
    const key = chunk.reason ?? "unclassified";
    by_reason[key] = (by_reason[key] ?? 0) + 1;
  }
  return {
    chunks,
    failed: failed.length,
    unread_fraction: chunks > 0 ? Math.round((failed.length / chunks) * 1000) / 1000 : 0,
    by_reason,
    refused: failed.some((chunk) => chunk.reason === "refused"),
    recovered: recoveredFrom(failed),
  };
}

function toRun(row: Record<string, unknown>): ExtractionRun {
  const asArray = <T>(value: unknown, read: (entry: unknown) => T | null): T[] =>
    Array.isArray(value)
      ? value.map(read).filter((entry): entry is T => entry !== null)
      : [];
  const chunks = Number(row.chunks ?? 0);
  const failed_chunks = asArray(row.failed_chunks, toFailedChunk);
  return {
    id: String(row.id),
    meeting_id: String(row.meeting_id),
    artifact_sha256: typeof row.artifact_sha256 === "string" ? row.artifact_sha256 : null,
    model: typeof row.model === "string" ? row.model : null,
    served_models: asArray(row.served_models, (entry) =>
      typeof entry === "string" ? entry : null,
    ),
    prompt_version: typeof row.prompt_version === "string" ? row.prompt_version : null,
    chunks,
    proposed: Number(row.proposed ?? 0),
    verified: Number(row.verified ?? 0),
    stored: Number(row.stored ?? 0),
    rejected: asArray(row.rejected, toRejected),
    failed_chunks,
    status: toStatus(row.status),
    error: typeof row.error === "string" ? row.error : null,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    finished_at:
      row.finished_at instanceof Date
        ? row.finished_at.toISOString()
        : typeof row.finished_at === "string"
          ? row.finished_at
          : null,
    failure_summary: summariseFailures(chunks, failed_chunks),
  };
}

export async function listRuns(db: Knex, meetingId: string, limit = 10): Promise<ExtractionRun[]> {
  const rows: unknown = await db("extraction_runs")
    .where({ meeting_id: meetingId })
    .orderBy("started_at", "desc")
    .limit(Math.min(Math.max(limit, 1), 50));
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map(toRun);
}

/** True when this meeting already has an extraction in flight. */
export async function isExtracting(db: Knex, meetingId: string): Promise<boolean> {
  const row: unknown = await db("extraction_runs")
    .where({ meeting_id: meetingId, status: "running" })
    .first("id");
  return typeof row === "object" && row !== null;
}
