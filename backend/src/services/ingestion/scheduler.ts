import { createHash } from "node:crypto";
import type { Knex } from "knex";
import type { AdapterRegistry } from "./adapters/registry";
import { errorMessage, IngestionQueue } from "./queue";
import { rebuildMatters } from "../matters";
import type { IngestionWorker } from "./worker";

/**
 * The thing that has never existed: something that actually calls the ingestion
 * pipeline.
 *
 * The queue, the worker, the adapter, `ingestion_sources`, `ingestion_runs`,
 * `ingestion_jobs` and `artifacts` were all built and all tested, and nothing
 * anywhere invoked any of them. `index.ts` started the digest scheduler and
 * stopped. The product's entire life has been spent at zero public records.
 *
 * Four properties are load-bearing here and each one is a rule, not a
 * preference:
 *
 * 1. **Cadence lives in the database.** `ingestion_sources.cron_expression` and
 *    `.enabled` decide when and whether a source sweeps. Changing a schedule is
 *    an UPDATE, never a deploy.
 * 2. **One sweep per source at a time**, enforced by a Postgres advisory lock
 *    keyed on the source id. A tick that cannot take the lock logs and returns.
 *    It does not queue a second sweep — that is what turns a slow source into an
 *    unbounded backlog.
 * 3. **Every tick writes its run row before doing any work**, and closes it
 *    `succeeded`, `partial` or `failed`. A sweep that produced work *and* errors
 *    is `partial`; the enum models that and it must not collapse to a boolean,
 *    because "34 of 37 parsed" reported as "failed" trains an operator to ignore
 *    the status.
 * 4. **Nothing sweeps on process start.** First execution is the first cron
 *    tick. A crash-looping container must never become a crawl of a county web
 *    server.
 */

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

/**
 * `SCHEDULER_ENABLED` when set, otherwise on everywhere except tests.
 *
 * The default matters more than the flag: a test suite that quietly schedules
 * real sweeps is a test suite that eventually hits a county web server from CI.
 */
export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SCHEDULER_ENABLED;
  if (raw !== undefined && raw !== "") {
    return /^(1|true|yes|on)$/i.test(raw.trim());
  }
  return env.NODE_ENV !== "test";
}

// ---------------------------------------------------------------------------
// Advisory locking
// ---------------------------------------------------------------------------

/**
 * Namespace for every CommissionWatch source lock, so we cannot collide with
 * another advisory lock in the same database. Arbitrary, fixed, and signed —
 * `pg_try_advisory_xact_lock(int4, int4)` takes signed 32-bit keys.
 */
export const SOURCE_LOCK_NAMESPACE = 0x636d_7773 | 0; // 'cmws'

/** A stable signed int32 from a source's uuid. */
export function sourceLockKey(sourceId: string): number {
  const digest = createHash("sha256").update(sourceId).digest();
  return digest.readInt32BE(0);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type RunStatus = "succeeded" | "partial" | "failed";

export type SweepOutcome =
  | { kind: "skipped"; reason: "locked" | "disabled" | "unknown-source"; sourceId: string }
  | {
      kind: "ran";
      sourceId: string;
      runId: string;
      status: RunStatus;
      counts: Record<string, number>;
      error: string | null;
    };

export interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const consoleLogger: SchedulerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** Just enough of node-cron's task to start, stop and inspect one. */
interface CronTask {
  stop(): void | Promise<void>;
  destroy(): void | Promise<void>;
  getNextRun(): Date | null;
}

interface CronModule {
  schedule(
    expression: string,
    fn: () => void,
    options?: { timezone?: string; name?: string; noOverlap?: boolean },
  ): CronTask;
  validate(expression: string): boolean;
}

export interface SourceRow {
  id: string;
  adapterKey: string;
  cronExpression: string;
  enabled: boolean;
  expectedIntervalHours: number | null;
}

export interface SourceSchedulerOptions {
  queue: IngestionQueue;
  worker: IngestionWorker;
  registry: AdapterRegistry;
  logger?: SchedulerLogger;
  /** Overrides the `SCHEDULER_ENABLED` / `NODE_ENV` decision. */
  enabled?: boolean;
  /** How far back a sweep's `discover` looks. Default 365 days. */
  lookbackDays?: number;
  /** Ceiling on one sweep's draining loop. Default 15 minutes. */
  sweepTimeoutMs?: number;
  /** Injected for tests; defaults to `node-cron`. */
  cron?: CronModule;
  /** Injected for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a dynamically imported module to the two functions we call.
 *
 * A type predicate rather than a cast: `node-cron` arrives as `unknown` from a
 * dynamic import, and the question "does this object have the shape I am about
 * to use" deserves a runtime answer, not an assertion that it does.
 */
function isCronModule(value: unknown): value is CronModule {
  return (
    isRecord(value) &&
    typeof value.schedule === "function" &&
    typeof value.validate === "function"
  );
}

/** Reads an `ingestion_sources` row, validating everything it uses. */
export function parseSourceRow(raw: unknown): SourceRow {
  if (!isRecord(raw)) throw new TypeError("ingestion_sources: expected a row object");
  const { id, adapter_key, cron_expression, enabled, expected_interval_hours } = raw;
  if (typeof id !== "string") throw new TypeError("ingestion_sources.id: expected string");
  if (typeof adapter_key !== "string") {
    throw new TypeError("ingestion_sources.adapter_key: expected string");
  }
  if (typeof cron_expression !== "string") {
    throw new TypeError("ingestion_sources.cron_expression: expected string");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("ingestion_sources.enabled: expected boolean");
  }
  const interval =
    expected_interval_hours === null || expected_interval_hours === undefined
      ? null
      : Number(expected_interval_hours);
  if (interval !== null && !Number.isFinite(interval)) {
    throw new TypeError("ingestion_sources.expected_interval_hours: expected a number or null");
  }
  return {
    id,
    adapterKey: adapter_key,
    cronExpression: cron_expression,
    enabled,
    expectedIntervalHours: interval,
  };
}

/**
 * The `ingestion_runs.counts` keys that mean work reached the database, and the
 * ones that mean it did not.
 *
 * Exported because the console totals lifetime records from the same two lists.
 * If the console counted a different set, a source could read "0 ingested" on
 * one screen and "succeeded" on another, which is the exact disagreement a
 * transparency project cannot afford to have with itself.
 */
export const SUCCESS_KEYS = ["discovered", "fetched", "parsed", "analyzed"] as const;
export const FAILURE_KEYS = ["failed", "blocked"] as const;

/**
 * Reads a run's tallies into a terminal status.
 *
 * Exported and pure because this is the decision the spec is most emphatic
 * about, and a decision worth an explicit test is a decision worth its own
 * function.
 */
export function classifyRun(
  counts: Record<string, number>,
  threw: boolean,
  /**
   * Jobs still queued when the sweep's clock ran out, if that is why it stopped.
   *
   * A sweep is time-boxed, and for a large archive the box is smaller than the
   * work. Bozeman's Granicus page yields 339 meetings; at the 10-second
   * crawl-delay we publish on the Methodology page that is ~57 minutes of
   * fetching against a 15-minute deadline, so a first sweep of it **cannot**
   * finish, however healthy everything is. On 2026-08-10 one did exactly that:
   * 89 documents fetched at 10.1s each, not one job failed, and the run was
   * recorded `failed` — indistinguishable on the sources screen from a scraper
   * that is dead. That is the confusion `/admin/sources` exists to prevent.
   *
   * Hitting the deadline with work outstanding and no errors is `partial`: real
   * progress, not finished. The backlog is not lost — `CLAIM_SQL` carries no
   * `run_id` filter and orders by `next_attempt_at`, so the next drain picks up
   * the oldest outstanding jobs first and the archive fills in across runs.
   *
   * A sweep that threw for any *other* reason is still `failed`.
   */
  outstanding = 0,
  /**
   * Jobs this sweep completed, whichever run enqueued them.
   *
   * Counted separately from `counts` because the two answer different
   * questions. `counts` is "what happened to this run's jobs" and is written by
   * handlers keyed on the job's own `run_id`; this is "what this sweep did with
   * its fifteen minutes". They diverge whenever a sweep drains an older run's
   * backlog, which — with a global claim ordered by age — is the normal case
   * while a large archive fills in.
   */
  processed = 0,
): RunStatus {
  const work =
    SUCCESS_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0) + processed;
  const errors = FAILURE_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0);
  if (threw) return "failed";
  if (outstanding > 0) {
    // Deadline reached. Only a run that achieved nothing at all is a failure —
    // that one really did not work.
    return work === 0 ? "failed" : "partial";
  }
  if (work === 0) return "failed";
  return errors > 0 ? "partial" : "succeeded";
}

/**
 * The sweep ran out of clock with jobs still queued.
 *
 * A distinct type rather than a string match on the message, so `runSweep` can
 * tell "the box was too small for the work" from "something broke" without
 * parsing English.
 */
export class SweepDeadlineReached extends Error {
  constructor(
    readonly outstanding: number,
    timeoutMs: number,
    /** Jobs this sweep completed before the clock ran out, from any run. */
    readonly processed = 0,
  ) {
    super(
      `sweep reached its ${timeoutMs}ms deadline with ${outstanding} job(s) still queued ` +
        `after completing ${processed}`,
    );
    this.name = "SweepDeadlineReached";
  }
}

export class SourceScheduler {
  private readonly logger: SchedulerLogger;
  private readonly enabled: boolean;
  private readonly lookbackDays: number;
  private readonly sweepTimeoutMs: number;
  private readonly now: () => Date;
  private readonly tasks = new Map<string, CronTask>();
  private readonly inFlight = new Set<string>();
  private cron: CronModule | null;
  private started = false;
  private lastOutcomeBySource = new Map<string, SweepOutcome>();

  constructor(
    private readonly db: Knex,
    private readonly options: SourceSchedulerOptions,
  ) {
    this.logger = options.logger ?? consoleLogger;
    this.enabled = options.enabled ?? schedulerEnabled();
    this.lookbackDays = options.lookbackDays ?? 365;
    this.sweepTimeoutMs = options.sweepTimeoutMs ?? 15 * 60 * 1000;
    this.now = options.now ?? ((): Date => new Date());
    this.cron = options.cron ?? null;
  }

  get running(): boolean {
    return this.started;
  }

  /** Sources currently scheduled, and when each next fires. */
  getStatus(): {
    enabled: boolean;
    running: boolean;
    sources: Array<{ sourceId: string; nextRun: Date | null; lastOutcome: SweepOutcome | null }>;
  } {
    const sources = [...this.tasks.entries()].map(([sourceId, task]) => ({
      sourceId,
      nextRun: task.getNextRun(),
      lastOutcome: this.lastOutcomeBySource.get(sourceId) ?? null,
    }));
    return { enabled: this.enabled, running: this.started, sources };
  }

  /**
   * Schedules every enabled source. **Sweeps nothing.**
   *
   * The first execution of any source is its first cron tick. This is the
   * boot-safety rule, and it is why `start()` is not allowed to look convenient
   * by "catching up" a source that looks overdue.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.enabled) {
      this.logger.info("SourceScheduler: disabled (SCHEDULER_ENABLED / NODE_ENV), scheduling nothing");
      return;
    }

    const cron = await this.loadCron();
    if (cron === null) {
      this.logger.error("SourceScheduler: node-cron unavailable, no source will sweep");
      return;
    }

    const sources = await this.loadSources();
    for (const source of sources) {
      if (!this.options.registry.has(source.adapterKey)) {
        this.logger.warn(
          `SourceScheduler: source ${source.id} names adapter '${source.adapterKey}', which is not registered — not scheduled`,
        );
        continue;
      }
      if (!cron.validate(source.cronExpression)) {
        this.logger.error(
          `SourceScheduler: source ${source.id} has an invalid cron expression '${source.cronExpression}' — not scheduled`,
        );
        continue;
      }
      const task = cron.schedule(
        source.cronExpression,
        () => {
          this.sweepSource(source.id).catch((error: unknown) => {
            // A sweep must never take the process down. The run row already
            // carries the truth; this is the last line of defence.
            this.logger.error(
              `SourceScheduler: sweep of ${source.id} threw outside its run — ${errorMessage(error)}`,
            );
          });
        },
        { timezone: "UTC", name: `source:${source.id}`, noOverlap: true },
      );
      this.tasks.set(source.id, task);
      this.logger.info(
        `SourceScheduler: ${source.adapterKey} (${source.id}) scheduled '${source.cronExpression}' UTC`,
      );
    }

    this.started = true;
    this.logger.info(
      `SourceScheduler: started with ${this.tasks.size} source(s); first sweep is on the first tick, not now`,
    );
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      void task.stop();
      void task.destroy();
    }
    this.tasks.clear();
    this.started = false;
  }

  /**
   * Re-read the enabled set and re-arm.
   *
   * `start()` reads `ingestion_sources` exactly once, so a source enabled at
   * runtime had no cron task until the next deploy — which would make the
   * console's toggle mean "sweeps nightly, eventually", and would be discovered
   * by an operator wondering why nothing happened overnight.
   *
   * Sweeps nothing, exactly like `start()`. Re-arming is not a reason to break
   * the boot-safety rule: the first execution of a newly enabled source is
   * still its first cron tick, or an explicit **Sweep now**.
   */
  async refresh(): Promise<void> {
    this.stop();
    await this.start();
  }

  private async loadCron(): Promise<CronModule | null> {
    if (this.cron !== null) return this.cron;
    try {
      const imported: unknown = await import("node-cron");
      const candidate = isRecord(imported) && isRecord(imported.default) ? imported.default : imported;
      if (!isCronModule(candidate)) return null;
      this.cron = candidate;
      return candidate;
    } catch {
      return null;
    }
  }

  /** Enabled sources with their cadence. */
  async loadSources(): Promise<SourceRow[]> {
    const rows: unknown = await this.db("ingestion_sources")
      .where({ enabled: true })
      .select("id", "adapter_key", "cron_expression", "enabled", "expected_interval_hours");
    return (Array.isArray(rows) ? rows : []).map(parseSourceRow);
  }

  /**
   * One sweep of one source, end to end.
   *
   * Also the entry point a console "sweep now" button will use, which is why it
   * is public and why it takes no cron context.
   */
  /** Whether this process is already sweeping that source. */
  isSweeping(sourceId: string): boolean {
    return this.inFlight.has(sourceId);
  }

  async sweepSource(sourceId: string): Promise<SweepOutcome> {
    if (this.inFlight.has(sourceId)) {
      // In-process guard. The advisory lock below is the real one — it also
      // covers a second container — but refusing here avoids opening a
      // transaction to be told what we already know.
      this.logger.warn(`SourceScheduler: sweep of ${sourceId} already in flight in this process`);
      return this.remember({ kind: "skipped", reason: "locked", sourceId });
    }
    this.inFlight.add(sourceId);
    try {
      return await this.sweepLocked(sourceId);
    } finally {
      this.inFlight.delete(sourceId);
    }
  }

  private async sweepLocked(sourceId: string): Promise<SweepOutcome> {
    // The transaction exists to pin one connection for the advisory lock's
    // lifetime, and for nothing else: the sweep's own writes go through `this.db`
    // so that a crash mid-sweep leaves the records it already ingested rather
    // than rolling back a night's work. `pg_try_advisory_xact_lock` releases on
    // commit or on connection loss, so a killed process never leaves a source
    // wedged.
    return this.db.transaction(async (trx) => {
      const locked: unknown = await trx.raw(
        "SELECT pg_try_advisory_xact_lock(?, ?) AS locked",
        [SOURCE_LOCK_NAMESPACE, sourceLockKey(sourceId)],
      );
      const row = isRecord(locked) && Array.isArray(locked.rows) ? locked.rows[0] : undefined;
      if (!isRecord(row) || row.locked !== true) {
        this.logger.warn(
          `SourceScheduler: another sweep holds the lock for source ${sourceId}; this tick does nothing`,
        );
        return this.remember({ kind: "skipped", reason: "locked", sourceId });
      }
      return this.runSweep(sourceId);
    });
  }

  private async runSweep(sourceId: string): Promise<SweepOutcome> {
    const source: unknown = await this.db("ingestion_sources").where({ id: sourceId }).first();
    if (!isRecord(source)) {
      this.logger.error(`SourceScheduler: no ingestion_sources row ${sourceId}`);
      return this.remember({ kind: "skipped", reason: "unknown-source", sourceId });
    }
    const parsed = parseSourceRow(source);
    if (!parsed.enabled) {
      this.logger.info(`SourceScheduler: source ${sourceId} is disabled; nothing swept`);
      return this.remember({ kind: "skipped", reason: "disabled", sourceId });
    }

    // The run row is written BEFORE any work, so a sweep that dies on its first
    // request is still visible as a sweep that happened and failed — not as a
    // quiet night.
    const inserted: unknown = await this.db("ingestion_runs")
      .insert({ source_id: sourceId, status: "running", counts: "{}" })
      .returning("id");
    const runRow = Array.isArray(inserted) ? inserted[0] : undefined;
    if (!isRecord(runRow) || typeof runRow.id !== "string") {
      throw new Error("ingestion_runs: insert returned no id");
    }
    const runId = runRow.id;

    let threw: string | null = null;
    let outstanding = 0;
    let processed = 0;
    try {
      const since = new Date(this.now().getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);
      await this.options.queue.enqueue("discover", { since: since.toISOString() }, runId);
      processed = await this.drain(runId);
    } catch (error) {
      if (error instanceof SweepDeadlineReached) {
        // Not an error. The sweep did as much as its clock allowed, and the
        // rest stays queued for the next drain. Recorded, never as `error`:
        // the sources screen reads that column to decide a source is failing.
        outstanding = error.outstanding;
        processed = error.processed;
        this.logger.info(
          `SourceScheduler: sweep ${runId} of ${sourceId} reached its deadline with ` +
            `${outstanding} job(s) queued; they carry over to the next drain`,
        );
      } else {
        threw = errorMessage(error);
        this.logger.error(`SourceScheduler: sweep ${runId} of ${sourceId} failed — ${threw}`);
      }
    }

    let matterError: string | null = null;
    const counts = await this.readCounts(runId);
    if (outstanding > 0) counts.outstanding = outstanding;
    // Always recorded, including zero: "this sweep completed no jobs" is a fact
    // worth being able to read, and its absence would be indistinguishable from
    // an older run written before this column meant anything.
    counts.processed = processed;

    // Matters are a projection of `agenda_items`, and this is where they are
    // brought up to date.
    //
    // **Once per sweep, not once per parse.** `rebuildMatters` scans the whole
    // of `agenda_items` in date order, deliberately: that ordering is what makes
    // a matter's title the *earliest* wording rather than whichever document
    // happened to be parsed first. Calling it per document would cost a full
    // scan per document — quadratic across a sweep that fetches hundreds — and
    // scoping it to one meeting to avoid that would give up the determinism the
    // full scan buys. A sweep is the natural boundary: many documents in, one
    // projection out.
    //
    // Skipped when the sweep wrote no agenda items, which is the common case for
    // a re-sweep that found nothing changed. An unchanged corpus projects to an
    // unchanged set of matters, so the scan would be pure cost.
    if ((counts.agenda_items_written ?? 0) > 0) {
      try {
        const rebuilt = await rebuildMatters(this.db);
        counts.matters = rebuilt.matters;
        counts.matter_appearances = rebuilt.appearances;
      } catch (error) {
        // Recorded, never swallowed — but it does not make the sweep `failed`,
        // and `threw` is deliberately left alone. The records reached the
        // database; only the view over them is stale, and telling an operator
        // their ingestion failed when it succeeded would send them looking in
        // the wrong place. The next sweep that writes an item rebuilds it.
        matterError = `matters projection failed — ${errorMessage(error)}`;
        this.logger.error(`SourceScheduler: sweep ${runId} of ${sourceId} ${matterError}`);
      }
    }

    const jobErrors = await this.readJobErrors(runId);
    const status = classifyRun(counts, threw !== null, outstanding, processed);
    const errorText = [threw, ...jobErrors, matterError].filter(
      (value): value is string => value !== null && value !== "",
    );

    await this.db("ingestion_runs")
      .where({ id: runId })
      .update({
        status,
        finished_at: this.db.fn.now(),
        // Written back because `outstanding` is added here, not by a handler.
        // Without this the number the operator most needs — how much is left —
        // would exist only in a log line.
        counts: JSON.stringify(counts),
        // Nothing is swallowed: every error the sweep produced is in the row.
        error: errorText.length > 0 ? errorText.join("\n") : null,
        updated_at: this.db.fn.now(),
      });

    await this.updateSourceHealth(sourceId, status);

    this.logger.info(
      `SourceScheduler: sweep ${runId} of ${sourceId} finished ${status} — ${JSON.stringify(counts)}`,
    );
    return this.remember({
      kind: "ran",
      sourceId,
      runId,
      status,
      counts,
      error: errorText.length > 0 ? errorText.join("\n") : null,
    });
  }

  /** Turns the worker until this run has no claimable work left, or time runs out. */
  /**
   * Turns the worker until this run has no claimable work left, or time runs
   * out. Returns how many jobs this sweep actually completed.
   *
   * That return value matters more than it looks. `ingestion_runs.counts` is
   * written by the handlers against **the run that enqueued the job**, while
   * `CLAIM_SQL` carries no `run_id` filter and takes the oldest pending work
   * anywhere. Those two facts are individually right and together produce a
   * trap: a sweep that spends its whole life draining an *earlier* run's
   * backlog credits every count to that earlier run and finishes with its own
   * `counts` empty.
   *
   * Bozeman's second sweep did exactly that on 2026-08-11 — it processed 250
   * queued jobs, took the site from 179 records to 358, and recorded
   * `records: 0` against itself, which then classified as `failed` because no
   * work appeared to have been done. The global claim is correct and is what
   * makes a backlog finish across runs; what was missing was the sweep
   * counting its own labour.
   *
   * A second, sharper trap sits behind that one: the same unfiltered claim
   * that lets a backlog finish across runs also lets it starve a *new*
   * source's very first job. `CLAIM_SQL` orders oldest-first with no run
   * filter, so a source with a large standing backlog (Bozeman) can occupy
   * every claim in a sweep meant for a different, brand-new source
   * (Gallatin) — whose own `discover` job, being the newest row in the
   * table, is claimed last and never reached before the deadline. That sweep
   * then reports `outstanding: 1` forever and, because `processed` climbed
   * from the *other* source's work, classifies as `partial` — healthy —
   * while the new source has never ingested a single record.
   *
   * The fix is two phases inside the same deadline, not a different claim:
   *
   *   Phase 1 — this run's own jobs first, via the run-scoped claim
   *   (`CLAIM_RUN_SQL`). This is what guarantees a new source's `discover`
   *   actually executes, however large another source's backlog is.
   *
   *   Phase 2 — once phase 1 has nothing more of its own to claim, whatever
   *   deadline budget remains goes to the original, unscoped claim, so a
   *   large archive still fills in across sweeps exactly as before.
   */
  private async drain(runId: string): Promise<number> {
    const deadline = Date.now() + this.sweepTimeoutMs;
    let processed = 0;

    // Phase 1: this run's own jobs first, so a new source's discover job is
    // never starved by an older source's backlog.
    for (;;) {
      const ownOutstanding = await this.countOutstanding(runId);
      if (ownOutstanding === 0) break;
      if (Date.now() > deadline) {
        throw new SweepDeadlineReached(ownOutstanding, this.sweepTimeoutMs, processed);
      }
      const tick = await this.options.worker.runOnce({ runId });
      processed += tick.completed;
      if (tick.claimed === 0) {
        // Own jobs remain, but none are claimable right now (e.g. waiting on
        // a retry backoff). Fall through to phase 2; the next drain picks
        // them up once they are due.
        break;
      }
    }

    // Phase 2: help drain the global backlog with whatever budget remains —
    // the original, unscoped claim, run for as long as there is deadline left
    // and something claimable. Not gated on this run's own outstanding count:
    // once phase 1 has finished this run's own work, leftover budget is spent
    // helping another source's backlog rather than sitting idle, which is how
    // a large archive keeps filling in across sweeps.
    for (;;) {
      if (Date.now() > deadline) break;
      const tick = await this.options.worker.runOnce();
      processed += tick.completed;
      if (tick.claimed === 0) {
        // Nothing claimable anywhere right now — everything left is waiting
        // on a retry backoff. Nothing more this sweep can usefully do.
        break;
      }
    }

    // Only this run's own outstanding work can make a sweep `partial` rather
    // than `succeeded`; a global backlog left behind after helping is not
    // this run's failure to report.
    const outstanding = await this.countOutstanding(runId);
    if (outstanding > 0 && Date.now() > deadline) {
      throw new SweepDeadlineReached(outstanding, this.sweepTimeoutMs, processed);
    }
    return processed;
  }

  private async countOutstanding(runId: string): Promise<number> {
    const row: unknown = await this.db("ingestion_jobs")
      .where({ run_id: runId })
      .whereIn("status", ["pending", "running"])
      .count({ total: "*" })
      .first();
    if (!isRecord(row)) return 0;
    const total = Number(row.total);
    return Number.isFinite(total) ? total : 0;
  }

  private async readCounts(runId: string): Promise<Record<string, number>> {
    const row: unknown = await this.db("ingestion_runs").where({ id: runId }).first("counts");
    if (!isRecord(row) || !isRecord(row.counts)) return {};
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(row.counts)) {
      if (typeof value === "number") counts[key] = value;
    }
    return counts;
  }

  /** The `last_error` of every job in this run that did not finish clean. */
  private async readJobErrors(runId: string): Promise<string[]> {
    const rows: unknown = await this.db("ingestion_jobs")
      .where({ run_id: runId })
      .whereIn("status", ["failed", "blocked"])
      .whereNotNull("last_error")
      .select("stage", "last_error");
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      if (!isRecord(row) || typeof row.last_error !== "string") return [];
      return [`${String(row.stage)}: ${row.last_error}`];
    });
  }

  /**
   * Records what the sweep did to the source's standing.
   *
   * `partial` counts as a success for `last_success_at`: work reached the
   * database, and treating it as silence would make the silence watch cry wolf.
   * It does not reset `consecutive_failures` to zero, because a source failing
   * partially every night is a source with a problem.
   */
  private async updateSourceHealth(sourceId: string, status: RunStatus): Promise<void> {
    if (status === "succeeded") {
      await this.db("ingestion_sources").where({ id: sourceId }).update({
        last_success_at: this.db.fn.now(),
        consecutive_failures: 0,
        health_status: "healthy",
        updated_at: this.db.fn.now(),
      });
      return;
    }
    if (status === "partial") {
      await this.db("ingestion_sources")
        .where({ id: sourceId })
        .update({
          last_success_at: this.db.fn.now(),
          health_status: "degraded",
          updated_at: this.db.fn.now(),
        });
      return;
    }
    await this.db("ingestion_sources")
      .where({ id: sourceId })
      .update({
        consecutive_failures: this.db.raw("consecutive_failures + 1"),
        health_status: "degraded",
        updated_at: this.db.fn.now(),
      });
  }

  private remember(outcome: SweepOutcome): SweepOutcome {
    this.lastOutcomeBySource.set(outcome.sourceId, outcome);
    return outcome;
  }
}
