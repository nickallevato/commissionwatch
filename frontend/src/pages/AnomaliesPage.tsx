import { useState } from "react";
import { useAnomalies } from "@/hooks/useAnomalies";
import { AnomalyCard } from "@/components/AnomalyCard";
import type { AnomalyFlagType, AnomalySeverity } from "@/types";

const FLAG_TYPE_OPTIONS: { value: AnomalyFlagType; label: string }[] = [
  { value: "emergency_session", label: "Emergency Session" },
  { value: "closed_door_vote", label: "Closed-Door Vote" },
  { value: "last_minute_agenda_change", label: "Last-Minute Agenda Change" },
  { value: "quorum_issue", label: "Quorum Issue" },
  { value: "unanimous_controversial", label: "Unanimous Controversial" },
  { value: "missing_minutes", label: "Missing Minutes" },
];

const SEVERITY_OPTIONS: AnomalySeverity[] = ["critical", "high", "medium", "low"];

export function AnomaliesPage() {
  const [flagType, setFlagType] = useState("");
  const [severity, setSeverity] = useState("");

  const { data: anomalies, isLoading } = useAnomalies({
    flag_type: flagType || undefined,
    severity: severity || undefined,
  });

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-100 mb-6">Anomalies</h2>

      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={flagType}
          onChange={(e) => setFlagType(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Types</option>
          {FLAG_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Severities</option>
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>

        {(flagType || severity) && (
          <button
            onClick={() => {
              setFlagType("");
              setSeverity("");
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
      ) : anomalies && anomalies.length > 0 ? (
        <div className="space-y-3">
          {anomalies.map((anomaly) => (
            <AnomalyCard
              key={anomaly.id}
              anomaly={anomaly}
              meetingId={anomaly.meeting_id}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          No anomalies found.
        </div>
      )}
    </div>
  );
}
