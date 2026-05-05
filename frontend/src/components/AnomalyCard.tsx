import { Link } from "react-router-dom";
import type { AnomalyFlag, AnomalyFlagType, AnomalySeverity } from "@/types";

const severityStyles: Record<AnomalySeverity, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
  high: "bg-red-500/10 text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  low: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const flagTypeLabels: Record<AnomalyFlagType, string> = {
  emergency_session: "Emergency Session",
  closed_door_vote: "Closed-Door Vote",
  last_minute_agenda_change: "Last-Minute Agenda Change",
  quorum_issue: "Quorum Issue",
  unanimous_controversial: "Unanimous Controversial",
  missing_minutes: "Missing Minutes",
};

const flagTypeIcons: Record<AnomalyFlagType, string> = {
  emergency_session: "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z",
  closed_door_vote: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
  last_minute_agenda_change: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
  quorum_issue: "M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z",
  unanimous_controversial: "M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5",
  missing_minutes: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
};

interface Props {
  anomaly: AnomalyFlag;
  meetingId?: string;
}

export function AnomalyCard({ anomaly, meetingId }: Props) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-800/50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <svg
            className="w-5 h-5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={flagTypeIcons[anomaly.flag_type]}
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-gray-200 font-medium">
              {flagTypeLabels[anomaly.flag_type]}
            </h4>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${severityStyles[anomaly.severity]}`}
            >
              {anomaly.severity}
            </span>
          </div>
          {anomaly.description && (
            <p className="text-sm text-gray-400 mt-1">{anomaly.description}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
            <span>Source: {anomaly.source}</span>
            <span>
              {new Date(anomaly.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {meetingId && (
              <Link
                to={`/meetings/${meetingId}`}
                className="text-accent-400 hover:text-accent-300"
              >
                View meeting
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
