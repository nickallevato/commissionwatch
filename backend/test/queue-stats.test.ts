import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  listRecentRuns,
  readQueueStats,
  readRunWork,
} from "../src/services/pressroom/queue-stats";
import {
  cleanupByPrefix,
  createJob,
  createRun,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The queue, as a thing the product can see.
 *
 * ## What this endpoint was built for
 *
 * `ingestion_jobs` is claimed globally and oldest-first. On 2026-08-16 that let
 * `gallatin-civicplus` report **Healthy** while having ingested nothing in its
 * entire life: every sweep it ran spent its whole budget draining
 * `bozeman-granicus`'s older backlog, and its own single `discover` job was
 * never reached. Three consecutive sweeps recorded byte-identical counts.
 *
 * Nothing in the product could show why, because starvation is a property of
 * the **queue** and every screen showed **sources**. The fixture below is that
 * production shape, deliberately: one source holding almost the whole queue with
 * the oldest jobs, and a second source holding one recent job that will never be
 * reached.
 *
 * The assertions are therefore about whether the figures make the starvation
 * *legible*, not merely present.
 */

const PREFIX = "queue-stats-test";
const EMAIL = "queue-stats-test@example.invalid";

const HOUR = 60 * 60 * 1000;

describe("the queue endpoint", () => {
  let cookie: string;
  let hog: Awaited<ReturnType<typeof createSource>>;
  let starved: Awaited<ReturnType<typeof createSource>>;
  let starvedRunId: string;
  let hogRunId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    cookie = await signInOperator(EMAIL, "Queue Stats Test");

    // The source with the bottomless backlog, and the older jobs.
    hog = await createSource(PREFIX, { adapterKey: `${PREFIX}-hog`, enabled: true });
    hogRunId = await createRun(hog.sourceId, {
      status: "partial",
      counts: { processed: 90, outstanding: 1 },
      startedAt: new Date(Date.now() - 6 * 24 * HOUR),
    });
    for (let index = 0; index < 5; index += 1) {
      await createJob(hogRunId, "fetch", { url: `https://example.invalid/${index}` }, {
        status: "pending",
      });
    }
    await createJob(hogRunId, "parse", { sha256: "a".repeat(64) }, { status: "done" });

    // The source that never gets a turn. One job, newest in the queue.
    starved = await createSource(PREFIX, {
      adapterKey: `${PREFIX}-starved`,
      enabled: true,
    });
    starvedRunId = await createRun(starved.sourceId, {
      status: "partial",
      counts: { processed: 90, outstanding: 1 },
    });
    await createJob(starvedRunId, "discover", { seed: "https://example.invalid" }, {
      status: "pending",
    });

    // The oldest pending job has to actually be older, or the fixture proves
    // nothing about ordering.
    await db("ingestion_jobs")
      .whereIn(
        "id",
        db("ingestion_jobs").select("id").where({ run_id: hogRunId, status: "pending" }),
      )
      .update({ next_attempt_at: new Date(Date.now() - 6 * 24 * HOUR) });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
  });

  it("requires an operator session", async () => {
    await request(app).get("/api/admin/pressroom/queue").expect(401);
  });

  it("reports the depth and the age of the head of the queue", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/queue")
      .set("Cookie", cookie)
      .expect(200);

    assert.ok(res.body.depth >= 6, `depth was ${String(res.body.depth)}`);
    assert.ok(
      typeof res.body.oldest_pending_at === "string",
      "the head of the queue must be reported: it is what everything newer is " +
        "waiting behind, and it is the most diagnostic figure here.",
    );
    assert.ok(
      new Date(res.body.oldest_pending_at).getTime() < Date.now() - 5 * 24 * HOUR,
      "the oldest pending job is six days old in the fixture; reporting a recent " +
        "timestamp would hide exactly the condition this endpoint exists to show.",
    );
    assert.equal(typeof res.body.read_at, "string");
  });

  it("attributes pending jobs to the source that is holding the queue", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/queue")
      .set("Cookie", cookie)
      .expect(200);

    const rows = res.body.by_source as Array<{
      adapter_key: string;
      pending: number;
      completed_lifetime: number;
      oldest_pending_at: string | null;
    }>;
    const hogRow = rows.find((row) => row.adapter_key === `${PREFIX}-hog`);
    const starvedRow = rows.find((row) => row.adapter_key === `${PREFIX}-starved`);

    assert.ok(hogRow !== undefined && starvedRow !== undefined, "both sources must appear");
    assert.equal(hogRow.pending, 5);
    assert.equal(starvedRow.pending, 1);
    assert.ok(
      hogRow.pending > starvedRow.pending,
      "the whole point is that one source's share is visibly the explanation",
    );
    assert.equal(
      starvedRow.completed_lifetime,
      0,
      "a source that has never completed a job of its own is the signature of " +
        "starvation, and it must be readable without a second request.",
    );
    assert.equal(hogRow.completed_lifetime, 1);
  });

  it("lists a source with nothing queued rather than omitting it", async () => {
    const idle = await createSource(PREFIX, {
      adapterKey: `${PREFIX}-idle`,
      enabled: false,
    });
    assert.ok(idle.sourceId);

    const stats = await readQueueStats(db);
    const row = stats.by_source.find((entry) => entry.adapter_key === `${PREFIX}-idle`);
    assert.ok(
      row !== undefined,
      "a registered source absent from this list reads as a source that does not " +
        "exist, which is the confusion the console is for.",
    );
    assert.equal(row.pending, 0);
    assert.equal(row.oldest_pending_at, null);
    assert.equal(row.enabled, false);
  });

  it("breaks the pending work down by stage", async () => {
    const stats = await readQueueStats(db);
    const stages = new Map(stats.by_stage.map((row) => [row.stage, row.pending]));
    assert.ok((stages.get("fetch") ?? 0) >= 5);
    assert.ok((stages.get("discover") ?? 0) >= 1);
  });

  it("returns no verdict of its own", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/queue")
      .set("Cookie", cookie)
      .expect(200);

    // Field NAMES, not values — an `adapter_key` may legitimately contain any
    // word, and this fixture's does. The claim under test is that no *field*
    // carries a judgement.
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, nested] of Object.entries(value)) {
        names.add(key);
        walk(nested);
      }
    };
    walk(res.body);

    assert.ok(names.size > 0, "walked nothing — the check itself is broken");
    const judgements = [...names].filter((name) =>
      /verdict|starved|healthy|status/i.test(name),
    );
    assert.deepEqual(
      judgements,
      [],
      `these fields carry a judgement: ${judgements.join(", ")}. The endpoint ` +
        'reports figures and judges nothing. "Starved" is a threshold somebody ' +
        "chose, and a threshold buried in an API is a decision nobody can check.",
    );
  });
});

describe("a sweep's own work versus somebody else's", () => {
  const OWN_PREFIX = "queue-work-test";

  let runId: string;

  before(async () => {
    await cleanupByPrefix(OWN_PREFIX);
    const source = await createSource(OWN_PREFIX, { enabled: true });
    runId = await createRun(source.sourceId, {
      status: "partial",
      counts: { processed: 90, outstanding: 1 },
    });
    await createJob(runId, "discover", { seed: "x" }, { status: "pending" });
    await createJob(runId, "parse", { sha256: "b".repeat(64) }, { status: "done" });
  });

  after(async () => {
    await cleanupByPrefix(OWN_PREFIX);
  });

  it("counts only this run's jobs, so the split against `processed` is real", async () => {
    const work = await readRunWork(db, runId);

    assert.equal(work.own_completed, 1);
    assert.equal(work.own_pending, 1);
    assert.ok(
      work.own_completed < 90,
      "the fixture's `counts.processed` is 90 while only one of this run's own " +
        "jobs completed. That gap is the figure the console could not show, and " +
        "a sweep whose own work is zero every time never started its source.",
    );
  });

  it("reports zero for a run with no jobs rather than throwing", async () => {
    const source = await createSource(`${OWN_PREFIX}-empty`, { enabled: true });
    const empty = await createRun(source.sourceId, { status: "failed" });
    const work = await readRunWork(db, empty);
    assert.deepEqual(work, { own_completed: 0, own_pending: 0 });
    await cleanupByPrefix(`${OWN_PREFIX}-empty`);
  });
});

describe("recent sweeps across every source", () => {
  const HIST = "queue-history-test";

  let cookie: string;

  before(async () => {
    await cleanupByPrefix(HIST);
    cookie = await signInOperator(`${HIST}@example.invalid`, "History Test");

    const source = await createSource(HIST, { adapterKey: `${HIST}-src`, enabled: true });
    // A sweep that drained somebody else's backlog: `processed` is 90 while only
    // one of its own jobs completed. That gap is the whole point of the view.
    const runId = await createRun(source.sourceId, {
      status: "partial",
      counts: { processed: 90, outstanding: 1 },
    });
    await createJob(runId, "parse", { sha256: "c".repeat(64) }, { status: "done" });
    await createJob(runId, "discover", { seed: "y" }, { status: "pending" });
  });

  after(async () => {
    await cleanupByPrefix(HIST);
    // Closes the pool `../src/app` opens on import. Exactly one per file, in
    // the LAST suite — it has now been in the wrong place twice, because adding
    // a suite below it silently tears the pool down under the new one.
    await db.destroy();
  });

  it("splits a sweep's own work from the work it did for others", async () => {
    const runs = await listRecentRuns(db, 25);
    const mine = runs.find((run) => run.adapter_key === `${HIST}-src`);

    assert.ok(mine !== undefined, "the seeded sweep must appear in the history");
    assert.equal(mine.own_completed, 1);
    assert.equal(mine.own_outstanding, 1);
    assert.equal(
      mine.others_completed,
      89,
      "`counts.processed` is 90 and one of the run's own jobs completed, so 89 of " +
        "that labour belonged to another run. A view that showed only `processed` " +
        "is what let five identical sweeps look healthy.",
    );
  });

  it("never reports a negative share for others", async () => {
    const source = await createSource(`${HIST}-neg`, { enabled: true });
    // More own completions than `processed` — possible when an earlier sweep
    // already drained some of this run's jobs.
    const runId = await createRun(source.sourceId, {
      status: "succeeded",
      counts: { processed: 0 },
    });
    await createJob(runId, "parse", { sha256: "d".repeat(64) }, { status: "done" });

    const runs = await listRecentRuns(db, 25);
    const row = runs.find((run) => run.run_id === runId);
    assert.ok(row !== undefined);
    assert.equal(row.others_completed, 0, "a negative share would be nonsense on the screen");
    await cleanupByPrefix(`${HIST}-neg`);
  });

  it("refuses a limit outside 1..25 rather than silently clamping", async () => {
    await request(app)
      .get("/api/admin/pressroom/runs?limit=0")
      .set("Cookie", cookie)
      .expect(400);
    await request(app)
      .get("/api/admin/pressroom/runs?limit=99")
      .set("Cookie", cookie)
      .expect(400);
  });

  it("is not shadowed by the id-scoped run route", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/runs?limit=5")
      .set("Cookie", cookie)
      .expect(200);
    assert.ok(Array.isArray(res.body.data), "`/runs` must list, not 400 as a bad id");
    assert.ok(res.body.data.length <= 5);
  });

  it("requires an operator session", async () => {
    await request(app).get("/api/admin/pressroom/runs").expect(401);
  });
});
