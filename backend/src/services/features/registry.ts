import type { Knex } from "knex";
import {
  FEATURES,
  type FeatureDefinition,
  type FeatureKey,
  featureDefinition,
  isFeatureKey,
  killSwitchEnvName,
} from "./manifest";

/**
 * Reads the switches, and is the only thing allowed to write them.
 *
 * ## The resolution order, and why it is that order
 *
 *   1. env kill switch   FEATURE_<UPPER_SNAKE_KEY>=false|0|no|off  →  OFF, always
 *   2. registry row      features.enabled                          →  that value
 *   3. legacy env        <legacyEnv>=true|1|yes|on                 →  ON
 *   4. default                                                     →  OFF
 *
 * Every failure mode falls the same way — off.
 *
 * **The kill switch outranks the database** because the scenario that most
 * demands turning a feature off is the one where the feature is hammering
 * Postgres, and a switch that needs a healthy database to say "stop" does not
 * work when it matters. `FEATURE_*=false` is honoured from the environment
 * alone, needs no query, cannot be overridden from the console, and survives a
 * restart because it lives in the deploy config — so an operator who has lost
 * the console still has a lever.
 *
 * It is **one-directional**. `FEATURE_EVENT_DRAIN=true` enables nothing; it is
 * not a switch, it is the absence of a kill switch. Forcing a feature on from
 * the environment would reintroduce exactly the untraceable enable this whole
 * design exists to remove, so a truthy `FEATURE_*` is logged as ineffective at
 * construction rather than obeyed.
 *
 * **The legacy env read stays** because `MCP_ENABLED`, `PRERENDER_ENABLED` and
 * `EVENT_DRAIN_ENABLED` are documented in `deploy/docker-compose.shared.yml`,
 * in `docs/STATUS.md` and in operator steps that are currently correct. With no
 * registry row present, behaviour is byte-identical to today — which is what
 * keeps the existing drain, consumer and MCP suites honest rather than
 * rewritten.
 *
 * ## Why the read path never queries
 *
 * `mcpEnabled()` is called on every request to `/mcp`. Making resolution async
 * would push a promise into that path. So the rows are cached in process,
 * `get()` and `resolve()` are synchronous and touch nothing but the cache, and a
 * poller refreshes every `FEATURE_POLL_INTERVAL_MS`. The backend and each worker
 * run their own poller, which is how a toggle reaches a process that did not
 * serve the request that made it. Five seconds of skew is acceptable for every
 * key in the manifest; it would not be acceptable for a wall, which is one more
 * reason walls are not in the manifest.
 *
 * **Before the first successful load nothing is enabled that env does not
 * enable.** The cache starts empty, a key absent from the cache falls straight
 * through to steps 3 and 4, and `start()` never awaits anything — so a process
 * that cannot reach the database enables nothing and still starts. `loadedAt`
 * stays null until a load succeeds and the console shows it, because "the switch
 * says on" and "this process has confirmed the switch says on" are different
 * facts.
 */

export type FeatureSource = "kill-switch" | "registry" | "legacy-env" | "default";

export interface FeatureResolution {
  enabled: boolean;
  /** Which of the four steps decided. The console names it. */
  source: FeatureSource;
  /** When this process last read the table, or null if it never has. */
  loadedAt: Date | null;
}

export interface FeatureRegistryLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface FeatureRegistryOptions {
  /** Read once, at construction, exactly like `eventDrainEnabled` reads it. */
  env?: NodeJS.ProcessEnv;
  /** Poll interval. Defaults to `FEATURE_POLL_INTERVAL_MS`, then to 5s. */
  intervalMs?: number;
  logger?: FeatureRegistryLogger;
}

export const DEFAULT_FEATURE_POLL_INTERVAL_MS = 5_000;

const TRUTHY = /^(1|true|yes|on)$/i;
const FALSEY = /^(0|false|no|off)$/i;

/** An HTTP status rides along so `routes/admin/features.ts` need not map these. */
export class FeatureRegistryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "FeatureRegistryError";
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}

/**
 * The poll interval from the environment.
 *
 * A garbage or non-positive value falls back to the default rather than
 * disabling the poller or spinning it: a typo in a deploy config must not be the
 * thing that stops toggles propagating, and it must not be the thing that opens
 * a query per millisecond either.
 */
export function featurePollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, "FEATURE_POLL_INTERVAL_MS");
  if (raw === null) return DEFAULT_FEATURE_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FEATURE_POLL_INTERVAL_MS;
  return Math.floor(parsed);
}

/**
 * Step 1, standalone: is this key forced off from the environment?
 *
 * Exported because it is the one step that holds with no registry, no database
 * and no process — `routes/admin/features.ts` asks it to decide whether to
 * render a control disabled, and a control that accepts a click and changes
 * nothing is worse than no control.
 */
export function killSwitchForcesOff(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = envValue(env, killSwitchEnvName(key));
  return raw !== null && FALSEY.test(raw);
}

function legacyEnvEnables(
  definition: FeatureDefinition,
  env: NodeJS.ProcessEnv,
): boolean {
  if (definition.legacyEnv === null) return false;
  const raw = envValue(env, definition.legacyEnv);
  // Only a truthy legacy value decides. `EVENT_DRAIN_ENABLED=false` falls
  // through to the default, which is the same answer by a shorter road — and
  // reporting the source as `default` there is honest: nothing enabled it.
  return raw !== null && TRUTHY.test(raw);
}

const consoleLogger: FeatureRegistryLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

interface FeatureRow {
  key: string;
  enabled: boolean;
}

export class FeatureRegistry {
  readonly intervalMs: number;

  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: FeatureRegistryLogger;

  /**
   * Only manifest keys, and only values this process read out of the database —
   * by a load or by its own committed write. A key absent here has no confirmed
   * row, which is exactly the "resolve through env and default only" state.
   *
   * Inert rows are dropped here, at the one place that reads the table, so no
   * caller downstream has to remember the rule.
   */
  private cache = new Map<FeatureKey, boolean>();
  private loaded: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(
    private readonly db: Knex,
    options: FeatureRegistryOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.intervalMs = options.intervalMs ?? featurePollIntervalMs(this.env);
    this.logger = options.logger ?? consoleLogger;

    // Said once, at startup, because the alternative is an operator setting
    // `FEATURE_MCP_SERVER=true`, seeing no change, and concluding the registry
    // is broken. The variable is a kill switch and has no on position.
    for (const definition of FEATURES) {
      const raw = envValue(this.env, killSwitchEnvName(definition.key));
      if (raw !== null && TRUTHY.test(raw)) {
        this.logger.warn(
          `FeatureRegistry: ${killSwitchEnvName(definition.key)}=${raw} has no effect. ` +
            "The FEATURE_* variables can only force a feature off; enable it from the " +
            "console so the change carries an operator and a reason.",
        );
      }
    }
  }

  /** When this process last read `features`. Null until it has. */
  get loadedAt(): Date | null {
    return this.loaded;
  }

  /* ----------------------------------------------------------------------
     Reading
     ---------------------------------------------------------------------- */

  /** The four steps, in order, against the cache. Synchronous by design. */
  resolve(key: FeatureKey): FeatureResolution {
    const definition = featureDefinition(key);

    if (killSwitchForcesOff(key, this.env)) {
      return { enabled: false, source: "kill-switch", loadedAt: this.loaded };
    }

    const row = this.cache.get(key);
    if (row !== undefined) {
      return { enabled: row, source: "registry", loadedAt: this.loaded };
    }

    if (legacyEnvEnables(definition, this.env)) {
      return { enabled: true, source: "legacy-env", loadedAt: this.loaded };
    }

    return { enabled: false, source: "default", loadedAt: this.loaded };
  }

  get(key: FeatureKey): boolean {
    return this.resolve(key).enabled;
  }

  /** Every manifest entry with its resolution, for the console. */
  resolveAll(): Array<{ definition: FeatureDefinition; resolution: FeatureResolution }> {
    return FEATURES.map((definition) => ({
      definition,
      resolution: this.resolve(definition.key),
    }));
  }

  /* ----------------------------------------------------------------------
     The poll
     ---------------------------------------------------------------------- */

  /**
   * Replaces the cache wholesale, so a deleted row stops deciding rather than
   * lingering as the last value this process happened to see.
   *
   * Rejects if the database is unreachable. That is deliberate: `setFlag` and
   * the admin route want to know, and the poller — the one caller that must
   * never propagate a failure — swallows it explicitly below.
   */
  async refresh(): Promise<void> {
    const rows = await this.db("features").select<FeatureRow[]>("key", "enabled");
    const next = new Map<FeatureKey, boolean>();
    for (const row of rows) {
      // The inertness rule. A row left behind by a rolled-back deploy names a
      // key this build does not have, and it does nothing — no error, no log
      // line per poll, no entry in the cache.
      if (isFeatureKey(row.key)) next.set(row.key, row.enabled === true);
    }
    this.cache = next;
    this.loaded = new Date();
  }

  /**
   * Arms the poll and kicks one refresh off without awaiting it.
   *
   * Nothing here blocks startup and nothing here throws into the caller: a
   * backend that cannot reach Postgres must still bind its port and serve its
   * health check, resolving every key through env and default while it cannot
   * see the table.
   */
  start(): void {
    if (this.timer === null) {
      const timer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
      timer.unref?.();
      this.timer = timer;
    }
    void this.tick();
  }

  private async tick(): Promise<void> {
    // Overlap guard, as in `EventDrain.start`: a refresh slower than the
    // interval must not queue a second one behind it.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.refresh();
    } catch (error) {
      // Logged, never rethrown, and the previous cache is left standing. Losing
      // contact with the table is not a reason to change any resolved value —
      // the operator's last known decision is a better answer than a guess.
      this.logger.error("FeatureRegistry: refresh failed; keeping the last known flags", error);
    } finally {
      this.refreshing = false;
    }
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /* ----------------------------------------------------------------------
     Writing
     ---------------------------------------------------------------------- */

  /**
   * Flips a switch and records who did it and why, in one transaction.
   *
   * One transaction because the two rows are one act: a `features` row whose
   * change has no audit entry is an untraceable enable, which is the thing this
   * design exists to remove, and an audit entry with no change is a lie about
   * what the system is doing. Neither is an acceptable half-state, so neither is
   * reachable.
   *
   * Three refusals:
   *
   *  - **an unknown key**, because writing a row for a key this build does not
   *    ship would look like a working switch and be inert;
   *  - **an empty reason**, for the reason `approveVoteEvent` gives — a decision
   *    has a reason, and this is a larger decision than approving one claim;
   *  - **a no-op**, so the audit log reads as a list of changes and not a list
   *    of clicks. No-op means a row already exists with this value. Writing
   *    `false` where there is no row at all is *not* a no-op: it records a
   *    decision to be off, which is a different fact from having defaulted off,
   *    and it is the write that overrides a legacy env var still saying on.
   */
  async setFlag(
    key: string,
    enabled: boolean,
    operatorId: string | null,
    reason: string,
  ): Promise<FeatureResolution> {
    if (!isFeatureKey(key)) {
      throw new FeatureRegistryError(
        `no such feature: ${key}. The manifest in this build is the authority on what a key ` +
          "means, and a row for an unknown key would do nothing.",
        404,
      );
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new FeatureRegistryError(
        "reason is required: turning a feature on or off is a decision, and a decision has a reason",
        400,
      );
    }

    await this.db.transaction(async (trx) => {
      // `FOR UPDATE` so two operators clicking at once serialise rather than
      // both reading the old value and both writing an audit row claiming the
      // same transition.
      const existing = await trx("features")
        .where({ key })
        .forUpdate()
        .first<FeatureRow | undefined>("key", "enabled");

      const from = existing === undefined ? null : existing.enabled === true;
      if (from === enabled) {
        throw new FeatureRegistryError(
          `${key} is already ${enabled ? "enabled" : "disabled"}`,
          409,
        );
      }

      if (existing === undefined) {
        await trx("features").insert({
          key,
          enabled,
          updated_by: operatorId,
          update_reason: trimmedReason,
          updated_at: trx.fn.now(),
        });
      } else {
        await trx("features").where({ key }).update({
          enabled,
          updated_by: operatorId,
          update_reason: trimmedReason,
          updated_at: trx.fn.now(),
        });
      }

      await trx("features_audit").insert({
        key,
        enabled_from: from,
        enabled_to: enabled,
        operator_id: operatorId,
        reason: trimmedReason,
      });
    });

    // Only after the commit. The operator's own next page load has to show what
    // they just did rather than stale state for up to a poll interval, which is
    // what invites a second click. Every other process learns on its next tick.
    this.cache.set(key, enabled);
    return this.resolve(key);
  }
}

/* --------------------------------------------------------------------------
   The process-wide instance
   -------------------------------------------------------------------------- */

/**
 * Installed by `src/index.ts` and read by the flag call sites.
 *
 * A settable module singleton rather than one built here from
 * `config/database`, for two reasons. A service in this codebase takes its
 * `Knex` from its caller — `EventDrain` and `PrerenderConsumer` both do — and
 * importing the default connection from a service would open a pool the moment
 * anything imported a flag check, including tests that have no database.
 *
 * The un-installed state is the important one: with no registry, `featureEnabled`
 * resolves through the kill switch, the legacy env var and the default, which is
 * byte-identical to what `eventDrainEnabled`, `prerenderEnabled` and
 * `mcpEnabled` did before this file existed. That is what lets the drain,
 * consumer and MCP suites pass unmodified.
 */
let installed: FeatureRegistry | null = null;

export function setFeatureRegistry(registry: FeatureRegistry | null): void {
  installed = registry;
}

export function getFeatureRegistry(): FeatureRegistry | null {
  return installed;
}

/**
 * The resolution a caller with no registry gets: steps 1, 3 and 4. Never step 2
 * — a process with no registry has confirmed nothing about the table and must
 * not pretend the absence of a row is a row saying off.
 *
 * `env` is honoured only on that path. An installed registry captured its
 * environment at construction and answers from that, because the cache it reads
 * was loaded under those variables and a per-call override would make two
 * callers in one process disagree about the same switch.
 */
export function resolveFeature(
  key: FeatureKey,
  env: NodeJS.ProcessEnv = process.env,
): FeatureResolution {
  const registry = installed;
  if (registry !== null) return registry.resolve(key);

  if (killSwitchForcesOff(key, env)) {
    return { enabled: false, source: "kill-switch", loadedAt: null };
  }
  if (legacyEnvEnables(featureDefinition(key), env)) {
    return { enabled: true, source: "legacy-env", loadedAt: null };
  }
  return { enabled: false, source: "default", loadedAt: null };
}

export function featureEnabled(
  key: FeatureKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveFeature(key, env).enabled;
}
