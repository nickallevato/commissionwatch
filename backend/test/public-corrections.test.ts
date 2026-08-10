import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { appendCorrectionRow, CorrectionError } from "../src/services/pressroom/corrections";
import type { PublicCorrection } from "../src/services/public-corrections";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * B3 · the public corrections log.
 *
 * The thing this suite exists to prove is the wall. `/api/corrections` takes no
 * id, so — like P6's search — it is a public surface a stranger can reach
 * without guessing anything, and a correction row quotes a fact about its
 * target in `old_value`. Publishing one for a withheld record would disclose
 * the withheld record.
 *
 * So every target table is asserted **in both directions**: withheld and
 * absent, then published and present. Absence alone would also hold for a query
 * that is simply broken, which is why the second half of each pair matters as
 * much as the first.
 *
 * `record_corrections` forbids DELETE, so nothing here cleans up after itself.
 * Every assertion keys on ids this run generated, never on a table-wide count.
 */

const PREFIX = "public-corrections-test";

interface LogBody {
  data: PublicCorrection[];
  total: number;
}

async function fetchLog(): Promise<PublicCorrection[]> {
  const res = await request(app).get("/api/corrections?limit=200").expect(200);
  const body = res.body as LogBody;
  return body.data;
}

function ids(corrections: PublicCorrection[]): string[] {
  return corrections.map((correction) => correction.id);
}

describe("the public corrections log", () => {
  let publishedMeeting = "";
  let withheldMeeting = "";
  let publishedItem = "";
  let withheldItem = "";
  let publishedDocument = "";
  let withheldDocument = "";
  let publicFlag = "";
  let heldFlag = "";

  /** Correction ids, one per target. */
  const correction: Record<string, string> = {};

  before(async () => {
    await cleanupByPrefix(PREFIX);
    const fixture = await createSource(PREFIX);

    publishedMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
      location: "Published Hall",
    });
    withheldMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-05",
      location: "Withheld Hall",
    });

    const [itemA] = await db("agenda_items")
      .insert({ meeting_id: publishedMeeting, item_number: 1, title: "Published item" })
      .returning<Array<{ id: string }>>("id");
    publishedItem = itemA.id;
    const [itemB] = await db("agenda_items")
      .insert({ meeting_id: withheldMeeting, item_number: 1, title: "Withheld item" })
      .returning<Array<{ id: string }>>("id");
    withheldItem = itemB.id;

    const [docA] = await db("meeting_documents")
      .insert({
        meeting_id: publishedMeeting,
        title: "Published agenda",
        document_type: "agenda",
        url: "https://example.invalid/published",
      })
      .returning<Array<{ id: string }>>("id");
    publishedDocument = docA.id;
    const [docB] = await db("meeting_documents")
      .insert({
        meeting_id: withheldMeeting,
        title: "Withheld agenda",
        document_type: "agenda",
        url: "https://example.invalid/withheld",
      })
      .returning<Array<{ id: string }>>("id");
    withheldDocument = docB.id;

    const [flagA] = await db("anomaly_flags")
      .insert({
        meeting_id: publishedMeeting,
        flag_type: "emergency_session",
        description: "An approved finding",
        severity: "high",
        review_state: "published",
      })
      .returning<Array<{ id: string }>>("id");
    publicFlag = flagA.id;
    const [flagB] = await db("anomaly_flags")
      .insert({
        meeting_id: publishedMeeting,
        flag_type: "quorum_issue",
        description: "A held finding",
        severity: "high",
        review_state: "held",
      })
      .returning<Array<{ id: string }>>("id");
    heldFlag = flagB.id;

    const targets: Array<[string, string, string, string, string | null, string | null]> = [
      ["publishedMeeting", "meetings", publishedMeeting, "location", "Old Hall", "Published Hall"],
      ["withheldMeeting", "meetings", withheldMeeting, "location", "Old Hall", "Withheld Hall"],
      ["publishedItem", "agenda_items", publishedItem, "title", "Old title", "Published item"],
      ["withheldItem", "agenda_items", withheldItem, "title", "Old title", "Withheld item"],
      [
        "publishedDocument",
        "meeting_documents",
        publishedDocument,
        "title",
        "Old doc",
        "Published agenda",
      ],
      [
        "withheldDocument",
        "meeting_documents",
        withheldDocument,
        "title",
        "Old doc",
        "Withheld agenda",
      ],
      ["publicFlag", "anomaly_flags", publicFlag, "review_state", "held", "published"],
      ["heldFlag", "anomaly_flags", heldFlag, "review_state", "held", "published"],
    ];

    for (const [key, table, id, field, oldValue, newValue] of targets) {
      const row = await appendCorrectionRow(db, {
        targetTable: table,
        targetId: id,
        field,
        oldValue,
        newValue,
        reason: `${PREFIX}: the source document says otherwise.`,
        actor: { id: null, email: "operator@example.invalid" },
      });
      correction[key] = row.id;
    }

    // Two targets that must never surface, whatever their state.
    const policy = await db("review_policy").first<{ id: string } | undefined>();
    assert.ok(policy, "review_policy has no row");
    const policyRow = await appendCorrectionRow(db, {
      targetTable: "review_policy",
      targetId: policy.id,
      field: "hold_at_or_above",
      oldValue: "high",
      newValue: "medium",
      reason: `${PREFIX}: threshold change.`,
      actor: { id: null, email: "operator@example.invalid" },
    });
    correction.policy = policyRow.id;

    const [dispute] = await db("record_disputes")
      .insert({
        reference: `CW-${PREFIX.slice(0, 8).toUpperCase()}`,
        target_table: "meetings",
        target_id: publishedMeeting,
        contested: "The location is wrong",
        account: "SECRET CONTESTER ACCOUNT TEXT",
        contact: `${PREFIX}@example.invalid`,
      })
      .returning<Array<{ id: string }>>("id");
    const disputeRow = await appendCorrectionRow(db, {
      targetTable: "record_disputes",
      targetId: dispute.id,
      field: "status",
      oldValue: null,
      newValue: "received",
      reason: `${PREFIX}: dispute received.`,
      actor: { id: null, email: null },
      disputeId: dispute.id,
    });
    correction.dispute = disputeRow.id;

    // And one correction to the published meeting that names the dispute, so
    // the reference — and only the reference — can be asserted on the page.
    const prompted = await appendCorrectionRow(db, {
      targetTable: "meetings",
      targetId: publishedMeeting,
      field: "location",
      oldValue: "Published Hall",
      newValue: "Corrected Hall",
      reason: `${PREFIX}: corrected after a dispute.`,
      actor: { id: null, email: "operator@example.invalid" },
      disputeId: dispute.id,
    });
    correction.prompted = prompted.id;
  });

  after(async () => {
    await db("record_disputes").where("contact", "like", `${PREFIX}%`).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  it("publishes a correction to a published meeting", async () => {
    const log = await fetchLog();
    assert.ok(ids(log).includes(correction.publishedMeeting));
  });

  it("withholds a correction to an unpublished meeting", async () => {
    const log = await fetchLog();
    assert.ok(
      !ids(log).includes(correction.withheldMeeting),
      "a correction to an unpublished meeting was published",
    );
    // The wall is what hides it — nothing about the row itself.
    for (const entry of log) {
      assert.ok(
        !entry.summary.includes("Withheld Hall"),
        "an unpublished meeting's value leaked through a correction summary",
      );
    }
  });

  it("reveals the withheld meeting's correction once it is published", async () => {
    const before = await fetchLog();
    assert.ok(!ids(before).includes(correction.withheldMeeting));

    await db("meetings").where({ id: withheldMeeting }).update({ published_at: new Date() });
    const after = await fetchLog();
    assert.ok(
      ids(after).includes(correction.withheldMeeting),
      "publishing the meeting did not surface its correction",
    );

    await db("meetings").where({ id: withheldMeeting }).update({ published_at: null });
    const again = await fetchLog();
    assert.ok(
      !ids(again).includes(correction.withheldMeeting),
      "unpublishing the meeting did not withdraw its correction",
    );
  });

  it("walks the wall for an agenda item and a document, in both directions", async () => {
    const before = await fetchLog();
    assert.ok(ids(before).includes(correction.publishedItem));
    assert.ok(ids(before).includes(correction.publishedDocument));
    assert.ok(!ids(before).includes(correction.withheldItem));
    assert.ok(!ids(before).includes(correction.withheldDocument));

    await db("meetings").where({ id: withheldMeeting }).update({ published_at: new Date() });
    const after = await fetchLog();
    assert.ok(ids(after).includes(correction.withheldItem));
    assert.ok(ids(after).includes(correction.withheldDocument));

    await db("meetings").where({ id: withheldMeeting }).update({ published_at: null });
  });

  it("publishes a finding's approval and withholds a held finding's", async () => {
    const log = await fetchLog();
    assert.ok(ids(log).includes(correction.publicFlag));
    assert.ok(
      !ids(log).includes(correction.heldFlag),
      "a correction to a held finding was published",
    );
  });

  it("withholds a finding whose meeting is not published, however approved it is", async () => {
    await db("meetings").where({ id: publishedMeeting }).update({ published_at: null });
    const log = await fetchLog();
    assert.ok(!ids(log).includes(correction.publicFlag));
    await db("meetings").where({ id: publishedMeeting }).update({ published_at: new Date() });
  });

  it("never publishes a policy change or anything about a dispute", async () => {
    const log = await fetchLog();
    assert.ok(!ids(log).includes(correction.policy), "a review_policy change was published");
    assert.ok(!ids(log).includes(correction.dispute), "a dispute's own log row was published");
    for (const entry of log) {
      assert.ok(
        !entry.reason.includes("SECRET CONTESTER ACCOUNT TEXT") &&
          !entry.summary.includes("SECRET CONTESTER ACCOUNT TEXT"),
        "a contester's account text reached the public log",
      );
    }
  });

  it("names the dispute that prompted a correction, by reference only", async () => {
    const log = await fetchLog();
    const entry = log.find((row) => row.id === correction.prompted);
    assert.ok(entry, "the prompted correction is missing");
    assert.ok(entry.dispute_reference?.startsWith("CW-"));
  });

  it("publishes no operator identity", async () => {
    const res = await request(app).get("/api/corrections?limit=200").expect(200);
    const serialised = JSON.stringify(res.body);
    assert.ok(
      !serialised.includes("operator@example.invalid"),
      "an operator's address reached the public corrections log",
    );
    assert.ok(!serialised.includes("operator_email"));
    assert.ok(!serialised.includes("operator_id"));
  });

  it("says what changed in plain words", async () => {
    const log = await fetchLog();
    const entry = log.find((row) => row.id === correction.publishedMeeting);
    assert.ok(entry);
    assert.equal(entry.record_label, "Meeting");
    assert.equal(entry.field_label, "location");
    assert.match(entry.summary, /Meeting location corrected from .*Old Hall.* to .*Published Hall/);
    assert.equal(entry.meeting_id, publishedMeeting);

    const approval = log.find((row) => row.id === correction.publicFlag);
    assert.ok(approval);
    // Not "review_state: held → published", which is our schema rather than
    // what happened.
    assert.equal(approval.summary, "Finding approved for publication by an operator.");
  });

  it("words publication as publication, not as a timestamp diff", async () => {
    const row = await appendCorrectionRow(db, {
      targetTable: "meetings",
      targetId: publishedMeeting,
      field: "published_at",
      oldValue: null,
      newValue: new Date().toISOString(),
      reason: `${PREFIX}: publishing after review.`,
      actor: { id: null, email: "operator@example.invalid" },
    });
    const log = await fetchLog();
    const entry = log.find((item) => item.id === row.id);
    assert.ok(entry);
    assert.equal(entry.summary, "Meeting published.");
  });

  it("refuses a reason that asserts motive, at the one writer every path uses", async () => {
    await assert.rejects(
      () =>
        appendCorrectionRow(db, {
          targetTable: "meetings",
          targetId: publishedMeeting,
          field: "location",
          oldValue: "a",
          newValue: "b",
          reason: "The clerk deliberately concealed the venue.",
          actor: { id: null, email: null },
        }),
      (err: unknown) => {
        assert.ok(err instanceof CorrectionError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /never the motive/);
        return true;
      },
    );
  });

  it("paginates, and answers an empty page rather than erroring", async () => {
    const res = await request(app).get("/api/corrections?limit=1&offset=0").expect(200);
    const body = res.body as LogBody;
    assert.equal(body.data.length, 1);
    assert.ok(body.total >= 1);

    const far = await request(app).get("/api/corrections?limit=1&offset=100000").expect(200);
    assert.deepEqual((far.body as LogBody).data, []);
  });
});
