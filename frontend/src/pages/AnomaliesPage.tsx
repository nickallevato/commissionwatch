import { useState } from "react";
import { Link } from "react-router-dom";
import { useAnomalies } from "@/hooks/useAnomalies";
import { AnomalyCard, flagTypeLabels } from "@/components/AnomalyCard";
import type { AnomalySeverity, AnomalyFlagType } from "@/types";

const severityOptions: AnomalySeverity[] = ["critical", "high", "medium", "low"];
/** Every member of the `anomaly_flag_type` enum, in filter-menu order. */
const flagTypeOptions: AnomalyFlagType[] = [
  "emergency_session",
  "closed_door_vote",
  "last_minute_agenda_change",
  "quorum_issue",
  "unanimous_controversial",
  "missing_minutes",
];

export function AnomaliesPage() {
  const [severity, setSeverity] = useState("");
  const [flagType, setFlagType] = useState("");

  const { data: anomalies, isLoading } = useAnomalies({
    severity: severity || undefined,
    flag_type: flagType || undefined,
  });

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-100 mb-6">Anomalies</h2>

      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Severities</option>
          {severityOptions.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={flagType}
          onChange={(e) => setFlagType(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-accent-500 focus:border-accent-500"
        >
          <option value="">All Types</option>
          {flagTypeOptions.map((value) => (
            <option key={value} value={value}>
              {flagTypeLabels[value]}
            </option>
          ))}
        </select>

        {(severity || flagType) && (
          <button
            onClick={() => {
              setSeverity("");
              setFlagType("");
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
              className="h-24 rounded-lg bg-gray-800 animate-pulse"
            />
          ))}
        </div>
      ) : anomalies && anomalies.length > 0 ? (
        <div className="space-y-3">
          {anomalies.map((anomaly) => (
            <div key={anomaly.id}>
              <AnomalyCard anomaly={anomaly} />
              {anomaly.meeting_id && (
                <Link
                  to={`/meetings/${anomaly.meeting_id}`}
                  className="text-xs text-accent-400 hover:text-accent-300 ml-8 mt-1 inline-block"
                >
                  View meeting →
                </Link>
              )}
            </div>
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
