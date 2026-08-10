import type { Vote, VoteValue } from "@/types";

/**
 * The vote vocabulary and the counting itself, split out of VoteBreakdown.tsx
 * so that file exports only its component. Pages that show a tally without
 * rendering the breakdown import from here, and the React Refresh boundary
 * around the component stays intact.
 */

/**
 * Every member of the Postgres `vote_value` enum, in tally display order.
 * This is the only vote vocabulary the interface speaks: yes / no / abstain /
 * absent. Never "yea" / "nay" — the database does not store those.
 */
export const VOTE_ORDER: VoteValue[] = ["yes", "no", "abstain", "absent"];

/** Display capitalisation for each `vote_value`. */
export const VOTE_LABEL: Record<VoteValue, string> = {
  yes: "Yes",
  no: "No",
  abstain: "Abstain",
  absent: "Absent",
};

/** Counts keyed by every `vote_value`, including the zeroes. */
export type VoteTally = Record<VoteValue, number>;

/** Count a set of cast votes into a complete tally. */
export function tallyVotes(votes: Vote[]): VoteTally {
  const counts: VoteTally = { yes: 0, no: 0, abstain: 0, absent: 0 };
  for (const vote of votes) {
    counts[vote.vote] += 1;
  }
  return counts;
}
