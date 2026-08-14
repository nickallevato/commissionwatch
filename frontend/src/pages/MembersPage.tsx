import { useMemo, useState } from "react";
import { useMembers } from "@/hooks/useMembers";
import { useJurisdictions } from "@/hooks/useMeetings";
import { useVotes } from "@/hooks/useVotes";
import { MemberCard, type MemberVotingRecord } from "@/components/MemberCard";

const selectClass =
  "border border-rule bg-paper px-2 py-1 text-sm text-ink hover:border-ink";

function emptyRecord(): MemberVotingRecord {
  return { yes: 0, no: 0, abstain: 0, absent: 0, total: 0 };
}

export function MembersPage() {
  const [jurisdictionId, setJurisdictionId] = useState("");

  const { data: jurisdictions } = useJurisdictions();
  const {
    data: members,
    isLoading,
    isError,
  } = useMembers(jurisdictionId || undefined);
  const { data: votes } = useVotes();

  const recordsByMember = useMemo(() => {
    const map = new Map<string, MemberVotingRecord>();
    for (const vote of votes ?? []) {
      const record = map.get(vote.member_id) ?? emptyRecord();
      record[vote.vote] += 1;
      record.total += 1;
      map.set(vote.member_id, record);
    }
    return map;
  }, [votes]);

  return (
    <div>
      <header>
        <p className="kicker">The roster</p>
        <h1 className="headline mt-1">Officials</h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Every seated official on the commissions we follow, the term they
          hold, and how each of them has voted on the record.
        </p>
      </header>

      <div className="rule-hi mt-6" />

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule py-3">
        <label className="flex items-center gap-2">
          <span className="label-sm">Jurisdiction</span>
          <select
            value={jurisdictionId}
            onChange={(e) => setJurisdictionId(e.target.value)}
            className={selectClass}
          >
            <option value="">All jurisdictions</option>
            {jurisdictions?.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}, {j.state}
              </option>
            ))}
          </select>
        </label>

        {members && (
          <p className="label-sm">
            <span className="figure text-sm text-ink">{members.length}</span>{" "}
            {members.length === 1 ? "official" : "officials"}
          </p>
        )}
      </div>

      {isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading officials</span>
          {[1, 2, 3].map((i) => (
            <div key={i} className="border-t border-rule py-6">
              <div className="h-5 w-52 animate-pulse bg-paper-sunk" />
              <div className="mt-2 h-3 w-32 animate-pulse bg-paper-sunk" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="border-t border-rule py-12 text-center text-sm text-accent">
          The roster could not be loaded.
        </p>
      ) : members && members.length > 0 ? (
        <div className="border-b border-rule">
          {members.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              record={recordsByMember.get(member.id)}
            />
          ))}
        </div>
      ) : (
        <p className="border-t border-rule py-12 text-center text-sm text-muted">
          No officials on record for this jurisdiction.
        </p>
      )}
    </div>
  );
}
