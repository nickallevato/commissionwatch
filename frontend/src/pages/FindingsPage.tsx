import { useMemo, useState, type ReactNode } from "react";
import { useAnomalies } from "@/hooks/useAnomalies";
import { useMeetings } from "@/hooks/useMeetings";
import { AnomalyCard } from "@/components/AnomalyCard";
import { Absence } from "@/components/ui/Absence";
import { flagTypeLabels } from "@/components/flag-labels";
import {
  severityLabels,
  severityOrder,
  severityRank,
} from "@/components/severity";
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

export function FindingsPage() {
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
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">Findings</h1>
        {/* This copy used to end "nothing here is a finding", under a heading
          that said "Flagged for review", reached from a nav link that said
          "Findings", at a URL that said /anomalies. Four names for one thing,
          one of them denying it was the thing.

          The old sentence was not merely inconsistent, it had gone stale. It
          was written when a detector's output went straight to the page, and
          drawing a line between a machine's flag and a person's finding was
          exactly right then. B-a shipped the review queue: `review_state`
          reaches 'published' only when a named operator approves it, so
          everything on this page has now been read by a person. Saying
          otherwise undersold the one guarantee that matters most. */}
        {/* Corrected 2026-08-15, and the correction matters more than the
          original edit did.

          This said "a person reviewed and published", which is false for most
          entries here. `resolveReviewState` (backend/src/services/review/policy.ts)
          holds a flag only when a detector marked it `alwaysHold` — which is
          what "nothing naming a person auto-publishes" is made of — or when its
          severity reaches the review threshold, `high` by default. A low or
          medium flag naming nobody is published by rule, with no human in the
          loop, and `anomaly_flags.review_state` defaults to 'published' besides.

          Claiming a review that did not happen is the same category of defect
          as an unsourced claim, and it was on the page that exists to explain
          how this site behaves. The guarantee that IS true is narrower and
          worth stating exactly: the person-naming ones are held. */}
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Patterns in the public record that our checks singled out. Anything
          naming a person is held until an operator approves it; the rest are
          published by rule, at low and medium severity, without a human in the
          loop. Each one links to the documents it rests on, so you can read the
          source and judge for yourself. A finding is not an allegation.
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
        // `<Absence>` rather than this page's own sentence, which said the
        // ledger "could not be loaded" and stopped there. A reader cannot tell
        // that from an empty ledger unless someone says whose failure it is,
        // and the status page is where the answer lives.
        <Absence reason="request-failed" subject="The findings ledger" />
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
        // Deliberately still this page's own sentence, where the error state
        // above is not. Neither empty case has an honest `<Absence>` reason: a
        // filter returning nothing is a statement about the filter rather than
        // about the record, and `not-reviewed` — the closest fit for an empty
        // ledger — reads "no findings **from this record** have been reviewed
        // yet", which is true on a meeting page and false of a site-wide
        // ledger. Mapping onto the nearest wrong reason is how the grammar of
        // absence stops meaning anything.
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
