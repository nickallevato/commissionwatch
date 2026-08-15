import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  extractionBacklog,
  extractionDistribution,
  listUnextractedMeetings,
  type DistributionReason,
  type ExtractionDistribution,
} from "../src/services/extraction/distribution";
import type { ExtractionOutcome, FailedChunk } from "../src/services/extraction/extractor";
import { classifyExtraction, summariseFailures } from "../src/services/extraction/runs";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createRun,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * The tally the design of record asked for, and the reason it is a delta.
 *
 * `extractionDistribution` aggregates the whole table on purpose — "what
 * fraction of the corpus went unread" is a question about the corpus, and a
 * version that took a filter would answer a different question. So these tests
 * measure the distribution before and after inserting known rows and assert on
 * the difference, exactly as a suite sharing a database with the seed has to.
 * Asserting absolute counts here would pass alone and fail beside anything else.
 */

const PREFIX = "extract-dist-test";

const SHAS = {
  unread: sha256Of(`${PREFIX}-unread`),
  hidden: sha256Of(`${PREFIX}-hidden`),
  read: sha256Of(`${PREFIX}-read`),
  queued: sha256Of(`${PREFIX}-queued`),
  agenda: sha256Of(`${PREFIX}-agenda`),
};

after(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts(Object.values(SHAS));
  await db.destroy();
});

/** A failed chunk with a stated reason. */
function chunk(index: number, reason: FailedChunk["reason"]): FailedChunk {
  return {
    index,
    error: `chunk ${index} failed: ${reason ?? "unclassified"}`,
    reason,
    finish_reason: null,
    native_finish_reason: null,
    recovered: 0,
  };
}

interface RunFixture {
  meetingId: string;
  status: "running" | "succeeded" | "partial" | "failed";
  chunks: number;
  failed: unknown[];
}

async function insertRun(fixture: RunFixture): Promise<void> {
  await db("extraction_runs").insert({
    meeting_id: fixture.meetingId,
    status: fixture.status,
    chunks: fixture.chunks,
    failed_chunks: JSON.stringify(fixture.failed),
    // The CHECK in migration 073 makes `finished_at IS NULL` exactly equivalent
    // to `running`, so a terminal fixture has to carry one.
    finished_at: fixture.status === "running" ? null : new Date(),
  });
}

function reasonCount(distribution: ExtractionDistribution, reason: DistributionReason): number {
  return distribution.by_reason.find((tally) => tally.reason === reason)?.chunks ?? 0;
}

function reasonRuns(distribution: ExtractionDistribution, reason: DistributionReason): number {
  return distribution.by_reason.find((tally) => tally.reason === reason)?.runs ?? 0;
}

describe("the corpus-wide failure distribution", () => {
  let before_: ExtractionDistribution;
  let after_: ExtractionDistribution;
  let meetingId = "";

  before(async () => {
    const fixture = await createSource(PREFIX);
    meetingId = await createMeeting(fixture.commissionId);
    before_ = await extractionDistribution(db);

    // Read whole.
    await insertRun({ meetingId, status: "succeeded", chunks: 4, failed: [] });
    // Read in part: two truncations and a refusal.
    await insertRun({
      meetingId,
      status: "partial",
      chunks: 9,
      failed: [chunk(0, "truncated-reply"), chunk(3, "truncated-reply"), chunk(7, "refused")],
    });
    // Read not at all.
    await insertRun({
      meetingId,
      status: "failed",
      chunks: 3,
      failed: [chunk(0, "request-failed"), chunk(1, "request-failed"), chunk(2, "request-failed")],
    });
    // In flight, and therefore not part of any answer.
    await insertRun({ meetingId, status: "running", chunks: 0, failed: [] });
    // One row from before the taxonomy existed, and one written by a version
    // that knows a reason this one does not.
    await insertRun({
      meetingId,
      status: "partial",
      // Three chunks, two of them unread: a partial run, so the count of runs
      // that read nothing stays at the one that genuinely read nothing.
      chunks: 3,
      failed: [{ index: 0, error: "legacy row, no reason" }, { index: 1, error: "x", reason: "martian" }],
    });

    after_ = await extractionDistribution(db);
  });

  it("counts every finished run and no running one", () => {
    assert.equal(after_.runs - before_.runs, 4);
    // A `running` row has chunks 0 and failed_chunks [] because `finishRun` has
    // not written them yet. Counting it would report an unread fraction of zero
    // for work that has not happened.
    assert.equal(after_.chunks - before_.chunks, 4 + 9 + 3 + 3);
    assert.equal(after_.unread - before_.unread, 3 + 3 + 2);
  });

  it("tallies each reason by chunk and by run", () => {
    assert.equal(reasonCount(after_, "truncated-reply") - reasonCount(before_, "truncated-reply"), 2);
    assert.equal(reasonRuns(after_, "truncated-reply") - reasonRuns(before_, "truncated-reply"), 1);
    assert.equal(reasonCount(after_, "refused") - reasonCount(before_, "refused"), 1);
    assert.equal(reasonCount(after_, "request-failed") - reasonCount(before_, "request-failed"), 3);
  });

  it("puts an unknown reason and a legacy row in the same unclassified bucket", () => {
    // Both mean "we cannot say why this chunk went unread". A separate bucket
    // for the unknown string would be a distinction the row cannot support.
    assert.equal(reasonCount(after_, "unclassified") - reasonCount(before_, "unclassified"), 2);
  });

  it("orders the reasons by how much of the corpus each one costs", () => {
    for (let index = 1; index < after_.by_reason.length; index += 1) {
      assert.ok(
        after_.by_reason[index - 1].chunks >= after_.by_reason[index].chunks,
        "by_reason must lead with the dominant failure",
      );
    }
  });

  it("separates a run that read nothing from one that read some of the document", () => {
    assert.equal(after_.runs_wholly_unread - before_.runs_wholly_unread, 1);
    assert.equal(after_.by_status.partial - before_.by_status.partial, 2);
    assert.equal(after_.by_status.failed - before_.by_status.failed, 1);
  });

  it("names a content filter separately, because no retry fixes it", () => {
    assert.equal(after_.runs_refused - before_.runs_refused, 1);
  });

  it("counts a meeting once however many times it was attempted", () => {
    // Four runs, one meeting. §5's bar is stated over meetings, so a meeting
    // retried ten times must not read as ten meetings read.
    assert.equal(after_.meetings - before_.meetings, 1);
    assert.equal(after_.meetings_read - before_.meetings_read, 1);
  });

  it("derives the unread fraction from its own totals", () => {
    assert.equal(
      after_.unread_fraction,
      Math.round((after_.unread / after_.chunks) * 1000) / 1000,
    );
  });

});

describe("what a truncated reply salvaged, counted", () => {
  /**
   * The measured corpus (2026-08-15, ten stored minutes documents, twelve
   * chunks) failed four chunks and every one of them was a `truncated-reply`
   * that had already recovered between 86 and 127 complete claims. So the
   * question a tally has to answer about this corpus is not "why" — it is
   * unanimous — but "did we get anything anyway".
   */
  it("adds the salvage up per reason and across the corpus", async () => {
    const fixture = await createSource(`${PREFIX}-salvage`);
    const meetingId = await createMeeting(fixture.commissionId);
    const before_ = await extractionDistribution(db);

    await insertRun({
      meetingId,
      status: "partial",
      chunks: 3,
      failed: [
        { ...chunk(0, "truncated-reply"), recovered: 86 },
        { ...chunk(1, "request-failed"), recovered: 0 },
      ],
    });
    const after_ = await extractionDistribution(db);

    assert.equal(after_.recovered - before_.recovered, 86);
    const truncated = after_.by_reason.find((tally) => tally.reason === "truncated-reply");
    const truncatedBefore = before_.by_reason.find((tally) => tally.reason === "truncated-reply");
    assert.equal((truncated?.recovered ?? 0) - (truncatedBefore?.recovered ?? 0), 86);
  });

  it("counts a legacy chunk's salvage as zero, not as unknown", async () => {
    const fixture = await createSource(`${PREFIX}-legacy-salvage`);
    const meetingId = await createMeeting(fixture.commissionId);
    const before_ = await extractionDistribution(db);
    // Written before the field existed. Reporting it as anything but zero
    // would be inventing a number for a row that does not carry one.
    await insertRun({
      meetingId,
      status: "partial",
      chunks: 2,
      failed: [{ index: 0, error: "old row", reason: "truncated-reply" }],
    });
    const after_ = await extractionDistribution(db);
    assert.equal(after_.recovered - before_.recovered, 0);
  });
});

describe("a failed_chunks column that is not an array", () => {
  it("is skipped rather than raising", async () => {
    const fixture = await createSource(`${PREFIX}-malformed`);
    const meetingId = await createMeeting(fixture.commissionId);
    await db("extraction_runs").insert({
      meeting_id: meetingId,
      status: "failed",
      chunks: 5,
      // What a restore or a hand-edit could leave behind. `jsonb_array_length`
      // and `jsonb_array_elements` both raise on this.
      failed_chunks: JSON.stringify({ index: 0, error: "not an array" }),
      finished_at: new Date(),
    });

    const distribution = await extractionDistribution(db);
    assert.ok(distribution.runs > 0);
  });
});

describe("a one-chunk document whose only reply was cut short", () => {
  /** An outcome with the fields `classifyExtraction` reads, and nothing else. */
  const outcomeWith = (chunks: number, failed: FailedChunk[]): ExtractionOutcome => ({
    model: "test/model:free",
    served_models: ["test/model:free"],
    prompt_version: "test",
    chunks,
    proposed: 0,
    result: { verified: [], rejected: [] },
    verified: [],
    failedChunks: failed,
  });

  it("is partial, not failed, when claims were salvaged from it", () => {
    // The defect this closes, measured on 2026-08-15: four of ten documents
    // were single-chunk truncations that had recovered dozens of verified
    // claims, and every one landed `failed` — a run holding stored claims out
    // of bytes it was recorded as not having read. `stage.ts` then throws on
    // `failed`, so the queue retried a deterministic outcome five times against
    // a per-minute rate-limited free tier and failed the job anyway.
    const outcome = outcomeWith(1, [{ ...chunk(0, "truncated-reply"), recovered: 114 }]);
    assert.equal(classifyExtraction(outcome), "partial");
  });

  it("is still failed when nothing at all came back", () => {
    // The original rule, unchanged: no evidence the document was read.
    assert.equal(classifyExtraction(outcomeWith(1, [chunk(0, "request-failed")])), "failed");
    assert.equal(
      classifyExtraction(outcomeWith(2, [chunk(0, "refused"), chunk(1, "refused")])),
      "failed",
    );
  });

  it("is still failed for a legacy run, whose chunks carry no salvage count", () => {
    const legacy: FailedChunk = {
      index: 0,
      error: "written before the field existed",
      reason: "truncated-reply",
      finish_reason: null,
      native_finish_reason: null,
      recovered: null,
    };
    // A null must not silently reclassify every historical run.
    assert.equal(classifyExtraction(outcomeWith(1, [legacy])), "failed");
  });

  it("reports the salvage in the per-run summary too", () => {
    const summary = summariseFailures(1, [{ ...chunk(0, "truncated-reply"), recovered: 86 }]);
    assert.equal(summary.recovered, 86);
    // The tail of that chunk still went unread, and the fraction says so.
    assert.equal(summary.unread_fraction, 1);
  });
});

describe("the backlog: how much of the corpus is unread", () => {
  let unreadMeeting = "";
  let unpublishedMeeting = "";
  let readMeeting = "";
  let queuedMeeting = "";
  let agendaOnlyMeeting = "";

  before(async () => {
    const fixture = await createSource(`${PREFIX}-backlog`);
    const runId = await createRun(fixture.sourceId);

    const parseJob = async (meetingId: string, sha256: string, documentType: string) => {
      await db("ingestion_jobs").insert({
        run_id: runId,
        stage: "parse",
        target: JSON.stringify({ sha256, meetingId, documentType }),
        status: "done",
        attempts: 1,
      });
    };

    unreadMeeting = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    unpublishedMeeting = await createMeeting(fixture.commissionId, { publishedAt: null });
    readMeeting = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    queuedMeeting = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    agendaOnlyMeeting = await createMeeting(fixture.commissionId, { publishedAt: new Date() });

    await createArtifact(SHAS.unread, "https://example.invalid/unread.pdf");
    await createArtifact(SHAS.hidden, "https://example.invalid/hidden.pdf");
    await createArtifact(SHAS.read, "https://example.invalid/read.pdf");
    await createArtifact(SHAS.queued, "https://example.invalid/queued.pdf");
    await createArtifact(SHAS.agenda, "https://example.invalid/agenda.pdf");

    await parseJob(unreadMeeting, SHAS.unread, "minutes");
    await parseJob(unpublishedMeeting, SHAS.hidden, "minutes");
    await parseJob(readMeeting, SHAS.read, "minutes");
    await parseJob(queuedMeeting, SHAS.queued, "minutes");
    // An agenda is not extractable: extracting votes from an agenda would
    // produce claims about things that had not happened yet.
    await parseJob(agendaOnlyMeeting, SHAS.agenda, "agenda");

    await insertRun({ meetingId: readMeeting, status: "partial", chunks: 3, failed: [chunk(0, "refused")] });
    await db("ingestion_jobs").insert({
      run_id: runId,
      stage: "extract",
      target: JSON.stringify({ sha256: SHAS.queued, meetingId: queuedMeeting }),
      status: "pending",
      attempts: 0,
    });
  });

  it("counts a meeting as read when any run read part of it", async () => {
    const backlog = await extractionBacklog(db);
    // `partial` counts: some of the document was examined, and the unread
    // fraction — not the backlog — is where the rest is stated.
    assert.ok(backlog.read >= 1);
    assert.ok(backlog.eligible >= 4);
    assert.equal(backlog.eligible - backlog.read, backlog.unread);
    assert.ok(backlog.queued >= 1);
  });

  it("lists the meetings whose minutes are stored and unread", async () => {
    const meetings = await listUnextractedMeetings(db, { limit: 1000 });
    const ids = meetings.map((meeting) => meeting.meeting_id);

    assert.ok(ids.includes(unreadMeeting), "a meeting with stored minutes and no run is backlog");
    assert.ok(ids.includes(unpublishedMeeting), "the backlog is our work queue, not the public one");
    assert.ok(!ids.includes(readMeeting), "a meeting already read is not backlog");
    // Enqueueing a second extract job for the same meeting is refused with a
    // 409, so a backfill that listed it would spend its limit collecting them.
    assert.ok(!ids.includes(queuedMeeting), "a queued meeting is already accounted for");
    assert.ok(!ids.includes(agendaOnlyMeeting), "an agenda is not minutes");

    const found = meetings.find((meeting) => meeting.meeting_id === unreadMeeting);
    assert.equal(found?.sha256, SHAS.unread, "the backlog names the bytes extraction would read");
    assert.equal(found?.published, true);
  });

  it("can be narrowed to published meetings, which is §5's bar", async () => {
    const meetings = await listUnextractedMeetings(db, { limit: 1000, publishedOnly: true });
    const ids = meetings.map((meeting) => meeting.meeting_id);
    assert.ok(ids.includes(unreadMeeting));
    assert.ok(!ids.includes(unpublishedMeeting));
  });

  it("honours its limit", async () => {
    const meetings = await listUnextractedMeetings(db, { limit: 1 });
    assert.equal(meetings.length, 1);
  });
});
