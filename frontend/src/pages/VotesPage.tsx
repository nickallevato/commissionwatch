import { useState } from "react";
import { useVotes } from "@/hooks/useVotes";
import type { VoteValue } from "@/types";

const VOTE_OPTIONS: { value: VoteValue; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "abstain", label: "Abstain" },
  { value: "absent", label: "Absent" },
];

const voteBadgeClass: Record<VoteValue, string> = {
  yes: "bg-green-900/50 text-green-400 border-green-800",
  no: "bg-red-900/50 text-red-400 border-red-800",
  abstain: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
  absent: "bg-gray-800 text-gray-500 border-gray-700",
};

export function VotesPage() {
  const [memberId, setMemberId] = useState("");
  const [voteFilter, setVoteFilter] = useState("");

  const { data: votes, isLoading, isError, error } = useVotes({
    member_id: memberId || undefined,
  });

  const filtered = voteFilter
    ? votes?.filter((v) => v.vote === voteFilter)
    : votes;

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-100 mb-6">Votes</h2>

      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          placeholder="Filter by member ID"
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        />

        <select
          value={voteFilter}
          onChange={(e) => setVoteFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Votes</option>
          {VOTE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {(memberId || voteFilter) && (
          <button
            onClick={() => {
              setMemberId("");
              setVoteFilter("");
            }}
            className="text-sm text-gray-400 hover:text-gray-200 px-3 py-2"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 rounded-lg bg-gray-800 animate-pulse"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="text-center py-12 text-red-400">
          Failed to load votes{error instanceof Error ? `: ${error.message}` : "."}
        </div>
      ) : filtered && filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((vote) => (
            <div
              key={vote.id}
              className="rounded-lg border border-gray-800 bg-gray-800/50 p-4"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-gray-100 font-medium">
                    {vote.member?.name ?? vote.member_id}
                  </p>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {new Date(vote.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${voteBadgeClass[vote.vote]}`}
                >
                  {vote.vote.charAt(0).toUpperCase() + vote.vote.slice(1)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          No votes found.
        </div>
      )}
    </div>
  );
}
