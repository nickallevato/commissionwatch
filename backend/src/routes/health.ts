import { Router } from "express";
import os from "os";
import { promises as fsPromises } from "fs";
import db from "../config/database";
import { probeStorage, type StorageState } from "../services/storage";
import { lastOpsEventOccurredAt } from "../services/delivery/ops-events";

/**
 * Health, in two endpoints, because they answer two different questions and
 * conflating them is how an outage gets longer.
 *
 *   GET /api/health        readiness — can this process serve a correct
 *                          response right now? 200 when yes, 503 when no.
 *   GET /api/health/live   liveness — is the process running? Always 200.
 *
 * Until 2026-08-14 there was one endpoint and it returned `status: "ok"`
 * unconditionally: the `SELECT 1` failure was caught, recorded as
 * `database: "disconnected"`, and then ignored. There was no code path on which
 * `status` was anything but "ok". A monitor reading only the HTTP status would
 * have reported the site healthy for the whole of the 2026-08-09 outage, and
 * one was about to be pointed at it.
 *
 * Readiness now derives from the checks, and the failing case is a 503 rather
 * than a 200 with bad news in the body — a probe that has to parse JSON to
 * learn it is down is a probe half the tooling in the world cannot write.
 *
 * Liveness is separate and deliberately stupid. An orchestrator that restarts a
 * container because its database is unreachable has replaced a five-minute
 * database outage with a crash loop, and the container comes back to the same
 * missing database. Restart on "the process is wedged"; never on "a dependency
 * it does not own is down".
 */

interface DigestStatus {
  dailyLastRun: Date | null;
  weeklyLastRun: Date | null;
  running: boolean;
}

let digestStatusFn: (() => DigestStatus) | null = null;

export function registerDigestStatus(fn: () => DigestStatus): void {
  digestStatusFn = fn;
}

/**
 * No check may outlive the probe that called it.
 *
 * `deploy/docker-compose.shared.yml` gives the container healthcheck a five
 * second timeout. A connection to a blackholed host does not refuse, it hangs,
 * so an unbounded check turns "MinIO is unreachable" into "the healthcheck
 * never answered" — which is a different and much less legible failure.
 */
const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("check timed out")), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── Database ───────────────────────────────────────────────────────── */

async function checkDatabase(): Promise<"connected" | "disconnected"> {
  try {
    await withTimeout(db.raw("SELECT 1"));
    return "connected";
  } catch {
    return "disconnected";
  }
}

/* ── Migrations ─────────────────────────────────────────────────────── */

interface MigrationStatus {
  /** The numeric prefix of the last applied migration, or `"none"`. */
  version: string | null;
  /**
   * Migrations on disk that have not been applied. `null` means the count
   * could not be taken — see `readPending`.
   */
  pending: number | null;
}

/**
 * `knex.migrate.list()` is typed `Promise<any>`, so its shape is narrowed here
 * rather than asserted. Anything that is not the documented
 * `[completed, pending]` pair reports `null`, which is "not known", not "zero".
 */
function countPending(listed: unknown): number | null {
  if (!Array.isArray(listed) || listed.length < 2) return null;
  const pending: unknown = listed[1];
  return Array.isArray(pending) ? pending.length : null;
}

async function checkMigrations(): Promise<MigrationStatus> {
  let version: string | null = null;
  try {
    version = await withTimeout(db.migrate.currentVersion());
  } catch {
    return { version: null, pending: null };
  }

  // The pending count reads the migrations directory as well as the database,
  // and the production image ships the sources at a path relative to the
  // working directory. A directory that cannot be read is reported as unknown
  // and does not fail readiness; a *database* that is behind does.
  let pending: number | null = null;
  try {
    pending = countPending(await withTimeout(db.migrate.list()));
  } catch {
    pending = null;
  }

  return { version, pending };
}

/**
 * "Reachable but not migrated" is the crash-loop shape this project has already
 * hit: the entrypoint runs `knex migrate:latest` before the server listens, so a
 * migration that failed leaves an empty or half-built schema behind a process
 * that answers HTTP perfectly well and 500s every query.
 */
function migrationsHealthy(status: MigrationStatus): boolean {
  if (status.version === null || status.version === "none") return false;
  if (status.pending !== null && status.pending > 0) return false;
  return true;
}

/* ── Object storage ─────────────────────────────────────────────────── */

/**
 * MinIO holds the artifact bytes behind every citation, so its reachability is
 * worth reporting — but it is **not** a hard dependency of the read API. Every
 * public response is served from Postgres; MinIO is needed to ingest a document
 * and to hand one back. Taking the whole archive off the air because a document
 * download would fail is a worse outcome than serving the archive and saying so.
 * Readiness therefore reports `degraded`, and stays 200.
 *
 * The probe itself lives in `services/storage.ts`, beside the client it is
 * probing. It briefly lived here instead, with its own `Client` built from the
 * same five environment variables — which meant a health check that could go on
 * reporting "reachable" about a bucket the application had stopped writing to.
 * The timeout stays here, because it is a property of the probe's caller rather
 * than of storage.
 */
async function checkStorage(): Promise<StorageState> {
  try {
    return await withTimeout(probeStorage());
  } catch {
    // The only way out of `probeStorage` other than a verdict is the timeout,
    // and a store that will not answer inside two seconds is unreachable as far
    // as anything downstream of this is concerned.
    return "unreachable";
  }
}

/* ── Resources ──────────────────────────────────────────────────────── */

/**
 * Coarse disk/memory pressure — never raw bytes.
 *
 * `/api/health` is public and unauthenticated. Publishing exact free capacity
 * here would hand anyone watching a countdown to exactly how much data to send
 * to fill the disk, or how much load to throw at the process to force an OOM.
 * A coarse state lets `scripts/external-monitor.ts` alarm on the same class of
 * failure that went unnoticed on 2026-08-15 (see the module doc there) without
 * publishing a capacity map of a shared host. If you're tempted to add the raw
 * numbers back "for debugging", put them behind an authenticated admin route
 * instead — not here.
 *
 * `unknown` is distinct from the three real states: it means this process
 * could not read the figure at all (a missing `/proc`, a permissions error), as
 * opposed to having read it and found it fine. `scripts/external-monitor.ts`
 * treats anything other than `ok` | `low` | `critical` as `blocked` — an
 * absence must never be mistaken for a clean bill of health.
 */
export type ResourceState = "ok" | "low" | "critical" | "unknown";

export interface ResourcesStatus {
  disk: ResourceState;
  memory: ResourceState;
}

/**
 * Thresholds, as a percentage of capacity used.
 *
 * The deploy host is a shared `t4g.medium` — one EBS volume and one pool of
 * RAM behind Caddy, this backend, Postgres, MinIO and four other product
 * stacks (docs/superpowers/plans/2026-08-04-w4-public-launch.md) — so there is
 * no dedicated headroom to tune against; the margin has to assume the rest of
 * the host is doing its own thing at the same time. 80% ("low") is meant to
 * fire early enough that an operator has time to act before a build, a WAL
 * segment, or another stack's log file is what finally tips it over. 90%
 * ("critical") is deliberately close to full: the 2026-08-15 incident was the
 * disk actually filling, not sitting at some comfortable plateau, and a
 * threshold set lower than that would cry wolf on every busy build. Both are
 * overridable per-environment because these are a considered guess about a
 * shared host, not a promise about this application's own footprint.
 */
const DEFAULT_DISK_LOW_PERCENT = 80;
const DEFAULT_DISK_CRITICAL_PERCENT = 90;
const DEFAULT_MEMORY_LOW_PERCENT = 80;
const DEFAULT_MEMORY_CRITICAL_PERCENT = 90;

/** A percentage threshold from the environment, or the default if unset or unusable. */
function readPercentThreshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return fallback;
  return parsed;
}

function classify(usedPercent: number, lowPercent: number, criticalPercent: number): ResourceState {
  if (usedPercent >= criticalPercent) return "critical";
  if (usedPercent >= lowPercent) return "low";
  return "ok";
}

/**
 * Disk usage of the filesystem holding the process's working directory.
 *
 * `fs.statfs` reads the mount the container's root filesystem sits on. In
 * `deploy/docker-compose.shared.yml` that is an overlayfs backed directly by
 * the host's EBS volume — the backend container is given no disk quota of its
 * own — so on the deployment this monitor watches, this figure genuinely is
 * the host's disk, which is the thing that filled on 2026-08-15. That is a
 * property of this deployment's compose file, not a guarantee `fs.statfs`
 * itself makes: a deployment that did quota the container's writable layer
 * would make this check honestly report the quota instead, which is still the
 * correct answer to "how much room does this process have left".
 */
async function checkDisk(): Promise<ResourceState> {
  try {
    const stats = await withTimeout(fsPromises.statfs(process.cwd()));
    const total = Number(stats.blocks) * Number(stats.bsize);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return "unknown";
    const usedPercent = ((total - available) / total) * 100;
    return classify(
      usedPercent,
      readPercentThreshold("RESOURCE_DISK_LOW_PERCENT", DEFAULT_DISK_LOW_PERCENT),
      readPercentThreshold("RESOURCE_DISK_CRITICAL_PERCENT", DEFAULT_DISK_CRITICAL_PERCENT),
    );
  } catch {
    return "unknown";
  }
}

/**
 * The container's own memory ceiling, from cgroup v2, when one is visible.
 *
 * `memory.max` can legitimately read `"max"` — no ceiling configured — in
 * which case there is nothing to compute a percentage against, so this
 * returns `null` exactly as it does for a missing or unreadable file, and the
 * caller falls back to `os.totalmem()`/`os.freemem()`.
 */
async function readCgroupV2Memory(): Promise<{ current: number; max: number } | null> {
  try {
    const [maxRaw, currentRaw] = await Promise.all([
      fsPromises.readFile("/sys/fs/cgroup/memory.max", "utf8"),
      fsPromises.readFile("/sys/fs/cgroup/memory.current", "utf8"),
    ]);
    if (maxRaw.trim() === "max") return null;
    const max = Number(maxRaw.trim());
    const current = Number(currentRaw.trim());
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(current) || current < 0) return null;
    return { current, max };
  } catch {
    return null;
  }
}

/**
 * Memory pressure.
 *
 * **What this can honestly determine.** Where the cgroup v2 memory controller
 * is visible — as it is on the deploy host, which runs this container under
 * `mem_limit: 512m` — `memory.max`/`memory.current` are read directly. Those
 * are exactly this container's own ceiling and usage; they cannot be confused
 * with the host's.
 *
 * **Where it cannot.** Off that path — this dev machine, a cgroup v1 host, a
 * non-Linux OS, or a container runtime that hides `/sys/fs/cgroup` — this
 * falls back to `os.totalmem()`/`os.freemem()`, which read `/proc/meminfo` and
 * report the **host's** memory, not necessarily this container's. On a shared
 * host that is still a usable signal (the host running low is exactly the
 * 2026-08-15 failure mode), but it is not the same claim as the cgroup path,
 * and this comment is the place that says so rather than a report that quietly
 * conflates the two.
 */
async function checkMemory(): Promise<ResourceState> {
  const lowPercent = readPercentThreshold("RESOURCE_MEMORY_LOW_PERCENT", DEFAULT_MEMORY_LOW_PERCENT);
  const criticalPercent = readPercentThreshold("RESOURCE_MEMORY_CRITICAL_PERCENT", DEFAULT_MEMORY_CRITICAL_PERCENT);

  const cgroup = await readCgroupV2Memory();
  if (cgroup !== null) {
    return classify((cgroup.current / cgroup.max) * 100, lowPercent, criticalPercent);
  }

  const total = os.totalmem();
  const free = os.freemem();
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return "unknown";
  return classify(((total - free) / total) * 100, lowPercent, criticalPercent);
}

async function checkResources(): Promise<ResourcesStatus> {
  const [disk, memory] = await Promise.all([checkDisk(), checkMemory()]);
  return { disk, memory };
}

/* ── Backup freshness ──────────────────────────────────────────────── */

/**
 * When `deploy/backup.sh` last recorded a successful run, or `null` if it
 * never has.
 *
 * This process never runs the backup itself — `backup.sh` runs on the host
 * under cron and calls `docker exec … emit-ops-event.js`, which writes to
 * `ops_event_log` (migration `107_create_ops_event_log`). Reading that table
 * here is what lets `/api/health` — public, unauthenticated, and already the
 * one thing `scripts/external-monitor.ts` can reach from outside the box —
 * answer "has a backup ever succeeded" honestly, the same way `resources`
 * already answers "is the disk full" for a monitor that cannot read the host
 * directly.
 *
 * `null` is reported as `null`, not folded into a timestamp of convenience:
 * an absence here means no evidence exists, and the caller (the monitor's
 * `evaluateBackupFreshness`) is the one that decides that is `blocked`, never
 * `pass`.
 */
async function checkBackup(): Promise<{ lastSuccessAt: string | null }> {
  try {
    const at = await withTimeout(lastOpsEventOccurredAt(db, "ops.backup_succeeded"));
    return { lastSuccessAt: at?.toISOString() ?? null };
  } catch {
    // The table could not be read — an older schema mid-migration, or a
    // database blip already reflected elsewhere in this response. `null` is
    // still the honest answer: this process does not know of a success.
    return { lastSuccessAt: null };
  }
}

/* ── The routes ─────────────────────────────────────────────────────── */

const router = Router();

/**
 * Liveness. It touches nothing, so there is nothing it can report but "this
 * process is executing JavaScript", which is exactly the question.
 */
router.get("/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

router.get("/", async (_req, res) => {
  const [database, migrations, storage, resources, backup] = await Promise.all([
    checkDatabase(),
    checkMigrations(),
    checkStorage(),
    checkResources(),
    checkBackup(),
  ]);

  const digest = digestStatusFn
    ? digestStatusFn()
    : { dailyLastRun: null, weeklyLastRun: null, running: false };

  const hardFailure = database !== "connected" || !migrationsHealthy(migrations);
  const status = hardFailure ? "unhealthy" : storage === "unreachable" ? "degraded" : "ok";

  res.status(hardFailure ? 503 : 200).json({
    status,
    // `database` keeps its original name and its two original values.
    // `scripts/external-monitor.ts` reads this exact field, and so may an
    // operator's shell history.
    database,
    migrations,
    storage,
    resources,
    backup,
    digest: {
      running: digest.running,
      dailyLastRun: digest.dailyLastRun?.toISOString() ?? null,
      weeklyLastRun: digest.weeklyLastRun?.toISOString() ?? null,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
