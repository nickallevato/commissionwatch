import type { Knex } from "knex";
import { setTimeout as delay } from "node:timers/promises";
import {
  BlockedError,
  InvalidJobError,
  IngestionQueue,
  errorMessage,
  type AnalyzeTarget,
  type ClaimedJob,
  type DiscoverTarget,
  type ExtractTarget,
  type FetchTarget,
  type GovernTarget,
  type IngestionStage,
  type ParseTarget,
  type StageTargets,
} from "./queue";

/**
 * The ingestion worker: a poll loop that claims jobs, dispatches them by stage
 * to an injected handler registry, and reports tallies into the run row.
 *
 * The worker knows nothing about any adapter. Handlers are injected, so adding
 * `gallatin-civicplus` or `mt-cers` never touches this file.
 *
 * THE CAPABILITY SPLIT — this is the load-bearing design decision:
 *
 *   discover / fetch  receive a target that names the network (a URL). They
 *                     are the only stages permitted to reach outside.
 *
 *   parse / analyze   receive an `ArtifactRef` resolved from the `artifacts`
 *                     table plus the artifact's bytes, already loaded. Their
 *                     targets carry a SHA-256 content address and no URL, and
 *                     their context carries no fetcher, no storage client and
 *                     no URL — there is nothing in scope to dereference.
 *
 * That is what lets development continue while a source is blocked: a Bozeman
 * agenda obtained by hand flows through parse and analyze identically to an
 * automatically fetched one, and the fetch stage's health is irrelevant to
 * both.
 */

// ---------------------------------------------------------------------------
// Artifact access
// ---------------------------------------------------------------------------

/** A stored artifact, as recorded in migration 019. */
export interface ArtifactRef {
  id: string;
  sha256: string;
  storageKey: string;
  contentType: string | null;
  sourceUrl: string | null;
  byteSize: number;
  fetchedAt: Date;
}

/**
 * Read-only access to artifact bytes. Injected so the worker does not depend
 * on MinIO (or on any particular object store) and so tests can supply bytes
 * from memory.
 */
export interface ArtifactStore {
  read(ref: ArtifactRef): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Handler contract
// ---------------------------------------------------------------------------

export interface StageResult {
  /** Extra tallies merged into `ingestion_runs.counts`. */
  counts?: Record<string, number>;
}

interface BaseStageContext {
  readonly jobId: string;
  readonly runId: string;
  /** Attempt number this invocation represents; 1 on the first. */
  readonly attempts: number;
  /** Database handle for the handler's own writes. Not a network capability. */
  readonly db: Knex;
  /** Aborts when the worker is asked to stop. */
  readonly signal: AbortSignal;
  /** Enqueues a follow-on job in the same run. */
  enqueue<S extends IngestionStage>(
    stage: S,
    target: StageTargets[S],
    delayMs?: number,
  ): Promise<string>;
}

export interface DiscoverContext extends BaseStageContext {
  readonly stage: "discover";
  readonly target: DiscoverTarget;
}

export interface FetchContext extends BaseStageContext {
  readonly stage: "fetch";
  readonly target: FetchTarget;
}

/**
 * Context for every stage after `fetch`. The bytes are already here; there is
 * no URL and no way to ask for one.
 */
interface StoredArtifactContext extends BaseStageContext {
  readonly artifact: ArtifactRef;
  readonly content: Buffer;
}

export interface ParseContext extends StoredArtifactContext {
  readonly stage: "parse";
  readonly target: ParseTarget;
}

export interface AnalyzeContext extends StoredArtifactContext {
  readonly stage: "analyze";
  readonly target: AnalyzeTarget;
}

/**
 * Reading the minutes with a model. Bytes in, held claims out.
 *
 * A stored-artifact context like parse and analyze, for the same reason: the
 * handler is handed the bytes its citations will be checked against and has no
 * way to ask for anything else. Its call to OpenRouter is not a source fetch —
 * nothing the model returns is stored unless it is first located in `content`.
 */
export interface ExtractContext extends StoredArtifactContext {
  readonly stage: "extract";
  readonly target: ExtractTarget;
}

/**
 * Checking the claims against the bytes they were read from, with a second model.
 *
 * A stored-artifact context for extraction's reason, and one more: the governor
 * must judge the same characters the extractor's offsets index into, so it
 * derives the document text from these bytes rather than from anything cached
 * beside them. A window read out of a differently-produced copy would be a
 * verdict about text nobody cited.
 */
export interface GovernContext extends StoredArtifactContext {
  readonly stage: "govern";
  readonly target: GovernTarget;
}

export type StageOutcome = Promise<StageResult | void>;

/**
 * Handlers are injected, never imported. A stage with no handler is `blocked`,
 * not failed: the jobs are held until a handler exists.
 */
export interface HandlerRegistry {
  discover?: (ctx: DiscoverContext) => StageOutcome;
  fetch?: (ctx: FetchContext) => StageOutcome;
  parse?: (ctx: ParseContext) => StageOutcome;
  analyze?: (ctx: AnalyzeContext) => StageOutcome;
  extract?: (ctx: ExtractContext) => StageOutcome;
  govern?: (ctx: GovernContext) => StageOutcome;
}

/** Count key recorded when a stage succeeds. */
const SUCCESS_COUNT_KEY: Record<IngestionStage, string> = {
  discover: "discovered",
  fetch: "fetched",
  parse: "parsed",
  analyze: "analyzed",
  extract: "extracted",
  govern: "governed",
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: WorkerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface WorkerOptions {
  handlers: HandlerRegistry;
  /** Required once a `parse` or `analyze` handler is registered. */
  artifacts?: ArtifactStore;
  /** Jobs claimed per poll. Default 5. */
  batchSize?: number;
  /** Pause after an empty claim. Default 1000ms. */
  idleDelayMs?: number;
  /**
   * Restrict this worker to these stages. Omitted means every stage.
   *
   * The standing worker started at boot passes `["parse", "analyze"]`, the two
   * stages that cannot reach the network. Leaving it unset — as the sweep's own
   * drain does — keeps the original behaviour.
   */
  stages?: readonly IngestionStage[];
  logger?: WorkerLogger;
}

export interface TickResult {
  claimed: number;
  completed: number;
  /** Failed attempts that were rescheduled with backoff. */
  retried: number;
  /** Jobs held in `blocked`. */
  blocked: number;
  /** Jobs terminated in `failed` — malformed, never retryable. */
  failed: number;
}

const EMPTY_TICK: TickResult = {
  claimed: 0,
  completed: 0,
  retried: 0,
  blocked: 0,
  failed: 0,
};

export class IngestionWorker {
  private readonly handlers: HandlerRegistry;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly batchSize: number;
  private readonly idleDelayMs: number;
  private readonly stages: readonly IngestionStage[] | undefined;
  private readonly logger: WorkerLogger;
  private controller = new AbortController();
  private looping = false;

  constructor(
    private readonly db: Knex,
    private readonly queue: IngestionQueue,
    options: WorkerOptions,
  ) {
    this.handlers = options.handlers;
    this.artifacts = options.artifacts;
    this.batchSize = options.batchSize ?? 5;
    this.idleDelayMs = options.idleDelayMs ?? 1000;
    this.stages = options.stages;
    this.logger = options.logger ?? defaultLogger;
  }

  get running(): boolean {
    return this.looping;
  }

  /** Polls until `stop()`. Resolves once the loop has wound down. */
  async start(): Promise<void> {
    if (this.looping) return;
    this.controller = new AbortController();
    this.looping = true;
    this.logger.info(
      `IngestionWorker: polling (batchSize=${this.batchSize}, idleDelayMs=${this.idleDelayMs})`,
    );
    try {
      while (!this.controller.signal.aborted) {
        let result: TickResult = EMPTY_TICK;
        try {
          result = await this.runOnce();
        } catch (error) {
          // A claim failure (database down) must not kill the loop.
          this.logger.error(`IngestionWorker: poll failed — ${errorMessage(error)}`);
        }
        if (result.claimed === 0 && !this.controller.signal.aborted) {
          await this.idle();
        }
      }
    } finally {
      this.looping = false;
      this.logger.info("IngestionWorker: stopped");
    }
  }

  /** Signals the loop to wind down and aborts in-flight handler signals. */
  stop(): void {
    this.controller.abort();
  }

  /**
   * One poll: claim a batch, run each job, record run counts. Exposed so a
   * caller (or a test) can drive the worker deterministically without a loop.
   */
  async runOnce(): Promise<TickResult> {
    const jobs = await this.queue.claim(this.batchSize, undefined, this.stages);
    if (jobs.length === 0) return { ...EMPTY_TICK };

    const tick: TickResult = { ...EMPTY_TICK, claimed: jobs.length };
    const countsByRun = new Map<string, Record<string, number>>();

    for (const job of jobs) {
      const counts = this.countsFor(countsByRun, job.runId);
      try {
        const result = await this.dispatch(job);
        await this.queue.complete(job.id);
        tick.completed += 1;
        bump(counts, SUCCESS_COUNT_KEY[job.stage], 1);
        if (result && result.counts) {
          for (const [key, delta] of Object.entries(result.counts)) {
            bump(counts, key, delta);
          }
        }
      } catch (error) {
        await this.recordFailure(job, error, tick, counts);
      }
    }

    for (const [runId, counts] of countsByRun) {
      try {
        await this.queue.recordRunCounts(runId, counts);
      } catch (error) {
        this.logger.error(
          `IngestionWorker: could not record counts for run ${runId} — ${errorMessage(error)}`,
        );
      }
    }

    return tick;
  }

  private async recordFailure(
    job: ClaimedJob,
    error: unknown,
    tick: TickResult,
    counts: Record<string, number>,
  ): Promise<void> {
    const message = errorMessage(error);

    if (error instanceof InvalidJobError) {
      // Retrying cannot repair a malformed job.
      await this.queue.abandon(job.id, error);
      tick.failed += 1;
      bump(counts, "failed", 1);
      this.logger.error(
        `IngestionWorker: ${job.stage} job ${job.id} is invalid — ${message}`,
      );
      return;
    }

    if (error instanceof BlockedError) {
      // Held, not lost, and without burning retries.
      await this.queue.block(job.id, message);
      tick.blocked += 1;
      bump(counts, "blocked", 1);
      this.logger.warn(
        `IngestionWorker: ${job.stage} job ${job.id} blocked — ${message}`,
      );
      return;
    }

    const outcome = await this.queue.fail(job.id, error);
    if (outcome.status === "blocked") {
      tick.blocked += 1;
      bump(counts, "blocked", 1);
      this.logger.error(
        `IngestionWorker: ${job.stage} job ${job.id} exhausted ${outcome.attempts} attempts, blocked — ${message}`,
      );
      return;
    }
    tick.retried += 1;
    bump(counts, "failed", 1);
    this.logger.warn(
      `IngestionWorker: ${job.stage} job ${job.id} failed (attempt ${outcome.attempts}), retry in ${outcome.delayMs}ms — ${message}`,
    );
  }

  /** Routes a claimed job to its handler, building the stage's context. */
  private async dispatch(job: ClaimedJob): Promise<StageResult | void> {
    const base = {
      jobId: job.id,
      runId: job.runId,
      attempts: job.attempts,
      db: this.db,
      signal: this.controller.signal,
      enqueue: <S extends IngestionStage>(
        stage: S,
        target: StageTargets[S],
        delayMs?: number,
      ): Promise<string> =>
        this.queue.enqueue(stage, target, job.runId, { delayMs }),
    };

    switch (job.stage) {
      case "discover": {
        const handler = this.requireHandler("discover", this.handlers.discover);
        return handler({ ...base, stage: "discover", target: job.target });
      }
      case "fetch": {
        const handler = this.requireHandler("fetch", this.handlers.fetch);
        return handler({ ...base, stage: "fetch", target: job.target });
      }
      case "parse": {
        const handler = this.requireHandler("parse", this.handlers.parse);
        const { artifact, content } = await this.loadArtifact(job.target.sha256);
        return handler({
          ...base,
          stage: "parse",
          target: job.target,
          artifact,
          content,
        });
      }
      case "analyze": {
        const handler = this.requireHandler("analyze", this.handlers.analyze);
        const { artifact, content } = await this.loadArtifact(job.target.sha256);
        return handler({
          ...base,
          stage: "analyze",
          target: job.target,
          artifact,
          content,
        });
      }
      case "extract": {
        const handler = this.requireHandler("extract", this.handlers.extract);
        const { artifact, content } = await this.loadArtifact(job.target.sha256);
        return handler({
          ...base,
          stage: "extract",
          target: job.target,
          artifact,
          content,
        });
      }
      case "govern": {
        const handler = this.requireHandler("govern", this.handlers.govern);
        const { artifact, content } = await this.loadArtifact(job.target.sha256);
        return handler({
          ...base,
          stage: "govern",
          target: job.target,
          artifact,
          content,
        });
      }
    }
  }

  private requireHandler<C>(
    stage: IngestionStage,
    handler: ((ctx: C) => StageOutcome) | undefined,
  ): (ctx: C) => StageOutcome {
    if (handler === undefined) {
      // No amount of retrying registers a handler.
      throw new BlockedError(`no handler registered for stage '${stage}'`);
    }
    return handler;
  }

  /**
   * Resolves a content address to stored bytes.
   *
   * The lookup goes through the `artifacts` table, so a post-fetch stage can
   * only ever read something the fetch stage already captured and recorded.
   */
  private async loadArtifact(
    sha256: string,
  ): Promise<{ artifact: ArtifactRef; content: Buffer }> {
    if (this.artifacts === undefined) {
      throw new BlockedError(
        "no ArtifactStore configured: stages after 'fetch' read stored artifacts",
      );
    }
    const row = await this.db("artifacts").where({ sha256 }).first();
    if (row === undefined) {
      // Retryable: the fetch that produces it may still be in flight.
      throw new Error(`no artifact recorded for sha256 ${sha256}`);
    }
    const artifact = toArtifactRef(row);
    const content = await this.artifacts.read(artifact);
    return { artifact, content };
  }

  private countsFor(
    byRun: Map<string, Record<string, number>>,
    runId: string,
  ): Record<string, number> {
    const existing = byRun.get(runId);
    if (existing) return existing;
    const created: Record<string, number> = {};
    byRun.set(runId, created);
    return created;
  }

  private async idle(): Promise<void> {
    try {
      await delay(this.idleDelayMs, undefined, {
        signal: this.controller.signal,
      });
    } catch {
      // Aborted while idling — the loop condition handles the exit.
    }
  }
}

function bump(counts: Record<string, number>, key: string, delta: number): void {
  if (!Number.isFinite(delta)) return;
  counts[key] = (counts[key] ?? 0) + delta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an `artifacts` row into an ArtifactRef. */
export function toArtifactRef(raw: unknown): ArtifactRef {
  if (!isRecord(raw)) {
    throw new TypeError("artifacts: expected a row object");
  }
  const { id, sha256, storage_key, content_type, source_url, byte_size, fetched_at } =
    raw;
  if (typeof id !== "string") throw new TypeError("artifacts.id: expected string");
  if (typeof sha256 !== "string") {
    throw new TypeError("artifacts.sha256: expected string");
  }
  if (typeof storage_key !== "string") {
    throw new TypeError("artifacts.storage_key: expected string");
  }
  if (typeof byte_size !== "number") {
    throw new TypeError("artifacts.byte_size: expected number");
  }
  const fetchedAt =
    fetched_at instanceof Date ? fetched_at : new Date(String(fetched_at));
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new TypeError("artifacts.fetched_at: expected timestamp");
  }
  return {
    id,
    sha256,
    storageKey: storage_key,
    contentType: typeof content_type === "string" ? content_type : null,
    sourceUrl: typeof source_url === "string" ? source_url : null,
    byteSize: byte_size,
    fetchedAt,
  };
}
