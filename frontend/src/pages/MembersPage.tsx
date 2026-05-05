import { useState } from "react";
import { useMembers } from "@/hooks/useMembers";
import { useJurisdictions } from "@/hooks/useMeetings";
import { MemberCard } from "@/components/MemberCard";

export function MembersPage() {
  const [jurisdictionId, setJurisdictionId] = useState("");
  const { data: jurisdictions } = useJurisdictions();
  const { data: members, isLoading } = useMembers(
    jurisdictionId || undefined,
  );

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h2 className="text-2xl font-bold text-gray-100">Officials</h2>
        <select
          value={jurisdictionId}
          onChange={(e) => setJurisdictionId(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Jurisdictions</option>
          {jurisdictions?.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}, {j.state}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-xl bg-gray-800 animate-pulse"
            />
          ))}
        </div>
      ) : members && members.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {members.map((member) => (
            <MemberCard key={member.id} member={member} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          No officials found.
        </div>
      )}
    </div>
  );
}
