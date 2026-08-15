import type { Knex } from "knex";

/**
 * Durable Postgres-backed ingestion queue.
 *
 * The claim path is `FOR UPDATE SKIP LOCKED` against the partial index created
 * in migration 018 (`idx_ingestion_jobs_claim`). That is the entire concurrency
 * story: two workers polling the same table must never claim the same job, and
 * a locked row is skipped rather than waited on.
 *
 * Schema of record: backend/migrations/018_create_ingestion_jobs.ts
 */

export type IngestionStage =
  | "discover"
  | "fetch"
  | "parse"
  | "analyze"
  | "extract"
  | "govern"
  | "locate";

export type IngestionJobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "blocked";

/** Anything a knex query or transaction can run against. */
export type QueryExecutor = Knex | Knex.Transaction;

// ---------------------------------------------------------------------------
// Stage targets
// ---------------------------------------------------------------------------
//
// CRITICAL INVARIANT (production design spec, "Ingestion queue and run
// tracking"): every stage after `fetch` reads from stored artifacts, never
// from the network.
//
// That invariant is expressed here, in the shape of the targets. A `fetch`
// target carries a URL because fetching is the one stage allowed to touch the
// network. A `parse` or `analyze` target carries a SHA-256 content address and
// nothing else that could be dereferenced over HTTP — there is no URL for a
// post-fetch handler to follow, so a source whose live fetching is blocked
// does not stop parse and analyze from being developed and tested against
// captured documents.
//
// `parseStageTarget` enforces this at runtime: a post-fetch target carrying a
// top-level `url` is rejected as invalid, not retried.

export interface DiscoverTarget {
  /** ISO-8601 instant; discover meetings changed at or after this time. */
  since: string;
  /** Adapter-specific extras (body filter, page cursor, ...). */
  metadata?: Record<string, unknown>;
}

export interface FetchTarget {
  /** The one stage permitted to dereference a URL. */
  url: string;
  meetingId?: string;
  documentType?: string;
  metadata?: Record<string, unknown>;
}

export interface ParseTarget {
  /** Content address of a stored artifact. Lowercase hex SHA-256. */
  sha256: string;
  meetingId?: string;
  documentType?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyzeTarget {
  /** Content address of a stored artifact. Lowercase hex SHA-256. */
  sha256: string;
  meetingId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Read a meeting's stored minutes with a language model.
 *
 * Post-`fetch`, so a content address and no URL — the invariant above holds
 * here as it does for parse and analyze. The one network call the handler makes
 * is to OpenRouter, which is not a source of record: nothing it returns is
 * stored without first being located in these bytes.
 *
 * `meetingId` is required, unlike on the other post-fetch stages. A claim and a
 * tally are both about a meeting, and there is no meaningful extraction of an
 * artifact belonging to none.
 */
export interface ExtractTarget {
  /** Content address of a stored artifact. Lowercase hex SHA-256. */
  sha256: string;
  meetingId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Have a second model check the claims already extracted from these bytes.
 *
 * The same shape as `ExtractTarget`, and deliberately not "a claim id": the
 * governor judges a claim against a window of the document, so the unit of work
 * is the artifact the windows are cut from. One job per (meeting, artifact)
 * reads the bytes once and judges every held claim they produced, rather than
 * re-deriving the document text once per claim.
 *
 * Post-`fetch`, so a content address and no URL. Its one network call is to
 * OpenRouter, which is not a source of record: nothing it returns is stored
 * without first being located in these bytes.
 */
export interface GovernTarget {
  /** Content address of a stored artifact. Lowercase hex SHA-256. */
  sha256: string;
  meetingId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Read the addresses out of a meeting's agenda and record them as places.
 *
 * The same shape as `ExtractTarget`, and post-`fetch` for the same reason: a
 * content address and no URL. Its one outbound call is to the US Census
 * geocoder, and unlike the model calls above, that call **is** a source — for
 * the coordinate, not for the record — which is why every row it produces
 * carries `places.geocoder` and `places.geocoded_at`. Nothing it returns is
 * stored until the address it answered about has been located in these bytes.
 *
 * `meetingId` is required, as on extract and govern: the unit of work is a
 * meeting's agenda and its items, and there is no meaningful location pass over
 * an artifact belonging to no meeting.
 */
export interface LocateTarget {
  /** Content address of a stored artifact. Lowercase hex SHA-256. */
  sha256: string;
  meetingId: string;
  metadata?: Record<string, unknown>;
}

export interface StageTargets {
  discover: DiscoverTarget;
  fetch: FetchTarget;
  parse: ParseTarget;
  analyze: AnalyzeTarget;
  extract: ExtractTarget;
  govern: GovernTarget;
  locate: LocateTarget;
}

export type JobTarget = StageTargets[IngestionStage];

/**
 * A job handed to a worker, discriminated on `stage` so narrowing on the stage
 * narrows the target type with it.
 */
export type ClaimedJob = {
  [S in IngestionStage]: {
    id: string;
    runId: string;
    stage: S;
    target: StageTargets[S];
    /** Attempt number this claim represents; 1 on the first claim. */
    attempts: number;
    nextAttemptAt: Date;
  };
}[IngestionStage];

/** A job row as stored, with the target left unparsed for inspection. */
export interface JobRecord {
  id: string;
  runId: string;
  stage: IngestionStage;
  target: unknown;
  status: IngestionJobStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

export interface FailResult {
  /** `pending` when the job was rescheduled, `blocked` when attempts ran out. */
  status: Extract<IngestionJobStatus, "pending" | "blocked">;
  attempts: number;
  /** Backoff applied before the next attempt; 0 when the job was blocked. */
  delayMs: number;
  nextAttemptAt: Date;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by a handler (or raised by the worker) when a job cannot proceed for a
 * reason retrying will not fix — a source whose live fetching is unavailable,
 * or a stage with no handler registered. The job is held in `blocked`, not
 * lost, and `unblock` returns it to the queue when the cause clears.
 */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

/**
 * Thrown when a job's stored target does not match its stage. Retrying cannot
 * repair a malformed row, so such a job terminates in `failed`.
 */
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobError";
  }
}

// ---------------------------------------------------------------------------
// Runtime validation of database rows
// ---------------------------------------------------------------------------

const STAGES: readonly IngestionStage[] = [
  "discover",
  "fetch",
  "parse",
  "analyze",
  "extract",
  "govern",
  "locate",
];

const STATUSES: readonly IngestionJobStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`ingestion_jobs.${field}: expected string`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`ingestion_jobs.${field}: expected finite number`);
  }
  return value;
}

function asDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new TypeError(`ingestion_jobs.${field}: expected timestamp`);
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asStage(value: unknown): IngestionStage {
  const candidates = STAGES.filter((stage) => stage === value);
  const stage = candidates[0];
  if (stage === undefined) {
    throw new TypeError(`ingestion_jobs.stage: unknown stage ${String(value)}`);
  }
  return stage;
}

function asStatus(value: unknown): IngestionJobStatus {
  const candidates = STATUSES.filter((status) => status === value);
  const status = candidates[0];
  if (status === undefined) {
    throw new TypeError(
      `ingestion_jobs.status: unknown status ${String(value)}`,
    );
  }
  return status;
}

/** Parses a raw row into a JobRecord, validating every field it reads. */
export function parseJobRecord(raw: unknown): JobRecord {
  if (!isRecord(raw)) {
    throw new TypeError("ingestion_jobs: expected a row object");
  }
  return {
    id: asString(raw.id, "id"),
    runId: asString(raw.run_id, "run_id"),
    stage: asStage(raw.stage),
    target: raw.target,
    status: asStatus(raw.status),
    attempts: asNumber(raw.attempts, "attempts"),
    nextAttemptAt: asDate(raw.next_attempt_at, "next_attempt_at"),
    lastError: asNullableString(raw.last_error, "last_error"),
  };
}

function requiredTargetString(
  target: Record<string, unknown>,
  key: string,
  stage: IngestionStage,
): string {
  const value = target[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidJobError(
      `${stage} target requires a non-empty string '${key}'`,
    );
  }
  return value;
}

function optionalTargetString(
  target: Record<string, unknown>,
  key: string,
  stage: IngestionStage,
): string | undefined {
  const value = target[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidJobError(`${stage} target '${key}' must be a string`);
  }
  return value;
}

function optionalMetadata(
  target: Record<string, unknown>,
  stage: IngestionStage,
): Record<string, unknown> | undefined {
  const value = target.metadata;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new InvalidJobError(`${stage} target 'metadata' must be an object`);
  }
  return value;
}

function asTargetRecord(
  raw: unknown,
  stage: IngestionStage,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new InvalidJobError(`${stage} target must be a JSON object`);
  }
  return raw;
}

/**
 * Rejects a post-fetch target that carries a dereferenceable URL.
 *
 * This is the runtime half of the "stages after fetch never touch the network"
 * invariant. The type half is that `ParseTarget`/`AnalyzeTarget` have no `url`
 * field; this catches a row written by something that ignored the types.
 */
function rejectNetworkTarget(
  target: Record<string, unknown>,
  stage: IngestionStage,
): void {
  if (target.url !== undefined) {
    throw new InvalidJobError(
      `${stage} target must not carry a url: stages after 'fetch' read stored ` +
        `artifacts by sha256, never the network`,
    );
  }
}

function parseSha256(
  target: Record<string, unknown>,
  stage: IngestionStage,
): string {
  const sha256 = requiredTargetString(target, "sha256", stage);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new InvalidJobError(
      `${stage} target 'sha256' must be lowercase hex SHA-256`,
    );
  }
  return sha256;
}

export function parseDiscoverTarget(raw: unknown): DiscoverTarget {
  const target = asTargetRecord(raw, "discover");
  const since = requiredTargetString(target, "since", "discover");
  if (Number.isNaN(new Date(since).getTime())) {
    throw new InvalidJobError("discover target 'since' must be an ISO instant");
  }
  return { since, metadata: optionalMetadata(target, "discover") };
}

export function parseFetchTarget(raw: unknown): FetchTarget {
  const target = asTargetRecord(raw, "fetch");
  return {
    url: requiredTargetString(target, "url", "fetch"),
    meetingId: optionalTargetString(target, "meetingId", "fetch"),
    documentType: optionalTargetString(target, "documentType", "fetch"),
    metadata: optionalMetadata(target, "fetch"),
  };
}

export function parseParseTarget(raw: unknown): ParseTarget {
  const target = asTargetRecord(raw, "parse");
  rejectNetworkTarget(target, "parse");
  return {
    sha256: parseSha256(target, "parse"),
    meetingId: optionalTargetString(target, "meetingId", "parse"),
    documentType: optionalTargetString(target, "documentType", "parse"),
    metadata: optionalMetadata(target, "parse"),
  };
}

export function parseAnalyzeTarget(raw: unknown): AnalyzeTarget {
  const target = asTargetRecord(raw, "analyze");
  rejectNetworkTarget(target, "analyze");
  return {
    sha256: parseSha256(target, "analyze"),
    meetingId: optionalTargetString(target, "meetingId", "analyze"),
    metadata: optionalMetadata(target, "analyze"),
  };
}

export function parseExtractTarget(raw: unknown): ExtractTarget {
  const target = asTargetRecord(raw, "extract");
  rejectNetworkTarget(target, "extract");
  return {
    sha256: parseSha256(target, "extract"),
    meetingId: requiredTargetString(target, "meetingId", "extract"),
    metadata: optionalMetadata(target, "extract"),
  };
}

export function parseLocateTarget(raw: unknown): LocateTarget {
  const target = asTargetRecord(raw, "locate");
  rejectNetworkTarget(target, "locate");
  return {
    sha256: parseSha256(target, "locate"),
    meetingId: requiredTargetString(target, "meetingId", "locate"),
    metadata: optionalMetadata(target, "locate"),
  };
}

export function parseGovernTarget(raw: unknown): GovernTarget {
  const target = asTargetRecord(raw, "govern");
  rejectNetworkTarget(target, "govern");
  return {
    sha256: parseSha256(target, "govern"),
    meetingId: requiredTargetString(target, "meetingId", "govern"),
    metadata: optionalMetadata(target, "govern"),
  };
}

/** Turns a stored record into a stage-discriminated, fully typed job. */
export function toClaimedJob(record: JobRecord): ClaimedJob {
  const base = {
    id: record.id,
    runId: record.runId,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
  };
  switch (record.stage) {
    case "discover":
      return { ...base, stage: "discover", target: parseDiscoverTarget(record.target) };
    case "fetch":
      return { ...base, stage: "fetch", target: parseFetchTarget(record.target) };
    case "parse":
      return { ...base, stage: "parse", target: parseParseTarget(record.target) };
    case "analyze":
      return { ...base, stage: "analyze", target: parseAnalyzeTarget(record.target) };
    case "extract":
      return { ...base, stage: "extract", target: parseExtractTarget(record.target) };
    case "govern":
      return { ...base, stage: "govern", target: parseGovernTarget(record.target) };
    case "locate":
      return { ...base, stage: "locate", target: parseLocateTarget(record.target) };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}` : error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueueOptions {
  /** Attempts allowed before a job is held in `blocked`. Default 5. */
  maxAttempts?: number;
  /** First retry delay. Doubles per attempt. Default 30s. */
  baseBackoffMs?: number;
  /** Ceiling on the doubling. Default 1h. */
  maxBackoffMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How long a `running` row must sit untouched before it counts as abandoned.
 *
 * Thirty minutes, set by the slowest stage rather than the average one: an
 * extraction is nine-ish sequential calls to a rate-limited free model and
 * legitimately takes minutes. Too small a threshold requeues live work and
 * doubles the load on the thing that was already slow.
 */
export const DEFAULT_STALLED_AFTER_MS = 30 * 60 * 1000;

export interface EnqueueOptions {
  /** Delay before the job first becomes claimable. Default 0 (due now). */
  delayMs?: number;
  /** Run inside a caller-owned transaction. */
  executor?: QueryExecutor;
}

const CLAIM_SQL = `
  SELECT id
  FROM ingestion_jobs
  WHERE status = 'pending' AND next_attempt_at <= now()
  ORDER BY next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT ?
`;

/**
 * The same claim, restricted to named stages.
 *
 * Exists for the standing worker, which drains `parse` and `analyze` only.
 * Those two stages cannot reach the network by construction — their targets
 * carry a content address and no URL, and their context carries no fetcher and
 * no storage client — so a worker limited to them can run from boot with no
 * risk of a crash-looping container turning into a crawl of a county web
 * server. That rule is why `SourceScheduler.start()` refuses to sweep on start,
 * and a standing worker claiming `fetch` would walk straight around it.
 *
 * `= ANY(?)` rather than an interpolated IN list: the stage set is small and
 * fixed, but building SQL by concatenating an array only has to be wrong once.
 */
const CLAIM_STAGES_SQL = `
  SELECT id
  FROM ingestion_jobs
  WHERE status = 'pending'
    AND next_attempt_at <= now()
    AND stage = ANY(?)
  ORDER BY next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT ?
`;

export class IngestionQueue {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;

  constructor(
    private readonly db: Knex,
    options: QueueOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  /**
   * Exponential backoff for the given attempt count, capped.
   * attempts=1 -> base, 2 -> 2x base, 3 -> 4x base, ...
   */
  backoffFor(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    const raw = this.baseBackoffMs * 2 ** exponent;
    return Math.min(raw, this.maxBackoffMs);
  }

  /** Inserts a pending job for `stage` against `target`, owned by `runId`. */
  async enqueue<S extends IngestionStage>(
    stage: S,
    target: StageTargets[S],
    runId: string,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const executor = options.executor ?? this.db;
    const delayMs = options.delayMs ?? 0;
    if (delayMs < 0) {
      throw new RangeError("enqueue delayMs must be >= 0");
    }

    // Validate against the stage's contract before it reaches the table, so a
    // malformed target fails at the caller rather than at the worker.
    this.validateTarget(stage, target);

    const rows: unknown = await executor("ingestion_jobs")
      .insert({
        run_id: runId,
        stage,
        target: JSON.stringify(target),
        status: "pending",
        attempts: 0,
        next_attempt_at: executor.raw("now() + (? * interval '1 millisecond')", [
          delayMs,
        ]),
      })
      .returning("id");

    const inserted = Array.isArray(rows) ? rows[0] : undefined;
    if (!isRecord(inserted)) {
      throw new Error("enqueue: insert returned no row");
    }
    return asString(inserted.id, "id");
  }

  private validateTarget<S extends IngestionStage>(
    stage: S,
    target: StageTargets[S],
  ): void {
    switch (stage) {
      case "discover":
        parseDiscoverTarget(target);
        return;
      case "fetch":
        parseFetchTarget(target);
        return;
      case "parse":
        parseParseTarget(target);
        return;
      case "analyze":
        parseAnalyzeTarget(target);
        return;
      case "extract":
        parseExtractTarget(target);
        return;
      case "govern":
        parseGovernTarget(target);
        return;
      case "locate":
        parseLocateTarget(target);
        return;
      default:
        throw new InvalidJobError(`unknown stage ${String(stage)}`);
    }
  }

  /**
   * Claims up to `limit` due jobs and marks them running in the same
   * transaction.
   *
   * `FOR UPDATE SKIP LOCKED` is the point: a row locked by another worker's
   * open transaction is skipped, so two workers polling concurrently partition
   * the queue instead of colliding on it.
   *
   * Pass `executor` to claim inside a transaction you control — the claim is
   * only durable once that transaction commits, and the rows stay locked
   * against other claimers until then.
   */
  async claim(
    limit: number,
    executor?: QueryExecutor,
    /** Restrict the claim to these stages. Omitted means any stage. */
    stages?: readonly IngestionStage[],
  ): Promise<ClaimedJob[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("claim limit must be a positive integer");
    }
    if (stages !== undefined && stages.length === 0) {
      // An empty list claims nothing while reading like "no restriction". A
      // worker that silently does nothing is the failure this whole file is
      // written to avoid.
      throw new RangeError("claim stages, when given, must name at least one stage");
    }
    if (executor) {
      return this.claimIn(executor, limit, stages);
    }
    return this.db.transaction((trx) => this.claimIn(trx, limit, stages));
  }

  private async claimIn(
    executor: QueryExecutor,
    limit: number,
    stages?: readonly IngestionStage[],
  ): Promise<ClaimedJob[]> {
    const selected =
      stages === undefined
        ? await executor.raw(CLAIM_SQL, [limit])
        : await executor.raw(CLAIM_STAGES_SQL, [[...stages], limit]);
    const selectedRows: unknown[] = Array.isArray(selected?.rows)
      ? selected.rows
      : [];
    if (selectedRows.length === 0) return [];

    const ids = selectedRows.map((row) => {
      if (!isRecord(row)) throw new TypeError("claim: expected a row object");
      return asString(row.id, "id");
    });

    const updated: unknown = await executor("ingestion_jobs")
      .whereIn("id", ids)
      .update({
        status: "running",
        attempts: executor.raw("attempts + 1"),
        updated_at: executor.fn.now(),
      })
      .returning([
        "id",
        "run_id",
        "stage",
        "target",
        "status",
        "attempts",
        "next_attempt_at",
        "last_error",
      ]);

    const updatedRows: unknown[] = Array.isArray(updated) ? updated : [];
    const byId = new Map<string, ClaimedJob>();
    for (const row of updatedRows) {
      const job = toClaimedJob(parseJobRecord(row));
      byId.set(job.id, job);
    }

    // RETURNING has no defined order; restore the next_attempt_at ordering the
    // claim query established.
    const jobs: ClaimedJob[] = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /** Marks a running job done. Done jobs are never claimed again. */
  async complete(jobId: string, executor?: QueryExecutor): Promise<void> {
    const runner = executor ?? this.db;
    const affected = await runner("ingestion_jobs")
      .where({ id: jobId, status: "running" })
      .update({ status: "done", last_error: null, updated_at: runner.fn.now() });
    if (affected === 0) {
      await this.assertTransitionable(jobId, "complete", runner);
    }
  }

  /**
   * Records a failed attempt.
   *
   * While attempts remain the job returns to `pending` with an exponentially
   * growing `next_attempt_at`. Once the attempts made reach `maxAttempts` the
   * job moves to `blocked` — held with its last error for a human or an
   * `unblock` call, never silently dropped and never retried forever.
   */
  async fail(
    jobId: string,
    error: unknown,
    executor?: QueryExecutor,
  ): Promise<FailResult> {
    const message = errorMessage(error);
    const run = async (trx: QueryExecutor): Promise<FailResult> => {
      const raw = await trx("ingestion_jobs")
        .where({ id: jobId })
        .forUpdate()
        .first();
      if (raw === undefined) {
        throw new Error(`ingestion job ${jobId} not found`);
      }
      const record = parseJobRecord(raw);
      if (record.status !== "running") {
        throw new Error(
          `cannot fail ingestion job ${jobId}: status is '${record.status}', expected 'running'`,
        );
      }

      if (record.attempts >= this.maxAttempts) {
        const blocked = await this.setStatus(
          trx,
          jobId,
          "blocked",
          `attempts exhausted after ${record.attempts}: ${message}`,
        );
        return {
          status: "blocked",
          attempts: record.attempts,
          delayMs: 0,
          nextAttemptAt: blocked.nextAttemptAt,
        };
      }

      const delayMs = this.backoffFor(record.attempts);
      const rows: unknown = await trx("ingestion_jobs")
        .where({ id: jobId })
        .update({
          status: "pending",
          last_error: message,
          next_attempt_at: trx.raw("now() + (? * interval '1 millisecond')", [
            delayMs,
          ]),
          updated_at: trx.fn.now(),
        })
        .returning("*");
      const updated = Array.isArray(rows) ? rows[0] : undefined;
      const rescheduled = parseJobRecord(updated);
      return {
        status: "pending",
        attempts: rescheduled.attempts,
        delayMs,
        nextAttemptAt: rescheduled.nextAttemptAt,
      };
    };

    if (executor) return run(executor);
    return this.db.transaction(run);
  }

  /**
   * Holds a job in `blocked` without consuming retries — the source cannot
   * proceed for a reason retrying will not fix.
   */
  async block(
    jobId: string,
    reason: string,
    executor?: QueryExecutor,
  ): Promise<void> {
    await this.setStatus(executor ?? this.db, jobId, "blocked", reason);
  }

  /**
   * Terminates a job in `failed`. Reserved for jobs that can never succeed —
   * a target that does not match its stage, for instance. Retrying a malformed
   * row only burns attempts.
   */
  async abandon(
    jobId: string,
    error: unknown,
    executor?: QueryExecutor,
  ): Promise<void> {
    await this.setStatus(
      executor ?? this.db,
      jobId,
      "failed",
      errorMessage(error),
    );
  }

  /**
   * Returns jobs left `running` by a dead process to the queue.
   *
   * A claim marks the row `running` and only the worker that made it ever moves
   * it on. Kill that process — a deploy, an OOM, a restart — and the row stays
   * `running` forever, claimable by nobody. That is the same permanent limbo
   * `extraction_runs` fell into, and moving extraction onto the queue would
   * merely have relocated it, since an extract job holds its claim for minutes
   * and is the most likely job in the table to be mid-flight when a deploy
   * lands.
   *
   * Attempts are **not** reset: the crashed attempt was an attempt, and a job
   * that dies the same way every time must still run out of retries rather than
   * loop forever. `unblock` resets them, deliberately — that is a human saying
   * the cause is gone.
   *
   * The threshold is what makes this safe to run while workers are live: a job
   * whose row has not been touched for far longer than any handler takes cannot
   * still be in progress.
   */
  async recoverStalled(
    olderThanMs: number = DEFAULT_STALLED_AFTER_MS,
    executor?: QueryExecutor,
  ): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      throw new RangeError("recoverStalled olderThanMs must be a positive number");
    }
    const runner = executor ?? this.db;
    return runner("ingestion_jobs")
      .where({ status: "running" })
      .where(
        "updated_at",
        "<",
        runner.raw("now() - (? * interval '1 millisecond')", [olderThanMs]),
      )
      .update({
        status: "pending",
        last_error:
          "the worker holding this job stopped without finishing it; requeued for another attempt",
        next_attempt_at: runner.fn.now(),
        updated_at: runner.fn.now(),
      });
  }

  /** Returns blocked jobs to the queue, due immediately, with attempts reset. */
  async unblock(jobIds: string[], executor?: QueryExecutor): Promise<number> {
    if (jobIds.length === 0) return 0;
    const runner = executor ?? this.db;
    return runner("ingestion_jobs")
      .whereIn("id", jobIds)
      .where({ status: "blocked" })
      .update({
        status: "pending",
        attempts: 0,
        next_attempt_at: runner.fn.now(),
        updated_at: runner.fn.now(),
      });
  }

  async get(jobId: string, executor?: QueryExecutor): Promise<JobRecord | null> {
    const raw = await (executor ?? this.db)("ingestion_jobs")
      .where({ id: jobId })
      .first();
    if (raw === undefined) return null;
    return parseJobRecord(raw);
  }

  /**
   * Merges per-stage tallies into `ingestion_runs.counts`.
   *
   * Read-modify-write under a row lock so two workers reporting into the same
   * run cannot lose each other's increments.
   */
  async recordRunCounts(
    runId: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const entries = Object.entries(deltas).filter(([, delta]) => delta !== 0);
    if (entries.length === 0) return {};

    return this.db.transaction(async (trx) => {
      const raw = await trx("ingestion_runs")
        .where({ id: runId })
        .forUpdate()
        .first();
      if (raw === undefined) {
        throw new Error(`ingestion run ${runId} not found`);
      }
      if (!isRecord(raw)) {
        throw new TypeError("ingestion_runs: expected a row object");
      }
      const current = isRecord(raw.counts) ? raw.counts : {};
      const merged: Record<string, unknown> = { ...current };
      for (const [key, delta] of entries) {
        const existing = merged[key];
        const base = typeof existing === "number" ? existing : 0;
        merged[key] = base + delta;
      }

      await trx("ingestion_runs")
        .where({ id: runId })
        .update({ counts: JSON.stringify(merged), updated_at: trx.fn.now() });

      const numeric: Record<string, number> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (typeof value === "number") numeric[key] = value;
      }
      return numeric;
    });
  }

  private async setStatus(
    executor: QueryExecutor,
    jobId: string,
    status: IngestionJobStatus,
    lastError: string | null,
  ): Promise<JobRecord> {
    const rows: unknown = await executor("ingestion_jobs")
      .where({ id: jobId })
      .update({
        status,
        last_error: lastError,
        updated_at: executor.fn.now(),
      })
      .returning("*");
    const updated = Array.isArray(rows) ? rows[0] : undefined;
    if (updated === undefined) {
      throw new Error(`ingestion job ${jobId} not found`);
    }
    return parseJobRecord(updated);
  }

  private async assertTransitionable(
    jobId: string,
    action: string,
    executor: QueryExecutor,
  ): Promise<never> {
    const record = await this.get(jobId, executor);
    if (record === null) {
      throw new Error(`ingestion job ${jobId} not found`);
    }
    throw new Error(
      `cannot ${action} ingestion job ${jobId}: status is '${record.status}', expected 'running'`,
    );
  }
}
