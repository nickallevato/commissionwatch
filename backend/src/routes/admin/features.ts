import { Router, type Request, type Response } from "express";
import db from "../../config/database";
import {
  featureKeys,
  killSwitchEnvName,
  type FeatureRisk,
} from "../../services/features/manifest";
import {
  FeatureRegistry,
  FeatureRegistryError,
  featurePollIntervalMs,
  getFeatureRegistry,
  killSwitchForcesOff,
} from "../../services/features/registry";
import { DEFAULT_DRAIN_INTERVAL_MS } from "../../services/events/drain";
import { DEFAULT_PRERENDER_INTERVAL_MS } from "../../services/prerender/consumer";

/**
 * `/api/admin/features` — the switch panel.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so every path here
 * 401s without a live session. That guard is load-bearing rather than
 * conventional: `PUT /:key` is the only thing in this product that can change
 * what a stranger can read without an operator touching Parameter Store, and
 * before this route existed the answer to "which features are live" was spread
 * across a compose file, an SSM SecureString and three source comments.
 *
 * **This route decides nothing about walls.** Every key it can write is a key in
 * the compiled manifest, and the manifest holds no key that gates the
 * publication wall, the review gate or the claim wall —
 * `feature-registry-audit.test.ts` is what keeps that true. There is no request
 * to this path that turns off a check.
 *
 * ## What `GET` reports, and why it reports the source
 *
 * Per feature: the resolved value, **which of the four steps decided it**, the
 * last change with its actor and reason, and this process's `loadedAt`. Naming
 * the deciding step is the point. An operator who flips a row, sees no change and
 * is told nothing concludes the console is broken and clicks again; an operator
 * who is told `kill-switch` goes and looks at `FEATURE_EVENT_DRAIN` in the deploy
 * config, which is where the answer actually is.
 *
 * `GET` refreshes the cache before it answers, so the console is the one reader
 * exempt from the five-second poll skew. A screen that shows the operator their
 * own write as not-yet-applied is a screen that invites a second write.
 */

const router = Router();

/**
 * The registry this route reads and writes.
 *
 * In production `src/index.ts` has installed the process singleton, and that is
 * deliberately the object used here: refreshing it on a console load also makes
 * the flag call sites in *this* process current, and `setFlag` updates the same
 * cache `mcpEnabled()` reads on the next request.
 *
 * With none installed — a suite that mounts this router without booting
 * `src/index.ts` — one is built over the default connection and reused. It is
 * never `start()`ed: this route refreshes explicitly on every `GET`, so a poller
 * here would be a second timer nothing stops, and a timer nothing stops is how a
 * test run hangs after its last assertion.
 */
let fallbackRegistry: FeatureRegistry | null = null;

function registryFor(): FeatureRegistry {
  const installed = getFeatureRegistry();
  if (installed !== null) return installed;
  fallbackRegistry ??= new FeatureRegistry(db);
  return fallbackRegistry;
}

/**
 * How long the loop behind a key waits between cycles, per key.
 *
 * Half of the honest answer to "how long until this takes effect": a process
 * polls the switch table on `pollIntervalMs`, and then the loop it gates notices
 * on its next cycle. The console adds the two and prints the number.
 *
 * **Imported from the loops, never re-declared here.** A copy of `10_000` in this
 * file would be right today and would go stale the day somebody changes the
 * consumer's interval — and it would go stale silently, on the screen whose job
 * is to say what is running and how long to wait. This project spent a section of
 * 0.3.0 on four surfaces that claimed to mirror something and had quietly
 * stopped; a hardcoded interval is the same defect with a longer fuse.
 *
 * A key absent from this map has no loop of its own. `mcp_server` resolves its
 * switch per request and adds nothing; the three keys with no consumer yet add
 * nothing because there is nothing yet to add. Absence is the honest answer in
 * both cases, and it is not the same as zero — the console renders it as "no
 * loop of its own" rather than as "instant".
 */
const CYCLE_INTERVAL_MS: Readonly<Record<string, number>> = {
  event_drain: DEFAULT_DRAIN_INTERVAL_MS,
  prerender: DEFAULT_PRERENDER_INTERVAL_MS,
};

/** The last change to a key, from the log rather than from the mirror on `features`. */
interface AuditRow {
  key: string;
  enabled_from: boolean | null;
  enabled_to: boolean;
  operator_id: string | null;
  operator_email: string | null;
  reason: string;
  created_at: Date;
}

interface LastChange {
  enabledFrom: boolean | null;
  enabledTo: boolean;
  operatorId: string | null;
  operatorEmail: string | null;
  reason: string;
  at: string;
}

interface FeatureView {
  key: string;
  title: string;
  description: string;
  risk: FeatureRisk;
  legacyEnv: string | null;
  requiresSeed: string | null;
  /** The variable that forces this key off, named so the operator can go find it. */
  killSwitchEnv: string;
  enabled: boolean;
  source: string;
  /** Null until this process has read `features`. Not the same fact as `enabled`. */
  loadedAt: string | null;
  /**
   * True when the environment is holding this key off. The console renders the
   * control disabled here, because a control that accepts a click and changes
   * nothing is worse than no control.
   */
  forcedOff: boolean;
  lastChange: LastChange | null;
}

/**
 * The most recent audit row per key, in one query.
 *
 * `DISTINCT ON` over `(key, created_at DESC, id DESC)` rides the index migration
 * 104 creates for exactly this question. `id DESC` breaks the tie because
 * `created_at` defaults to `now()`, which is the transaction timestamp — two
 * writes inside one transaction would share it, and the later row is the one that
 * describes the current state.
 */
async function lastChanges(): Promise<Map<string, LastChange>> {
  const rows = await db("features_audit as a")
    .leftJoin("operators as o", "o.id", "a.operator_id")
    .whereIn("a.key", [...featureKeys()])
    .distinctOn("a.key")
    .orderBy([
      { column: "a.key" },
      { column: "a.created_at", order: "desc" },
      { column: "a.id", order: "desc" },
    ])
    .select<AuditRow[]>(
      "a.key",
      "a.enabled_from",
      "a.enabled_to",
      "a.operator_id",
      "a.reason",
      "a.created_at",
      { operator_email: "o.email" },
    );

  const byKey = new Map<string, LastChange>();
  for (const row of rows) {
    byKey.set(row.key, {
      enabledFrom: row.enabled_from,
      enabledTo: row.enabled_to,
      operatorId: row.operator_id,
      // Null when the operator account has since been deleted: migration 104
      // sets the reference null rather than cascading, because losing the record
      // that the drain was turned on is worse than an anonymous row.
      operatorEmail: row.operator_email,
      reason: row.reason,
      at: row.created_at.toISOString(),
    });
  }
  return byKey;
}

function viewOf(
  registry: FeatureRegistry,
  changes: Map<string, LastChange>,
): FeatureView[] {
  return registry.resolveAll().map(({ definition, resolution }) => ({
    key: definition.key,
    title: definition.title,
    description: definition.description,
    risk: definition.risk,
    legacyEnv: definition.legacyEnv,
    requiresSeed: definition.requiresSeed,
    killSwitchEnv: killSwitchEnvName(definition.key),
    enabled: resolution.enabled,
    source: resolution.source,
    loadedAt: resolution.loadedAt === null ? null : resolution.loadedAt.toISOString(),
    forcedOff: killSwitchForcesOff(definition.key),
    lastChange: changes.get(definition.key) ?? null,
  }));
}

router.get("/", async (_req: Request, res, next) => {
  try {
    const registry = registryFor();
    // Read the table before answering. If it is unreachable this rejects and the
    // request 500s, which is the honest outcome: the audit query below would fail
    // too, and a console that renders every flag as "off, source: default"
    // because it could not reach Postgres would be actively misleading about a
    // screen whose whole job is to say what is on.
    await registry.refresh();

    res.json({
      features: viewOf(registry, await lastChanges()),
      // The two halves of the latency, served rather than assumed, so the console
      // prints a number that tracks the deploy config and the loops' own
      // constants instead of one somebody typed into the frontend.
      pollIntervalMs: featurePollIntervalMs(),
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  } catch (err) {
    next(err);
  }
});

interface SetBody {
  enabled?: unknown;
  reason?: unknown;
}

/**
 * Flip one switch, with a reason.
 *
 * The refusals are `FeatureRegistry.setFlag`'s and they arrive here carrying
 * their own status: unknown key 404, empty reason 400, no-op 409. Mapped by
 * `instanceof` in one place, the way `place-links.ts` maps `ReviewError` — a
 * refusal that surfaces as a 500 reads to the operator as a broken console
 * rather than as an answer.
 *
 * `enabled` is validated here rather than in the service because it is an HTTP
 * concern: a body of `{ enabled: "false" }` is a truthy string, and coercing it
 * would turn a client bug into an enable. There is no default — omitting the
 * field is a 400, not an off.
 *
 * A key the kill switch is holding off can still be written, and the response
 * says `source: "kill-switch"` so the console can show that the decision is
 * recorded and the environment is overriding it. Refusing the write instead would
 * make the console unable to record a decision that becomes live the moment the
 * deploy config drops the variable — but it does mean the row can be true while
 * the feature is off, which is why the response carries the resolution and not
 * just the value that was stored.
 */
router.put("/:key", async (req: Request<{ key: string }, unknown, SetBody>, res, next) => {
  try {
    const { enabled, reason } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean", statusCode: 400 });
      return;
    }
    if (typeof reason !== "string") {
      res.status(400).json({
        error: "reason is required: turning a feature on or off is a decision, and a decision has a reason",
        statusCode: 400,
      });
      return;
    }

    const registry = registryFor();
    const resolution = await registry.setFlag(
      req.params.key,
      enabled,
      req.operator?.id ?? null,
      reason,
    );

    res.json({
      key: req.params.key,
      enabled: resolution.enabled,
      source: resolution.source,
      loadedAt: resolution.loadedAt === null ? null : resolution.loadedAt.toISOString(),
      forcedOff: killSwitchForcesOff(req.params.key),
      lastChange: (await lastChanges()).get(req.params.key) ?? null,
    });
  } catch (err) {
    fail(res, err, next);
  }
});

function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof FeatureRegistryError) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

export default router;
