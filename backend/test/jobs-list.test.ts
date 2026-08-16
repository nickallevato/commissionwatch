import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { describe as describeTarget, listJobs } from "../src/services/pressroom/jobs";
import {
  cleanupByPrefix,
  createJob,
  createRun,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * Opening the queue.
 *
 * The console could report that 976 jobs were waiting and never what any of
 * them was. A depth alone cannot distinguish 972 fetches of a county archive —
 * a healthy backlog — from 972 retries of one broken URL, which is an outage
 * wearing a backlog's clothes.
 *
 * The load-bearing assertion here is `subject`: each stage addresses its work by
 * a different target key, and reading the wrong one would show an operator a row
 * of blanks or, worse, the wrong identifier for the right job.
 */

const PREFIX = "jobs-list-test";
const EMAIL = "jobs-list-test@example.invalid";

describe("describe() reads the key each stage actually uses", () => {
  it("reads the right key per stage", () => {
    assert.equal(describeTarget("fetch", { url: "https://example.invalid/a.pdf" }), "https://example.invalid/a.pdf");
    assert.equal(describeTarget("parse", { sha256: "a".repeat(64) }), "a".repeat(64));
    assert.equal(describeTarget("analyze", { sha256: "b".repeat(64) }), "b".repeat(64));
    assert.equal(describeTarget("discover", { since: "2026-08-01" }), "2026-08-01");
    assert.equal(describeTarget("extract", { meetingId: "m-1" }), "m-1");
    assert.equal(describeTarget("locate", { meetingId: "m-2" }), "m-2");
  });

  it("parses a target handed back as a JSON string", () => {
    assert.equal(describeTarget("fetch", JSON.stringify({ url: "https://x.invalid" })), "https://x.invalid");
  });

  it("returns null rather than guessing when the key is missing", () => {
    assert.equal(
      describeTarget("fetch", { sha256: "c".repeat(64) }),
      null,
      "a fetch job whose target carries no url was enqueued in a shape its " +
        "handler cannot read, and showing some other field would hide that.",
    );
    assert.equal(describeTarget("fetch", "not json"), null);
    assert.equal(describeTarget("unknown-stage", { url: "https://x.invalid" }), null);
  });
});

describe("the jobs list", () => {
  let cookie: string;
  let sourceId: string;
  let runId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    cookie = await signInOperator(EMAIL, "Jobs List Test");

    const fixture = await createSource(PREFIX, { adapterKey: `${PREFIX}-src`, enabled: true });
    sourceId = fixture.sourceId;
    runId = await createRun(sourceId, { status: "partial", counts: { processed: 3 } });

    await createJob(runId, "fetch", { url: "https://example.invalid/one.pdf" }, { status: "pending" });
    await createJob(runId, "fetch", { url: "https://example.invalid/two.pdf" }, { status: "pending" });
    await createJob(runId, "parse", { sha256: "d".repeat(64) }, { status: "done" });
    await createJob(
      runId,
      "fetch",
      { url: "https://example.invalid/broken.pdf" },
      { status: "failed", lastError: "504 from origin after 3 attempts", attempts: 3 },
    );
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  it("requires an operator session", async () => {
    await request(app).get("/api/admin/pressroom/jobs").expect(401);
  });

  it("says what each job is, not just that it exists", async () => {
    const page = await listJobs(db, { sourceId, limit: 50, offset: 0 });

    const subjects = page.data.map((job) => job.subject);
    assert.ok(
      subjects.includes("https://example.invalid/one.pdf"),
      "a fetch job must show the URL it will fetch — the whole point of opening the queue",
    );
    assert.ok(subjects.includes("d".repeat(64)), "a parse job must show its content address");
    assert.equal(page.total, 4);
  });

  it("carries a failure's error verbatim", async () => {
    const page = await listJobs(db, { sourceId, status: "failed", limit: 50, offset: 0 });
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0].last_error, "504 from origin after 3 attempts");
    assert.equal(page.data[0].attempts, 3);
  });

  it("counts the whole filtered set, not just the page", async () => {
    const page = await listJobs(db, { sourceId, limit: 1, offset: 0 });
    assert.equal(page.data.length, 1, "one row on the page");
    assert.equal(page.total, 4, "four in the set");
    assert.equal(page.counts.pending, 2);
    assert.equal(page.counts.done, 1);
    assert.equal(page.counts.failed, 1);
    assert.equal(page.counts.blocked, 0, "a status with none must read 0, not be absent");
  });

  it("filters by stage and by status together", async () => {
    const page = await listJobs(db, {
      sourceId,
      stage: "fetch",
      status: "pending",
      limit: 50,
      offset: 0,
    });
    assert.equal(page.total, 2);
    assert.ok(page.data.every((job) => job.stage === "fetch" && job.status === "pending"));
  });

  it("refuses an unknown status instead of returning an empty page", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/jobs?status=banana")
      .set("Cookie", cookie)
      .expect(400);
    assert.match(
      String(res.body.error),
      /status must be one of/,
      'an empty page would read as "no such jobs" when the truth is "no such status"',
    );
  });

  it("refuses a limit outside 1..200 and a negative offset", async () => {
    await request(app).get("/api/admin/pressroom/jobs?limit=0").set("Cookie", cookie).expect(400);
    await request(app).get("/api/admin/pressroom/jobs?limit=999").set("Cookie", cookie).expect(400);
    await request(app).get("/api/admin/pressroom/jobs?offset=-1").set("Cookie", cookie).expect(400);
  });

  it("refuses a malformed source id", async () => {
    await request(app)
      .get("/api/admin/pressroom/jobs?source_id=not-a-uuid")
      .set("Cookie", cookie)
      .expect(400);
  });

  it("serves the list over HTTP with its counts", async () => {
    const res = await request(app)
      .get(`/api/admin/pressroom/jobs?source_id=${sourceId}&limit=50`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(res.body.total, 4);
    assert.equal(res.body.counts.pending, 2);
    assert.ok(Array.isArray(res.body.data));
  });
});
