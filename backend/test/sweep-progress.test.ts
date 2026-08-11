import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { classifyRun, SweepDeadlineReached } from "../src/services/ingestion/scheduler";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { meetingParseStatus } from "../src/services/pressroom/meetings";
import { STATIONARY_STAGES } from "../src/services/ingestion";
import { cleanupByPrefix, createMeeting, createRun, createSource } from "./helpers/pressroom";

/**
 * What the first live Bozeman sweep taught us, on 2026-08-10.
 *
 * It fetched 89 documents at 10.1 seconds each — exactly the crawl-delay the
 * Methodology page promises — hit the 15-minute sweep deadline with 339 jobs
 * queued, and was recorded `failed`. Nothing had gone wrong. The archive is
 * simply larger than one time-boxed sweep: 339 documents at a polite rate is
 * about 57 minutes of fetching, so that source can never finish in one run.
 *
 * Three defects fell out of it, and this suite pins all three.
 */

const PREFIX = "sweep-progress-test";

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

describe("a sweep that runs out of clock is not a sweep that failed", () => {
  const counts = { discovered: 339, fetched: 89 };

  it("is partial when the deadline arrived with work outstanding", () => {
    assert.equal(classifyRun(counts, false, 250), "partial");
  });

  it("is still failed when it threw for any other reason", () => {
    assert.equal(classifyRun(counts, true, 0), "failed");
  });

  it("is failed when the deadline arrived and nothing at all was achieved", () => {
    // Outstanding work plus zero progress is not "partially done".
    assert.equal(classifyRun({}, false, 250), "failed");
  });

  it("is unchanged when no deadline was involved", () => {
    assert.equal(classifyRun(counts, false, 0), "succeeded");
    assert.equal(classifyRun({ fetched: 3, failed: 1 }, false, 0), "partial");
    assert.equal(classifyRun({}, false, 0), "failed");
  });

  it("carries the outstanding count on the error, not just in a log line", () => {
    const error = new SweepDeadlineReached(250, 900_000, 89);
    assert.equal(error.outstanding, 250);
    assert.equal(error.processed, 89);
    assert.match(error.message, /250 job\(s\) still queued/);
    // A distinct type, so `runSweep` never has to match on English.
    assert.ok(error instanceof SweepDeadlineReached);
  });
});

describe("a sweep that drains an older run's backlog gets credit for it", () => {
  /**
   * The trap this closes, seen live on 2026-08-11.
   *
   * `counts` is written by handlers against the run that *enqueued* a job, and
   * `CLAIM_SQL` takes the oldest pending work anywhere with no `run_id` filter.
   * Both are right. Together they mean a sweep that spends its whole life
   * finishing an earlier run's backlog ends with its own `counts` empty — and
   * Bozeman's second sweep did precisely that: 250 jobs processed, the site
   * taken from 179 records to 358, and `records: 0` recorded against itself.
   */
  it("is partial, not failed, when its own counts are empty but it did the work", () => {
    assert.equal(classifyRun({}, false, 89, 250), "partial");
  });

  it("is still failed when it genuinely completed nothing", () => {
    assert.equal(classifyRun({}, false, 89, 0), "failed");
  });

  it("counts processed work even with no jobs outstanding", () => {
    // A sweep that cleared an older backlog entirely and enqueued nothing new.
    assert.equal(classifyRun({}, false, 0, 12), "succeeded");
  });
});

describe("the standing worker cannot reach the network", () => {
  it("claims parse and analyze only", () => {
    // The boot-safety rule: a crash-looping container must never become a crawl
    // of a county web server. `fetch` and `discover` are the only stages that
    // reach outside, so a loop that starts with the process must not claim them.
    assert.deepEqual([...STATIONARY_STAGES], ["parse", "analyze"]);
    assert.ok(!STATIONARY_STAGES.includes("fetch" as never));
    assert.ok(!STATIONARY_STAGES.includes("discover" as never));
  });
});

describe("claiming by stage", () => {
  let runId = "";
  const queue = new IngestionQueue(db);

  before(async () => {
    const { sourceId } = await createSource(PREFIX, { enabled: true });
    runId = await createRun(sourceId, { status: "running" });
    await queue.enqueue("fetch", { url: "https://example.invalid/a" }, runId);
    await queue.enqueue("parse", { sha256: "a".repeat(64) }, runId);
  });

  it("returns only the named stages", async () => {
    const claimed = await queue.claim(10, undefined, ["parse", "analyze"]);
    assert.equal(claimed.length, 1, "a stage-restricted claim took the wrong number of jobs");
    assert.equal(claimed[0].stage, "parse");
  });

  it("refuses an empty stage list rather than silently claiming nothing", async () => {
    // An empty array reads like "no restriction" and behaves like "never claim
    // anything" — a worker that does nothing while looking healthy.
    await assert.rejects(() => queue.claim(1, undefined, []), /at least one stage/);
  });
});

describe("not parsed and parsed-with-nothing-found are different answers", () => {
  const queue = new IngestionQueue(db);

  it("says no_document when the meeting has no parse job at all", async () => {
    const { commissionId } = await createSource(`${PREFIX}-nodoc`, { enabled: true });
    const meetingId = await createMeeting(commissionId, { date: "2026-05-01" });

    const status = await meetingParseStatus(db, meetingId);
    assert.equal(status.state, "no_document");
    assert.equal(status.total, 0);
  });

  it("says not_run while the parse job is still queued", async () => {
    // This is the Bozeman case. The screen said "Nothing was extracted from
    // this document" about a document the parser had never opened.
    const { sourceId, commissionId } = await createSource(`${PREFIX}-queued`, { enabled: true });
    const runId = await createRun(sourceId, { status: "running" });
    const meetingId = await createMeeting(commissionId, { date: "2026-05-02" });
    await queue.enqueue("parse", { sha256: "b".repeat(64), meetingId }, runId);

    const status = await meetingParseStatus(db, meetingId);
    assert.equal(status.state, "not_run");
    assert.equal(status.outstanding, 1);
    assert.equal(status.done, 0);
  });

  it("says done once the parse job has run, however little it found", async () => {
    const { sourceId, commissionId } = await createSource(`${PREFIX}-done`, { enabled: true });
    const runId = await createRun(sourceId, { status: "succeeded" });
    const meetingId = await createMeeting(commissionId, { date: "2026-05-03" });
    const jobId = await queue.enqueue("parse", { sha256: "c".repeat(64), meetingId }, runId);
    await db("ingestion_jobs").where({ id: jobId }).update({ status: "done" });

    const status = await meetingParseStatus(db, meetingId);
    // Zero agenda items after this is a real finding about the document.
    assert.equal(status.state, "done");
    assert.equal(status.done, 1);
    assert.equal(status.outstanding, 0);
  });

  it("says failed, with the error verbatim, when the parse job died", async () => {
    const { sourceId, commissionId } = await createSource(`${PREFIX}-failed`, { enabled: true });
    const runId = await createRun(sourceId, { status: "failed" });
    const meetingId = await createMeeting(commissionId, { date: "2026-05-04" });
    const jobId = await queue.enqueue("parse", { sha256: "d".repeat(64), meetingId }, runId);
    await db("ingestion_jobs")
      .where({ id: jobId })
      .update({ status: "failed", last_error: "Unreadable content type application/msword" });

    const status = await meetingParseStatus(db, meetingId);
    assert.equal(status.state, "failed");
    assert.equal(status.failed, 1);
    assert.equal(status.last_error, "Unreadable content type application/msword");
  });
});
