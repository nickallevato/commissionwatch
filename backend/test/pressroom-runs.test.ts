import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { getRun, ReparseError, reparseMeeting, reparseRun } from "../src/services/pressroom/runs";
import {
  cleanupByPrefix,
  createArtifact,
  createJob,
  createMeeting,
  createRun,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The run screen — decisions 4 and 5.
 *
 * 4 · A run that parsed 34 of 37 is a success with a footnote. Collapsing it to
 *     "failed" trains the operator to ignore the status, which is worse than
 *     having no status at all.
 * 5 · Re-parse replays stored bytes. It is a distinct action from "sweep now",
 *     and it makes no request to a county web server — structurally, because
 *     the parse stage has no path back to a URL.
 */

const PREFIX = "pressroom-runs-test";
const EMAIL = "pressroom-runs-test@example.invalid";

const SHA_A = sha256Of("pressroom-runs-a");
const SHA_B = sha256Of("pressroom-runs-b");

describe("pressroom run detail", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let partialRunId: string;
  let meetingId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA_A, SHA_B]);

    fixture = await createSource(PREFIX, { enabled: true });
    meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });

    partialRunId = await createRun(fixture.sourceId, {
      status: "partial",
      counts: { discovered: 37, parsed: 34, failed: 3 },
    });

    await createArtifact(SHA_A, "https://example.invalid/a.pdf");
    await createArtifact(SHA_B, "https://example.invalid/b.pdf");

    await createJob(partialRunId, "parse", { sha256: SHA_A, meetingId }, { status: "done" });
    await createJob(partialRunId, "parse", { sha256: SHA_B, meetingId }, { status: "done" });
    await createJob(
      partialRunId,
      "fetch",
      { url: "https://example.invalid/c.pdf", meetingId },
      { status: "failed", lastError: "HTTP 503 from the county web server", attempts: 5 },
    );
    await createJob(
      partialRunId,
      "parse",
      { sha256: SHA_A, meetingId },
      { status: "blocked", lastError: "parse_unsupported: application/msword" },
    );

    cookie = await signInOperator(EMAIL, "Runs Operator");
  });

  // No db.destroy() here: node:test runs a describe's after hook before the
  // next describe starts, so tearing the pool down would leave the re-parse
  // suite below with no connection.
  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([SHA_A, SHA_B]);
    await db("operators").where({ email: EMAIL }).del();
  });

  it("is closed without a session", async () => {
    await request(app).get(`/api/admin/pressroom/runs/${partialRunId}`).expect(401);
    await request(app).post(`/api/admin/pressroom/runs/${partialRunId}/reparse`).expect(401);
  });

  it("keeps a partial run partial rather than collapsing it to failed", async () => {
    const detail = await getRun(db, partialRunId);
    assert.ok(detail);
    assert.equal(detail.outcome.headline, "partial");
    assert.equal(detail.run.status, "partial");
    // The footnote, not the headline: 34 parsed is the story, 3 failed is the
    // asterisk.
    assert.equal(detail.outcome.records, 71);
    assert.equal(detail.outcome.failures, 3);
  });

  it("lists every failed and blocked job with its error text verbatim", async () => {
    const detail = await getRun(db, partialRunId);
    assert.ok(detail);
    assert.equal(detail.failures.length, 2);
    const errors = detail.failures.map((failure) => failure.last_error);
    assert.ok(errors.includes("HTTP 503 from the county web server"));
    assert.ok(errors.includes("parse_unsupported: application/msword"));
  });

  it("tallies jobs by status and by stage", async () => {
    const detail = await getRun(db, partialRunId);
    assert.ok(detail);
    assert.equal(detail.jobs.total, 4);
    assert.equal(detail.jobs.by_status.done, 2);
    assert.equal(detail.jobs.by_status.failed, 1);
    assert.equal(detail.jobs.by_status.blocked, 1);
    assert.ok(detail.jobs.by_stage.some((bucket) => bucket.stage === "fetch"));
  });

  it("names the source and jurisdiction the run belongs to", async () => {
    const detail = await getRun(db, partialRunId);
    assert.ok(detail);
    assert.equal(detail.source.id, fixture.sourceId);
    assert.match(detail.source.jurisdiction_name, new RegExp(PREFIX));
  });

  it("404s an unknown run and 400s a malformed id", async () => {
    assert.equal(await getRun(db, "00000000-0000-4000-8000-000000000000"), null);
    await request(app)
      .get("/api/admin/pressroom/runs/not-a-uuid")
      .set("Cookie", cookie)
      .expect(400);
  });

  it("serves the detail over the API", async () => {
    const res = await request(app)
      .get(`/api/admin/pressroom/runs/${partialRunId}`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(res.body.outcome.headline, "partial");
    assert.equal(res.body.failures.length, 2);
  });
});

describe("pressroom re-parse", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let runId: string;
  let meetingId: string;
  const queue = new IngestionQueue(db);
  const openedRuns: string[] = [];

  const REPARSE_PREFIX = `${PREFIX}-replay`;
  const SHA_C = sha256Of("pressroom-runs-c");
  const SHA_D = sha256Of("pressroom-runs-d");

  before(async () => {
    await cleanupByPrefix(REPARSE_PREFIX);
    await deleteArtifacts([SHA_C, SHA_D]);

    fixture = await createSource(REPARSE_PREFIX, { enabled: true });
    meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    runId = await createRun(fixture.sourceId, { status: "succeeded", counts: { parsed: 2 } });

    await createArtifact(SHA_C, "https://example.invalid/c.pdf");
    await createArtifact(SHA_D, "https://example.invalid/d.pdf");

    await createJob(runId, "fetch", { url: "https://example.invalid/c.pdf", meetingId });
    await createJob(runId, "parse", { sha256: SHA_C, meetingId, documentType: "agenda" });
    await createJob(runId, "parse", { sha256: SHA_D, meetingId, documentType: "minutes" });
    // A repeat of the same artifact: the replay must queue it once.
    await createJob(runId, "parse", { sha256: SHA_C, meetingId, documentType: "agenda" });
  });

  after(async () => {
    if (openedRuns.length > 0) await db("ingestion_runs").whereIn("id", openedRuns).del();
    await cleanupByPrefix(REPARSE_PREFIX);
    await deleteArtifacts([SHA_C, SHA_D]);
    await db.destroy();
  });

  it("queues one parse job per distinct artifact, in a new run", async () => {
    const result = await reparseRun(db, queue, runId);
    openedRuns.push(result.run_id);
    assert.equal(result.enqueued, 2);
    assert.notEqual(result.run_id, runId, "the original run is a record of a date, not a workspace");
  });

  it("queues nothing that could reach the network", async () => {
    // The guarantee is structural: a parse target carrying a `url` is rejected
    // by the queue itself. Asserting the shape of what was queued is the
    // observable half of that.
    const result = await reparseRun(db, queue, runId);
    openedRuns.push(result.run_id);

    const jobs = await db("ingestion_jobs")
      .where({ run_id: result.run_id })
      .select<Array<{ stage: string; target: Record<string, unknown> }>>("stage", "target");
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assert.equal(job.stage, "parse");
      assert.equal("url" in job.target, false, "a parse job must not carry a URL");
      assert.match(String(job.target.sha256), /^[0-9a-f]{64}$/);
    }
  });

  it("replays a meeting's artifacts without knowing which run found them", async () => {
    const result = await reparseMeeting(db, queue, meetingId);
    openedRuns.push(result.run_id);
    assert.equal(result.enqueued, 2);

    const run = await db("ingestion_runs")
      .where({ id: result.run_id })
      .first<{ source_id: string } | undefined>("source_id");
    assert.equal(run?.source_id, fixture.sourceId);
  });

  it("refuses rather than opening an empty run when there is nothing stored", async () => {
    const emptyRunId = await createRun(fixture.sourceId, { status: "failed", counts: {} });
    await assert.rejects(
      () => reparseRun(db, queue, emptyRunId),
      (error: unknown) => error instanceof ReparseError && error.statusCode === 409,
    );
  });

  it("404s a run that does not exist", async () => {
    await assert.rejects(
      () => reparseRun(db, queue, "00000000-0000-4000-8000-000000000000"),
      (error: unknown) => error instanceof ReparseError && error.statusCode === 404,
    );
  });
});
