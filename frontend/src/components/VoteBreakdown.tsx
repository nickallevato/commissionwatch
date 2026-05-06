import { useState } from "react";
import type { Vote, Member, VoteValue } from "@/types";

const voteStyles: Record<VoteValue, string> = {
  yes: "bg-green-500/10 text-green-400 border-green-500/20",
  no: "bg-red-500/10 text-red-400 border-red-500/20",
  abstain: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  absent: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const voteLabels: Record<VoteValue, string> = {
  yes: "Yea",
  no: "Nay",
  abstain: "Abstain",
  absent: "Absent",
};

interface Props {
  votes: Vote[];
  members: Member[];
}

export function VoteBreakdown({ votes, members }: Props) {
  const [expanded, setExpanded] = useState(false);

  const memberMap = new Map(members.map((m) => [m.id, m]));

  const counts: Record<VoteValue, number> = { yes: 0, no: 0, abstain: 0, absent: 0 };
  for (const v of votes) {
    counts[v.vote]++;
  }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {(Object.entries(counts) as [VoteValue, number][]).map(
          ([value, count]) =>
            count > 0 && (
              <span
                key={value}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${voteStyles[value]}`}
              >
                {voteLabels[value]}: {count}
              </span>
            ),
        )}
        {votes.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-gray-400 hover:text-gray-200 ml-1"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
        )}
      </div>

      {expanded && votes.length > 0 && (
        <div className="mt-3 space-y-1">
          {votes.map((v) => {
            const member = memberMap.get(v.member_id);
            return (
              <div
                key={v.id}
                className="flex items-center justify-between text-sm px-3 py-1.5 rounded bg-gray-800/50"
              >
                <span className="text-gray-300">
                  {member?.name ?? "Unknown Member"}
                  {member?.title && (
                    <span className="text-gray-500 ml-1">
                      — {member.title}
                    </span>
                  )}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${voteStyles[v.vote]}`}
                >
                  {voteLabels[v.vote]}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
