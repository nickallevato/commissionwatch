import { describe, it, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import { registerDigestStatus } from "../src/routes/health";
import db from "../src/config/database";

describe("GET /api/health", () => {
  afterEach(async () => {
    registerDigestStatus(() => ({
      dailyLastRun: null,
      weeklyLastRun: null,
      running: false,
    }));
    // The backup fixtures below write rows to a table no other test in this
    // file touches; clear them so a later test in this same describe block
    // never sees state a previous one left behind.
    await db("ops_event_log").where({ event_type: "ops.backup_succeeded" }).del();
  });

  it("returns status ok with database connected", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.status, "ok");
    assert.equal(res.body.database, "connected");
    assert.ok(res.body.timestamp);
  });

  it("includes digest scheduler status", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.ok("digest" in res.body);
    assert.equal(res.body.digest.running, false);
    assert.equal(res.body.digest.dailyLastRun, null);
    assert.equal(res.body.digest.weeklyLastRun, null);
  });

  it("reports digest last run times when registered", async () => {
    const daily = new Date("2026-05-05T06:00:00Z");
    const weekly = new Date("2026-05-04T06:00:00Z");
    registerDigestStatus(() => ({
      dailyLastRun: daily,
      weeklyLastRun: weekly,
      running: true,
    }));

    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.digest.running, true);
    assert.equal(res.body.digest.dailyLastRun, daily.toISOString());
    assert.equal(res.body.digest.weeklyLastRun, weekly.toISOString());
  });

  it("reports the applied migration version and no pending migrations", async () => {
    const res = await request(app).get("/api/health").expect(200);

    // A schema behind its migrations is the crash-loop shape: the entrypoint
    // migrates before the server listens, so a failed migration leaves a
    // process that answers HTTP and 500s every query.
    assert.equal(typeof res.body.migrations.version, "string");
    assert.notEqual(res.body.migrations.version, "none");
    assert.equal(res.body.migrations.pending, 0);
  });

  it("includes a resources object with coarse disk and memory states", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.ok("resources" in res.body);
    assert.ok(["ok", "low", "critical", "unknown"].includes(res.body.resources.disk));
    assert.ok(["ok", "low", "critical", "unknown"].includes(res.body.resources.memory));
    // Coarse states only — this endpoint is public and unauthenticated, and a
    // raw byte count would hand an attacker a countdown to how much it takes
    // to fill the disk. See routes/health.ts for the reasoning.
    assert.equal(typeof res.body.resources.disk, "string");
    assert.equal(res.body.resources.disk.match(/^\d/), null);
  });

  it("includes a backup object reporting no recorded success on a fresh table", async () => {
    // The test database has never had `ops_event_log` written to, which is
    // exactly the "fresh host, uninstalled cron" state `evaluateBackupFreshness`
    // in `external-monitor.ts` treats as BLOCKED, never PASS.
    await db("ops_event_log").where({ event_type: "ops.backup_succeeded" }).del();
    const res = await request(app).get("/api/health").expect(200);

    assert.ok("backup" in res.body);
    assert.equal(res.body.backup.lastSuccessAt, null);
  });

  it("reports the most recent ops.backup_succeeded row as backup.lastSuccessAt", async () => {
    await db("ops_event_log").where({ event_type: "ops.backup_succeeded" }).del();
    const older = new Date("2026-08-14T04:17:00Z");
    const newer = new Date("2026-08-16T04:17:00Z");
    await db("ops_event_log").insert([
      { event_type: "ops.backup_succeeded", detail: "older", source: "backup.sh", host: "test", occurred_at: older },
      { event_type: "ops.backup_succeeded", detail: "newer", source: "backup.sh", host: "test", occurred_at: newer },
    ]);

    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.backup.lastSuccessAt, newer.toISOString());
  });

  it("reports object storage as unconfigured when MINIO_ENDPOINT is unset", async () => {
    // The test environment runs no MinIO, which is a missing setting rather
    // than a failure — reporting it as a failure would make CI permanently
    // "degraded" and teach a reader to ignore the field.
    assert.equal(process.env.MINIO_ENDPOINT, undefined);
    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.storage, "unconfigured");
  });
});

describe("GET /api/health · object storage is degraded, not fatal", () => {
  const saved = process.env.MINIO_ENDPOINT;
  const savedPort = process.env.MINIO_PORT;

  afterEach(() => {
    if (saved === undefined) delete process.env.MINIO_ENDPOINT;
    else process.env.MINIO_ENDPOINT = saved;
    if (savedPort === undefined) delete process.env.MINIO_PORT;
    else process.env.MINIO_PORT = savedPort;
  });

  it("stays 200 with an unreachable object store, and says so", async () => {
    // Port 1 on loopback: nothing listens, so the connection refuses fast.
    process.env.MINIO_ENDPOINT = "127.0.0.1";
    process.env.MINIO_PORT = "1";

    const res = await request(app).get("/api/health").expect(200);

    // Every public read is served from Postgres. Taking the archive off the
    // air because a document *download* would fail is a worse outcome than
    // serving the archive and flagging it.
    assert.equal(res.body.storage, "unreachable");
    assert.equal(res.body.status, "degraded");
  });
});

describe("GET /api/health/live", () => {
  it("is 200 while the process is up, and touches nothing", async () => {
    const res = await request(app).get("/api/health/live").expect(200);

    assert.equal(res.body.status, "alive");
    assert.ok(res.body.timestamp);
    // Deliberately reports no dependency. Liveness that consults the database
    // is readiness wearing the wrong name, and an orchestrator acting on it
    // restarts a healthy process into a crash loop against a database that is
    // still down.
    assert.equal(res.body.database, undefined);
  });
});

/**
 * Last in the file, and it has to be.
 *
 * There is no seam for "the database is down" that is worth building — a fake
 * would prove the fake works. So this closes the real pool the app opened,
 * which is exactly the state `SELECT 1` sees during an outage, and nothing that
 * needs a connection can run afterwards. node:test runs a file's tests in
 * declaration order, so "afterwards" is everything below this point: the
 * closing `after` hook, and nothing else.
 */
describe("GET /api/health · with the database gone", () => {
  before(async () => {
    await db.destroy();
  });

  it("answers 503, so a monitor that reads only the status code sees it", async () => {
    const res = await request(app).get("/api/health").expect(503);

    assert.equal(res.body.database, "disconnected");
    assert.notEqual(res.body.status, "ok");
    assert.equal(res.body.status, "unhealthy");
  });

  it("keeps liveness at 200, because restarting would not bring the database back", async () => {
    const res = await request(app).get("/api/health/live").expect(200);
    assert.equal(res.body.status, "alive");
  });
});

// Closes the knex pool `../src/app` opens on import.
//
// Suites that leaked a pool are why the test script carried
// `--test-force-exit`. That flag calls `process.exit()`, which drops whatever
// a child had not yet flushed to the reporter — so the largest suite here
// silently reported 29, 40 or 44 of its 68 tests depending on timing, always
// green, with nothing to say the rest had gone unreported. Closing the pools
// is what let the flag come off.
after(async () => {
  await db.destroy();
});
