import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  DORMANT_AFTER_DAYS,
  identify,
  normalizeTitle,
  parseDesignator,
  rebuildMatters,
} from "../src/services/matters";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * Matters — the subject of decision behind the per-meeting agenda item.
 *
 * Two things are being proved here, and the second is the one that catches a
 * broken feature.
 *
 * **The identity is the one that was decided, and nothing looser.** Three
 * printings of "Ordinance 2145" are one matter; a sidewalk repair and a bridge
 * replacement are two, forever, however alike a similarity score would find
 * them. And the rebuild is a projection, so running it twice must leave the
 * database exactly as it was.
 *
 * **The publication wall holds in both directions.** A matter is a rollup, which
 * makes it the most dangerous surface in the product for that wall: an
 * unpublished meeting leaks through a count or a `last_seen` date as completely
 * as through a document. So the suite asserts that a matter with only
 * unpublished appearances is absent and 404s, *and* that publishing the meeting
 * makes it appear — a test that only proved absence would also pass against a
 * feature that returned nothing at all.
 *
 * Every fixture date is relative to today. A suite with hardcoded dates asserts
 * that `dormant` works until the calendar walks past the fixture, and then
 * asserts nothing.
 */

const PREFIX = "matters-test";

/** Distinctive enough that no seed row and no other suite's fixture matches. */
const TAG = "Matterstest";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Computed once, at module load, and used for both the fixtures and the
 * assertions. Calling `daysAgo` twice would recompute it, and a suite that
 * straddles UTC midnight would then insert one date and assert another.
 */
const DATE_OLD = daysAgo(DORMANT_AFTER_DAYS + 220);
const DATE_A = daysAgo(40);
const DATE_B = daysAgo(25);
const DATE_C = daysAgo(10);
const DATE_HIDDEN = daysAgo(5);

interface MatterBody {
  id: string;
  title: string;
  designator: string | null;
  state: string;
  first_seen: string;
  last_seen: string;
  appearance_count: number;
  jurisdiction_name: string;
  commission_name: string;
}

interface MatterDetailBody extends MatterBody {
  appearances: Array<{
    agenda_item_id: string;
    meeting_id: string;
    meeting_date: string;
    item_number: number;
    title: string;
    match_rule: string;
  }>;
}

interface ListBody {
  data: MatterBody[];
  total: number;
}

describe("matters", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let meetingOld: string;
  let meetingA: string;
  let meetingB: string;
  let meetingC: string;
  let meetingHidden: string;
  let decidedItemId: string;

  async function addItem(meetingId: string, itemNumber: number, title: string): Promise<string> {
    const [row] = await db("agenda_items")
      .insert({ meeting_id: meetingId, item_number: itemNumber, title })
      .returning<Array<{ id: string }>>("id");
    return row.id;
  }

  async function list(query = ""): Promise<ListBody> {
    const res = await request(app)
      .get(`/api/matters?jurisdiction_id=${fixture.jurisdictionId}&limit=200${query}`)
      .expect(200);
    return res.body as ListBody;
  }

  /** The suite's matters, by the title they were first seen under. */
  async function byTitle(fragment: string): Promise<MatterBody> {
    const body = await list();
    const found = body.data.filter((row) => row.title.includes(fragment));
    assert.equal(found.length, 1, `expected exactly one matter matching ${fragment}`);
    return found[0];
  }

  async function detail(id: string): Promise<MatterDetailBody> {
    const res = await request(app).get(`/api/matters/${id}`).expect(200);
    return res.body as MatterDetailBody;
  }

  before(async () => {
    await cleanupByPrefix(PREFIX);
    fixture = await createSource(PREFIX, { enabled: false });

    meetingOld = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: DATE_OLD,
    });
    meetingA = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: DATE_A,
    });
    meetingB = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: DATE_B,
    });
    meetingC = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: DATE_C,
    });
    meetingHidden = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: DATE_HIDDEN,
    });

    // One ordinance, three meetings, three different printings of its title.
    await addItem(meetingA, 1, `Ordinance 2145 - ${TAG} north corridor zone map amendment`);
    await addItem(meetingB, 2, `Ordinance No. 2145 ${TAG} north corridor, continued`);
    await addItem(meetingC, 3, `Ord. 2145 ${TAG} north corridor, final reading`);

    // Two genuinely different subjects, from the same meeting.
    await addItem(meetingA, 4, `${TAG} sidewalk repair on Elm Street`);
    await addItem(meetingA, 5, `${TAG} bridge replacement on Oak Street`);

    // A second sidewalk appearance, on a meeting nobody has published. Same
    // matter, and it must not reach a reader through the count or the timeline.
    await addItem(meetingHidden, 6, `${TAG} sidewalk repair on Elm Street`);

    // A matter whose every appearance is unpublished.
    await addItem(meetingHidden, 7, `Resolution 24-77 ${TAG} hidden budget transfer`);

    // One fixture per derived state.
    decidedItemId = await addItem(meetingC, 8, `${TAG} library expansion contract award`);
    await addItem(meetingC, 9, `${TAG} parking structure proposal, withdrawn by the applicant`);
    await addItem(meetingOld, 10, `${TAG} annexation study for the west quadrant`);
    await addItem(meetingC, 11, `${TAG} trail easement acceptance`);

    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Sample Commissioner",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    // A recorded vote is what makes a matter decided. Migration 010 stores one
    // row per member and no motion-level outcome column, so the votes are the
    // result.
    await db("votes").insert({
      meeting_id: meetingC,
      agenda_item_id: decidedItemId,
      member_id: member.id,
      vote: "yes",
    });

    await rebuildMatters(db);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  /* --- identity ---------------------------------------------------------- */

  it("parses the designators it claims to, and nothing looser", () => {
    assert.deepEqual(parseDesignator("Ordinance 2145 - rezone"), {
      key: "ordinance 2145",
      label: "Ordinance 2145",
    });
    assert.deepEqual(parseDesignator("Resolution No. 24-11"), {
      key: "resolution 24-11",
      label: "Resolution 24-11",
    });
    assert.equal(parseDesignator("Application Z-2024-017 for a conditional use")?.key,
      "application z-2024-017");
    // An ordinance and a resolution sharing a number are two matters. The kind
    // is part of the identity for exactly this reason.
    assert.notEqual(
      parseDesignator("Ordinance 24-11")?.key,
      parseDesignator("Resolution 24-11")?.key,
    );
    // A word that merely starts like one of the keywords is not a designator.
    assert.equal(parseDesignator("Residential rezone of the north corridor"), null);
    assert.equal(parseDesignator("Ordinance amending Chapter 38, first reading"), null);
  });

  it("normalises a title without inferring anything about it", () => {
    assert.equal(
      normalizeTitle("4. Sidewalk Repair on Elm Street."),
      "sidewalk repair on elm street",
    );
    assert.equal(normalizeTitle("A) Sidewalk repair  on Elm  Street"), "sidewalk repair on elm street");
    // No stemming, no synonyms: these say different things and stay different.
    assert.notEqual(normalizeTitle("sidewalk repair"), normalizeTitle("sidewalk repairs"));
    assert.equal(identify("   "), null);
  });

  /* --- the rollup -------------------------------------------------------- */

  it("makes one matter of three printings of Ordinance 2145", async () => {
    const matter = await byTitle("north corridor zone map amendment");
    assert.equal(matter.designator, "Ordinance 2145");
    assert.equal(matter.appearance_count, 3);
    assert.equal(matter.first_seen, DATE_A);
    assert.equal(matter.last_seen, DATE_C);

    const body = await detail(matter.id);
    assert.equal(body.appearances.length, 3);
    // Ascending, because a timeline reads forwards.
    assert.deepEqual(
      body.appearances.map((row) => row.meeting_date),
      [DATE_A, DATE_B, DATE_C],
    );
    assert.deepEqual(
      body.appearances.map((row) => row.meeting_id),
      [meetingA, meetingB, meetingC],
    );
    // The basis of every join is inspectable from the row itself.
    assert.deepEqual(
      [...new Set(body.appearances.map((row) => row.match_rule))],
      ["designator"],
    );
    // The title as printed at *that* meeting, not the matter's.
    assert.match(body.appearances[2].title, /final reading/);
  });

  it("keeps two genuinely different subjects apart", async () => {
    const sidewalk = await byTitle("sidewalk repair on Elm Street");
    const bridge = await byTitle("bridge replacement on Oak Street");
    assert.notEqual(sidewalk.id, bridge.id);
    assert.equal(sidewalk.designator, null);
    assert.equal(bridge.appearance_count, 1);

    const body = await detail(bridge.id);
    assert.equal(body.appearances.length, 1);
    assert.equal(body.appearances[0].match_rule, "normalized_title");
  });

  it("rebuilds idempotently", async () => {
    const firstRun = await rebuildMatters(db);
    const sidewalkBefore = await byTitle("sidewalk repair on Elm Street");

    const secondRun = await rebuildMatters(db);
    assert.deepEqual(secondRun, firstRun);

    // Same rows, not merely the same number of them: a rebuild that deleted and
    // recreated every matter would keep the counts and break every link a reader
    // had ever followed.
    const sidewalkAfter = await byTitle("sidewalk repair on Elm Street");
    assert.equal(sidewalkAfter.id, sidewalkBefore.id);
    assert.equal(sidewalkAfter.appearance_count, sidewalkBefore.appearance_count);
  });

  /* --- the publication wall ---------------------------------------------- */

  it("hides a matter whose every appearance is unpublished, and 404s it by id", async () => {
    const rows = await db("matters")
      .where({ commission_id: fixture.commissionId, identity_key: "d:resolution 24-77" })
      .select<Array<{ id: string }>>("id");
    // The row exists. The wall is a read-time rule, not a reason not to derive.
    assert.equal(rows.length, 1);

    const body = await list();
    assert.equal(
      body.data.some((matter) => matter.id === rows[0].id),
      false,
    );
    await request(app).get(`/api/matters/${rows[0].id}`).expect(404);
  });

  it("counts only published appearances", async () => {
    const sidewalk = await byTitle("sidewalk repair on Elm Street");
    // Two links exist in the database...
    const links = await db("matter_appearances")
      .where({ matter_id: sidewalk.id })
      .select<Array<{ id: string }>>("id");
    assert.equal(links.length, 2);
    // ...and the reader sees the one on a published meeting.
    assert.equal(sidewalk.appearance_count, 1);

    const body = await detail(sidewalk.id);
    assert.equal(body.appearances.length, 1);
    assert.equal(body.appearances[0].meeting_id, meetingA);
    assert.equal(sidewalk.last_seen, DATE_A);
  });

  it("makes both appear the moment the meeting is published", async () => {
    const withheld = await list();
    await db("meetings").where({ id: meetingHidden }).update({ published_at: new Date() });

    const published = await list();
    assert.equal(published.total, withheld.total + 1);

    const hidden = await byTitle("hidden budget transfer");
    assert.equal(hidden.designator, "Resolution 24-77");
    assert.equal(hidden.appearance_count, 1);
    await request(app).get(`/api/matters/${hidden.id}`).expect(200);

    // The rollup follows too: the sidewalk's withheld appearance is now visible.
    const sidewalk = await byTitle("sidewalk repair on Elm Street");
    assert.equal(sidewalk.appearance_count, 2);
    assert.equal(sidewalk.last_seen, DATE_HIDDEN);

    // Put the wall back for the remaining assertions.
    await db("meetings").where({ id: meetingHidden }).update({ published_at: null });
    const restored = await list();
    assert.equal(restored.total, withheld.total);
  });

  /* --- derived state ------------------------------------------------------ */

  it("derives decided from a recorded vote on the most recent appearance", async () => {
    const matter = await byTitle("library expansion contract award");
    assert.equal(matter.state, "decided");
  });

  /**
   * The premise of this test was inverted on 2026-08-14. It used to assert that
   * the word "withdrawn" in a title produced the `withdrawn` state; it now
   * asserts that it does not, which is the guarantee the service actually
   * makes. "Appeal of withdrawn permit" and "replacing withdrawn Ordinance
   * 2101" both carry the word and neither describes a withdrawn matter, so the
   * regex was removed rather than narrowed — see the note above
   * `STATE_EXPRESSION`.
   */
  it("does not read a state out of the word 'withdrawn' in free text", async () => {
    const matter = await byTitle("parking structure proposal");
    assert.equal(
      matter.state,
      "pending",
      "the clerk's wording must not become a published status",
    );
  });

  it("derives dormant from silence, not from a stored status", async () => {
    const matter = await byTitle("annexation study for the west quadrant");
    assert.equal(matter.state, "dormant");
    // Nothing wrote that word anywhere. Migration 038's rule: no `state` column.
    const columns = await db("matters").columnInfo();
    assert.equal("state" in columns, false);
  });

  it("derives pending for a matter that is none of the above", async () => {
    const matter = await byTitle("trail easement acceptance");
    assert.equal(matter.state, "pending");
    // The three-reading ordinance has no vote recorded against its last
    // appearance, so it is pending too — the state says what the record shows,
    // not what a reader would guess a third reading means.
    assert.equal((await byTitle("north corridor zone map amendment")).state, "pending");
  });

  it("filters the list by state, in both directions", async () => {
    const dormant = await list("&state=dormant");
    const titles = dormant.data.map((row) => row.title);
    assert.ok(titles.some((title) => title.includes("annexation study")));
    assert.equal(
      titles.some((title) => title.includes("trail easement")),
      false,
    );
    assert.equal(dormant.total, dormant.data.length);

    const pending = await list("&state=pending");
    assert.ok(pending.data.some((row) => row.title.includes("trail easement")));
    assert.equal(
      pending.data.some((row) => row.title.includes("annexation study")),
      false,
    );
  });

  /* --- validation --------------------------------------------------------- */

  it("400s an invalid uuid and an unrecognised state", async () => {
    await request(app).get("/api/matters/not-a-uuid").expect(400);
    await request(app).get("/api/matters?jurisdiction_id=not-a-uuid").expect(400);
    // A typo must not answer with a confident, empty page.
    await request(app).get("/api/matters?state=tabled").expect(400);
  });

  it("404s a well-formed id that names nothing", async () => {
    await request(app)
      .get("/api/matters/00000000-0000-4000-8000-000000000000")
      .expect(404);
  });
});
