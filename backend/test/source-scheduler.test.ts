import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { createAdapterRegistry } from "../src/services/ingestion/adapters/registry";
import type {
  DocumentRef,
  FetchedArtifact,
  MeetingRef,
  SourceAdapter,
  SourceDescriptor,
} from "../src/services/ingestion/adapters/types";
import { sha256Hex } from "../src/services/ingestion/adapters/types";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { IngestionWorker } from "../src/services/ingestion/worker";
import {
  classifyRun,
  parseSourceRow,
  schedulerEnabled,
  RUN_RECOVERY_INTERVAL_MS,
  SourceScheduler,
  sourceLockKey,
  SOURCE_LOCK_NAMESPACE,
} from "../src/services/ingestion/scheduler";

/**
 * The scheduler, against a real database and a fake adapter.
 *
 * No test here reaches the network. The adapter is a stub whose behaviour each
 * test chooses, which is the point of the injection: the scheduler's job is
 * run bookkeeping and mutual exclusion, and neither depends on any county.
 */

const JURISDICTION_NAME = "Scheduler Test County";
const ADAPTER_KEY = "scheduler-test-adapter";

interface StubBehaviour {
  discover: () => Promise<MeetingRef[]>;
}

function createStubAdapter(behaviour: StubBehaviour): SourceAdapter {
  return {
    key: ADAPTER_KEY,
    describeSource(): SourceDescriptor {
      return {
        key: ADAPTER_KEY,
        jurisdiction: { name: JURISDICTION_NAME, state: "MT", type: "county" },
        bodies: [
          {
            key: "test-board",
            name: "Scheduler Test Board",
            listingUrl: "https://example.invalid/listing",
          },
        ],
        baseUrls: ["https://example.invalid"],
        politeness: {
          minDelayMs: 2000,
          maxConcurrency: 1,
          userAgent: "CommissionWatch/0.1 (test)",
          respectRobotsTxt: true,
          maxRetries: 1,
        },
        supportsLiveFetch: true,
      };
    },
    discoverMeetings: () => behaviour.discover(),
    async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
      const bytes = new TextEncoder().encode(`bytes for ${ref.url}`);
      return {
        bytes,
        contentType: "application/pdf",
        sourceUrl: ref.url,
        sha256: sha256Hex(bytes),
        byteSize: bytes.length,
        fetchedAt: new Date().toISOString(),
        ref,
      };
    },
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let jurisdictionId: string;
let sourceId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    // ingestion_sources -> runs -> jobs and commissions -> meetings all cascade.
    await db("jurisdictions").where({ id: row.id }).del();
  }
}

before(async () => {
  await removeFixtures();
  const [jurisdiction] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  jurisdictionId = jurisdiction.id;

  const [source] = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdictionId,
      adapter_key: ADAPTER_KEY,
      enabled: true,
      cron_expression: "0 7 * * *",
      expected_interval_hours: 24,
    })
    .returning("id");
  sourceId = source.id;
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_runs").where({ source_id: sourceId }).del();
  await db("ingestion_sources").where({ id: sourceId }).update({
    enabled: true,
    consecutive_failures: 0,
    health_status: "healthy",
    last_success_at: null,
  });
});

/** Polls until `read` returns non-null, or gives up loudly. */
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function buildScheduler(
  adapter: SourceAdapter,
  overrides: { sweepTimeoutMs?: number; recoveryIntervalMs?: number } = {},
): SourceScheduler {
  const registry = createAdapterRegistry([adapter]);
  const queue = new IngestionQueue(db, { maxAttempts: 1 });
  const worker = new IngestionWorker(db, queue, {
    handlers: {
      // The scheduler's contract is the run row, not the pipeline. A discover
      // handler that simply calls the adapter is enough to exercise it, and it
      // keeps this suite independent of MinIO.
      async discover() {
        await adapter.discoverMeetings(new Date(0));
        return { counts: {} };
      },
    },
    logger: silentLogger,
    batchSize: 1,
  });
  return new SourceScheduler(db, {
    queue,
    worker,
    registry,
    logger: silentLogger,
    enabled: true,
    sweepTimeoutMs: overrides.sweepTimeoutMs ?? 5000,
    ...(overrides.recoveryIntervalMs === undefined
      ? {}
      : { recoveryIntervalMs: overrides.recoveryIntervalMs }),
  });
}

describe("schedulerEnabled", () => {
  it("is off under NODE_ENV=test so the suite schedules nothing", () => {
    assert.equal(schedulerEnabled({ NODE_ENV: "test" }), false);
  });

  it("is on outside tests", () => {
    assert.equal(schedulerEnabled({ NODE_ENV: "production" }), true);
    assert.equal(schedulerEnabled({}), true);
  });

  it("lets SCHEDULER_ENABLED override in both directions", () => {
    assert.equal(schedulerEnabled({ NODE_ENV: "test", SCHEDULER_ENABLED: "true" }), true);
    assert.equal(schedulerEnabled({ NODE_ENV: "production", SCHEDULER_ENABLED: "0" }), false);
    assert.equal(schedulerEnabled({ NODE_ENV: "production", SCHEDULER_ENABLED: "" }), true);
  });

  it("is what the running process actually reports under this suite", () => {
    // Belt and braces: if someone sets SCHEDULER_ENABLED in the test env, this
    // fails loudly rather than the suite quietly starting to sweep.
    assert.equal(schedulerEnabled(), false);
  });
});

describe("classifyRun", () => {
  it("calls a sweep with work and no errors succeeded", () => {
    assert.equal(classifyRun({ discovered: 1, fetched: 3 }, false), "succeeded");
  });

  it("calls a sweep with work AND errors partial, not failed", () => {
    // 34 of 37 parsed is a success with a footnote. Collapsing it to 'failed'
    // teaches an operator to ignore the status.
    assert.equal(classifyRun({ discovered: 1, parsed: 34, failed: 3 }, false), "partial");
  });

  it("calls a sweep that produced nothing failed", () => {
    assert.equal(classifyRun({ failed: 1 }, false), "failed");
    assert.equal(classifyRun({}, false), "failed");
  });

  it("calls a sweep that threw failed regardless of its tallies", () => {
    assert.equal(classifyRun({ discovered: 1, fetched: 9 }, true), "failed");
  });
});

describe("sourceLockKey", () => {
  it("is stable for one source id and differs between two", () => {
    const a = sourceLockKey("11111111-1111-1111-1111-111111111111");
    const b = sourceLockKey("22222222-2222-2222-2222-222222222222");
    assert.equal(a, sourceLockKey("11111111-1111-1111-1111-111111111111"));
    assert.notEqual(a, b);
  });

  it("fits the signed 32-bit key pg_try_advisory_xact_lock takes", () => {
    const key = sourceLockKey("11111111-1111-1111-1111-111111111111");
    assert.ok(Number.isInteger(key));
    assert.ok(key >= -(2 ** 31) && key <= 2 ** 31 - 1);
    assert.ok(SOURCE_LOCK_NAMESPACE >= -(2 ** 31) && SOURCE_LOCK_NAMESPACE <= 2 ** 31 - 1);
  });
});

describe("parseSourceRow", () => {
  it("reads the scheduling columns migration 028 added", () => {
    const row = parseSourceRow({
      id: "abc",
      adapter_key: "k",
      cron_expression: "0 7 * * *",
      enabled: true,
      expected_interval_hours: 24,
    });
    assert.deepEqual(row, {
      id: "abc",
      adapterKey: "k",
      cronExpression: "0 7 * * *",
      enabled: true,
      expectedIntervalHours: 24,
    });
  });

  it("treats a null expected interval as 'no expectation stated'", () => {
    const row = parseSourceRow({
      id: "abc",
      adapter_key: "k",
      cron_expression: "* * * * *",
      enabled: false,
      expected_interval_hours: null,
    });
    assert.equal(row.expectedIntervalHours, null);
  });

  it("refuses a row missing a column it uses", () => {
    assert.throws(() => parseSourceRow({ id: "abc" }), TypeError);
  });
});

describe("SourceScheduler — boot safety", () => {
  it("schedules sources but sweeps nothing on start", async () => {
    let discoverCalls = 0;
    const adapter = createStubAdapter({
      discover: async () => {
        discoverCalls += 1;
        return [];
      },
    });
    const scheduler = buildScheduler(adapter);
    try {
      await scheduler.start();
      assert.equal(scheduler.running, true);
      // The whole point: a crash loop must not become a crawl of a county web
      // server, so the first execution is the first cron tick.
      assert.equal(discoverCalls, 0);
      const runs = await db("ingestion_runs").where({ source_id: sourceId });
      assert.equal(runs.length, 0);
      const status = scheduler.getStatus();
      assert.ok(status.sources.some((entry) => entry.sourceId === sourceId));
    } finally {
      scheduler.stop();
    }
  });

  it("schedules nothing at all when disabled", async () => {
    const scheduler = new SourceScheduler(db, {
      queue: new IngestionQueue(db),
      worker: new IngestionWorker(db, new IngestionQueue(db), { handlers: {}, logger: silentLogger }),
      registry: createAdapterRegistry([createStubAdapter({ discover: async () => [] })]),
      logger: silentLogger,
      enabled: false,
    });
    await scheduler.start();
    assert.equal(scheduler.running, false);
    assert.equal(scheduler.getStatus().sources.length, 0);
  });
});

describe("SourceScheduler — run bookkeeping", () => {
  it("writes a run row that reaches a terminal status", async () => {
    const adapter = createStubAdapter({ discover: async () => [] });
    const outcome = await buildScheduler(adapter).sweepSource(sourceId);

    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    const run = await db("ingestion_runs").where({ id: outcome.runId }).first();
    assert.ok(run);
    assert.equal(run.status, "succeeded");
    assert.notEqual(run.finished_at, null);
    assert.equal(run.error, null);
    assert.equal(run.counts.discovered, 1);
  });

  it("marks the source healthy and stamps last_success_at on success", async () => {
    const adapter = createStubAdapter({ discover: async () => [] });
    await buildScheduler(adapter).sweepSource(sourceId);
    const source = await db("ingestion_sources").where({ id: sourceId }).first();
    assert.equal(source.health_status, "healthy");
    assert.equal(source.consecutive_failures, 0);
    assert.notEqual(source.last_success_at, null);
  });

  it("records a throwing adapter as a failed run carrying the error text", async () => {
    const adapter = createStubAdapter({
      discover: async () => {
        throw new Error("gallatinmt.gov answered 503");
      },
    });
    const outcome = await buildScheduler(adapter).sweepSource(sourceId);

    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    assert.equal(outcome.status, "failed");
    const run = await db("ingestion_runs").where({ id: outcome.runId }).first();
    assert.equal(run.status, "failed");
    assert.notEqual(run.finished_at, null);
    // Nothing swallowed: the reason is in the row, not only in a log line.
    assert.match(String(run.error), /503/);

    const source = await db("ingestion_sources").where({ id: sourceId }).first();
    assert.equal(source.consecutive_failures, 1);
    assert.equal(source.health_status, "degraded");
  });

  it("survives an adapter that throws — the process stays up", async () => {
    const adapter = createStubAdapter({
      discover: async () => {
        throw new Error("boom");
      },
    });
    const scheduler = buildScheduler(adapter);
    await scheduler.sweepSource(sourceId);
    // A second sweep after a failure still runs, which is the observable form
    // of "the failure did not take anything down".
    const second = await scheduler.sweepSource(sourceId);
    assert.equal(second.kind, "ran");
  });

  it("does not sweep a disabled source", async () => {
    await db("ingestion_sources").where({ id: sourceId }).update({ enabled: false });
    let calls = 0;
    const adapter = createStubAdapter({
      discover: async () => {
        calls += 1;
        return [];
      },
    });
    const outcome = await buildScheduler(adapter).sweepSource(sourceId);
    assert.deepEqual(outcome, { kind: "skipped", reason: "disabled", sourceId });
    assert.equal(calls, 0);
  });
});

describe("SourceScheduler — one sweep per source", () => {
  it("starts no second run while another holds the advisory lock", async () => {
    // A transaction on its own connection takes the lock and holds it open,
    // standing in for a sweep already in flight — in this process or another
    // container. The lock is transaction-scoped, so it cannot leak out of this
    // test even if an assertion throws.
    let acquired!: () => void;
    let release!: () => void;
    const isAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const isReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [
        SOURCE_LOCK_NAMESPACE,
        sourceLockKey(sourceId),
      ]);
      acquired();
      await isReleased;
    });

    try {
      await isAcquired;

      let calls = 0;
      const adapter = createStubAdapter({
        discover: async () => {
          calls += 1;
          return [];
        },
      });
      const outcome = await buildScheduler(adapter).sweepSource(sourceId);

      assert.deepEqual(outcome, { kind: "skipped", reason: "locked", sourceId });
      assert.equal(calls, 0, "a locked tick must not sweep");
      const runs = await db("ingestion_runs").where({ source_id: sourceId });
      assert.equal(runs.length, 0, "a locked tick must not even open a run");
    } finally {
      release();
      await holder;
    }
  });

  it("releases the lock when the sweep finishes, so the next tick can run", async () => {
    const adapter = createStubAdapter({ discover: async () => [] });
    const scheduler = buildScheduler(adapter);
    const first = await scheduler.sweepSource(sourceId);
    const second = await scheduler.sweepSource(sourceId);
    assert.equal(first.kind, "ran");
    assert.equal(second.kind, "ran");
    const runs = await db("ingestion_runs").where({ source_id: sourceId });
    assert.equal(runs.length, 2);
  });
});

/**
 * Runs abandoned by a process that stopped mid-sweep.
 *
 * `runSweep` opens the run row before any work and closes it after, with no
 * `finally` in between — so a deploy, an OOM kill or any other death leaves the
 * row `running` with a null `finished_at` permanently. Production did exactly
 * that on 2026-08-16: two runs opened at 07:17Z were still reported `running`
 * ten hours later, by a process built at 12:33Z that had never seen them.
 */
/**
 * One pending discover per source.
 *
 * Production held five on 2026-08-16 — three for Gallatin, two for Bozeman,
 * the oldest from the 14th — because every sweep enqueued one unconditionally
 * and a sweep that hit its deadline left its own behind. Each would eventually
 * run a full discovery crawl of the same county.
 */
describe("a sweep does not queue a second discover beside the first", () => {
  it("adopts the pending discover instead of adding another", async () => {
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.sweepSource(sourceId);
    // Leave the first sweep's discover behind, exactly as a deadline would.
    await db("ingestion_jobs").update({ status: "pending", next_attempt_at: db.fn.now() });
    const before = await db("ingestion_jobs").where({ stage: "discover" });
    assert.equal(before.length, 1);

    await scheduler.sweepSource(sourceId);

    const after = await db("ingestion_jobs").where({ stage: "discover" });
    assert.equal(after.length, 1, "a second sweep must not add a second discovery crawl");
  });

  it("re-points the adopted job at the open run, not the closed one", async () => {
    // Otherwise the counts land on a run that finished days ago, and phase 1 of
    // the drain has no work of its own to claim.
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.sweepSource(sourceId);
    await db("ingestion_jobs").update({ status: "pending", next_attempt_at: db.fn.now() });
    const first = await db("ingestion_jobs").where({ stage: "discover" }).first();

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");

    const adopted = await db("ingestion_jobs").where({ id: first.id }).first();
    assert.notEqual(adopted.run_id, first.run_id);
    assert.equal(adopted.run_id, outcome.kind === "ran" ? outcome.runId : null);
  });

  it("does not reset attempts, because adopting is not a human clearing a fault", async () => {
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.sweepSource(sourceId);
    await db("ingestion_jobs").update({ status: "pending", attempts: 2, next_attempt_at: db.fn.now() });

    await scheduler.sweepSource(sourceId);

    // The adopted job is due immediately, so the same sweep drains it and the
    // count goes up by one. What must never happen is it going *down*: a reset
    // would hand a repeatedly-failing job a fresh budget every night, and that
    // reset belongs to `unblock` and to a person.
    const job = await db("ingestion_jobs").where({ stage: "discover" }).first();
    assert.ok(
      Number(job.attempts) >= 2,
      `attempts fell to ${job.attempts}; only unblock resets an attempt budget`,
    );
  });
});

describe("SourceScheduler.recoverAbandonedRuns", () => {
  async function insertRun(
    startedMinutesAgo: number,
    counts: Record<string, number>,
    error: string | null = null,
  ): Promise<string> {
    const [row] = await db("ingestion_runs")
      .insert({
        source_id: sourceId,
        status: "running",
        counts: JSON.stringify(counts),
        error,
        started_at: db.raw("now() - (? * interval '1 minute')", [startedMinutesAgo]),
      })
      .returning("id");
    return row.id;
  }

  it("closes an abandoned run that ingested something as partial, not failed", async () => {
    // The records reached the database whether or not the sweep lived to report
    // them. Calling this `failed` would throw away work that actually happened.
    const runId = await insertRun(60, { discovered: 12, fetched: 30 });
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    assert.equal(await scheduler.recoverAbandonedRuns(30 * 60 * 1000), 1);

    const row = await db("ingestion_runs").where({ id: runId }).first();
    assert.equal(row.status, "partial");
    assert.notEqual(row.finished_at, null);
    assert.match(row.error, /stopped before it finished/);
  });

  it("closes an abandoned run that ingested nothing as failed", async () => {
    const runId = await insertRun(60, {});
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.recoverAbandonedRuns(30 * 60 * 1000);

    const row = await db("ingestion_runs").where({ id: runId }).first();
    assert.equal(row.status, "failed");
  });

  it("keeps the errors the run had already recorded", async () => {
    // Recovery explains why the row is being closed. It is not licence to erase
    // what the sweep had already reported about itself.
    const runId = await insertRun(60, {}, "robots.txt disallowed /Archive");
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.recoverAbandonedRuns(30 * 60 * 1000);

    const row = await db("ingestion_runs").where({ id: runId }).first();
    assert.match(row.error, /robots\.txt disallowed/);
    assert.match(row.error, /stopped before it finished/);
  });

  it("leaves a run younger than the threshold alone", async () => {
    // The guard seen to hold. Without an age threshold this would close the
    // sweep that is running right now, mid-flight.
    const runId = await insertRun(5, { discovered: 1 });
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    assert.equal(await scheduler.recoverAbandonedRuns(30 * 60 * 1000), 0);

    const row = await db("ingestion_runs").where({ id: runId }).first();
    assert.equal(row.status, "running");
    assert.equal(row.finished_at, null);
  });

  it("does not touch source health, because a dead process is not a sick source", async () => {
    // `updateSourceHealth` stamps `last_success_at` with now(). Applying it here
    // would record a success fresher than anything that happened, and the
    // silence watch reads that column.
    await insertRun(60, { discovered: 5 });
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    await scheduler.recoverAbandonedRuns(30 * 60 * 1000);

    const source = await db("ingestion_sources").where({ id: sourceId }).first();
    assert.equal(source.last_success_at, null);
    assert.equal(Number(source.consecutive_failures), 0);
    assert.equal(source.health_status, "healthy");
  });

  it("keeps checking on a timer, because a run stranded just after boot is invisible otherwise", async () => {
    // The hole the boot-only check left, walked into by production on
    // 2026-08-16: a deploy at 20:04Z stranded a run opened at 20:00Z. At boot
    // that run was four minutes old — under the threshold that stops this
    // closing a *live* sweep — so nothing looked again, and for a nightly
    // source nothing would have until the following morning.
    assert.equal(RUN_RECOVERY_INTERVAL_MS, 5 * 60 * 1000);

    const runId = await insertRun(60, { discovered: 4 });
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }), {
      recoveryIntervalMs: 20,
    });

    try {
      // `start()` finds no cron module under test and returns early. The timer
      // is armed before that, deliberately: recovery has nothing to do with
      // cron, and this asserts it rather than trusting the ordering.
      await scheduler.start();

      const closed = await waitFor(async () => {
        const row = await db("ingestion_runs").where({ id: runId }).first();
        return row.status === "partial" ? row : null;
      });
      assert.notEqual(closed.finished_at, null);
    } finally {
      scheduler.stop();
    }
  });

  it("stops checking once the scheduler stops", async () => {
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }), {
      recoveryIntervalMs: 20,
    });
    await scheduler.start();
    scheduler.stop();

    const runId = await insertRun(60, { discovered: 4 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const row = await db("ingestion_runs").where({ id: runId }).first();
    assert.equal(row.status, "running", "a stopped scheduler must not still be writing");
  });

  it("refuses a threshold that is not a positive number", async () => {
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));
    await assert.rejects(() => scheduler.recoverAbandonedRuns(0), RangeError);
    await assert.rejects(() => scheduler.recoverAbandonedRuns(Number.NaN), RangeError);
  });

  it("closes an abandoned run as a side effect of the next sweep", async () => {
    // The console reads the latest run. A stuck row is most visible there, and
    // the sweep is the moment that screen changes anyway.
    const stale = await insertRun(60, { discovered: 3 });
    const scheduler = buildScheduler(createStubAdapter({ discover: async () => [] }));

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");

    const row = await db("ingestion_runs").where({ id: stale }).first();
    assert.equal(row.status, "partial");
    assert.notEqual(row.finished_at, null);
    const stillRunning = await db("ingestion_runs")
      .where({ source_id: sourceId, status: "running" })
      .count({ total: "*" })
      .first();
    assert.equal(Number(stillRunning?.total), 0, "no run may be left open after a sweep");
  });
});
