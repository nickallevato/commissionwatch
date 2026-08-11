import type { Knex } from "knex";
import type { ExtractionOutcome } from "./extractor";

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
  failed_chunks: Array<{ index: number; error: string }>;
  status: ExtractionRunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * How a finished run should be labelled.
 *
 * A run with failed chunks is `partial`, never `succeeded`, even when it stored
 * claims — some part of the document was never read, and a reviewer looking at
 * the claims list has no way to see that from the claims alone. If EVERY chunk
 * failed there is no evidence the document was read at all, so that is
 * `failed`, not `partial`.
 */
export function classifyExtraction(outcome: ExtractionOutcome): ExtractionRunStatus {
  const failed = outcome.failedChunks.length;
  if (failed === 0) return "succeeded";
  if (outcome.chunks > 0 && failed >= outcome.chunks) return "failed";
  return "partial";
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

function toRun(row: Record<string, unknown>): ExtractionRun {
  const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    id: String(row.id),
    meeting_id: String(row.meeting_id),
    artifact_sha256: typeof row.artifact_sha256 === "string" ? row.artifact_sha256 : null,
    model: typeof row.model === "string" ? row.model : null,
    served_models: asArray<string>(row.served_models),
    prompt_version: typeof row.prompt_version === "string" ? row.prompt_version : null,
    chunks: Number(row.chunks ?? 0),
    proposed: Number(row.proposed ?? 0),
    verified: Number(row.verified ?? 0),
    stored: Number(row.stored ?? 0),
    rejected: asArray(row.rejected),
    failed_chunks: asArray(row.failed_chunks),
    status: String(row.status) as ExtractionRunStatus,
    error: typeof row.error === "string" ? row.error : null,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    finished_at:
      row.finished_at instanceof Date
        ? row.finished_at.toISOString()
        : typeof row.finished_at === "string"
          ? row.finished_at
          : null,
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
