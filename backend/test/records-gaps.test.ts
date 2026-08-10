import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  findGap,
  listGaps,
  parseGapId,
  SCOPED_GAP_KINDS,
  type RecordGap,
} from "../src/services/records/gaps";
import { cleanupByPrefix, createJob, createMeeting, createRun, createSource } from "./helpers/pressroom";

/**
 * P7 · the gaps in the record.
 *
 * Two things this suite is really about.
 *
 * **The gaps are derived, not listed.** Every assertion below builds rows and
 * then asks the query what it sees. Nothing names a jurisdiction, a meeting or a
 * source in the implementation, so filling a gap makes it disappear without
 * anyone pruning a list — which is asserted directly: the same meeting is
 * checked before and after its minutes arrive.
 *
 * **The public scope cannot name an unpublished meeting.** Asserted in both
 * directions, like `search.test.ts`: absent while withheld, present once
 * published. Absence alone would also hold for a query that returned nothing at
 * all.
 */

const PREFIX = "records-gaps-test";

function ids(gaps: RecordGap[]): string[] {
  return gaps.map((gap) => gap.id);
}

describe("records gaps", () => {
  let jurisdictionId = "";
  let commissionId = "";
  let sourceId = "";

  before(async () => {
    await cleanupByPrefix(PREFIX);
    const fixture = await createSource(PREFIX, { enabled: true });
    jurisdictionId = fixture.jurisdictionId;
    commissionId = fixture.commissionId;
    sourceId = fixture.sourceId;
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  describe("missing minutes", () => {
    it("finds a concluded meeting whose minutes are not in the record, and loses it when they arrive", async () => {
      const meetingId = await createMeeting(commissionId, {
        publishedAt: new Date(),
        date: "2026-08-04",
      });

      const before = await listGaps(db, "operator", { meetingId });
      const gap = before.find((row) => row.id === `missing_minutes:${meetingId}`);
      assert.ok(gap, "a concluded meeting with no minutes is a gap");
      assert.equal(gap.kind, "missing_minutes");
      assert.equal(gap.jurisdiction_id, jurisdictionId);
      assert.equal(gap.meeting_date, "2026-08-04");
      assert.match(gap.requested_record, /minutes of the .* meeting held on 2026-08-04/);

      // Nothing prunes a list: the row simply stops matching the query.
      await db("meeting_documents").insert({
        meeting_id: meetingId,
        title: "Minutes",
        document_type: "minutes",
        url: `https://example.invalid/${meetingId}-minutes.pdf`,
      });

      const after = await listGaps(db, "operator", { meetingId });
      assert.ok(!ids(after).includes(`missing_minutes:${meetingId}`));

      await db("meetings").where({ id: meetingId }).del();
    });

    it("does not treat a meeting that has not been held as missing its minutes", async () => {
      const meetingId = await createMeeting(commissionId, {
        publishedAt: new Date(),
        date: "2099-01-01",
      });
      await db("meetings").where({ id: meetingId }).update({ status: "scheduled" });

      const gaps = await listGaps(db, "operator", { meetingId });
      assert.deepEqual(ids(gaps), []);

      await db("meetings").where({ id: meetingId }).del();
    });

    it("treats a linked minutes URL as the minutes being in the record", async () => {
      const meetingId = await createMeeting(commissionId, { publishedAt: new Date() });
      await db("meetings")
        .where({ id: meetingId })
        .update({ minutes_url: "https://example.invalid/minutes.pdf" });

      const gaps = await listGaps(db, "operator", { meetingId });
      assert.ok(!ids(gaps).includes(`missing_minutes:${meetingId}`));

      await db("meetings").where({ id: meetingId }).del();
    });
  });

  describe("the publication wall", () => {
    it("hides an unpublished meeting from the public scope and reveals it on publication", async () => {
      const meetingId = await createMeeting(commissionId, { publishedAt: null });
      const gapId = `missing_minutes:${meetingId}`;

      const withheld = await listGaps(db, "public", { meetingId });
      assert.ok(!ids(withheld).includes(gapId), "an unpublished meeting is not a public gap");
      assert.equal(await findGap(db, "public", gapId), null);

      // The operator sees it throughout — the wall is between ingested and
      // published, not between the operator and the database.
      const operatorView = await listGaps(db, "operator", { meetingId });
      assert.ok(ids(operatorView).includes(gapId));

      await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });

      const published = await listGaps(db, "public", { meetingId });
      assert.ok(ids(published).includes(gapId), "publishing the meeting makes the gap public");
      assert.ok(await findGap(db, "public", gapId));

      await db("meetings").where({ id: meetingId }).del();
    });
  });

  describe("unpublished exhibits", () => {
    it("finds an agenda item naming an exhibit when the meeting holds no supporting document", async () => {
      const meetingId = await createMeeting(commissionId, { publishedAt: new Date() });
      const [item] = await db("agenda_items")
        .insert({
          meeting_id: meetingId,
          item_number: 4,
          title: "Zoning map amendment",
          description: "Staff report and Exhibit B are incorporated by reference.",
        })
        .returning<Array<{ id: string }>>("id");

      const gaps = await listGaps(db, "public", { meetingId });
      const gap = gaps.find((row) => row.id === `unpublished_exhibit:${item.id}`);
      assert.ok(gap, "an exhibit reference with nothing supporting it is a gap");
      assert.match(gap.requested_record, /Exhibit B/);
      assert.match(gap.requested_record, /agenda item 4/);
      assert.equal(gap.document_title, "Zoning map amendment");

      await db("meeting_documents").insert({
        meeting_id: meetingId,
        title: "Agenda packet",
        document_type: "packet",
        url: `https://example.invalid/${meetingId}-packet.pdf`,
      });

      const after = await listGaps(db, "public", { meetingId });
      assert.ok(!ids(after).includes(`unpublished_exhibit:${item.id}`));

      await db("meetings").where({ id: meetingId }).del();
    });

    it("ignores an agenda item that names no exhibit", async () => {
      const meetingId = await createMeeting(commissionId, { publishedAt: new Date() });
      await db("agenda_items").insert({
        meeting_id: meetingId,
        item_number: 1,
        title: "Approval of the consent agenda",
        description: "No supporting material.",
      });

      const gaps = await listGaps(db, "public", { meetingId });
      assert.ok(!gaps.some((row) => row.kind === "unpublished_exhibit"));

      await db("meetings").where({ id: meetingId }).del();
    });
  });

  describe("operator-only kinds", () => {
    it("offers a disabled source to the operator and never to the public", async () => {
      await db("ingestion_sources").where({ id: sourceId }).update({ enabled: false });

      const operatorGaps = await listGaps(db, "operator");
      const gap = operatorGaps.find((row) => row.id === `disabled_source:${sourceId}`);
      assert.ok(gap, "a source that is not collecting is an operator gap");
      assert.match(gap.requested_record, /agendas, minutes and supporting materials/);
      assert.match(gap.requested_record, /on or after \d{4}-\d{2}-\d{2}/);

      const publicGaps = await listGaps(db, "public");
      assert.ok(!ids(publicGaps).includes(`disabled_source:${sourceId}`));
      assert.equal(await findGap(db, "public", `disabled_source:${sourceId}`), null);

      await db("ingestion_sources").where({ id: sourceId }).update({ enabled: true });
    });

    it("offers a fetch that did not complete to the operator, and states no error in the letter's terms", async () => {
      const runId = await createRun(sourceId, { status: "partial" });
      const jobId = await createJob(
        runId,
        "fetch",
        { url: "https://example.invalid/exhibit-c.pdf", title: "Exhibit C" },
        { status: "failed", lastError: "403 Forbidden from the vendor edge" },
      );

      const operatorGaps = await listGaps(db, "operator");
      const gap = operatorGaps.find((row) => row.id === `failed_fetch:${jobId}`);
      assert.ok(gap, "a fetch that did not complete is an operator gap");
      assert.match(gap.requested_record, /Exhibit C/);
      // Our transport trouble is not the custodian's business and never reaches
      // the text of a request.
      assert.ok(!gap.requested_record.includes("403"));
      assert.ok(!gap.summary.includes("403"));

      const publicGaps = await listGaps(db, "public");
      assert.ok(!ids(publicGaps).includes(`failed_fetch:${jobId}`));

      await db("ingestion_runs").where({ id: runId }).del();
    });

    it("scopes the kinds themselves, so a public caller cannot ask for an operator kind", async () => {
      assert.deepEqual([...SCOPED_GAP_KINDS.public], ["missing_minutes", "unpublished_exhibit"]);
      const gaps = await listGaps(db, "public", { kinds: ["disabled_source", "failed_fetch"] });
      assert.deepEqual(gaps, []);
    });
  });

  describe("gap ids", () => {
    it("round-trips a well-formed id and rejects everything else", () => {
      const uuid = "11111111-2222-3333-4444-555555555555";
      assert.deepEqual(parseGapId(`missing_minutes:${uuid}`), {
        kind: "missing_minutes",
        subjectId: uuid,
      });
      assert.equal(parseGapId("missing_minutes"), null);
      assert.equal(parseGapId(`not_a_kind:${uuid}`), null);
      assert.equal(parseGapId("missing_minutes:not-a-uuid"), null);
      assert.equal(parseGapId("missing_minutes:' OR 1=1 --"), null);
    });
  });
});
