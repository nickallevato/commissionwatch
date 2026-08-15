import type { Knex } from "knex";
import { errorMessage } from "../ingestion/queue";
import { SOURCE_LOCK_NAMESPACE, sourceLockKey } from "../ingestion/scheduler";
import { featureEnabled } from "../features/registry";
import { takeSnapshot } from "./archive";

/**
 * The thing that finally calls `takeSnapshot`.
 *
 * The dated export archive shipped in 0.4.0 with a writer nothing invoked.
 * `npm run export:snapshot` is a manual command; no scheduler, no queue stage
 * and no cron ran it, so the archive answered 404 for every date and would have
 * held exactly one snapshot — taken the day somebody tested it. A feature whose
 * only entry point is a human remembering a command is a feature with one row in
 * it.
 *
 * Five properties are load-bearing here.
 *
 * 1. **The gate is the existing `dated_export_archive` key**, read **per cycle**.
 *    Not latched in the constructor: that exact bug — a console toggle that never
 *    reached a running loop — was found in the drain and the prerender consumer in
 *    0.4.0, and `EventDrain.enabled` documents the fix this copies.
 * 2. **A skipped cycle is recorded.** A gated loop that does nothing quietly is
 *    indistinguishable from a broken one, and "failures are disclosed, not
 *    swallowed" is a project invariant. Every cycle lands in
 *    `export_snapshot_runs`, skips and failures included, and the operator console
 *    reads those rows.
 * 3. **One snapshot per UTC day, and a second cycle that day is a no-op** — not a
 *    duplicate and not an error. The day is the archive's own unit of address, so
 *    it is the unit of idempotence too.
 * 4. **A Postgres advisory lock, not an in-process flag.** Two backend containers
 *    both wake on their own timer, and a read-then-write same-day check races
 *    between them. `pg_try_advisory_xact_lock` is the idiom `SourceScheduler`
 *    already uses for "one sweep per source at a time", and the namespace is
 *    shared with it so this cannot collide with an unrelated lock in the database.
 * 5. **Nothing snapshots on process start.** `start()` arms the timer and takes
 *    nothing; the first snapshot is the first tick. Same rule as
 *    `SourceScheduler.start`, for the same reason — a crash-looping container must
 *    not turn a boot into a workload.
 *
 * ## Why an interval and not a cron expression
 *
 * A daily cron fires at one instant, so a container that happens to be
 * restarting then misses the day entirely and nothing notices until a reader
 * asks for that date. This wakes hourly and asks "has today been recorded yet",
 * which makes a restart cost at most an hour of lateness and never a lost day.
 * The cadence is therefore a property of the data — one snapshot per UTC day —
 * rather than of a clock the deploy has to hit.
 */

export type SnapshotRunOutcome =
  | "taken"
  | "skipped_disabled"
  | "skipped_same_day"
  | "skipped_locked"
  | "failed";

export interface SnapshotRun {
  /** `YYYY-MM-DD`, UTC, as the archive addresses a day. */
  run_day: string;
  outcome: SnapshotRunOutcome;
  /** Cycles that reached this outcome on this day. */
  cycles: number;
  first_at: Date;
  last_at: Date;
  snapshot_id: string | null;
  detail: string | null;
}

export interface SnapshotTickResult {
  day: string;
  outcome: SnapshotRunOutcome;
  snapshotId: string | null;
  detail: string;
}

export interface SnapshotSchedulerLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface SnapshotSchedulerOptions {
  /** Overrides the `dated_export_archive` resolution, as the drain's does. */
  enabled?: boolean;
  /** How often to ask whether today has been recorded. Default one hour. */
  intervalMs?: number;
  /** Injected for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: SnapshotSchedulerLogger;
}

/** Hourly. See the header: the day is the cadence, this is only the polling rate. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The lock key, in `SourceScheduler`'s namespace.
 *
 * Derived from a string the way a source's key is, rather than a hand-picked
 * integer, so it cannot silently equal a source id's key — and sharing the
 * namespace is what keeps every CommissionWatch advisory lock in one space
 * instead of two that can collide with each other.
 */
export const SNAPSHOT_LOCK_KEY = sourceLockKey("export-snapshot");

const consoleLogger: SnapshotSchedulerLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

/**
 * The `dated_export_archive` switch, defaulting to **off**, resolved through the
 * registry exactly as `/api/data/archive` resolves it.
 *
 * One key for the whole feature, deliberately: with the flag off the archive
 * paths 404, so a snapshot taken then would be a recording nothing can serve and
 * a row about a day no reader can address. Turning the key on is the single act
 * that starts both recording and serving.
 *
 * The manual `npm run export:snapshot` still ignores the flag, and that stays
 * true — an operator preparing to turn the archive on needs to be able to start
 * recording by hand first. The flag gates the *loop*, which is the same division
 * `PrerenderConsumer.enabled` and `prerender-rebuild.ts` draw.
 */
export function datedExportArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return featureEnabled("dated_export_archive", env);
}

/** The UTC day a moment falls in, in the archive's own `YYYY-MM-DD` form. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new TypeError(`export_snapshot_runs.${field}: expected a timestamp`);
}

function asOutcome(value: unknown): SnapshotRunOutcome {
  // The table's CHECK is the authority; this narrows the row without asserting.
  switch (value) {
    case "taken":
    case "skipped_disabled":
    case "skipped_same_day":
    case "skipped_locked":
    case "failed":
      return value;
    default:
      throw new TypeError(`export_snapshot_runs.outcome: unknown outcome ${String(value)}`);
  }
}

export function parseSnapshotRun(raw: unknown): SnapshotRun {
  if (!isRecord(raw)) throw new TypeError("export_snapshot_runs: expected a row object");
  const cycles = Number(raw.cycles);
  if (!Number.isFinite(cycles)) {
    throw new TypeError("export_snapshot_runs.cycles: expected a number");
  }
  return {
    run_day: String(raw.run_day),
    outcome: asOutcome(raw.outcome),
    cycles,
    first_at: asDate(raw.first_at, "first_at"),
    last_at: asDate(raw.last_at, "last_at"),
    snapshot_id: typeof raw.snapshot_id === "string" ? raw.snapshot_id : null,
    detail: typeof raw.detail === "string" ? raw.detail : null,
  };
}

/**
 * Records one cycle's outcome, collapsing repeats of the same outcome on the
 * same day into one row with a count and a last-seen time.
 *
 * The upsert is the whole concurrency story: two containers reaching the same
 * outcome in the same second produce one row with `cycles = 2`, because the
 * unique index over `(run_day, outcome)` turns the second insert into an update
 * rather than into a duplicate or an error.
 */
export async function recordSnapshotRun(
  db: Knex,
  entry: {
    day: string;
    outcome: SnapshotRunOutcome;
    snapshotId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  await db("export_snapshot_runs")
    .insert({
      run_day: entry.day,
      outcome: entry.outcome,
      snapshot_id: entry.snapshotId ?? null,
      detail: entry.detail ?? null,
    })
    .onConflict(["run_day", "outcome"])
    .merge({
      cycles: db.raw("export_snapshot_runs.cycles + 1"),
      last_at: db.fn.now(),
      // The newest detail wins: for a repeated failure the current error is more
      // useful than the first one, and for a skip the two are identical.
      detail: entry.detail ?? null,
    });
}

/**
 * The ledger, newest day first. What the operator console reads.
 *
 * `run_day` is rendered by Postgres rather than parsed from a `date` column,
 * because node-pg turns a bare `date` into a JS `Date` at **local** midnight —
 * which for any host west of UTC is the previous day, on the one value the
 * archive uses as an address.
 */
export async function listSnapshotRuns(db: Knex, limit = 30): Promise<SnapshotRun[]> {
  const rows: unknown = await db("export_snapshot_runs")
    .orderBy([
      { column: "run_day", order: "desc" },
      { column: "last_at", order: "desc" },
    ])
    .limit(limit)
    .select(
      db.raw("to_char(run_day, 'YYYY-MM-DD') as run_day"),
      "outcome",
      "cycles",
      "first_at",
      "last_at",
      "snapshot_id",
      "detail",
    );
  return (Array.isArray(rows) ? rows : []).map(parseSnapshotRun);
}

/** The snapshot already recorded for a UTC day, or null. */
export async function snapshotTakenOn(
  db: Knex,
  day: string,
): Promise<{ id: string; taken_at: Date } | null> {
  const row = await db("export_snapshots")
    .where("taken_at", ">=", new Date(`${day}T00:00:00.000Z`))
    .where("taken_at", "<=", new Date(`${day}T23:59:59.999Z`))
    .orderBy("taken_at", "desc")
    .first<{ id: string; taken_at: Date } | undefined>("id", "taken_at");
  return row ?? null;
}

export class ExportSnapshotScheduler {
  readonly intervalMs: number;

  private readonly logger: SnapshotSchedulerLogger;
  private readonly enabledOverride: boolean | null;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** What the last cycle saw. Null until a cycle has looked. */
  private observed: boolean | null = null;

  constructor(
    private readonly db: Knex,
    options: SnapshotSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.enabledOverride = options.enabled ?? null;
    this.now = options.now ?? ((): Date => new Date());
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * Read per cycle, not latched at construction — the reason `EventDrain.enabled`
   * gives at length. `options.enabled` still wins, so a suite can pin the loop
   * without a database row and without touching the environment.
   */
  get enabled(): boolean {
    return this.enabledOverride ?? datedExportArchiveEnabled();
  }

  /**
   * The current value, having logged any **change** in it.
   *
   * Transitions only. The durable record of a skipped cycle is the
   * `export_snapshot_runs` row, not a log line, so the log carries the two facts
   * a line is good at — "this started recording" and "this stopped".
   */
  private observeEnabled(): boolean {
    const enabled = this.enabled;
    if (this.observed === enabled) return enabled;
    const first = this.observed === null;
    this.observed = enabled;

    if (!enabled) {
      this.logger.warn(
        first
          ? "ExportSnapshotScheduler: disabled (the dated_export_archive feature is off); " +
              "no snapshot will be taken, and every skipped cycle is recorded in export_snapshot_runs"
          : "ExportSnapshotScheduler: disabled by the dated_export_archive feature; " +
              "no further snapshot will be taken",
      );
    } else if (!first) {
      this.logger.warn(
        "ExportSnapshotScheduler: enabled by the dated_export_archive feature; " +
          "today's snapshot is taken on the next cycle",
      );
    }
    return enabled;
  }

  /**
   * One cycle. Safe to call directly, and the timer calls nothing else.
   *
   * Never throws: a snapshot that fails is a `failed` row with its error text,
   * because a scheduler that takes the process down over a failed read of an
   * export is worse than one that says what went wrong and tries again in an
   * hour.
   */
  async tick(): Promise<SnapshotTickResult> {
    const day = utcDay(this.now());

    // The gate is here rather than only in the timer callback, so no caller —
    // not a script, not a future console button — can run a cycle that records
    // while the feature is off. Checked before the transaction opens, and the
    // skip is written rather than returned silently.
    if (!this.observeEnabled()) {
      return this.record({
        day,
        outcome: "skipped_disabled",
        snapshotId: null,
        detail:
          "the dated_export_archive feature is off, so no snapshot was taken and the archive " +
          "cannot answer for this day",
      });
    }

    try {
      return await this.db.transaction(async (trx) => {
        const locked: unknown = await trx.raw(
          "SELECT pg_try_advisory_xact_lock(?, ?) AS locked",
          [SOURCE_LOCK_NAMESPACE, SNAPSHOT_LOCK_KEY],
        );
        const row = isRecord(locked) && Array.isArray(locked.rows) ? locked.rows[0] : undefined;
        if (!isRecord(row) || row.locked !== true) {
          return this.record(
            {
              day,
              outcome: "skipped_locked",
              snapshotId: null,
              detail: "another process holds the snapshot lock; this cycle did nothing",
            },
            trx,
          );
        }

        // Forward-only and content-addressed semantics are `archive.ts`'s and are
        // not touched here: this asks only whether the day already has one.
        const existing = await snapshotTakenOn(trx, day);
        if (existing !== null) {
          return this.record(
            {
              day,
              outcome: "skipped_same_day",
              snapshotId: existing.id,
              detail: `a snapshot for ${day} was already taken at ${existing.taken_at.toISOString()}`,
            },
            trx,
          );
        }

        // The run row and the snapshot commit together, so the ledger cannot
        // claim a snapshot that rolled back.
        const { snapshot, datasets } = await takeSnapshot(trx, { note: null });
        const rows = datasets.reduce((total, dataset) => total + dataset.row_count, 0);
        return this.record(
          {
            day,
            outcome: "taken",
            snapshotId: snapshot.id,
            detail: `${datasets.length} dataset(s), ${rows} row(s)`,
          },
          trx,
        );
      });
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.error(`ExportSnapshotScheduler: cycle for ${day} failed — ${detail}`, error);
      try {
        // On `this.db`, not the transaction: that one rolled back, and a failure
        // recorded inside it would roll back with the failure it exists to
        // report.
        return await this.record({ day, outcome: "failed", snapshotId: null, detail });
      } catch (writeError) {
        // The database is the thing that is broken, so writing the ledger row
        // fails too. Logged, and the outcome still returned: a scheduler that
        // rethrows here would take the failure out of the one channel that is
        // still working — the log — and turn it into an unhandled rejection in
        // the timer.
        this.logger.error(
          `ExportSnapshotScheduler: could not record the failed cycle for ${day}`,
          writeError,
        );
        return { day, outcome: "failed", snapshotId: null, detail };
      }
    }
  }

  private async record(
    entry: {
      day: string;
      outcome: SnapshotRunOutcome;
      snapshotId: string | null;
      detail: string;
    },
    executor: Knex = this.db,
  ): Promise<SnapshotTickResult> {
    await recordSnapshotRun(executor, entry);
    return {
      day: entry.day,
      outcome: entry.outcome,
      snapshotId: entry.snapshotId,
      detail: entry.detail,
    };
  }

  /**
   * Arms the poll whether or not the feature is on, so a toggle needs no restart
   * — the correction 0.4.0 made to `EventDrain.start`, which used to return early
   * when disabled and so left no timer to notice the change.
   *
   * **Takes no snapshot here.** The first one is the first tick.
   */
  start(): void {
    this.observeEnabled();
    if (this.timer !== null) return;

    const timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((error: unknown) => {
          this.logger.error("ExportSnapshotScheduler: tick failed", error);
        })
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
