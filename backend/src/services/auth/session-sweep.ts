/**
 * The thing that finally calls `OperatorAuthService.sweepExpiredSessions`.
 *
 * That method existed since it was written and nothing called it: a repo-wide
 * search for its name found only its own definition and its own test. It is
 * not an auth bypass — `validateSession` already refuses anything past its
 * `idle_expires_at` or `absolute_expires_at`, so an unswept row cannot
 * authenticate anybody — but with nothing removing rows past
 * `absolute_expires_at`, `operator_sessions` grows forever. The retention
 * policy (`docs/superpowers/specs/2026-08-16-retention-policy.md` §4) already
 * states the fix: wire the existing method into the same scheduler mechanism
 * that drives the rest of this process, on a daily cadence.
 *
 * This copies the shape `ExportSnapshotScheduler` and `EventDrain` already
 * use for periodic work in this codebase, deliberately, rather than inventing
 * a fourth way to run a loop:
 *
 *  - a timer armed in `start()`, unconditionally, so a restart is never what
 *    re-enables the sweep;
 *  - nothing swept on boot — the first sweep is the first tick, so a
 *    crash-looping container cannot turn into a delete storm;
 *  - a `tick()` that never throws, so a sweep failure cannot take the process
 *    down. A site that still serves every record with one stale table beats
 *    a site that will not start because deleting old sessions failed;
 *  - `stop()` clears the timer and nothing else needs to unwind, because a
 *    sweep is one statement with no partial state to roll back.
 *
 * Unlike `ExportSnapshotScheduler` this has no feature flag to re-read per
 * cycle. Sweeping expired sessions is table hygiene, not a capability an
 * operator turns on for readers — there is nothing to gate.
 *
 * ## Disclosure
 *
 * A cycle that removed nothing logs nothing. A cycle that removed rows logs
 * one line naming the count. The alternative — a line every cycle, including
 * every "removed 0" — is exactly the kind of log a person learns to skip
 * past, and this defect existed for however long it did partly because a
 * missing sweep produced no signal at all; a present-but-silent sweep should
 * not produce noise instead. A failure is different: it is always logged,
 * with the error, because "failures are disclosed, not swallowed" holds
 * regardless of how routine the failing operation was.
 */

export interface SessionSweeperLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** Just enough of `OperatorAuthService` to drive the sweep. */
export interface SessionSweepable {
  sweepExpiredSessions(): Promise<number>;
}

export interface SessionSweepSchedulerOptions {
  /** How often to sweep. Default 24 hours — the retention policy's cadence. */
  intervalMs?: number;
  logger?: SessionSweeperLogger;
}

/** Daily. Session rows are cheap and nothing downstream needs them removed faster. */
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const consoleLogger: SessionSweeperLogger = {
  info: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
};

export class SessionSweepScheduler {
  readonly intervalMs: number;

  private readonly logger: SessionSweeperLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly auth: SessionSweepable,
    options: SessionSweepSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * One cycle. Safe to call directly, and the timer calls nothing else.
   *
   * Never throws — see the header. Returns the number of rows removed so a
   * caller (a test, or a future console button) can assert on it directly
   * rather than scraping the log.
   */
  async tick(): Promise<number> {
    try {
      const removed = await this.auth.sweepExpiredSessions();
      if (removed > 0) {
        this.logger.info(`SessionSweepScheduler: removed ${removed} expired operator session(s)`);
      }
      return removed;
    } catch (error) {
      this.logger.error("SessionSweepScheduler: sweep failed", error);
      return 0;
    }
  }

  /**
   * Arms the timer. Sweeps nothing here — the first sweep is the first tick,
   * matching `ExportSnapshotScheduler.start` and `SourceScheduler.start` for
   * the same reason: a crash-looping container must not turn a boot into a
   * workload.
   */
  start(): void {
    if (this.timer !== null) return;

    const timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick().finally(() => {
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
