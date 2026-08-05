import { useMemo, useState, type ReactNode } from "react";
import { useAnomalies } from "@/hooks/useAnomalies";
import { useMeetings } from "@/hooks/useMeetings";
import { AnomalyCard, flagTypeLabels } from "@/components/AnomalyCard";
import {
  severityLabels,
  severityOrder,
  severityRank,
} from "@/components/AnomalyBadge";
import type { AnomalyFlagType } from "@/types";

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

  const {
    data: anomalies,
    isLoading,
    isError,
  } = useAnomalies({
    severity: severity || undefined,
    flag_type: flagType || undefined,
  });

  // `/anomalies` returns flags without their meeting, so the jurisdiction and
  // meeting date each entry is datelined with are joined on here.
  const { data: meetings } = useMeetings();
  const meetingsById = useMemo(
    () => new Map((meetings ?? []).map((meeting) => [meeting.id, meeting])),
    [meetings],
  );

  const filtered = Boolean(severity || flagType);

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">The ledger</p>
        <h2 className="headline mt-1.5 text-3xl sm:text-4xl">
          Flagged for review
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Entries in the public record that our checks singled out for a person
          to read. A flag is a prompt to open the source document and judge for
          yourself — nothing here is a finding.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-4 border-y border-rule py-3">
        <FilterField id="filter-severity" label="Severity">
          <select
            id="filter-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-none border border-rule bg-paper px-2 py-1 text-sm text-ink focus:border-ink"
          >
            <option value="">All severities</option>
            {severityOrder.map((value) => (
              <option key={value} value={value}>
                {severityRank[value]} · {severityLabels[value]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="filter-flag-type" label="Flag type">
          <select
            id="filter-flag-type"
            value={flagType}
            onChange={(e) => setFlagType(e.target.value)}
            className="rounded-none border border-rule bg-paper px-2 py-1 text-sm text-ink focus:border-ink"
          >
            <option value="">All flag types</option>
            {flagTypeOptions.map((value) => (
              <option key={value} value={value}>
                {flagTypeLabels[value]}
              </option>
            ))}
          </select>
        </FilterField>

        {filtered && (
          <button
            type="button"
            onClick={() => {
              setSeverity("");
              setFlagType("");
            }}
            className="label-sm pb-1 underline underline-offset-4 hover:text-ink"
          >
            Clear filters
          </button>
        )}

        {anomalies && (
          <p className="ml-auto pb-1">
            <span className="figure text-sm text-ink">{anomalies.length}</span>{" "}
            <span className="label-sm">
              {anomalies.length === 1 ? "entry" : "entries"}
            </span>
          </p>
        )}
      </div>

      {isError ? (
        <p className="py-16 text-center text-sm text-muted">
          The ledger could not be loaded. Try again shortly.
        </p>
      ) : isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading flagged entries</span>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex animate-pulse gap-4 border-b border-rule py-5"
              aria-hidden="true"
            >
              <div className="h-7 w-7 shrink-0 bg-paper-sunk" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-56 max-w-full bg-paper-sunk" />
                <div className="h-3 w-full bg-paper-sunk" />
                <div className="h-3 w-2/3 bg-paper-sunk" />
              </div>
            </div>
          ))}
        </div>
      ) : anomalies && anomalies.length > 0 ? (
        <div>
          {anomalies.map((anomaly) => (
            <AnomalyCard
              key={anomaly.id}
              anomaly={anomaly}
              meeting={meetingsById.get(anomaly.meeting_id)}
            />
          ))}
        </div>
      ) : (
        <p className="py-16 text-center text-sm text-muted">
          {filtered
            ? "No flags match this view."
            : "Nothing is flagged for review."}
        </p>
      )}
    </div>
  );
}

interface FilterFieldProps {
  id: string;
  label: string;
  children: ReactNode;
}

function FilterField({ id, label, children }: FilterFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="label-sm block">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
