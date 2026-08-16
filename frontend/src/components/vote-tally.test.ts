import { describe, it, expect } from "vitest";
import { tallyVotes, VOTE_ORDER, VOTE_LABEL } from "./vote-tally";
import type { Vote, VoteValue } from "@/types";

/**
 * `tallyVotes` used to have a second, independent implementation local to
 * `MeetingDetailPage.tsx` (`function tally`). The two counted identically —
 * same four `vote_value` members, same zero-initialised counts, same
 * increment — but nothing enforced that they stay identical, and a future
 * edit to one without the other would have silently diverged what a page
 * reports about a vote. This suite pins the shared implementation directly
 * so that guarantee no longer depends on reading two files side by side.
 */

let voteSeq = 0;
function makeVote(value: VoteValue): Vote {
  voteSeq += 1;
  return {
    id: `vote-${voteSeq}`,
    meeting_id: "meeting-1",
    agenda_item_id: "item-1",
    member_id: `member-${voteSeq}`,
    vote: value,
    created_at: "2024-12-03T18:30:00.000Z",
  };
}

describe("tallyVotes", () => {
  it("counts every vote_value member the schema permits: yes, no, abstain, absent", () => {
    const votes = [
      makeVote("yes"),
      makeVote("yes"),
      makeVote("no"),
      makeVote("abstain"),
      makeVote("absent"),
    ];
    expect(tallyVotes(votes)).toEqual({ yes: 2, no: 1, abstain: 1, absent: 1 });
  });

  it("returns a complete zeroed tally on empty input, not a partial object", () => {
    expect(tallyVotes([])).toEqual({ yes: 0, no: 0, abstain: 0, absent: 0 });
  });

  it("VOTE_ORDER and VOTE_LABEL cover exactly the four vote_value enum members", () => {
    expect(VOTE_ORDER).toEqual(["yes", "no", "abstain", "absent"]);
    expect(Object.keys(VOTE_LABEL).sort()).toEqual(
      ["abstain", "absent", "no", "yes"].sort(),
    );
  });
});
