import { Link } from "react-router-dom";
import { useMeetings } from "@/hooks/useMeetings";
import { StatusBadge } from "@/components/StatusBadge";

export function HomePage() {
  const { data: meetings, isLoading } = useMeetings();
  const recent = meetings?.slice(0, 6) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-100">Dashboard</h2>
        <p className="text-gray-400 mt-1">
          Recent commission meetings at a glance.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 rounded-xl bg-gray-800 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {recent.map((meeting) => (
            <Link
              key={meeting.id}
              to={`/meetings/${meeting.id}`}
              className="block rounded-xl border border-gray-800 bg-gray-800/50 p-5 hover:border-accent-500/50 hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm text-accent-400 font-medium">
                  {new Date(meeting.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <StatusBadge status={meeting.status} />
              </div>
              <h3 className="text-gray-100 font-semibold mb-1 line-clamp-1">
                {meeting.commission?.name ?? "Commission Meeting"}
              </h3>
              <p className="text-sm text-gray-400 line-clamp-1">
                {meeting.commission?.jurisdiction?.name},{" "}
                {meeting.commission?.jurisdiction?.state}
              </p>
              {meeting.time && (
                <p className="text-xs text-gray-500 mt-2">
                  {meeting.time} &middot; {meeting.location ?? "TBD"}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}

      {!isLoading && recent.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No meetings found.
        </div>
      )}
    </div>
  );
}
