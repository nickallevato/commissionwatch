import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import db from "../src/config/database";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { IngestionWorker } from "../src/services/ingestion/worker";
import { createAdapterRegistry } from "../src/services/ingestion/adapters/registry";
import { SourceScheduler } from "../src/services/ingestion/scheduler";
import { cleanupByPrefix, createRun, createSource } from "./helpers/pressroom";

/**
 * 2026-08-16 production starvation: Gallatin ingested zero records ever, while
 * reporting verdict "Healthy". Bozeman's backlog (339 meetings, ~57 minutes of
 * fetching against a 15-minute sweep box) is structurally never-emptying, and
 * `CLAIM_SQL` is a global, unfiltered, oldest-first claim. So Gallatin's own
 * sweep spent its entire deadline claiming Bozeman's older jobs, never reached
 * its own (newest) `discover` job, and finished with `outstanding: 1` — which
 * `classifyRun` reads as `partial`, and `partial` counts as a success for
 * `last_success_at`. A new source could therefore never start, and looked
 * healthy while never starting.
 *
 * The fix keeps the global claim (it is what lets a backlog finish across
 * sweeps) but makes `SourceScheduler.drain` claim a run's own jobs first,
 * via a new run-scoped claim, before falling back to the global one to help
 * whatever backlog budget remains.
 */

const PREFIX = "ingestion-starvation-test";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

/** Backdates a pending job's `next_attempt_at` so it sorts before anything new. */
async function backdate(jobId: string, secondsAgo: number): Promise<void> {
  await db("ingestion_jobs")
    .where({ id: jobId })
    .update({ next_attempt_at: db.raw("now() - (? * interval '1 second')", [secondsAgo]) });
}

describe("IngestionQueue — run-scoped claim", () => {
  it("claims only the given run's jobs, regardless of which run is globally older", async () => {
    const { sourceId: sourceA } = await createSource(`${PREFIX}-queue-a`, { enabled: true });
    const { sourceId: sourceB } = await createSource(`${PREFIX}-queue-b`, { enabled: true });
    const runA = await createRun(sourceA, { status: "running" });
    const runB = await createRun(sourceB, { status: "running" });
    const queue = new IngestionQueue(db);

    // Run A's job is older and would win an unfiltered, oldest-first claim.
    const jobA = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runA);
    await backdate(jobA, 3600);
    const jobB = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runB);

    const claimed = await queue.claim(10, undefined, undefined, runB);
    assert.equal(claimed.length, 1, "a run-scoped claim must return exactly this run's job");
    assert.equal(claimed[0].id, jobB);
    assert.equal(claimed[0].runId, runB);

    // The older job is untouched — still pending, still claimable by its own run.
    const stillA = await queue.get(jobA);
    assert.equal(stillA?.status, "pending");
  });

  it("honours the stage restriction when both a run and a stage set are given", async () => {
    const { sourceId } = await createSource(`${PREFIX}-queue-stage`, { enabled: true });
    const runId = await createRun(sourceId, { status: "running" });
    const queue = new IngestionQueue(db);
    await queue.enqueue("fetch", { url: "https://example.invalid/a" }, runId);
    const parseJobId = await queue.enqueue("parse", { sha256: "a".repeat(64) }, runId);

    const claimed = await queue.claim(10, undefined, ["parse", "analyze"], runId);
    assert.equal(claimed.length, 1, "run+stage claim took the wrong number of jobs");
    assert.equal(claimed[0].id, parseJobId);
    assert.equal(claimed[0].stage, "parse");
  });

  it("still refuses an empty stage list when a run is also given", async () => {
    const { sourceId } = await createSource(`${PREFIX}-queue-empty-stage`, { enabled: true });
    const runId = await createRun(sourceId, { status: "running" });
    const queue = new IngestionQueue(db);
    await assert.rejects(() => queue.claim(1, undefined, [], runId), /at least one stage/);
  });
});

describe("IngestionWorker.runOnce — run scope", () => {
  it("with no argument still claims globally, exactly as before", async () => {
    const { sourceId: sourceA } = await createSource(`${PREFIX}-worker-a`, { enabled: true });
    const { sourceId: sourceB } = await createSource(`${PREFIX}-worker-b`, { enabled: true });
    const runA = await createRun(sourceA, { status: "running" });
    const runB = await createRun(sourceB, { status: "running" });
    const queue = new IngestionQueue(db);
    const jobA = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runA);
    await backdate(jobA, 3600);
    const jobB = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runB);

    const worker = new IngestionWorker(db, queue, {
      handlers: { async discover() { return {}; } },
      logger: silentLogger,
      batchSize: 25,
    });

    // The claim is deliberately global — `claim` may also pick up due jobs
    // left behind by other suites' fixtures — so this asserts on the two
    // jobs this test owns rather than on an exact global count.
    await worker.runOnce();
    const recordA = await queue.get(jobA);
    const recordB = await queue.get(jobB);
    assert.equal(recordA?.status, "done", "an unscoped runOnce must still reach the older run's job");
    assert.equal(recordB?.status, "done", "an unscoped runOnce must still reach the newer run's job");
  });

  it("with { runId } claims only that run's jobs, even when another run's are older", async () => {
    const { sourceId: sourceA } = await createSource(`${PREFIX}-worker-scoped-a`, { enabled: true });
    const { sourceId: sourceB } = await createSource(`${PREFIX}-worker-scoped-b`, { enabled: true });
    const runA = await createRun(sourceA, { status: "running" });
    const runB = await createRun(sourceB, { status: "running" });
    const queue = new IngestionQueue(db);
    const jobA = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runA);
    await backdate(jobA, 3600);
    const jobB = await queue.enqueue("discover", { since: "2026-01-01T00:00:00.000Z" }, runB);

    const worker = new IngestionWorker(db, queue, {
      handlers: { async discover() { return {}; } },
      logger: silentLogger,
      batchSize: 10,
    });

    const tick = await worker.runOnce({ runId: runB });
    assert.equal(tick.claimed, 1, "a run-scoped runOnce must claim only its own run's job");
    const record = await queue.get(jobB);
    assert.equal(record?.status, "done");
    const stillA = await queue.get(jobA);
    assert.equal(stillA?.status, "pending", "the other run's older job must be untouched");
  });
});

/** A slow, no-op discover handler and a small deadline: enough ticks to hit it. */
function buildScheduler(sweepTimeoutMs: number, discoverDelayMs: number): {
  scheduler: SourceScheduler;
  queue: IngestionQueue;
} {
  const queue = new IngestionQueue(db, { maxAttempts: 1 });
  const worker = new IngestionWorker(db, queue, {
    handlers: {
      async discover() {
        await delay(discoverDelayMs);
        return { counts: {} };
      },
    },
    logger: silentLogger,
    batchSize: 1,
  });
  const scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry: createAdapterRegistry([]),
    logger: silentLogger,
    enabled: true,
    sweepTimeoutMs,
  });
  return { scheduler, queue };
}

describe("SourceScheduler.drain — starvation regression (2026-08-16)", () => {
  it("processes a new source's own discover job despite an older, larger backlog", async () => {
    const { sourceId: backlogSource } = await createSource(`${PREFIX}-drain-backlog`, {
      enabled: true,
    });
    const { sourceId: newSource } = await createSource(`${PREFIX}-drain-new`, { enabled: true });
    const backlogRun = await createRun(backlogSource, { status: "running" });

    const { scheduler, queue } = buildScheduler(60, 20);

    // A backlog large enough that, at 20ms per job, draining it exhausts a
    // 60ms deadline (~3 jobs) well before reaching a 4th or 5th job — and
    // certainly before an unscoped claim would ever reach the new source's
    // (globally newest) job.
    for (let i = 0; i < 5; i += 1) {
      const jobId = await queue.enqueue(
        "discover",
        { since: "2026-01-01T00:00:00.000Z" },
        backlogRun,
      );
      await backdate(jobId, 3600 - i); // all strictly older than anything new
    }

    const outcome = await scheduler.sweepSource(newSource);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;

    const ownJob = await db("ingestion_jobs")
      .where({ run_id: outcome.runId, stage: "discover" })
      .first();
    assert.ok(ownJob, "the new source's own discover job must exist");
    assert.equal(
      ownJob.status,
      "done",
      "the new source's own discover job must be processed even though an older, " +
        "larger backlog sat ahead of it in the global claim order",
    );
    assert.equal(
      outcome.counts.outstanding ?? 0,
      0,
      "the new source's own work being done means nothing is outstanding for it",
    );
  });

  it("still helps drain the other source's backlog once its own jobs are done", async () => {
    const { sourceId: backlogSource } = await createSource(`${PREFIX}-drain-help-backlog`, {
      enabled: true,
    });
    const { sourceId: newSource } = await createSource(`${PREFIX}-drain-help-new`, {
      enabled: true,
    });
    const backlogRun = await createRun(backlogSource, { status: "running" });

    // Generous deadline: the new source's single job finishes fast, leaving
    // plenty of budget for phase 2 to help the backlog.
    const { scheduler, queue } = buildScheduler(500, 20);

    const backlogJobIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const jobId = await queue.enqueue(
        "discover",
        { since: "2026-01-01T00:00:00.000Z" },
        backlogRun,
      );
      await backdate(jobId, 3600 - i);
      backlogJobIds.push(jobId);
    }

    const outcome = await scheduler.sweepSource(newSource);
    assert.equal(outcome.kind, "ran");

    const doneBacklog = await db("ingestion_jobs")
      .whereIn("id", backlogJobIds)
      .andWhere({ status: "done" });
    assert.ok(
      doneBacklog.length > 0,
      "phase 2 must still spend leftover budget helping another source's backlog",
    );
  });

  it("still reaches its deadline (and reports it) when this run's own work outgrows the box", async () => {
    const { sourceId } = await createSource(`${PREFIX}-drain-own-deadline`, { enabled: true });

    const queue = new IngestionQueue(db, { maxAttempts: 1 });
    const worker = new IngestionWorker(db, queue, {
      handlers: {
        async discover(ctx) {
          // Cascades four more of this run's own (slow) fetch jobs — more
          // own-work than a small deadline can finish.
          for (let i = 0; i < 4; i += 1) {
            await ctx.enqueue("fetch", { url: `https://example.invalid/${i}` });
          }
          return { counts: {} };
        },
        async fetch() {
          await delay(20);
          return { counts: {} };
        },
      },
      logger: silentLogger,
      batchSize: 1,
    });
    const scheduler = new SourceScheduler(db, {
      queue,
      worker,
      registry: createAdapterRegistry([]),
      logger: silentLogger,
      enabled: true,
      sweepTimeoutMs: 40,
    });

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    assert.ok(
      (outcome.counts.outstanding ?? 0) > 0,
      "own work bigger than the deadline must still be reported as outstanding, " +
        "not silently dropped by the run-scoped phase",
    );
    assert.equal(outcome.status, "partial");
  });
});
