import { Link } from "react-router";
import { SeverityMark } from "@/components/AnomalyBadge";
import { flagTypeLabels } from "@/components/flag-labels";
import { FindingSource } from "@/components/ui/FindingSource";
import { resolveFindingSource } from "@/components/ui/finding-source";
import type { AnomalyFlag, Meeting } from "@/types";

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
 * muted text, and a source chip pointing at the document it was drawn from.
 *
 * The chip is `<FindingSource>` as of 2026-08-15, and the rule behind it is the
 * meeting page's. This card had its own — always the minutes, and
 * `metadata.source_document` ignored entirely — so a finding an operator had
 * pinned to a named staff report was cited here as the minutes. One row, two
 * answers, and a reader who checked the wrong one found nothing.
 *
 * It is not `<Citation>`: a finding carries no quotation and no artifact hash.
 * See `ui/finding-source.ts`.
 */
export function AnomalyCard({ anomaly, meeting: meetingProp }: Props) {
  const meeting = meetingProp ?? anomaly.meeting;
  const jurisdiction = meeting?.commission?.jurisdiction;
  // No documents to pass: `/anomalies` returns flags without them, so the rule
  // resolves against `meetings.minutes_url` / `agenda_url` alone.
  const source = resolveFindingSource(anomaly, meeting);

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

        {/* Per finding, not per page.
          
          The ledger's lead copy states the rule — anything naming a person is
          held, the rest publish at low and medium severity by rule — because
          until now that was the most the page could honestly say. `review_state`
          is 'published' for both, so a reader had no way to tell which entry in
          front of them had been read by anybody.
          
          `undefined` prints nothing at all. An older response that does not
          carry the field means "we do not know", and that is not the same
          statement as "nobody approved this" — printing the latter for the
          former would be the same overclaim, one layer down. */}
        {anomaly.operator_reviewed === true ? (
          <p className="mt-1 text-[0.6875rem] leading-normal text-muted">
            Approved for publication by an operator
            {anomaly.reviewed_at ? (
              <>
                {" on "}
                <span className="figure">{anomaly.reviewed_at.slice(0, 10)}</span>
              </>
            ) : null}
            .
          </p>
        ) : anomaly.operator_reviewed === false ? (
          <p className="mt-1 text-[0.6875rem] leading-normal text-muted">
            Published by rule at this severity. No operator read it.
          </p>
        ) : null}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <FindingSource source={source} />
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
