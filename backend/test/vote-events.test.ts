import { createHash, randomUUID } from "node:crypto";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  approveVoteEvent,
  checkVoteTally,
  findTallyDiscrepancies,
  linkClaimsToVoteEvent,
  listPublishedVoteEvents,
  recordVoteEvent,
  rejectVoteEvent,
  VoteEventError,
  type VoteCounts,
} from "../src/services/vote-events";
import { cleanupByPrefix, createMeeting, createSource, sha256Of } from "./helpers/pressroom";

/**
 * Approve a claim the way the schema now requires.
 *
 * Deliberately not a call into `services/review/claims.ts`: this suite is about
 * vote tallies, and coupling it to the claims approval path would make a change
 * there fail here for reasons that have nothing to do with tallies. What it does
 * share is the constraint, which is the part that matters.
 */
async function approveClaimFixture(claimId: string): Promise<void> {
  const rendered = `Fixture claim ${claimId}`;
  await db("minute_claims")
    .where({ id: claimId })
    .update({
      status: "approved",
      rendered_text: rendered,
      render_sha256: createHash("sha256").update(rendered).digest("hex"),
      render_version: "claim-render@1",
      approved_by: randomUUID(),
      approved_at: new Date(),
    });
}

/**
 * *"The motion failed 2–3"* as a stored fact, and the check that makes it
 * worth storing.
 *
 * The tally is a stronger statement than any single claim — it names a whole
 * body by composition — so the tests here are mostly about the ways it can be
 * wrong. The central one is the sum check: if the extractor missed a member or
 * invented one, the claims and the tally disagree, and that disagreement is the
 * loudest signal available that a document was read badly. It must be visible
 * and it must block approval, because a number nobody can check against the
 * record is exactly what this project may not publish.
 */

const PREFIX = "vote-events";
const ARTIFACT_SHA = sha256Of("vote-events-minutes");
const MODEL = "test/model:free";
const PROMPT_VERSION = "test-prompt";

let meetingId: string;
let otherMeetingId: string;

function counts(partial: Partial<VoteCounts>): VoteCounts {
  return { yes: 0, no: 0, abstain: 0, absent: 0, ...partial };
}

/** A tally as the extractor would propose it: cited, held, offset located. */
async function tally(
  options: {
    motion?: string;
    result?: "pass" | "fail";
    counts: VoteCounts;
    offset?: number;
    meetingId?: string;
  },
): Promise<string> {
  return recordVoteEvent(db, {
    meetingId: options.meetingId ?? meetingId,
    motionText: options.motion ?? "Motion to approve Ordinance 2145",
    result: options.result ?? "fail",
    counts: options.counts,
    artifactSha256: ARTIFACT_SHA,
    quote: "The motion failed 2-3.",
    quoteOffset: options.offset ?? 1200,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
  });
}

async function claim(
  action: string,
  subject: string,
  options: { offset?: number; status?: string; meetingId?: string } = {},
): Promise<string> {
  const [row] = await db("minute_claims")
    .insert({
      meeting_id: options.meetingId ?? meetingId,
      artifact_sha256: ARTIFACT_SHA,
      subject_name: subject,
      action,
      matter: "Ordinance 2145",
      quote: `${subject} voted on Ordinance 2145.`,
      quote_offset: options.offset ?? Math.floor(Math.random() * 1000),
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      status: options.status ?? "held",
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  const fixture = await createSource(PREFIX);
  meetingId = await createMeeting(fixture.commissionId);
  otherMeetingId = await createMeeting(fixture.commissionId, { date: "2026-08-11" });
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await db.destroy();
});

beforeEach(async () => {
  await db("minute_claims").whereIn("meeting_id", [meetingId, otherMeetingId]).del();
  await db("vote_events").whereIn("meeting_id", [meetingId, otherMeetingId]).del();
});

describe("vote_events — the row", () => {
  it("refuses a tally with no citation", async () => {
    await assert.rejects(
      () =>
        db("vote_events").insert({
          meeting_id: meetingId,
          motion_text: "Motion to approve",
          result: "pass",
          counts: JSON.stringify(counts({ yes: 5 })),
          artifact_sha256: ARTIFACT_SHA,
          quote: "   ",
          quote_offset: 10,
          model: MODEL,
          prompt_version: PROMPT_VERSION,
        }),
      /vote_events_quote_check/,
      "a whitespace quote cites nothing and must not satisfy NOT NULL",
    );
  });

  it("refuses a tally whose counts omit an option", async () => {
    await assert.rejects(
      () =>
        db("vote_events").insert({
          meeting_id: meetingId,
          motion_text: "Motion to approve",
          result: "pass",
          // No `absent`. "3 yes, 2 no" and "3 yes, 2 no, 0 absent" say
          // different things about who was in the room.
          counts: JSON.stringify({ yes: 3, no: 2, abstain: 0 }),
          artifact_sha256: ARTIFACT_SHA,
          quote: "The motion passed 3-2.",
          quote_offset: 10,
          model: MODEL,
          prompt_version: PROMPT_VERSION,
        }),
      /vote_events_counts_check/,
    );
  });

  it("stores a proposed tally held", async () => {
    const id = await tally({ counts: counts({ yes: 2, no: 3 }) });
    const row = await db("vote_events").where({ id }).first("status");
    assert.equal(row.status, "held");
  });

  it("revises rather than duplicates when the same bytes are read again", async () => {
    const first = await tally({ counts: counts({ yes: 2, no: 3 }) });
    await db("vote_events").where({ id: first }).update({ status: "approved" });

    const second = await tally({ counts: counts({ yes: 2, no: 2, absent: 1 }) });
    assert.equal(second, first, "the same citation is the same tally");

    const rows = await db("vote_events").where({ meeting_id: meetingId });
    assert.equal(rows.length, 1);
    // The merge revises the reading and leaves the operator's decision alone.
    assert.equal(rows[0].status, "approved");
    assert.deepEqual(rows[0].counts, counts({ yes: 2, no: 2, absent: 1 }));
  });
});

describe("vote_events — the sum check", () => {
  it("agrees when every linked claim is accounted for", async () => {
    const id = await tally({ counts: counts({ yes: 2, no: 3 }) });
    const ids = [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      await claim("voted_yes", "Mayor Morrison", { offset: 2 }),
      await claim("voted_no", "Commissioner Sample", { offset: 3 }),
      await claim("voted_no", "Commissioner Fischer", { offset: 4 }),
      await claim("voted_no", "Deputy Mayor Vance", { offset: 5 }),
    ];
    assert.equal(await linkClaimsToVoteEvent(db, id, ids), 5);

    const check = await checkVoteTally(db, id);
    assert.ok(check);
    assert.equal(check.agrees, true);
    assert.deepEqual(check.differences, []);
    assert.deepEqual(check.linked, counts({ yes: 2, no: 3 }));
  });

  it("does not let a mover or a seconder move the arithmetic", async () => {
    const id = await tally({ counts: counts({ yes: 1, no: 0 }) });
    const ids = [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      await claim("moved", "Commissioner Bode", { offset: 2 }),
      await claim("seconded", "Mayor Morrison", { offset: 3 }),
    ];
    await linkClaimsToVoteEvent(db, id, ids);

    const check = await checkVoteTally(db, id);
    assert.ok(check);
    assert.equal(check.agrees, true, "moving a motion is not voting on it");
    assert.equal(check.non_voting, 2, "but the link is still reported");
  });

  it("surfaces a missed member as a named difference", async () => {
    const id = await tally({ counts: counts({ yes: 2, no: 3 }) });
    await linkClaimsToVoteEvent(db, id, [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      await claim("voted_yes", "Mayor Morrison", { offset: 2 }),
      await claim("voted_no", "Commissioner Sample", { offset: 3 }),
      await claim("voted_no", "Commissioner Fischer", { offset: 4 }),
    ]);

    const check = await checkVoteTally(db, id);
    assert.ok(check);
    assert.equal(check.agrees, false);
    assert.deepEqual(check.differences, [{ option: "no", stated: 3, linked: 2 }]);

    const discrepancies = await findTallyDiscrepancies(db, meetingId);
    assert.deepEqual(
      discrepancies.map((entry) => entry.vote_event_id),
      [id],
    );
  });

  it("ignores a claim an operator rejected", async () => {
    const id = await tally({ counts: counts({ yes: 1 }) });
    await linkClaimsToVoteEvent(db, id, [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      // Rejected: an operator has said this is not in the record, so it must
      // not keep propping the tally up.
      await claim("voted_yes", "Someone From The Audience", { offset: 2, status: "rejected" }),
    ]);

    const check = await checkVoteTally(db, id);
    assert.ok(check);
    assert.equal(check.agrees, true);
    assert.deepEqual(check.linked, counts({ yes: 1 }));
  });

  it("will not link a claim from another meeting", async () => {
    const id = await tally({ counts: counts({ yes: 1 }) });
    const stranger = await claim("voted_yes", "Commissioner Elsewhere", {
      offset: 9,
      meetingId: otherMeetingId,
    });
    assert.equal(await linkClaimsToVoteEvent(db, id, [stranger]), 0);

    const row = await db("minute_claims").where({ id: stranger }).first("vote_event_id");
    assert.equal(row.vote_event_id, null);
  });
});

describe("vote_events — review", () => {
  it("refuses to approve a tally that disagrees with its own votes", async () => {
    const id = await tally({ counts: counts({ yes: 2, no: 3 }) });
    await linkClaimsToVoteEvent(db, id, [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      await claim("voted_no", "Commissioner Sample", { offset: 2 }),
    ]);

    await assert.rejects(
      () => approveVoteEvent(db, id, { reason: "looks right to me" }),
      (error: unknown) => {
        assert.ok(error instanceof VoteEventError);
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /yes: says 2, 1 linked/);
        return true;
      },
    );

    const row = await db("vote_events").where({ id }).first("status");
    assert.equal(row.status, "held", "a refused approval must not half-apply");
  });

  it("approves a tally that adds up, with a reason", async () => {
    const id = await tally({ counts: counts({ yes: 1, no: 1 }) });
    await linkClaimsToVoteEvent(db, id, [
      await claim("voted_yes", "Commissioner Bode", { offset: 1 }),
      await claim("voted_no", "Commissioner Sample", { offset: 2 }),
    ]);

    const check = await approveVoteEvent(db, id, { reason: "checked against the minutes" });
    assert.equal(check.status, "approved");

    const row = await db("vote_events").where({ id }).first("status", "review_reason");
    assert.equal(row.status, "approved");
    assert.equal(row.review_reason, "checked against the minutes");
  });

  it("requires a reason on either decision", async () => {
    const id = await tally({ counts: counts({}) });
    await assert.rejects(() => approveVoteEvent(db, id, { reason: "  " }), VoteEventError);
    await assert.rejects(() => rejectVoteEvent(db, id, { reason: "" }), VoteEventError);
  });
});

describe("vote_events — what the public may see", () => {
  it("shows nothing while the tally is held", async () => {
    await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });
    await tally({ counts: counts({ yes: 1 }) });
    assert.deepEqual(await listPublishedVoteEvents(db, meetingId), []);
  });

  it("shows nothing while the meeting is unpublished, approved or not", async () => {
    await db("meetings").where({ id: meetingId }).update({ published_at: null });
    const id = await tally({ counts: counts({ yes: 1 }) });
    await linkClaimsToVoteEvent(db, id, [await claim("voted_yes", "Commissioner Bode", { offset: 1 })]);
    await approveVoteEvent(db, id, { reason: "checked" });

    assert.deepEqual(
      await listPublishedVoteEvents(db, meetingId),
      [],
      "approving a tally is not a decision to publish the meeting",
    );
  });

  it("nests the approved member votes under an approved tally", async () => {
    const id = await tally({ counts: counts({ yes: 1, no: 1 }) });
    const yes = await claim("voted_yes", "Commissioner Bode", { offset: 10 });
    const no = await claim("voted_no", "Commissioner Sample", { offset: 20 });
    await linkClaimsToVoteEvent(db, id, [yes, no]);
    await approveVoteEvent(db, id, { reason: "checked" });
    // Only the approved claim renders: a held claim naming a person is not
    // public just because the tally it belongs to is.
    //
    // This was a bare `status = 'approved'` until migration 087, and the new
    // CHECK refused it — correctly. Approving a claim is not a status flip any
    // more: an approved row must carry the rendered sentence, the sha of those
    // exact bytes, and the person who approved them, because the pin is what
    // stops a later template edit republishing words nobody read. The fixture
    // now sets a real pin rather than the constraint being relaxed to admit a
    // shortcut production code cannot take.
    await approveClaimFixture(yes);
    await db("meetings").where({ id: meetingId }).update({ published_at: new Date() });

    const events = await listPublishedVoteEvents(db, meetingId);
    assert.equal(events.length, 1);
    assert.equal(events[0].result, "fail");
    assert.deepEqual(events[0].counts, counts({ yes: 1, no: 1 }));
    assert.deepEqual(
      events[0].votes.map((vote) => vote.subject_name),
      ["Commissioner Bode"],
    );
  });
});
