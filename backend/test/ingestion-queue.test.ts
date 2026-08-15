import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import db from "../src/config/database";
import {
  BlockedError,
  IngestionQueue,
  InvalidJobError,
  type ClaimedJob,
} from "../src/services/ingestion/queue";
import {
  IngestionWorker,
  type AnalyzeContext,
  type ArtifactRef,
  type ArtifactStore,
  type DiscoverContext,
  type ExtractContext,
  type FetchContext,
  type ParseContext,
} from "../src/services/ingestion/worker";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ADAPTER_KEY = "queue-test-adapter";
const STORAGE_KEY = "queue-test/agenda.pdf";

const SINCE = "2026-01-01T00:00:00.000Z";

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const ARTIFACT_BODY = Buffer.from("BOZEMAN CITY COMMISSION AGENDA — captured");
const ARTIFACT_SHA = sha256Of(ARTIFACT_BODY.toString());

/** Serves bytes from memory: the worker must not need MinIO to run a stage. */
class MemoryArtifactStore implements ArtifactStore {
  readonly reads: string[] = [];
  constructor(private readonly bytes: Map<string, Buffer>) {}
  async read(ref: ArtifactRef): Promise<Buffer> {
    this.reads.push(ref.storageKey);
    const found = this.bytes.get(ref.storageKey);
    if (!found) throw new Error(`no bytes for ${ref.storageKey}`);
    return found;
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let sourceId: string;
let runId: string;

async function removeFixtures(): Promise<void> {
  await db("artifacts").where({ sha256: ARTIFACT_SHA }).del();
  // ingestion_runs and ingestion_jobs cascade from the source.
  await db("ingestion_sources")
    .where({ jurisdiction_id: BOZEMAN_ID, adapter_key: ADAPTER_KEY })
    .del();
}

/**
 * Restricts an assertion to jobs this suite created. `claim` is intentionally
 * global — a worker claims whatever is due — so tests filter by run.
 */
function ownJobs(jobs: ClaimedJob[]): ClaimedJob[] {
  return jobs.filter((job) => job.runId === runId);
}

before(async () => {
  await removeFixtures();

  const [source] = await db("ingestion_sources")
    .insert({
      jurisdiction_id: BOZEMAN_ID,
      adapter_key: ADAPTER_KEY,
      config: JSON.stringify({ baseUrl: "https://example.invalid" }),
      enabled: true,
    })
    .returning("id");
  sourceId = source.id;

  const [run] = await db("ingestion_runs")
    .insert({ source_id: sourceId, status: "running" })
    .returning("id");
  runId = run.id;

  await db("artifacts").insert({
    sha256: ARTIFACT_SHA,
    storage_key: STORAGE_KEY,
    content_type: "application/pdf",
    source_url: "https://example.invalid/agenda.pdf",
    byte_size: ARTIFACT_BODY.byteLength,
  });
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_jobs").where({ run_id: runId }).del();
  await db("ingestion_runs").where({ id: runId }).update({ counts: "{}" });
});

describe("IngestionQueue — enqueue", () => {
  it("inserts a pending job that is immediately due", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);

    const record = await queue.get(jobId);
    assert.ok(record, "job should exist");
    assert.equal(record.runId, runId);
    assert.equal(record.stage, "discover");
    assert.equal(record.status, "pending");
    assert.equal(record.attempts, 0);
    assert.equal(record.lastError, null);
    assert.ok(
      record.nextAttemptAt.getTime() <= Date.now() + 1000,
      "a job with no delay is due now",
    );
    assert.deepEqual(record.target, { since: SINCE });
  });

  it("honours a delay so the job is not yet claimable", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue(
      "fetch",
      { url: "https://example.invalid/a.pdf" },
      runId,
      { delayMs: 60_000 },
    );

    const claimed = ownJobs(await queue.claim(10));
    assert.equal(claimed.length, 0, "a future job must not be claimed");

    const record = await queue.get(jobId);
    assert.equal(record?.status, "pending");
  });

  it("rejects a parse target carrying a url", async () => {
    const queue = new IngestionQueue(db);
    // The type system forbids this shape; a caller reaching the table another
    // way must still be rejected. Build the target through the validator.
    await assert.rejects(
      () =>
        queue.enqueue(
          "parse",
          // Extra properties are checked at runtime by parseParseTarget.
          Object.assign({ sha256: ARTIFACT_SHA }, { url: "https://x.invalid" }),
          runId,
        ),
      InvalidJobError,
      "stages after fetch must not be handed a url",
    );
  });
});

describe("IngestionQueue — claim", () => {
  it("claims due jobs and marks them running with an incremented attempt", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);

    const claimed = ownJobs(await queue.claim(10));
    assert.equal(claimed.length, 1);
    const job = claimed[0];
    assert.equal(job.id, jobId);
    assert.equal(job.stage, "discover");
    assert.equal(job.attempts, 1, "claiming counts as an attempt");
    if (job.stage === "discover") {
      assert.equal(job.target.since, SINCE);
    }

    const record = await queue.get(jobId);
    assert.equal(record?.status, "running");
  });

  it("does not reclaim a running job", async () => {
    const queue = new IngestionQueue(db);
    await queue.enqueue("discover", { since: SINCE }, runId);

    assert.equal(ownJobs(await queue.claim(10)).length, 1);
    assert.equal(ownJobs(await queue.claim(10)).length, 0);
  });

  it("orders claims by next_attempt_at", async () => {
    const queue = new IngestionQueue(db);
    const later = await queue.enqueue("discover", { since: SINCE }, runId);
    await db("ingestion_jobs")
      .where({ id: later })
      .update({ next_attempt_at: db.raw("now() - interval '1 second'") });
    const earlier = await queue.enqueue("discover", { since: SINCE }, runId);
    await db("ingestion_jobs")
      .where({ id: earlier })
      .update({ next_attempt_at: db.raw("now() - interval '1 hour'") });

    const claimed = ownJobs(await queue.claim(10));
    assert.deepEqual(
      claimed.map((job) => job.id),
      [earlier, later],
    );
  });

  /**
   * The point of FOR UPDATE SKIP LOCKED. Two transactions claim at the same
   * time, both still open: the second must skip the rows the first has locked
   * rather than block on them or hand back the same job.
   *
   * If SKIP LOCKED were dropped, the second claim would wait on the first's
   * locks, which are only released after both claims resolve — the statement
   * timeout turns that regression into a fast failure instead of a hang.
   */
  it("two concurrent claims never return the same job", async () => {
    const queue = new IngestionQueue(db);
    const jobIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      jobIds.push(await queue.enqueue("discover", { since: SINCE }, runId));
    }

    const trxA: Knex.Transaction = await db.transaction();
    const trxB: Knex.Transaction = await db.transaction();
    let claimedA: ClaimedJob[] = [];
    let claimedB: ClaimedJob[] = [];
    try {
      await trxA.raw("SET LOCAL statement_timeout = '5000ms'");
      await trxB.raw("SET LOCAL statement_timeout = '5000ms'");

      [claimedA, claimedB] = await Promise.all([
        queue.claim(3, trxA),
        queue.claim(3, trxB),
      ]);

      await trxA.commit();
      await trxB.commit();
    } catch (error) {
      if (!trxA.isCompleted()) await trxA.rollback();
      if (!trxB.isCompleted()) await trxB.rollback();
      throw error;
    }

    const idsA = ownJobs(claimedA).map((job) => job.id);
    const idsB = ownJobs(claimedB).map((job) => job.id);
    const overlap = idsA.filter((id) => idsB.includes(id));
    assert.deepEqual(overlap, [], "SKIP LOCKED must partition the queue");

    const all = [...idsA, ...idsB];
    assert.equal(new Set(all).size, all.length, "no job claimed twice");
    assert.equal(all.length, jobIds.length, "every due job was claimed once");

    const running = await db("ingestion_jobs")
      .where({ run_id: runId, status: "running" })
      .count<{ count: string }[]>("* as count");
    assert.equal(Number(running[0].count), jobIds.length);
  });
});

describe("IngestionQueue — complete", () => {
  it("does not reclaim a completed job", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);

    const [job] = ownJobs(await queue.claim(10));
    await queue.complete(job.id);

    const record = await queue.get(jobId);
    assert.equal(record?.status, "done");

    // Even with the clock well past its due time it is not eligible again.
    await db("ingestion_jobs")
      .where({ id: jobId })
      .update({ next_attempt_at: db.raw("now() - interval '1 day'") });
    assert.equal(
      ownJobs(await queue.claim(10)).length,
      0,
      "a done job is never claimed again",
    );
  });

  it("refuses to complete a job that is not running", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);
    await assert.rejects(() => queue.complete(jobId), /expected 'running'/);
  });
});

describe("IngestionQueue — fail and backoff", () => {
  it("grows the backoff exponentially between attempts", async () => {
    const queue = new IngestionQueue(db, {
      maxAttempts: 5,
      baseBackoffMs: 1000,
    });
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);

    const delays: number[] = [];
    const scheduled: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [job] = ownJobs(await queue.claim(10));
      assert.ok(job, `job should be claimable on attempt ${attempt}`);
      assert.equal(job.attempts, attempt);

      const before = Date.now();
      const outcome = await queue.fail(job.id, new Error(`boom ${attempt}`));
      assert.equal(outcome.status, "pending");
      delays.push(outcome.delayMs);
      scheduled.push(outcome.nextAttemptAt.getTime() - before);

      // Pull the job back to due so the next attempt can be observed without
      // waiting out the real backoff.
      await db("ingestion_jobs")
        .where({ id: jobId })
        .update({ next_attempt_at: db.raw("now()") });
    }

    assert.deepEqual(delays, [1000, 2000, 4000], "backoff doubles per attempt");
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] > delays[i - 1], "each backoff is longer than the last");
    }
    for (let i = 0; i < scheduled.length; i += 1) {
      assert.ok(
        scheduled[i] >= delays[i] - 500,
        `next_attempt_at reflects the ${delays[i]}ms backoff`,
      );
    }

    const record = await queue.get(jobId);
    assert.equal(record?.status, "pending");
    assert.match(record?.lastError ?? "", /boom 3/);
  });

  it("caps the backoff at maxBackoffMs", () => {
    const queue = new IngestionQueue(db, {
      baseBackoffMs: 1000,
      maxBackoffMs: 5000,
    });
    assert.equal(queue.backoffFor(1), 1000);
    assert.equal(queue.backoffFor(2), 2000);
    assert.equal(queue.backoffFor(3), 4000);
    assert.equal(queue.backoffFor(4), 5000);
    assert.equal(queue.backoffFor(40), 5000);
  });

  it("blocks a job that exhausts its attempts rather than failing it forever", async () => {
    const queue = new IngestionQueue(db, {
      maxAttempts: 3,
      baseBackoffMs: 1,
    });
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);

    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [job] = ownJobs(await queue.claim(10));
      assert.ok(job, `job should be claimable on attempt ${attempt}`);
      const outcome = await queue.fail(job.id, new Error("source unavailable"));
      statuses.push(outcome.status);
      await db("ingestion_jobs")
        .where({ id: jobId })
        .update({ next_attempt_at: db.raw("now()") });
    }

    assert.deepEqual(statuses, ["pending", "pending", "blocked"]);

    const record = await queue.get(jobId);
    assert.equal(record?.status, "blocked", "held, not failed");
    assert.notEqual(record?.status, "failed");
    assert.equal(record?.attempts, 3);
    assert.match(record?.lastError ?? "", /attempts exhausted after 3/);
    assert.match(record?.lastError ?? "", /source unavailable/);

    // A blocked job is out of the claim path even though it is due.
    assert.equal(ownJobs(await queue.claim(10)).length, 0);

    // ...and it is recoverable: unblocking returns it to the queue.
    assert.equal(await queue.unblock([jobId]), 1);
    const requeued = await queue.get(jobId);
    assert.equal(requeued?.status, "pending");
    assert.equal(requeued?.attempts, 0, "unblock resets the attempt budget");
    assert.equal(
      ownJobs(await queue.claim(10)).length,
      1,
      "an unblocked job is claimable again",
    );
  });

  it("terminates a malformed job in failed, not blocked", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);
    await queue.claim(10);

    await queue.abandon(jobId, new InvalidJobError("target has no since"));
    const record = await queue.get(jobId);
    assert.equal(record?.status, "failed");
    assert.equal(ownJobs(await queue.claim(10)).length, 0);
  });
});

describe("IngestionQueue — run counts", () => {
  it("merges tallies into the run row without losing increments", async () => {
    const queue = new IngestionQueue(db);
    await queue.recordRunCounts(runId, { discovered: 3, fetched: 1 });
    const merged = await queue.recordRunCounts(runId, { fetched: 2, failed: 1 });

    assert.deepEqual(merged, { discovered: 3, fetched: 3, failed: 1 });

    const run = await db("ingestion_runs").where({ id: runId }).first();
    assert.deepEqual(run.counts, { discovered: 3, fetched: 3, failed: 1 });
  });
});

describe("IngestionWorker — dispatch", () => {
  it("routes each stage to its injected handler and records run counts", async () => {
    const queue = new IngestionQueue(db);
    const seen: string[] = [];

    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      batchSize: 10,
      artifacts: new MemoryArtifactStore(
        new Map([[STORAGE_KEY, ARTIFACT_BODY]]),
      ),
      handlers: {
        discover: async (ctx: DiscoverContext) => {
          seen.push(`discover:${ctx.target.since}`);
          // A stage chains the next one within its own run.
          await ctx.enqueue("fetch", { url: "https://example.invalid/a.pdf" });
        },
        fetch: async (ctx: FetchContext) => {
          seen.push(`fetch:${ctx.target.url}`);
        },
        parse: async (ctx: ParseContext) => {
          seen.push(`parse:${ctx.artifact.sha256}`);
        },
      },
    });

    await queue.enqueue("discover", { since: SINCE }, runId);
    const first = await worker.runOnce();
    assert.equal(first.claimed, 1);
    assert.equal(first.completed, 1);

    const second = await worker.runOnce();
    assert.equal(second.claimed, 1, "discover enqueued the fetch job");
    assert.equal(second.completed, 1);

    assert.deepEqual(seen, [
      `discover:${SINCE}`,
      "fetch:https://example.invalid/a.pdf",
    ]);

    const run = await db("ingestion_runs").where({ id: runId }).first();
    assert.deepEqual(run.counts, { discovered: 1, fetched: 1 });
  });

  it("hands parse the stored artifact and its bytes, never a url", async () => {
    const queue = new IngestionQueue(db);
    const store = new MemoryArtifactStore(
      new Map([[STORAGE_KEY, ARTIFACT_BODY]]),
    );
    const received: ParseContext[] = [];

    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      artifacts: store,
      handlers: {
        parse: async (ctx: ParseContext) => {
          received.push(ctx);
          return { counts: { agendaItems: 4 } };
        },
      },
    });

    await queue.enqueue("parse", { sha256: ARTIFACT_SHA }, runId);
    const tick = await worker.runOnce();
    assert.equal(tick.completed, 1);

    const ctx = received[0];
    assert.ok(ctx, "parse handler ran");
    assert.equal(ctx.artifact.sha256, ARTIFACT_SHA);
    assert.equal(ctx.artifact.storageKey, STORAGE_KEY);
    assert.equal(ctx.artifact.byteSize, ARTIFACT_BODY.byteLength);
    assert.equal(ctx.content.toString(), ARTIFACT_BODY.toString());
    assert.deepEqual(store.reads, [STORAGE_KEY], "bytes came from storage");

    // The whole point: nothing in the parse contract points at the network.
    // The only thing the target actually carries is a content address.
    assert.deepEqual(
      Object.entries(ctx.target)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key),
      ["sha256"],
    );
    assert.ok(
      !Object.keys(ctx.target).includes("url"),
      "a parse target has no url",
    );
    assert.equal(
      Object.values(ctx).some(
        (value) => typeof value === "function" && value.name === "fetch",
      ),
      false,
      "the parse context grants no fetcher",
    );

    const run = await db("ingestion_runs").where({ id: runId }).first();
    assert.deepEqual(run.counts, { parsed: 1, agendaItems: 4 });
  });

  it("gives analyze the same artifact contract as parse", async () => {
    const queue = new IngestionQueue(db);
    let body = "";
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      artifacts: new MemoryArtifactStore(
        new Map([[STORAGE_KEY, ARTIFACT_BODY]]),
      ),
      handlers: {
        analyze: async (ctx: AnalyzeContext) => {
          body = ctx.content.toString();
        },
      },
    });

    await queue.enqueue("analyze", { sha256: ARTIFACT_SHA }, runId);
    await worker.runOnce();
    assert.match(body, /BOZEMAN CITY COMMISSION AGENDA/);
  });

  it("blocks a stage with no registered handler instead of burning retries", async () => {
    const queue = new IngestionQueue(db);
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      handlers: {},
    });

    const jobId = await queue.enqueue("discover", { since: SINCE }, runId);
    const tick = await worker.runOnce();
    assert.equal(tick.blocked, 1);
    assert.equal(tick.retried, 0);

    const record = await queue.get(jobId);
    assert.equal(record?.status, "blocked");
    assert.equal(record?.attempts, 1, "blocking does not consume the budget");
    assert.match(record?.lastError ?? "", /no handler registered/);
  });

  it("blocks on a handler's BlockedError and retries on any other error", async () => {
    const queue = new IngestionQueue(db, { maxAttempts: 5, baseBackoffMs: 1 });
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      batchSize: 10,
      handlers: {
        discover: async (ctx: DiscoverContext) => {
          if (ctx.target.metadata?.blocked === true) {
            throw new BlockedError("bozeman live fetching unavailable");
          }
          throw new Error("transient network reset");
        },
      },
    });

    const blockedId = await queue.enqueue(
      "discover",
      { since: SINCE, metadata: { blocked: true } },
      runId,
    );
    const retryId = await queue.enqueue("discover", { since: SINCE }, runId);

    const tick = await worker.runOnce();
    assert.equal(tick.claimed, 2);
    assert.equal(tick.blocked, 1);
    assert.equal(tick.retried, 1);
    assert.equal(tick.completed, 0);

    assert.equal((await queue.get(blockedId))?.status, "blocked");
    const retried = await queue.get(retryId);
    assert.equal(retried?.status, "pending");
    assert.ok(
      retried && retried.nextAttemptAt.getTime() > Date.now() - 1000,
      "the retry was rescheduled",
    );

    const run = await db("ingestion_runs").where({ id: runId }).first();
    assert.deepEqual(run.counts, { blocked: 1, failed: 1 });
  });

  it("retries a parse job whose artifact is not recorded yet", async () => {
    const queue = new IngestionQueue(db, { maxAttempts: 3, baseBackoffMs: 1 });
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      artifacts: new MemoryArtifactStore(new Map()),
      handlers: { parse: async () => undefined },
    });

    const missing = sha256Of("never fetched");
    const jobId = await queue.enqueue("parse", { sha256: missing }, runId);

    const tick = await worker.runOnce();
    assert.equal(tick.retried, 1);
    const record = await queue.get(jobId);
    assert.equal(record?.status, "pending");
    assert.match(record?.lastError ?? "", /no artifact recorded/);
  });

  it("reports an empty tick when nothing is due", async () => {
    const queue = new IngestionQueue(db);
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      handlers: {},
    });
    const tick = await worker.runOnce();
    assert.equal(tick.claimed, 0);
    assert.equal(tick.completed, 0);
  });
});

describe("IngestionWorker — poll loop", () => {
  it("drains the queue while running and stops on request", async () => {
    const queue = new IngestionQueue(db);
    let handled = 0;
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      batchSize: 2,
      idleDelayMs: 5,
      handlers: {
        discover: async () => {
          handled += 1;
        },
      },
    });

    for (let i = 0; i < 5; i += 1) {
      await queue.enqueue("discover", { since: SINCE }, runId);
    }

    const loop = worker.start();
    const deadline = Date.now() + 10_000;
    while (handled < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    worker.stop();
    await loop;

    assert.equal(handled, 5, "the loop drained every job");
    assert.equal(worker.running, false);

    const done = await db("ingestion_jobs")
      .where({ run_id: runId, status: "done" })
      .count<{ count: string }[]>("* as count");
    assert.equal(Number(done[0].count), 5);
  });
});

/**
 * `extract` — the stage that replaced `void runExtraction(...)`.
 *
 * The old version was an unawaited promise in a request handler: a deploy
 * mid-run destroyed the work and left `extraction_runs` `running` forever,
 * there was no concurrency control over a per-minute rate-limited free tier,
 * and there was no queue depth to look at. Everything below is a property that
 * only holds because the work now owns a row.
 */
describe("IngestionQueue — the extract stage", () => {
  const MEETING_ID = "3b2a1c9d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";

  it("rejects an extract target carrying a url", async () => {
    const queue = new IngestionQueue(db);
    await assert.rejects(
      () =>
        queue.enqueue(
          "extract",
          Object.assign(
            { sha256: ARTIFACT_SHA, meetingId: MEETING_ID },
            { url: "https://x.invalid" },
          ),
          runId,
        ),
      InvalidJobError,
      "extraction reads stored bytes; the only network it touches is the model",
    );
  });

  it("rejects an extract target with no meeting", async () => {
    const queue = new IngestionQueue(db);
    await assert.rejects(
      // A tally and a claim are both about a meeting. An extraction of an
      // artifact belonging to none has nowhere to write its output.
      () => queue.enqueue("extract", { sha256: ARTIFACT_SHA, meetingId: "" }, runId),
      InvalidJobError,
    );
  });

  it("hands the handler the stored bytes and the meeting", async () => {
    const queue = new IngestionQueue(db);
    const received: ExtractContext[] = [];
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      artifacts: new MemoryArtifactStore(new Map([[STORAGE_KEY, ARTIFACT_BODY]])),
      handlers: {
        extract: async (ctx: ExtractContext) => {
          received.push(ctx);
          return { counts: { extraction_claims_stored: 3 } };
        },
      },
    });

    await queue.enqueue("extract", { sha256: ARTIFACT_SHA, meetingId: MEETING_ID }, runId);
    const tick = await worker.runOnce();
    assert.equal(tick.completed, 1);

    const ctx = received[0];
    assert.ok(ctx, "extract handler ran");
    assert.equal(ctx.target.meetingId, MEETING_ID);
    assert.equal(ctx.artifact.sha256, ARTIFACT_SHA);
    assert.equal(ctx.content.toString(), ARTIFACT_BODY.toString());

    const run = await db("ingestion_runs").where({ id: runId }).first();
    assert.deepEqual(run.counts, { extracted: 1, extraction_claims_stored: 3 });
  });

  it("keeps the extraction loop off the other stages' work", async () => {
    const queue = new IngestionQueue(db);
    const worker = new IngestionWorker(db, queue, {
      logger: silentLogger,
      stages: ["extract"],
      artifacts: new MemoryArtifactStore(new Map([[STORAGE_KEY, ARTIFACT_BODY]])),
      handlers: { extract: async () => undefined, parse: async () => undefined },
    });

    const parseId = await queue.enqueue("parse", { sha256: ARTIFACT_SHA }, runId);
    await queue.enqueue("extract", { sha256: ARTIFACT_SHA, meetingId: MEETING_ID }, runId);

    const tick = await worker.runOnce();
    assert.equal(tick.claimed, 1, "a stage-restricted worker claims only its stage");
    assert.equal((await queue.get(parseId))?.status, "pending");
  });

  /**
   * The restart the old design lost work to. A worker claims an extract job,
   * the process dies before the handler returns, and the row is left `running`
   * — claimable by nobody, because only the claimer ever moves it on.
   */
  it("requeues an extract job abandoned by a stopped worker", async () => {
    const queue = new IngestionQueue(db);
    const jobId = await queue.enqueue(
      "extract",
      { sha256: ARTIFACT_SHA, meetingId: MEETING_ID },
      runId,
    );
    await queue.claim(1, undefined, ["extract"]);
    assert.equal((await queue.get(jobId))?.status, "running");

    // The process died an hour ago.
    await db("ingestion_jobs")
      .where({ id: jobId })
      .update({ updated_at: db.raw("now() - interval '1 hour'") });

    assert.equal(await queue.recoverStalled(30 * 60 * 1000), 1);
    const recovered = await queue.get(jobId);
    assert.equal(recovered?.status, "pending");
    assert.equal(recovered?.attempts, 1, "the crashed attempt still counts as an attempt");
    assert.match(recovered?.lastError ?? "", /stopped without finishing it/);

    const reclaimed = ownJobs(await queue.claim(5, undefined, ["extract"]));
    assert.deepEqual(
      reclaimed.map((job) => job.id),
      [jobId],
    );
  });

  it("leaves a job a live worker is still holding alone", async () => {
    const queue = new IngestionQueue(db);
    await queue.enqueue("extract", { sha256: ARTIFACT_SHA, meetingId: MEETING_ID }, runId);
    await queue.claim(1, undefined, ["extract"]);

    // Nine chunks against a throttled free model take minutes. A threshold
    // that requeues live work doubles the load on the slowest thing there is.
    assert.equal(await queue.recoverStalled(30 * 60 * 1000), 0);
  });

  it("two concurrent claims never return the same extract job", async () => {
    const queue = new IngestionQueue(db);
    const jobIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      jobIds.push(
        await queue.enqueue("extract", { sha256: ARTIFACT_SHA, meetingId: MEETING_ID }, runId),
      );
    }

    const trxA: Knex.Transaction = await db.transaction();
    const trxB: Knex.Transaction = await db.transaction();
    let claimedA: ClaimedJob[] = [];
    let claimedB: ClaimedJob[] = [];
    try {
      await trxA.raw("SET LOCAL statement_timeout = '5000ms'");
      await trxB.raw("SET LOCAL statement_timeout = '5000ms'");
      [claimedA, claimedB] = await Promise.all([
        queue.claim(2, trxA, ["extract"]),
        queue.claim(2, trxB, ["extract"]),
      ]);
      await trxA.commit();
      await trxB.commit();
    } catch (error) {
      if (!trxA.isCompleted()) await trxA.rollback();
      if (!trxB.isCompleted()) await trxB.rollback();
      throw error;
    }

    const ids = [...ownJobs(claimedA), ...ownJobs(claimedB)].map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length, "SKIP LOCKED must partition the queue");
    assert.equal(ids.length, jobIds.length);
  });
});
