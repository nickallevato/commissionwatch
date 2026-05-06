import type { Member } from "@/types";

interface Props {
  member: Member;
}

export function MemberCard({ member }: Props) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-800/50 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-gray-300 font-semibold text-sm">
          {member.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-gray-100 font-semibold truncate">{member.name}</h3>
          {member.title && (
            <p className="text-sm text-gray-400 mt-0.5">{member.title}</p>
          )}
          {member.jurisdiction && (
            <p className="text-sm text-gray-500 mt-0.5">
              {member.jurisdiction.name}, {member.jurisdiction.state}
            </p>
          )}
        </div>
      </div>
      {(member.term_start || member.term_end) && (
        <div className="mt-3 text-xs text-gray-500">
          Term:{" "}
          {member.term_start
            ? new Date(member.term_start).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })
            : "?"}{" "}
          –{" "}
          {member.term_end
            ? new Date(member.term_end).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })
            : "Present"}
        </div>
      )}
    </div>
  );
}
