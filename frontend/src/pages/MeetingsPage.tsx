import { useState } from "react";
import { Link } from "react-router-dom";
import { useMeetings, useJurisdictions } from "@/hooks/useMeetings";
import { StatusBadge } from "@/components/StatusBadge";
import type { MeetingStatus } from "@/types";

export function MeetingsPage() {
  const [jurisdictionId, setJurisdictionId] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: jurisdictions } = useJurisdictions();
  const { data: meetings, isLoading } = useMeetings({
    jurisdiction_id: jurisdictionId || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  });

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-100 mb-6">Meetings</h2>

      <div className="flex flex-wrap gap-3 mb-6">
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

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          placeholder="From"
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          placeholder="To"
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        />

        {(jurisdictionId || status || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setJurisdictionId("");
              setStatus("");
              setDateFrom("");
              setDateTo("");
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
              className="h-20 rounded-lg bg-gray-800 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {meetings?.map((meeting) => (
            <Link
              key={meeting.id}
              to={`/meetings/${meeting.id}`}
              className="block rounded-lg border border-gray-800 bg-gray-800/50 p-4 hover:border-accent-500/50 hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <h3 className="text-gray-100 font-semibold truncate">
                    {meeting.commission?.name ?? "Commission Meeting"}
                  </h3>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {meeting.commission?.jurisdiction?.name},{" "}
                    {meeting.commission?.jurisdiction?.state} &middot;{" "}
                    {new Date(meeting.date).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    {meeting.time && ` at ${meeting.time}`}
                  </p>
                </div>
                <StatusBadge status={meeting.status} />
              </div>
            </Link>
          ))}
          {meetings?.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No meetings match your filters.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function meetingStatusLabel(status: MeetingStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
