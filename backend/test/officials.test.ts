import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { getOfficialProfile } from "../src/services/officials";
import { FEDERAL_ONLY_CAVEAT } from "../src/services/finance/coverage";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * `/api/officials/:id` — the reader's view of one person.
 *
 * The wall is the point of this suite. A profile is arithmetic over meetings,
 * and arithmetic over a withheld record still discloses it: a vote count that
 * moves when nothing public has changed tells a reader an unpublished meeting
 * exists and roughly what happened at it. So every figure is asserted **in both
 * directions** — withheld, then published — because absence alone would also
 * hold for a query that is simply broken.
 */

const PREFIX = "officials-test";

describe("the official profile", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let memberId: string;
  let otherMemberId: string;
  let thirdMemberId: string;
  let publishedMeetingId: string;
  let withheldMeetingId: string;
  let heldFlagId: string;
  let publishedFlagId: string;

  before(async () => {
    fixture = await createSource(PREFIX);

    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Dana Whitcomb",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    memberId = member.id;

    const [other] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Marco Ferreira",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    otherMemberId = other.id;

    const [third] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Alina Sokolov",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    thirdMemberId = third.id;

    publishedMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-03-10",
    });
    withheldMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-04-14",
    });

    // Published meeting: two items. Our official dissents on the second.
    const publishedItems = await db("agenda_items")
      .insert([
        { meeting_id: publishedMeetingId, item_number: 1, title: `${PREFIX} consent agenda` },
        { meeting_id: publishedMeetingId, item_number: 2, title: `${PREFIX} zoning amendment` },
      ])
      .returning<Array<{ id: string }>>("id");

    await db("votes").insert([
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[0].id, member_id: memberId, vote: "yes" },
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[0].id, member_id: otherMemberId, vote: "yes" },
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[1].id, member_id: memberId, vote: "no" },
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[1].id, member_id: otherMemberId, vote: "yes" },
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[0].id, member_id: thirdMemberId, vote: "yes" },
      { meeting_id: publishedMeetingId, agenda_item_id: publishedItems[1].id, member_id: thirdMemberId, vote: "yes" },
    ]);

    // Withheld meeting: our official is absent throughout, so publishing it
    // would move the attendance rate as well as the vote count.
    const [withheldItem] = await db("agenda_items")
      .insert({ meeting_id: withheldMeetingId, item_number: 1, title: `${PREFIX} withheld item` })
      .returning<Array<{ id: string }>>("id");
    await db("votes").insert([
      { meeting_id: withheldMeetingId, agenda_item_id: withheldItem.id, member_id: memberId, vote: "absent" },
      { meeting_id: withheldMeetingId, agenda_item_id: withheldItem.id, member_id: otherMemberId, vote: "yes" },
    ]);

    const flags = await db("anomaly_flags")
      .insert([
        {
          meeting_id: publishedMeetingId,
          flag_type: "vote_donor_conflict",
          description: `${PREFIX} held finding`,
          severity: "medium",
          source: "auto",
          review_state: "held",
          metadata: JSON.stringify({ memberId }),
        },
        {
          meeting_id: publishedMeetingId,
          flag_type: "quorum_issue",
          description: `${PREFIX} published finding`,
          severity: "medium",
          source: "auto",
          review_state: "published",
          metadata: JSON.stringify({ memberId }),
        },
      ])
      .returning<Array<{ id: string }>>("id");
    heldFlagId = flags[0].id;
    publishedFlagId = flags[1].id;
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  it("404s an id that is not an official", async () => {
    await request(app).get("/api/officials/99999999-9999-9999-9999-999999999999").expect(404);
  });

  it("400s a malformed id rather than querying on it", async () => {
    await request(app).get("/api/officials/not-a-uuid").expect(400);
  });

  it("returns the voting record from published meetings only", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.equal(profile.record.total, 2);
    assert.equal(profile.record.yes, 1);
    assert.equal(profile.record.no, 1);
    // The withheld meeting holds an `absent` row for this official.
    assert.equal(profile.record.absent, 0);
  });

  it("derives attendance from meetings that recorded a roll call", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.equal(profile.attendance.meetingsWithRollCall, 1);
    assert.equal(profile.attendance.present, 1);
    assert.equal(profile.attendance.absent, 0);
    assert.equal(profile.attendance.rate, 1);
  });

  it("computes alignment against the majority, and reports the denominator", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.equal(profile.alignment.comparableVotes, 2);
    assert.equal(profile.alignment.withMajority, 1);
    assert.equal(profile.alignment.rate, 0.5);
  });

  it("says nothing rather than zero when there is nothing comparable", async () => {
    const marco = await getOfficialProfile(db, otherMemberId);
    assert.ok(marco);
    // Marco voted with the majority on both, so his rate is 1. The point being
    // asserted is the other case: a null rate, never rendered as 0.
    assert.equal(marco.alignment.rate, 1);

    const empty = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: `${PREFIX} Never Voted`,
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    const blank = await getOfficialProfile(db, empty[0].id);
    assert.ok(blank);
    assert.equal(blank.alignment.rate, null);
    assert.equal(blank.attendance.rate, null);
    assert.equal(blank.record.total, 0);
  });

  it("draws twelve months of activity including the empty ones", async () => {
    const profile = await getOfficialProfile(db, memberId, {
      now: new Date("2026-08-10T00:00:00Z"),
    });
    assert.ok(profile);
    assert.equal(profile.activity.length, 12);
    assert.equal(profile.activity[profile.activity.length - 1].month, "2026-08");
    const march = profile.activity.find((month) => month.month === "2026-03");
    assert.ok(march);
    assert.equal(march.votes, 2);
    // April holds the withheld meeting and must read zero.
    const april = profile.activity.find((month) => month.month === "2026-04");
    assert.ok(april);
    assert.equal(april.votes, 0);
  });

  it("builds a timeline of published meetings, with dissents counted", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.equal(profile.timeline.length, 1);
    assert.equal(profile.timeline[0].meeting_id, publishedMeetingId);
    assert.equal(profile.timeline[0].date, "2026-03-10");
    assert.equal(profile.timeline[0].dissents, 1);
    assert.equal(profile.timeline[0].record.total, 2);
  });

  it("shows only findings an operator has published", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    const ids = profile.findings.map((finding) => finding.id);
    assert.ok(ids.includes(publishedFlagId));
    assert.ok(!ids.includes(heldFlagId), "a held finding must not reach the profile");
  });

  it("carries the federal-only caveat whether or not there is a finding", async () => {
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.equal(profile.finance.caveat, FEDERAL_ONLY_CAVEAT);
    assert.equal(profile.finance.federalOnly, true);
    assert.ok(profile.finance.systems.some((system) => system.key === "mt_cers"));
  });

  it("serves the coverage note on its own route, needing no official", async () => {
    const response = await request(app).get("/api/officials/finance-coverage").expect(200);
    const body = response.body as { caveat: string; federalOnly: boolean };
    assert.equal(body.caveat, FEDERAL_ONLY_CAVEAT);
    assert.equal(body.federalOnly, true);
  });

  /**
   * **The other direction.** Publishing the withheld meeting must make its vote
   * appear, its month fill in and its absence count — because absence alone
   * would also hold for a query that never worked.
   */
  it("shows the withheld meeting's record once it is published, and hides it again", async () => {
    const before = await getOfficialProfile(db, memberId, {
      now: new Date("2026-08-10T00:00:00Z"),
    });
    assert.ok(before);
    assert.equal(before.record.total, 2);
    assert.equal(before.attendance.meetingsWithRollCall, 1);
    assert.equal(before.timeline.length, 1);

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: new Date() });

    const during = await getOfficialProfile(db, memberId, {
      now: new Date("2026-08-10T00:00:00Z"),
    });
    assert.ok(during);
    assert.equal(during.record.total, 3);
    assert.equal(during.record.absent, 1);
    assert.equal(during.attendance.meetingsWithRollCall, 2);
    assert.equal(during.attendance.present, 1);
    assert.equal(during.attendance.absent, 1);
    assert.equal(during.timeline.length, 2);
    const april = during.activity.find((month) => month.month === "2026-04");
    assert.ok(april);
    assert.equal(april.votes, 1);

    await db("meetings").where({ id: withheldMeetingId }).update({ published_at: null });

    const after = await getOfficialProfile(db, memberId, {
      now: new Date("2026-08-10T00:00:00Z"),
    });
    assert.ok(after);
    assert.equal(after.record.total, 2);
    assert.equal(after.timeline.length, 1);
  });

  it("hides a published finding when its meeting is unpublished", async () => {
    await db("meetings").where({ id: publishedMeetingId }).update({ published_at: null });
    const profile = await getOfficialProfile(db, memberId);
    assert.ok(profile);
    assert.deepEqual(profile.findings, []);
    await db("meetings").where({ id: publishedMeetingId }).update({ published_at: new Date() });

    const restored = await getOfficialProfile(db, memberId);
    assert.ok(restored);
    assert.equal(restored.findings.length, 1);
  });

  it("serves the whole profile over HTTP", async () => {
    const response = await request(app).get(`/api/officials/${memberId}`).expect(200);
    const body = response.body as {
      official: { name: string };
      record: { total: number };
      finance: { caveat: string };
    };
    assert.equal(body.official.name, "Dana Whitcomb");
    assert.equal(body.record.total, 2);
    assert.equal(body.finance.caveat, FEDERAL_ONLY_CAVEAT);
  });
});
