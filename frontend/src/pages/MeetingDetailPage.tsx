import { useParams, Link } from "react-router-dom";
import {
  useMeeting,
  useAgendaItems,
  useRundown,
} from "@/hooks/useMeetings";
import { useMeetingVotes } from "@/hooks/useVotes";
import { useMeetingAnomalies } from "@/hooks/useAnomalies";
import { useMembers } from "@/hooks/useMembers";
import { StatusBadge } from "@/components/StatusBadge";
import { RundownViewer } from "@/components/RundownViewer";
import { VoteBreakdown } from "@/components/VoteBreakdown";
import { AnomalyCard } from "@/components/AnomalyCard";

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: meeting, isLoading: meetingLoading } = useMeeting(id!);
  const { data: agendaItems, isLoading: agendaLoading } = useAgendaItems(id!);
  const { data: rundown } = useRundown(id!);
  const { data: meetingVotes } = useMeetingVotes(id!);
  const { data: anomalies } = useMeetingAnomalies(id!);
  const { data: allMembers } = useMembers();

  if (meetingLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-gray-800 rounded animate-pulse" />
        <div className="h-32 bg-gray-800 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400">Meeting not found.</p>
        <Link to="/meetings" className="text-accent-400 hover:text-accent-300 mt-2 inline-block">
          Back to meetings
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <Link
        to="/meetings"
        className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to meetings
      </Link>

      <div className="mt-4 rounded-xl border border-gray-800 bg-gray-800/50 p-6">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-100">
              {meeting.commission?.name ?? "Commission Meeting"}
            </h2>
            <p className="text-gray-400 mt-1">
              {meeting.commission?.jurisdiction?.name},{" "}
              {meeting.commission?.jurisdiction?.state}
            </p>
          </div>
          <StatusBadge status={meeting.status} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6 text-sm">
          <div>
            <span className="text-gray-500">Date</span>
            <p className="text-gray-200 mt-0.5">
              {new Date(meeting.date).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Time</span>
            <p className="text-gray-200 mt-0.5">{meeting.time ?? "TBD"}</p>
          </div>
          <div>
            <span className="text-gray-500">Location</span>
            <p className="text-gray-200 mt-0.5">{meeting.location ?? "TBD"}</p>
          </div>
        </div>

        {(meeting.agenda_url || meeting.minutes_url) && (
          <div className="flex gap-3 mt-6">
            {meeting.agenda_url && (
              <a
                href={meeting.agenda_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent-400 hover:text-accent-300"
              >
                View Agenda PDF
              </a>
            )}
            {meeting.minutes_url && (
              <a
                href={meeting.minutes_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent-400 hover:text-accent-300"
              >
                View Minutes PDF
              </a>
            )}
          </div>
        )}
      </div>

      {rundown && (
        <div className="mt-6">
          <RundownViewer rundown={rundown} />
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-lg font-semibold text-gray-100 mb-4">
          Agenda Items
        </h3>
        {agendaLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-gray-800 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : agendaItems && agendaItems.length > 0 ? (
          <div className="space-y-2">
            {agendaItems.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-gray-800 bg-gray-800/50 p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-700 text-gray-300 text-sm font-medium flex items-center justify-center">
                    {item.item_number}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-gray-200 font-medium">{item.title}</h4>
                    {item.description && (
                      <p className="text-sm text-gray-400 mt-1">
                        {item.description}
                      </p>
                    )}
                    {item.category && (
                      <span className="inline-block mt-2 text-xs text-gray-500 bg-gray-700/50 px-2 py-0.5 rounded">
                        {item.category}
                      </span>
                    )}
                    {(() => {
                      const itemVotes = meetingVotes?.filter(
                        (v) => v.agenda_item_id === item.id,
                      );
                      if (!itemVotes?.length) return null;
                      return (
                        <div className="mt-2">
                          <VoteBreakdown
                            votes={itemVotes}
                            members={allMembers ?? []}
                          />
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No agenda items available.</p>
        )}
      </div>

      {anomalies && anomalies.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-gray-100 mb-4">
            Anomaly Flags
          </h3>
          <div className="space-y-3">
            {anomalies.map((anomaly) => (
              <AnomalyCard key={anomaly.id} anomaly={anomaly} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
