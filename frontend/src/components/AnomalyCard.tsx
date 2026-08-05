import { Link } from "react-router-dom";
import { SeverityMark } from "@/components/AnomalyBadge";
import type { AnomalyFlag, AnomalyFlagType, Meeting } from "@/types";

/**
 * Keyed by the `anomaly_flag_type` enum — the single source of display names.
 * Sentence case, and deliberately descriptive rather than accusatory: a flag
 * marks something for a person to read, it does not assert wrongdoing.
 */
export const flagTypeLabels: Record<AnomalyFlagType, string> = {
  emergency_session: "Emergency session",
  closed_door_vote: "Closed-door vote",
  last_minute_agenda_change: "Last-minute agenda change",
  quorum_issue: "Quorum issue",
  unanimous_controversial: "Unanimous vote on a contested item",
  missing_minutes: "Minutes not published",
};

/** How the flag entered the ledger. Provenance is part of the citation. */
const sourceLabels: Record<AnomalyFlag["source"], string> = {
  auto: "Automated check",
  manual: "Added in review",
};

interface Props {
  anomaly: AnomalyFlag;
  /**
   * The meeting this flag was raised against. `/anomalies` returns flags
   * without the relation loaded, so a caller that already holds the meetings
   * can supply it here; otherwise the embedded `anomaly.meeting` is used.
   */
  meeting?: Meeting;
}

/**
 * One entry in the flag ledger: severity square, flag type as a serif
 * sub-headline, the description in sans, jurisdiction and meeting date in
 * muted text, and a citation chip pointing at the source document.
 */
export function AnomalyCard({ anomaly, meeting: meetingProp }: Props) {
  const meeting = meetingProp ?? anomaly.meeting;
  const jurisdiction = meeting?.commission?.jurisdiction;
  const source = sourceDocument(meeting);

  const meta = [
    jurisdiction ? `${jurisdiction.name}, ${jurisdiction.state}` : null,
    meeting?.date ? `Meeting ${formatDate(meeting.date)}` : null,
    `Flagged ${formatDate(anomaly.created_at)}`,
  ].filter((part): part is string => part !== null);

  return (
    <article className="flex gap-4 border-b border-rule py-5">
      <SeverityMark severity={anomaly.severity} />

      <div className="min-w-0 flex-1">
        <h3 className="font-display text-lg font-semibold leading-snug tracking-headline text-ink">
          {flagTypeLabels[anomaly.flag_type]}
        </h3>

        <p className="mt-1 text-sm text-ink-soft">{anomaly.description}</p>

        <p className="mt-2 text-[0.6875rem] leading-normal text-muted">
          {meta.join(" · ")}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {source && (
            <a
              className="cite"
              href={source.href}
              target="_blank"
              rel="noreferrer"
            >
              {source.label}
            </a>
          )}
          {anomaly.meeting_id && (
            <Link className="cite" to={`/meetings/${anomaly.meeting_id}`}>
              Meeting record
            </Link>
          )}
          <span className="label-sm">{sourceLabels[anomaly.source]}</span>
        </div>
      </div>
    </article>
  );
}

/** Prefer minutes over the agenda: minutes are the record of what happened. */
function sourceDocument(
  meeting: Meeting | undefined,
): { href: string; label: string } | null {
  if (meeting?.minutes_url) {
    return { href: meeting.minutes_url, label: "Source: minutes" };
  }
  if (meeting?.agenda_url) {
    return { href: meeting.agenda_url, label: "Source: agenda" };
  }
  return null;
}

/**
 * Dates are read in UTC so a plain `YYYY-MM-DD` meeting date never slides a day
 * backwards for a viewer west of Greenwich.
 */
function formatDate(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
