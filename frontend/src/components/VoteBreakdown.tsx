import { useState } from "react";
import type { Vote, Member, VoteValue } from "@/types";

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

const voteColor: Record<VoteValue, string> = {
  yes: "text-pass",
  no: "text-fail",
  abstain: "text-sev3",
  absent: "text-muted",
};

/** Small uppercase treatment shared by the tally captions and roll-call values. */
const valueLabel =
  "text-[0.6875rem] font-semibold uppercase tracking-label leading-none";

interface Props {
  votes: Vote[];
  members: Member[];
  /**
   * `summary` (default) prints the tally with a disclosure that reveals the
   * roll call. `roll-call` prints the per-member roll call on its own, for
   * callers that already show the tally themselves.
   */
  mode?: "summary" | "roll-call";
}

export function VoteBreakdown({ votes, members, mode = "summary" }: Props) {
  const [expanded, setExpanded] = useState(false);
  const counts = tallyVotes(votes);

  if (mode === "roll-call") {
    return <RollCall votes={votes} members={members} />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {VOTE_ORDER.filter((value) => counts[value] > 0).map((value) => (
          <span key={value} className="flex items-baseline gap-1.5">
            <span className={`figure text-sm ${voteColor[value]}`}>
              {counts[value]}
            </span>
            <span className={`${valueLabel} text-muted`}>
              {VOTE_LABEL[value]}
            </span>
          </span>
        ))}

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className={`${valueLabel} text-muted underline-offset-4 hover:text-ink hover:underline`}
        >
          {expanded ? "Hide roll call" : "Roll call"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3">
          <RollCall votes={votes} members={members} />
        </div>
      )}
    </div>
  );
}

function RollCall({ votes, members }: { votes: Vote[]; members: Member[] }) {
  const memberMap = new Map(members.map((m) => [m.id, m]));

  const ordered = [...votes].sort((a, b) => {
    const an = memberMap.get(a.member_id)?.name ?? "";
    const bn = memberMap.get(b.member_id)?.name ?? "";
    return an.localeCompare(bn);
  });

  return (
    <div>
      <span className="label-sm">Roll call</span>
      <ul className="mt-1.5 border-t border-rule">
        {ordered.map((vote) => {
          const member = memberMap.get(vote.member_id);
          return (
            <li
              key={vote.id}
              className="flex items-baseline justify-between gap-6 border-b border-rule py-1.5"
            >
              <span className="text-sm text-ink-soft">
                {member?.name ?? "Unidentified member"}
              </span>
              <span className={`${valueLabel} ${voteColor[vote.vote]}`}>
                {VOTE_LABEL[vote.vote]}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
