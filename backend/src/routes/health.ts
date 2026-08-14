import { Router } from "express";
import db from "../config/database";
import { probeStorage, type StorageState } from "../services/storage";

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
  const [database, migrations, storage] = await Promise.all([
    checkDatabase(),
    checkMigrations(),
    checkStorage(),
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
    digest: {
      running: digest.running,
      dailyLastRun: digest.dailyLastRun?.toISOString() ?? null,
      weeklyLastRun: digest.weeklyLastRun?.toISOString() ?? null,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
