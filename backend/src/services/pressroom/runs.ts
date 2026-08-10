import type { Knex } from "knex";
import type { IngestionQueue } from "../ingestion/queue";
import { failuresIn, readCounts, recordsIn, type RunStatusValue } from "./sources";

/**
 * The run screen, and the re-parse action.
 *
 * Two of P2's decisions live here:
 *
 *  - **Partial failure stays green-with-a-red-row.** `outcome.headline` is the
 *    run's own status, unchanged. A run that parsed 34 of 37 documents is a
 *    success with a footnote, and collapsing it to "failed" would train the
 *    operator to stop reading the status at all — which is worse than having no
 *    status. The footnote is `failures[]`, every failed or blocked job with its
 *    error text as recorded.
 *  - **Re-parse without re-fetching.** Artifacts are content-addressed and the
 *    bytes are already held, so fixing the parser and replaying costs a county
 *    web server nothing. This is a *different action* from "sweep now" and is
 *    presented as one.
 *
 * The no-refetch guarantee is structural rather than promised: `parse` jobs
 * carry a `sha256`, `IngestionQueue.validateTarget` rejects a post-fetch target
 * carrying a `url`, and the parse handler is handed bytes by the worker. There
 * is no code path from `parse` back to the network to be careful about.
 */

export type JobStatusValue = "pending" | "running" | "done" | "failed" | "blocked";

export interface RunJobTallies {
  total: number;
  by_status: Record<JobStatusValue, number>;
  by_stage: Array<{ stage: string; status: string; count: number }>;
}

export interface RunFailure {
  id: string;
  stage: string;
  status: Extract<JobStatusValue, "failed" | "blocked">;
  attempts: number;
  last_error: string | null;
  target: unknown;
  next_attempt_at: string | null;
}

export interface RunDetail {
  run: {
    id: string;
    source_id: string;
    status: RunStatusValue;
    started_at: string;
    finished_at: string | null;
    counts: Record<string, number>;
    error: string | null;
  };
  source: { id: string; adapter_key: string; jurisdiction_name: string };
  jobs: RunJobTallies;
  failures: RunFailure[];
  outcome: { headline: RunStatusValue; records: number; failures: number };
}

const JOB_STATUSES: readonly JobStatusValue[] = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function asJobStatus(value: unknown): JobStatusValue | null {
  return JOB_STATUSES.find((status) => status === value) ?? null;
}

function asRunStatus(value: unknown): RunStatusValue {
  const statuses: readonly RunStatusValue[] = ["running", "succeeded", "partial", "failed"];
  return statuses.find((status) => status === value) ?? "failed";
}

/** jsonb, which arrives as an object or as a string depending on the driver. */
function readTarget(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** One run, its source, its job tallies, and every job that did not finish. */
export async function getRun(db: Knex, runId: string): Promise<RunDetail | null> {
  const raw: unknown = await db("ingestion_runs as r")
    .join("ingestion_sources as s", "r.source_id", "s.id")
    .join("jurisdictions as j", "s.jurisdiction_id", "j.id")
    .where("r.id", runId)
    .first(
      "r.id as id",
      "r.source_id as source_id",
      "r.status as status",
      "r.started_at as started_at",
      "r.finished_at as finished_at",
      "r.counts as counts",
      "r.error as error",
      "s.adapter_key as adapter_key",
      "j.name as jurisdiction_name",
    );
  if (!isRecord(raw)) return null;

  const startedAt = asIsoOrNull(raw.started_at);
  if (startedAt === null) return null;

  const counts = readCounts(raw.counts);
  const status = asRunStatus(raw.status);

  const jobRows: unknown = await db("ingestion_jobs")
    .where({ run_id: runId })
    .select("id", "stage", "status", "attempts", "last_error", "target", "next_attempt_at")
    .orderBy("created_at", "asc");

  const by_status: Record<JobStatusValue, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
  };
  const stageIndex = new Map<string, { stage: string; status: string; count: number }>();
  const failures: RunFailure[] = [];
  let total = 0;

  for (const row of Array.isArray(jobRows) ? jobRows : []) {
    if (!isRecord(row)) continue;
    total += 1;
    const stage = asString(row.stage, "unknown");
    const jobStatus = asJobStatus(row.status);
    if (jobStatus !== null) by_status[jobStatus] += 1;

    const key = `${stage}:${asString(row.status, "unknown")}`;
    const bucket = stageIndex.get(key);
    if (bucket) bucket.count += 1;
    else stageIndex.set(key, { stage, status: asString(row.status, "unknown"), count: 1 });

    if (jobStatus === "failed" || jobStatus === "blocked") {
      failures.push({
        id: asString(row.id),
        stage,
        status: jobStatus,
        attempts: asNumber(row.attempts, 0),
        // Verbatim. A truncated or prettified error is a failure the operator
        // cannot act on, which is the same as no error at all.
        last_error: typeof row.last_error === "string" ? row.last_error : null,
        target: readTarget(row.target),
        next_attempt_at: asIsoOrNull(row.next_attempt_at),
      });
    }
  }

  return {
    run: {
      id: asString(raw.id),
      source_id: asString(raw.source_id),
      status,
      started_at: startedAt,
      finished_at: asIsoOrNull(raw.finished_at),
      counts,
      error: typeof raw.error === "string" ? raw.error : null,
    },
    source: {
      id: asString(raw.source_id),
      adapter_key: asString(raw.adapter_key),
      jurisdiction_name: asString(raw.jurisdiction_name),
    },
    jobs: { total, by_status, by_stage: [...stageIndex.values()] },
    failures,
    // The headline is the status as recorded. `partial` stays `partial`.
    outcome: { headline: status, records: recordsIn(counts), failures: failuresIn(counts) },
  };
}

// ---------------------------------------------------------------------------
// Re-parse
// ---------------------------------------------------------------------------

export interface ReparseResult {
  run_id: string;
  enqueued: number;
}

export class ReparseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReparseError";
  }
}

interface ParseJobTarget {
  sha256: string;
  meetingId?: string;
  documentType?: string;
  metadata?: Record<string, unknown>;
}

/** Distinct parse targets behind a set of job rows, in the order first seen. */
function distinctParseTargets(rows: unknown): ParseJobTarget[] {
  const seen = new Set<string>();
  const targets: ParseJobTarget[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    const target = readTarget(row.target);
    if (!isRecord(target)) continue;
    const sha256 = asString(target.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256) || seen.has(sha256)) continue;
    seen.add(sha256);
    const next: ParseJobTarget = { sha256 };
    if (typeof target.meetingId === "string") next.meetingId = target.meetingId;
    if (typeof target.documentType === "string") next.documentType = target.documentType;
    if (isRecord(target.metadata)) next.metadata = target.metadata;
    targets.push(next);
  }
  return targets;
}

/**
 * Opens a run and queues one `parse` job per artifact.
 *
 * A new `ingestion_runs` row rather than reopening the old one: the original
 * run is a record of what happened on a date, and rewriting it to say something
 * else about that date is exactly the mutation this project refuses elsewhere.
 * The replay gets its own row, its own tallies, and its own place in the
 * history.
 */
async function openReparseRun(
  db: Knex,
  queue: IngestionQueue,
  sourceId: string,
  targets: ParseJobTarget[],
): Promise<ReparseResult> {
  if (targets.length === 0) {
    throw new ReparseError("Nothing to re-parse: no stored artifact is reachable here", 409);
  }

  const inserted: unknown = await db("ingestion_runs")
    .insert({
      source_id: sourceId,
      status: "running",
      counts: JSON.stringify({ reparse_queued: targets.length }),
    })
    .returning("id");
  const row = Array.isArray(inserted) ? inserted[0] : undefined;
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new ReparseError("Could not open a run for the re-parse", 500);
  }
  const runId = row.id;

  let enqueued = 0;
  for (const target of targets) {
    await queue.enqueue("parse", target, runId);
    enqueued += 1;
  }
  return { run_id: runId, enqueued };
}

/** Replays every artifact this run parsed, against bytes already held. */
export async function reparseRun(
  db: Knex,
  queue: IngestionQueue,
  runId: string,
): Promise<ReparseResult> {
  const run: unknown = await db("ingestion_runs").where({ id: runId }).first("id", "source_id");
  if (!isRecord(run)) throw new ReparseError("Run not found", 404);

  const jobs: unknown = await db("ingestion_jobs")
    .where({ run_id: runId, stage: "parse" })
    .orderBy("created_at", "asc")
    .select("target");

  return openReparseRun(db, queue, asString(run.source_id), distinctParseTargets(jobs));
}

/**
 * Replays every artifact this meeting's documents were parsed from.
 *
 * The meeting-to-artifact link is the parse job's target, not a foreign key:
 * `meeting_documents` records a URL, and the artifact records the bytes that
 * URL produced. Going through the job is how the two are related without
 * inventing a column that could disagree with the queue.
 */
export async function reparseMeeting(
  db: Knex,
  queue: IngestionQueue,
  meetingId: string,
): Promise<ReparseResult> {
  const jobs: unknown = await db("ingestion_jobs as job")
    .join("ingestion_runs as run", "job.run_id", "run.id")
    .where("job.stage", "parse")
    .whereRaw("job.target ->> 'meetingId' = ?", [meetingId])
    .orderBy("job.created_at", "asc")
    .select("job.target as target", "run.source_id as source_id");

  const rows = (Array.isArray(jobs) ? jobs : []).filter(isRecord);
  if (rows.length === 0) {
    throw new ReparseError(
      "Nothing to re-parse: no stored artifact has been parsed for this meeting",
      409,
    );
  }

  return openReparseRun(db, queue, asString(rows[0].source_id), distinctParseTargets(rows));
}
