import type { Member } from "@/types";

interface Props {
  member: Member;
  jurisdictionName?: string;
}

export function MemberCard({ member, jurisdictionName }: Props) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-800/50 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-700 text-gray-300 flex items-center justify-center font-medium text-sm">
          {member.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-gray-100 font-semibold">{member.name}</h3>
          {member.title && (
            <p className="text-sm text-gray-400">{member.title}</p>
          )}
          {jurisdictionName && (
            <p className="text-xs text-gray-500 mt-1">{jurisdictionName}</p>
          )}
          {(member.term_start || member.term_end) && (
            <p className="text-xs text-gray-500 mt-1">
              Term:{" "}
              {member.term_start
                ? new Date(member.term_start).toLocaleDateString("en-US", {
                    month: "short",
                    year: "numeric",
                  })
                : "?"}
              {" — "}
              {member.term_end
                ? new Date(member.term_end).toLocaleDateString("en-US", {
                    month: "short",
                    year: "numeric",
                  })
                : "Present"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
