import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { collectMetrics } from "../src/services/metrics";
import { totalTranscriptCoverage, transcriptCoverage } from "../src/services/transcript-coverage";

/**
 * `/api/metrics` publishes this project's own numbers.
 *
 * The tests that matter here are not the arithmetic. They are the two ways this
 * endpoint could become dishonest: by leaking an identifier from a record an
 * operator withheld, and by rendering "we have never published anything" as a
 * number that reads like a fast answer.
 */

const JURISDICTION_NAME = "Metrics Test County";

let jurisdictionId: string;
let commissionId: string;
let publishedId: string;
let withheldId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
}

before(async () => {
  await removeFixtures();
  const [j] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  jurisdictionId = typeof j === "string" ? j : j.id;

  const [c] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "Metrics Board" })
    .returning("id");
  commissionId = typeof c === "string" ? c : c.id;

  const [published] = await db("meetings")
    .insert({
      commission_id: commissionId,
      date: "2026-01-05",
      // Ten days between sitting and publication, so the median is assertable.
      published_at: new Date("2026-01-15T00:00:00Z"),
    })
    .returning("id");
  publishedId = typeof published === "string" ? published : published.id;

  const [withheld] = await db("meetings")
    .insert({ commission_id: commissionId, date: "2026-02-02" })
    .returning("id");
  withheldId = typeof withheld === "string" ? withheld : withheld.id;

  await db("agenda_items").insert({
    meeting_id: withheldId,
    item_number: 1,
    title: "Ordinance 7788 withheld-from-metrics probe",
  });
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

describe("GET /api/metrics", () => {
  it("is public and needs no operator session", async () => {
    const res = await request(app).get("/api/metrics");
    assert.equal(res.status, 200);
  });

  it("counts a withheld meeting in the total but not in the published count", async () => {
    const metrics = await collectMetrics(db);
    // The count is the point: a reader must be able to tell how much of the
    // archive is being held back, without being able to tell *which*.
    assert.ok(metrics.corpus.meetings_total >= 2);
    assert.ok(metrics.corpus.meetings_total > metrics.corpus.meetings_published);
  });

  /**
   * The wall. `publication.ts` answers 404 rather than 403 so a stranger cannot
   * enumerate what has been ingested and withheld; an aggregate count names
   * nobody, but a title or an id would undo that in one field.
   */
  it("returns no identifier or free text from any record", async () => {
    const res = await request(app).get("/api/metrics");
    const body = JSON.stringify(res.body);

    assert.ok(!body.includes(withheldId), "leaked an unpublished meeting id");
    assert.ok(!body.includes(publishedId), "leaked a meeting id");
    assert.ok(
      !body.includes("Ordinance 7788"),
      "leaked the title of an item on an unpublished meeting",
    );
    assert.ok(!body.includes(JURISDICTION_NAME), "leaked a jurisdiction name");
  });

  it("reports every value as a number or a stated absence, never a mixture", async () => {
    const metrics = await collectMetrics(db);
    for (const [key, value] of Object.entries(metrics.corpus)) {
      assert.equal(typeof value, "number", `corpus.${key} must be a number`);
    }
    for (const [key, value] of Object.entries(metrics.review)) {
      assert.equal(typeof value, "number", `review.${key} must be a number`);
    }
    for (const [key, value] of Object.entries(metrics.quality)) {
      const expected = key === "roster_sourced" ? "boolean" : "number";
      assert.equal(typeof value, expected, `quality.${key} must be a ${expected}`);
    }
  });

  /**
   * `rosterCoverage` and the vote-event counts were built as exported functions
   * with no caller. A quality signal nothing reads is a signal nobody acts on.
   */
  it("reports the roster gap, which is what predicts the rejection rate", async () => {
    const metrics = await collectMetrics(db);
    assert.equal(typeof metrics.quality.roster_unmatched, "number");
    assert.equal(typeof metrics.quality.roster_seats_implied, "number");
  });

  /**
   * `members` has no source URL, no fetched-at and no artifact sha, so no row
   * can prove where it came from. Publishing the `false` is the point — it is
   * the gap that gates the whole claims pipeline, and a page that quietly
   * reported `true` would be claiming provenance the schema cannot carry.
   */
  it("says plainly that no roster is sourced yet", async () => {
    const metrics = await collectMetrics(db);
    assert.equal(
      metrics.quality.roster_sourced,
      false,
      "members carries no provenance columns; reporting true would be a claim we cannot support",
    );
  });

  /**
   * Four numbers, not three. A body with two hundred unswept meetings must not
   * be able to render as fully covered, which is exactly what dropping
   * `unchecked` would allow — and `absent` and `unavailable` stay apart because
   * one is the custodian's empty caption file and the other is our failure to
   * read anything at all.
   */
  it("reports transcripts as four separate numbers in the quality block", async () => {
    const metrics = await collectMetrics(db);
    const keys = Object.keys(metrics.quality).filter((key) => key.startsWith("transcripts_"));
    assert.deepEqual(
      keys.sort(),
      [
        "transcripts_absent",
        "transcripts_published",
        "transcripts_unavailable",
        "transcripts_unchecked",
      ],
      "all four transcript states are reported, and none is folded into another",
    );
  });

  it("matches the totals the public coverage route breaks down", async () => {
    // The summary and the breakdown are the same query. If these ever disagree
    // there are two aggregations, which is the thing this reuses to avoid.
    const metrics = await collectMetrics(db);
    const rows = await transcriptCoverage(db);
    const summed = totalTranscriptCoverage(rows);
    assert.equal(metrics.quality.transcripts_published, summed.published);
    assert.equal(metrics.quality.transcripts_absent, summed.absent);
    assert.equal(metrics.quality.transcripts_unavailable, summed.unavailable);
    assert.equal(metrics.quality.transcripts_unchecked, summed.unchecked);
  });

  it("counts a transcript on a withheld meeting nowhere at all", async () => {
    // Unlike every other figure here, transcript coverage is inside the
    // publication wall: it comes from `transcriptCoverage`, which joins through
    // `meetings.published_at`. A transcript document on a meeting an operator
    // has not published contributes to none of the four.
    const before = await collectMetrics(db);
    const [document] = await db("meeting_documents")
      .insert({
        meeting_id: withheldId,
        title: "Captions (withheld probe)",
        document_type: "transcript",
        url: "https://metrics.invalid/videos/1/captions.vtt",
      })
      .returning("id");
    const documentId = typeof document === "string" ? document : document.id;
    try {
      const after = await collectMetrics(db);
      assert.equal(after.quality.transcripts_unchecked, before.quality.transcripts_unchecked);
      assert.equal(after.quality.transcripts_published, before.quality.transcripts_published);
    } finally {
      await db("meeting_documents").where({ id: documentId }).del();
    }
  });

  it("derives held findings so the parts always sum to the whole", async () => {
    const metrics = await collectMetrics(db);
    assert.equal(
      metrics.review.findings_held + metrics.review.findings_published,
      metrics.review.findings_total,
    );
  });

  it("measures publication latency in days from the meeting date", async () => {
    const metrics = await collectMetrics(db);
    assert.ok(
      metrics.latency.median_days_to_publish !== null,
      "a published meeting exists, so there is a median",
    );
    assert.ok(
      (metrics.latency.median_days_to_publish ?? 0) > 0,
      "publication happened after the meeting, so the median is positive",
    );
  });

  /**
   * "Never" and "immediately" are opposite claims and both would render as 0.
   * A transparency project reporting instant publication because it has never
   * published anything is the worst available failure of this endpoint.
   */
  it("reports null, not zero, when nothing has ever been published", async () => {
    await db.transaction(async (trx) => {
      const empty = await collectMetrics(
        // A transaction that hides every publication, rolled back afterwards, so
        // the assertion runs against a real empty state rather than a stub.
        await trx("meetings").update({ published_at: null }).then(() => trx),
      );
      assert.equal(empty.latency.median_days_to_publish, null);
      assert.equal(empty.latency.last_published_at, null);
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });
});
