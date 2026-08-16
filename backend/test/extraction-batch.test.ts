import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { IngestionQueue } from "../src/services/ingestion/queue";
import {
  enqueueExtractionBatch,
  MAX_EXTRACT_BATCH,
  queuedExtraction,
  skipReasonFor,
} from "../src/services/extraction/stage";
import { ExtractionUnavailable } from "../src/services/extraction/run";
import { registerPressroomStack } from "../src/routes/admin/pressroom";
import { buildIngestionStack } from "../src/services/ingestion";
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
 * H7 — the operator-triggered batch extraction enqueue.
 *
 * `docs/STATUS.md` item 1f refused a batch route until extraction became a
 * real queue stage with restart safety and a `blocked` state — that landed in
 * `services/extraction/stage.ts`. This suite covers the second half: the
 * route that lets an operator spend a stated, bounded amount of a
 * rate-limited free model's quota, and the disclosure of what happened to
 * every meeting it looked at, not just the ones it enqueued.
 */

const PREFIX = "extraction-batch-test";
const EMAIL = "extraction-batch-test@example.invalid";

async function withMinutesArtifact(
  db: import("knex").Knex,
  sourceId: string,
  meetingId: string,
  sha: string,
): Promise<void> {
  await createArtifact(sha, `https://example.invalid/${sha.slice(0, 8)}.pdf`);
  const runId = await createRun(sourceId, { status: "succeeded", counts: { parsed: 1 } });
  await createJob(runId, "parse", { sha256: sha, meetingId, documentType: "minutes" });
}

describe("batch extraction enqueue — service", () => {
  let cookie: string;
  let fixture: Awaited<ReturnType<typeof createSource>>;
  const queue = new IngestionQueue(db);
  const shas: string[] = [];

  before(async () => {
    await cleanupByPrefix(PREFIX);
    fixture = await createSource(PREFIX, { enabled: true });
    cookie = await signInOperator(EMAIL, "Batch Extraction Operator");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts(shas);
    await db("operators").where({ email: EMAIL }).del();
    // The last teardown in the file: node's test runner isolates each test
    // file in its own process, and an open Knex pool is an open handle that
    // keeps that process alive past every test finishing. Every other suite
    // in this codebase destroys the pool exactly once, at the true end of the
    // file — see extraction.test.ts's single top-level `after`, and
    // pressroom-runs.test.ts's comment on why its first describe deliberately
    // does not.
    await db.destroy();
  });

  it("enqueues exactly the eligible meetings, oldest first, and respects limit", async () => {
    const p = `${PREFIX}-order`;
    const src = await createSource(p, { enabled: true });

    const oldest = await createMeeting(src.commissionId, { date: "2020-01-01" });
    const middle = await createMeeting(src.commissionId, { date: "2021-01-01" });
    const newest = await createMeeting(src.commissionId, { date: "2022-01-01" });

    for (const [id, seed] of [
      [oldest, "order-oldest"],
      [middle, "order-middle"],
      [newest, "order-newest"],
    ] as const) {
      const sha = sha256Of(`${p}-${seed}`);
      shas.push(sha);
      await withMinutesArtifact(db, src.sourceId, id, sha);
    }

    // limit 2: the two oldest are enqueued, the newest is left for next time
    // (it is not "skipped" — it was simply never reached).
    const result = await enqueueExtractionBatch(db, queue, 2);
    const enqueuedIds = result.enqueued.map((entry) => entry.meeting_id);

    assert.deepEqual(enqueuedIds, [oldest, middle]);
    assert.equal(result.enqueued.length, 2);
    assert.ok(!enqueuedIds.includes(newest));
  });

  it("reports skipped meetings with their reasons: already queued, already extracted, no minutes", async () => {
    const p = `${PREFIX}-reasons`;
    const src = await createSource(p, { enabled: true });

    // Already extracted: a finished run that read something.
    const extracted = await createMeeting(src.commissionId, { date: "2019-01-01" });
    const extractedSha = sha256Of(`${p}-extracted`);
    shas.push(extractedSha);
    await withMinutesArtifact(db, src.sourceId, extracted, extractedSha);
    await db("extraction_runs").insert({
      meeting_id: extracted,
      status: "succeeded",
      finished_at: db.fn.now(),
      artifact_sha256: extractedSha,
    });

    // No minutes artifact at all.
    const noMinutes = await createMeeting(src.commissionId, { date: "2019-02-01" });

    // Already queued: an extract job pending for it.
    const queuedMeeting = await createMeeting(src.commissionId, { date: "2019-03-01" });
    const queuedSha = sha256Of(`${p}-queued`);
    shas.push(queuedSha);
    await withMinutesArtifact(db, src.sourceId, queuedMeeting, queuedSha);
    const preRunId = await createRun(src.sourceId, { status: "running" });
    await db("ingestion_jobs").insert({
      run_id: preRunId,
      stage: "extract",
      target: JSON.stringify({ sha256: queuedSha, meetingId: queuedMeeting }),
      status: "pending",
    });

    // Eligible, so the batch actually enqueues something too.
    const eligible = await createMeeting(src.commissionId, { date: "2019-04-01" });
    const eligibleSha = sha256Of(`${p}-eligible`);
    shas.push(eligibleSha);
    await withMinutesArtifact(db, src.sourceId, eligible, eligibleSha);

    const result = await enqueueExtractionBatch(db, queue, MAX_EXTRACT_BATCH);

    const byId = new Map(result.skipped.map((entry) => [entry.meeting_id, entry]));
    assert.equal(byId.get(extracted)?.reason, "already_extracted");
    assert.equal(byId.get(noMinutes)?.reason, "no_minutes_artifact");
    assert.equal(byId.get(queuedMeeting)?.reason, "already_queued");
    for (const entry of result.skipped) {
      assert.ok(entry.detail.length > 0, `skip reason for ${entry.meeting_id} must carry a detail`);
    }

    assert.ok(result.enqueued.some((entry) => entry.meeting_id === eligible));
  });

  it("is idempotent: running the batch twice enqueues nothing the second time", async () => {
    const p = `${PREFIX}-idempotent`;
    const src = await createSource(p, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2018-01-01" });
    const sha = sha256Of(`${p}-idempotent`);
    shas.push(sha);
    await withMinutesArtifact(db, src.sourceId, meetingId, sha);

    const first = await enqueueExtractionBatch(db, queue, MAX_EXTRACT_BATCH);
    assert.ok(first.enqueued.some((entry) => entry.meeting_id === meetingId));

    const jobId = await queuedExtraction(db, meetingId);
    assert.ok(jobId, "the first run must have left a queued job behind");

    const second = await enqueueExtractionBatch(db, queue, MAX_EXTRACT_BATCH);
    assert.ok(
      !second.enqueued.some((entry) => entry.meeting_id === meetingId),
      "a meeting already queued must not be enqueued again",
    );
    const skip = second.skipped.find((entry) => entry.meeting_id === meetingId);
    assert.equal(skip?.reason, "already_queued");
  });

  it("requires auth", async () => {
    await request(app).post("/api/admin/pressroom/meetings/extract-batch").send({ limit: 1 }).expect(401);
  });

  it("maps a status code to a skip reason only for the two enqueueExtraction actually throws", () => {
    // Pins the classifier a real reviewer caught: it used to return
    // "already_queued" for ANY status code that was not 404, so a future
    // failure (say a 500 opening the run) would have been relabelled a
    // benign skip instead of surfacing as the error it is.
    assert.equal(
      skipReasonFor(new ExtractionUnavailable("no minutes", 404)),
      "no_minutes_artifact",
    );
    assert.equal(
      skipReasonFor(new ExtractionUnavailable("already queued", 409)),
      "already_queued",
    );
    assert.equal(
      skipReasonFor(new ExtractionUnavailable("could not open a run", 500)),
      null,
      "an unrecognised status code must not be classified as a skip",
    );
  });

  it("does not swallow a failure that is not ExtractionUnavailable into skipped", async () => {
    const p = `${PREFIX}-real-failure`;
    const src = await createSource(p, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2016-01-01" });
    const sha = sha256Of(`${p}-real-failure`);
    shas.push(sha);
    await withMinutesArtifact(db, src.sourceId, meetingId, sha);

    // A real queue wrapped in a Proxy that fails only `enqueue`, rather than a
    // cast to the interface — the hard rule against casts to quiet the
    // compiler applies to test code too, and `Proxy<T>` stays `T` with no cast.
    const brokenQueue = new Proxy(queue, {
      get(target, prop, receiver) {
        if (prop === "enqueue") {
          return async (): Promise<string> => {
            throw new Error("queue is unreachable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await assert.rejects(
      () => enqueueExtractionBatch(db, brokenQueue, 1),
      /queue is unreachable/,
    );
  });

  describe("with a live stack registered", () => {
    before(() => {
      const liveStack = buildIngestionStack(db);
      registerPressroomStack({ queue: liveStack.queue, scheduler: liveStack.scheduler });
    });

    after(() => {
      registerPressroomStack(null);
    });

    it("is reachable and not shadowed by /meetings/:id/extract", async () => {
      // A meaningless UUID as ":id" would 400 "Invalid meeting id" if this
      // request were being matched against /meetings/:id/extract or
      // /meetings/:id instead of the literal /meetings/extract-batch path.
      const res = await request(app)
        .post("/api/admin/pressroom/meetings/extract-batch")
        .set("Cookie", cookie)
        .send({ limit: 1 })
        .expect(202);
      assert.ok(Array.isArray(res.body.enqueued));
      assert.ok(Array.isArray(res.body.skipped));
      assert.equal(res.body.limit, 1);
    });

    it("rejects a missing, zero, negative, or non-integer limit", async () => {
      for (const body of [{}, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "5" }]) {
        const res = await request(app)
          .post("/api/admin/pressroom/meetings/extract-batch")
          .set("Cookie", cookie)
          .send(body)
          .expect(400);
        assert.match(res.body.error, /positive integer/);
      }
    });

    it(`rejects a limit over ${MAX_EXTRACT_BATCH}, naming the ceiling, not clamping it`, async () => {
      const res = await request(app)
        .post("/api/admin/pressroom/meetings/extract-batch")
        .set("Cookie", cookie)
        .send({ limit: MAX_EXTRACT_BATCH + 1 })
        .expect(400);
      assert.match(res.body.error, new RegExp(String(MAX_EXTRACT_BATCH)));
    });

    it("the response discloses both enqueued and skipped, never a bare count", async () => {
      const p = `${PREFIX}-response-shape`;
      const src = await createSource(p, { enabled: true });
      const noMinutes = await createMeeting(src.commissionId, { date: "2017-01-01" });
      void noMinutes;

      const res = await request(app)
        .post("/api/admin/pressroom/meetings/extract-batch")
        .set("Cookie", cookie)
        .send({ limit: 1 })
        .expect(202);

      assert.equal(typeof res.body === "object" && res.body !== null, true);
      assert.ok("enqueued" in res.body);
      assert.ok("skipped" in res.body);
      assert.equal(Object.keys(res.body).includes("count"), false);
    });
  });
});
