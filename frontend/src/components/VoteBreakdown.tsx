import { useState } from "react";
import type { Vote, Member, VoteValue } from "@/types";

const voteStyles: Record<VoteValue, string> = {
  yea: "bg-green-500/10 text-green-400 border-green-500/20",
  nay: "bg-red-500/10 text-red-400 border-red-500/20",
  abstain: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  absent: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

interface Props {
  votes: Vote[];
  members: Member[];
}

export function VoteBreakdown({ votes, members }: Props) {
  const [expanded, setExpanded] = useState(false);

  const memberMap = new Map(members.map((m) => [m.id, m]));

  const counts: Record<VoteValue, number> = { yea: 0, nay: 0, abstain: 0, absent: 0 };
  for (const v of votes) {
    counts[v.value]++;
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100"
      >
        <div className="flex gap-1.5">
          {(Object.entries(counts) as [VoteValue, number][])
            .filter(([, count]) => count > 0)
            .map(([value, count]) => (
              <span
                key={value}
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${voteStyles[value]}`}
              >
                {count} {value}
              </span>
            ))}
        </div>
        <svg
          className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {votes.map((vote) => {
            const member = memberMap.get(vote.member_id);
            return (
              <div
                key={vote.id}
                className="flex items-center justify-between text-sm px-2 py-1 rounded bg-gray-800/50"
              >
                <span className="text-gray-300">
                  {member?.name ?? "Unknown member"}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${voteStyles[vote.value]}`}
                >
                  {vote.value}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
