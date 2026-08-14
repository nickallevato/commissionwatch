import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  clampLimit,
  clampOffset,
  search,
} from "../src/services/search";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * P6 · Full-text search over the published record.
 *
 * The suite exists for one invariant above all the others: **search must not be
 * a hole through the publication wall.** Every other public path takes a meeting
 * id, so a reader who cannot guess one cannot reach a withheld record. Search
 * takes a *word*. If it ignored `meetings.published_at`, anyone could retrieve
 * an unreviewed agenda by guessing a term in it, and the entire review process
 * would be decoration.
 *
 * So the wall is asserted in both directions: the unpublished meeting, its
 * agenda items and its document text are absent, and the moment the meeting is
 * published all three appear. A test that only proved absence would also pass
 * against a search that returned nothing at all.
 *
 * Findings and matters were added later and each has a *different* wall, so
 * each gets the same treatment twice over. A finding needs an operator's
 * approval and — only if it has a meeting — a published one. A matter needs one
 * published appearance. Both directions, for both, including the case a naive
 * `join meetings` silently deletes: a records-derived finding has no meeting at
 * all and must still be findable once approved.
 */

const PREFIX = "search-test";

/**
 * A term invented for this suite.
 *
 * It has to be absent from the seed and from every other suite's fixtures, or
 * the assertions measure the database instead of the search. "Quorumcheck" is
 * not a word, and `to_tsvector` stems it to a lexeme nothing else produces.
 */
const TERM = "quorumcheck";
const HASHES = [
  sha256Of(`${PREFIX}-published`),
  sha256Of(`${PREFIX}-withheld`),
  // Backs the records-derived finding, which has no meeting and therefore needs
  // an artifact to satisfy `anomaly_flags_subject_check`.
  sha256Of(`${PREFIX}-records`),
];

interface SearchBody {
  data: Array<{
    kind: string;
    id: string;
    title: string;
    snippet: string;
    rank: number;
    meeting_id?: string | null;
    item_number?: number;
    document_type?: string;
    flag_type?: string;
    severity?: string;
    designator?: string | null;
  }>;
  total: number;
  query: string;
}

async function get(query: string, extra = ""): Promise<SearchBody> {
  const res = await request(app)
    .get(`/api/search?q=${encodeURIComponent(query)}${extra}`)
    .expect(200);
  return res.body as SearchBody;
}

/** Attaches a document, an artifact, a version and extracted text to a meeting. */
async function attachDocument(
  meetingId: string,
  sha256: string,
  title: string,
  body: string,
): Promise<string> {
  const artifactId = await createArtifact(sha256, `https://example.invalid/${sha256}.pdf`);
  const [document] = await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title,
      document_type: "agenda",
      url: `https://example.invalid/${sha256}.pdf`,
    })
    .returning<Array<{ id: string }>>("id");
  await db("document_versions").insert({
    meeting_document_id: document.id,
    artifact_id: artifactId,
    version_no: 1,
  });
  await db("artifact_texts").insert({
    artifact_id: artifactId,
    text: body,
    char_count: body.length,
  });
  return artifactId;
}

/** One finding. `meetingId` is null for a records-derived flag, which has none. */
async function createFinding(options: {
  meetingId: string | null;
  artifactId?: string;
  description: string;
  reviewState: "published" | "held";
}): Promise<string> {
  const [row] = await db("anomaly_flags")
    .insert({
      meeting_id: options.meetingId,
      artifact_id: options.artifactId ?? null,
      flag_type: "quorum_issue",
      severity: "medium",
      description: options.description,
      review_state: options.reviewState,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

/**
 * A matter and its appearances, inserted directly rather than through
 * `rebuildMatters`.
 *
 * The rebuild derives identity from agenda item titles, which would make every
 * fixture here a statement about the parser as well as about search. What these
 * tests are about is which meetings the appearances sit on, so that is what the
 * fixture states.
 */
let nextAppearanceItemNumber = 90;

async function createMatter(
  commissionId: string,
  options: { designator: string; identityKey: string; title: string; meetingIds: string[] },
): Promise<string> {
  const [matter] = await db("matters")
    .insert({
      commission_id: commissionId,
      identity_key: options.identityKey,
      designator: options.designator,
      title: options.title,
    })
    .returning<Array<{ id: string }>>("id");

  for (const meetingId of options.meetingIds) {
    // `(meeting_id, item_number)` is unique, and two matters both appearing on
    // the published meeting collide unless the counter outlives the call.
    nextAppearanceItemNumber += 1;
    const [item] = await db("agenda_items")
      .insert({
        meeting_id: meetingId,
        item_number: nextAppearanceItemNumber,
        title: `${options.designator} as noticed`,
        description: "Appearance fixture for the matters branch of search.",
      })
      .returning<Array<{ id: string }>>("id");
    await db("matter_appearances").insert({
      matter_id: matter.id,
      agenda_item_id: item.id,
      match_rule: "designator",
    });
  }

  return matter.id;
}

describe("full-text search over the record", () => {
  let publishedMeetingId: string;
  let withheldMeetingId: string;
  let titleMatchItemId: string;
  let bodyMatchItemId: string;
  let withheldItemId: string;
  let memberId: string;
  let publishedArtifactId: string;
  let withheldArtifactId: string;
  let recordsArtifactId: string;
  let publishedFindingId: string;
  let heldFindingId: string;
  let withheldMeetingFindingId: string;
  let recordsFindingId: string;
  let publishedMatterId: string;
  let withheldMatterId: string;
  let mixedMatterId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts(HASHES);
    const fixture = await createSource(PREFIX, { enabled: false });

    publishedMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-05",
      location: `${TERM} Fairgrounds Pavilion`,
    });
    withheldMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-06",
      location: `${TERM} Withheld Annex`,
    });

    const [titleItem] = await db("agenda_items")
      .insert({
        meeting_id: publishedMeetingId,
        item_number: 1,
        title: `${TERM} ordinance first reading`,
        description: "An unrelated description about drainage easements.",
      })
      .returning<Array<{ id: string }>>("id");
    titleMatchItemId = titleItem.id;

    const [bodyItem] = await db("agenda_items")
      .insert({
        meeting_id: publishedMeetingId,
        item_number: 2,
        title: "Consent agenda",
        description: `A routine item. The ${TERM} report was received and filed by the board.`,
      })
      .returning<Array<{ id: string }>>("id");
    bodyMatchItemId = bodyItem.id;

    // Stemming has a fixture of its own, so the assertion cannot be satisfied by
    // an exact match somewhere else.
    await db("agenda_items").insert({
      meeting_id: publishedMeetingId,
      item_number: 3,
      title: "Special meeting of the drainage board",
      description: "Called under the district's own bylaws.",
    });

    const [withheldItem] = await db("agenda_items")
      .insert({
        meeting_id: withheldMeetingId,
        item_number: 1,
        title: `${TERM} rezoning of the north parcel`,
        description: "Ingested, never reviewed, never published.",
      })
      .returning<Array<{ id: string }>>("id");
    withheldItemId = withheldItem.id;

    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: `${PREFIX} Alexandra Ruiz`,
        title: `${TERM} liaison to the planning board`,
        term_start: "2025-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    memberId = member.id;

    publishedArtifactId = await attachDocument(
      publishedMeetingId,
      HASHES[0],
      "Agenda packet",
      `Page one. The ${TERM} appropriation was discussed at length before the vote.`,
    );
    withheldArtifactId = await attachDocument(
      withheldMeetingId,
      HASHES[1],
      "Withheld agenda packet",
      `The ${TERM} appropriation appears here too, in a record nobody has published.`,
    );
    recordsArtifactId = await createArtifact(
      HASHES[2],
      `https://example.invalid/${HASHES[2]}.pdf`,
    );

    publishedFindingId = await createFinding({
      meetingId: publishedMeetingId,
      description: `The ${TERM} roll call shows four members present for a body of five.`,
      reviewState: "published",
    });
    heldFindingId = await createFinding({
      meetingId: publishedMeetingId,
      description: `A ${TERM} narrative waiting on an operator, and naming a person.`,
      reviewState: "held",
    });
    withheldMeetingFindingId = await createFinding({
      meetingId: withheldMeetingId,
      description: `The ${TERM} roll call on a meeting nobody has published yet.`,
      reviewState: "published",
    });
    // No meeting: a records-derived flag is about an artifact. Migration 027
    // made `meeting_id` nullable for exactly this, and it is the row an inner
    // join to `meetings` would delete without saying so.
    recordsFindingId = await createFinding({
      meetingId: null,
      artifactId: recordsArtifactId,
      description: `A ${TERM} discrepancy between the released document and the index.`,
      reviewState: "published",
    });

    publishedMatterId = await createMatter(fixture.commissionId, {
      designator: "Ordinance 2145",
      identityKey: "d:ordinance 2145",
      title: `Ordinance 2145 — ${TERM} corridor rezone`,
      meetingIds: [publishedMeetingId],
    });
    withheldMatterId = await createMatter(fixture.commissionId, {
      designator: "Ordinance 3199",
      identityKey: "d:ordinance 3199",
      title: `Ordinance 3199 — ${TERM} annexation of the east tract`,
      meetingIds: [withheldMeetingId],
    });
    mixedMatterId = await createMatter(fixture.commissionId, {
      designator: "Ordinance 4177",
      identityKey: "d:ordinance 4177",
      title: `Ordinance 4177 — ${TERM} vacation of an alley`,
      meetingIds: [publishedMeetingId, withheldMeetingId],
    });
  });

  after(async () => {
    await db("members").where("name", "like", `${PREFIX}%`).del();
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts(HASHES);
    await db.destroy();
  });

  // -------------------------------------------------------------------------
  // The invariant
  // -------------------------------------------------------------------------

  it("never returns an unpublished meeting, its agenda items or its document text", async () => {
    const body = await get(TERM, "&limit=100");
    const ids = body.data.map((row) => row.id);

    assert.equal(
      ids.includes(withheldMeetingId),
      false,
      "an unpublished meeting was searchable",
    );
    assert.equal(
      ids.includes(withheldItemId),
      false,
      "an unpublished meeting's agenda item was searchable",
    );
    assert.equal(
      ids.includes(withheldArtifactId),
      false,
      "an unpublished meeting's document text was searchable",
    );

    // Every returned row that belongs to a meeting belongs to a published one.
    for (const row of body.data) {
      if (row.meeting_id !== undefined && row.meeting_id !== "") {
        assert.notEqual(row.meeting_id, withheldMeetingId);
      }
    }
  });

  it("returns the published counterparts of every one of those, so the wall is not just silence", async () => {
    const ids = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.ok(ids.includes(publishedMeetingId), "the published meeting was missing");
    assert.ok(ids.includes(titleMatchItemId), "the published agenda item was missing");
    assert.ok(ids.includes(publishedArtifactId), "the published document text was missing");
  });

  it("admits the withheld records the moment the meeting is published, and hides them again", async () => {
    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: new Date() });
    const opened = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.ok(opened.includes(withheldMeetingId));
    assert.ok(opened.includes(withheldItemId));
    assert.ok(opened.includes(withheldArtifactId));

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: null });
    const closed = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(closed.includes(withheldMeetingId), false);
    assert.equal(closed.includes(withheldItemId), false);
    assert.equal(closed.includes(withheldArtifactId), false);
  });

  // -------------------------------------------------------------------------
  // Finding things
  // -------------------------------------------------------------------------

  it("returns a meeting whose agenda mentions a term, and not one that does not", async () => {
    const hit = await get(TERM, "&limit=100");
    assert.ok(hit.data.some((row) => row.id === titleMatchItemId));

    const miss = await get("photovoltaic");
    assert.equal(miss.total, 0);
    assert.deepEqual(miss.data, []);
  });

  it("ranks a title match above a body match", async () => {
    const body = await get(TERM, "&limit=100");
    const items = body.data.filter((row) => row.kind === "agenda_item");
    const titleIndex = items.findIndex((row) => row.id === titleMatchItemId);
    const bodyIndex = items.findIndex((row) => row.id === bodyMatchItemId);
    assert.ok(titleIndex >= 0 && bodyIndex >= 0, "both agenda items should match");
    assert.ok(
      titleIndex < bodyIndex,
      "weighting is A title / B description; a title match must outrank a mention",
    );
    assert.ok(items[titleIndex].rank > items[bodyIndex].rank);
  });

  it("stems, so 'meetings' finds 'meeting'", async () => {
    const body = await get("meetings", "&limit=100");
    assert.ok(
      body.data.some((row) => row.title === "Special meeting of the drainage board"),
      "stemming is off: 'meetings' no longer matches 'meeting'",
    );
  });

  it("honours quoted phrases the way websearch_to_tsquery does", async () => {
    const phrase = await get('"appropriation was discussed"', "&limit=100");
    assert.ok(phrase.data.some((row) => row.id === publishedArtifactId));

    const wrongOrder = await get('"discussed was appropriation"', "&limit=100");
    assert.equal(wrongOrder.data.some((row) => row.id === publishedArtifactId), false);
  });

  it("honours -exclusions", async () => {
    const withOrdinance = await get(`${TERM} ordinance`, "&limit=100");
    assert.ok(withOrdinance.data.some((row) => row.id === titleMatchItemId));

    const without = await get(`${TERM} -ordinance`, "&limit=100");
    assert.equal(
      without.data.some((row) => row.id === titleMatchItemId),
      false,
      "-ordinance should exclude the item whose title carries it",
    );
  });

  it("finds a member by name and by title", async () => {
    const byName = await get("Alexandra Ruiz", "&limit=100");
    assert.ok(byName.data.some((row) => row.kind === "member" && row.id === memberId));

    const byTitle = await get(TERM, "&limit=100");
    assert.ok(byTitle.data.some((row) => row.kind === "member" && row.id === memberId));
  });

  it("finds a meeting by its venue and discriminates the kinds", async () => {
    const body = await get(TERM, "&limit=100");
    const kinds = new Set(body.data.map((row) => row.kind));
    assert.deepEqual([...kinds].sort(), [
      "agenda_item",
      "document",
      "finding",
      "matter",
      "meeting",
      "member",
    ]);

    const meeting = body.data.find((row) => row.id === publishedMeetingId);
    assert.ok(meeting);
    assert.equal(meeting.kind, "meeting");
    // The commission's name heads the result: `meetings` has no title, and the
    // venue is what matched, not what a reader calls the sitting.
    assert.equal(meeting.title, `${PREFIX} Commission`);

    const document = body.data.find((row) => row.id === publishedArtifactId);
    assert.ok(document);
    assert.equal(document.kind, "document");
    assert.equal(document.document_type, "agenda");
  });

  // -------------------------------------------------------------------------
  // Findings — a different wall: approval, plus a meeting that may not exist
  // -------------------------------------------------------------------------

  it("finds a published finding by a word in its description", async () => {
    const finding = (await get(TERM, "&limit=100")).data.find(
      (row) => row.id === publishedFindingId,
    );
    assert.ok(finding, "an approved finding on a published meeting was not searchable");
    assert.equal(finding.kind, "finding");
    assert.equal(finding.flag_type, "quorum_issue");
    assert.equal(finding.severity, "medium");
    assert.equal(finding.meeting_id, publishedMeetingId);
  });

  it("withholds a held finding, and admits it the moment an operator publishes it", async () => {
    const held = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(
      held.includes(heldFindingId),
      false,
      "a finding awaiting review was searchable — the review queue would be decoration",
    );

    await db("anomaly_flags").where({ id: heldFindingId }).update({ review_state: "published" });
    const opened = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.ok(opened.includes(heldFindingId), "approving the finding did not make it findable");

    await db("anomaly_flags").where({ id: heldFindingId }).update({ review_state: "held" });
    const closed = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(closed.includes(heldFindingId), false);
  });

  it("withholds an approved finding whose meeting is not published, and admits it when it is", async () => {
    const hidden = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(
      hidden.includes(withheldMeetingFindingId),
      false,
      "an approved finding leaked the existence of an unpublished meeting",
    );

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: new Date() });
    const opened = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.ok(opened.includes(withheldMeetingFindingId));

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: null });
    const closed = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(closed.includes(withheldMeetingFindingId), false);
  });

  it("finds an approved finding that has no meeting at all", async () => {
    const finding = (await get(TERM, "&limit=100")).data.find(
      (row) => row.id === recordsFindingId,
    );
    // The case an inner join to `meetings` deletes without saying so.
    // `anomaly_flags.meeting_id` has been nullable since migration 027, and a
    // records-derived finding has an artifact instead. It has no meeting to be
    // published, so requiring one would hide it permanently rather than merely
    // until review.
    assert.ok(finding, "a records-derived finding was dropped by the meeting join");
    assert.equal(finding.meeting_id, null);
  });

  // -------------------------------------------------------------------------
  // Matters — a third wall: one published appearance is enough
  // -------------------------------------------------------------------------

  it("finds a matter by its designator and by a word in its title", async () => {
    const byDesignator = (await get('"Ordinance 2145"', "&limit=100")).data.find(
      (row) => row.id === publishedMatterId,
    );
    assert.ok(byDesignator, "a matter was not findable by the designator a reader would type");
    assert.equal(byDesignator.kind, "matter");
    assert.equal(byDesignator.designator, "Ordinance 2145");

    const byTitle = await get(`${TERM} corridor rezone`, "&limit=100");
    assert.ok(byTitle.data.some((row) => row.id === publishedMatterId));
  });

  it("withholds a matter whose every appearance is unpublished, and admits it when one is published", async () => {
    const hidden = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(
      hidden.includes(withheldMatterId),
      false,
      "a matter reachable only through unpublished meetings was searchable",
    );

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: new Date() });
    const opened = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.ok(opened.includes(withheldMatterId), "publishing its only appearance did not admit it");

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: null });
    const closed = (await get(TERM, "&limit=100")).data.map((row) => row.id);
    assert.equal(closed.includes(withheldMatterId), false);
  });

  it("returns a matter with published and unpublished appearances once, not once per appearance", async () => {
    const rows = (await get(TERM, "&limit=100")).data.filter((row) => row.id === mixedMatterId);
    assert.equal(
      rows.length,
      1,
      "one published appearance is enough, and the EXISTS must not become a join",
    );
  });

  it("merges every kind into one ranked page, without a kind crowding out the others", async () => {
    const body = await get(TERM);
    assert.ok(body.total <= 20, "the fixture outgrew the default page and this test now lies");
    assert.equal(body.data.length, body.total);

    const ranks = body.data.map((row) => row.rank);
    for (let i = 1; i < ranks.length; i += 1) {
      assert.ok(ranks[i - 1] >= ranks[i], "the merged page is not ordered by rank");
    }

    assert.deepEqual([...new Set(body.data.map((row) => row.kind))].sort(), [
      "agenda_item",
      "document",
      "finding",
      "matter",
      "meeting",
      "member",
    ]);
  });

  // -------------------------------------------------------------------------
  // Snippets
  // -------------------------------------------------------------------------

  it("returns the matching sentence, with the match marked and not marked up", async () => {
    const body = await get(TERM, "&limit=100");
    const document = body.data.find((row) => row.id === publishedArtifactId);
    assert.ok(document);
    assert.ok(
      document.snippet.includes(`${HIGHLIGHT_START}${TERM}${HIGHLIGHT_END}`),
      "the match should be delimited in the snippet",
    );
    assert.match(document.snippet, /appropriation was discussed/);
    // Control characters, never markup: this text came out of a third-party PDF
    // and the page must never be asked to inject it as HTML.
    assert.equal(document.snippet.includes("<"), false);
  });

  // -------------------------------------------------------------------------
  // Empty, blank and absurd input
  // -------------------------------------------------------------------------

  it("answers an empty result set rather than an error when there is nothing to find", async () => {
    for (const query of ["", "   ", "the and of", "zzzzzzzznotaword"]) {
      const res = await request(app).get(`/api/search?q=${encodeURIComponent(query)}`).expect(200);
      const body = res.body as SearchBody;
      assert.deepEqual(body.data, [], `"${query}" should return no rows`);
      assert.equal(body.total, 0);
    }
  });

  it("answers 200 with no q at all", async () => {
    const res = await request(app).get("/api/search").expect(200);
    assert.deepEqual((res.body as SearchBody).data, []);
    assert.equal((res.body as SearchBody).total, 0);
  });

  it("takes neither value when q is repeated, rather than concatenating two searches", async () => {
    const res = await request(app).get(`/api/search?q=${TERM}&q=ordinance`).expect(200);
    assert.deepEqual((res.body as SearchBody).data, []);
  });

  it("searches an empty result space without touching the database when q is blank", async () => {
    // The short-circuit is the property: no query is issued, so this holds on a
    // database with no tables reachable at all.
    const result = await search(db, { q: "  " });
    assert.deepEqual(result, { data: [], total: 0, query: "" });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it("pages without repeating or dropping a row", async () => {
    const all = await get(TERM, "&limit=100");
    assert.ok(all.total >= 5, "fixture should produce at least five hits");

    const first = await get(TERM, "&limit=2&offset=0");
    const second = await get(TERM, "&limit=2&offset=2");
    assert.equal(first.data.length, 2);
    assert.equal(first.total, all.total, "the total is of the result set, not of the page");
    assert.equal(second.total, all.total);

    const paged = [...first.data, ...second.data].map((row) => row.id);
    assert.deepEqual(paged, all.data.slice(0, 4).map((row) => row.id));
    assert.equal(new Set(paged).size, paged.length, "a row appeared on two pages");
  });

  it("clamps limit and offset the way the meetings router does", () => {
    assert.equal(clampLimit(undefined), 20);
    assert.equal(clampLimit("nonsense"), 20);
    assert.equal(clampLimit("0"), 1);
    assert.equal(clampLimit("5"), 5);
    assert.equal(clampLimit("5000"), 100);
    assert.equal(clampOffset(undefined), 0);
    assert.equal(clampOffset("-9"), 0);
    assert.equal(clampOffset("12"), 12);
  });

  it("echoes the trimmed query back", async () => {
    const body = await get(`  ${TERM}  `);
    assert.equal(body.query, TERM);
  });
});
