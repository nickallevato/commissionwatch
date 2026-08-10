import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useAgendaDiff,
  useAgendaItems,
  useMeeting,
  useMeetingDocuments,
  useRundown,
} from "@/hooks/useMeetings";
import { useMeetingVotes } from "@/hooks/useVotes";
import { useMeetingAnomalies } from "@/hooks/useAnomalies";
import { useMembers } from "@/hooks/useMembers";
import { StatusBadge } from "@/components/StatusBadge";
import { RundownViewer } from "@/components/RundownViewer";
import { AgendaDiffTimeline } from "@/components/AgendaDiffTimeline";
import { flagTypeLabels } from "@/components/AnomalyCard";
import { SeverityMark, severityRank } from "@/components/AnomalyBadge";
import type { AnomalyFlag, Meeting, MeetingDocument, Vote, VoteValue } from "@/types";

/* ---------------------------------------------------------------- formatting */

/**
 * `meetings.date` is a calendar date (`YYYY-MM-DD`). Parsing it with `new
 * Date()` would read it as UTC midnight and render the previous day west of
 * Greenwich, so the parts are assembled in local time instead.
 */
function formatMeetingDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const parsed = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** `meetings.time` is a clock string (`18:00`, `18:00:00`). */
function formatClock(value: string | null): string | null {
  if (!value) return null;
  const parts = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!parts) return value;
  const hour = Number(parts[1]);
  if (hour > 23) return value;
  const meridiem = hour < 12 ? "a.m." : "p.m.";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${parts[2]} ${meridiem}`;
}

/* -------------------------------------------------------------------- tallies */

interface Tally {
  yes: number;
  no: number;
  abstain: number;
  absent: number;
}

function tally(votes: Vote[]): Tally {
  const counts: Tally = { yes: 0, no: 0, abstain: 0, absent: 0 };
  for (const vote of votes) counts[vote.vote]++;
  return counts;
}

type Outcome = "passed" | "failed" | "none";

function outcomeOf(counts: Tally): Outcome {
  if (counts.yes + counts.no === 0) return "none";
  return counts.yes > counts.no ? "passed" : "failed";
}

const outcomeLabel: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  none: "No recorded vote",
};

const outcomeText: Record<Outcome, string> = {
  passed: "text-pass",
  failed: "text-fail",
  none: "text-muted",
};

/* ----------------------------------------------------------------- citations */

interface Citation {
  label: string;
  url: string | null;
}

function findDocument(
  documents: MeetingDocument[],
  kind: string,
): MeetingDocument | undefined {
  return documents.find(
    (doc) =>
      doc.document_type.toLowerCase().includes(kind) ||
      doc.title.toLowerCase().includes(kind),
  );
}

/**
 * Names the record a flag was drawn from. Only sources that actually exist on
 * the meeting are cited — when nothing is on file the chip says so rather than
 * implying a document that was never published.
 */
function citationFor(
  anomaly: AnomalyFlag,
  meeting: Meeting,
  documents: MeetingDocument[],
): Citation {
  const named = anomaly.metadata?.source_document;
  if (typeof named === "string" && named.length > 0) {
    const match = documents.find((doc) => doc.title === named);
    const url = anomaly.metadata?.source_url;
    return {
      label: named,
      url: match?.url ?? (typeof url === "string" ? url : null),
    };
  }

  const agendaDoc = findDocument(documents, "agenda");
  const minutesDoc = findDocument(documents, "minutes");
  const agenda: Citation | null =
    agendaDoc || meeting.agenda_url
      ? {
          label: agendaDoc?.title ?? "agenda",
          url: agendaDoc?.url ?? meeting.agenda_url,
        }
      : null;
  const minutes: Citation | null =
    minutesDoc || meeting.minutes_url
      ? {
          label: minutesDoc?.title ?? "minutes",
          url: minutesDoc?.url ?? meeting.minutes_url,
        }
      : null;

  if (anomaly.flag_type === "missing_minutes") {
    return minutes ?? { label: "no minutes on file", url: null };
  }
  // How the meeting was noticed is evidenced by the agenda; what happened in
  // the room is evidenced by the minutes.
  if (
    anomaly.flag_type === "last_minute_agenda_change" ||
    anomaly.flag_type === "emergency_session"
  ) {
    return agenda ?? minutes ?? { label: "meeting record", url: null };
  }
  return minutes ?? agenda ?? { label: "meeting record", url: null };
}

function CitationChip({ citation }: { citation: Citation }) {
  const text = `Source: ${citation.label}`;
  if (!citation.url) return <span className="cite">{text}</span>;
  return (
    <a
      className="cite"
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {text}
    </a>
  );
}

/* --------------------------------------------------------------------- page */

export function MeetingDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const meetingQuery = useMeeting(id);
  const agendaQuery = useAgendaItems(id);
  const rundownQuery = useRundown(id);
  const votesQuery = useMeetingVotes(id);
  const anomaliesQuery = useMeetingAnomalies(id);
  const documentsQuery = useMeetingDocuments(id);
  const diffQuery = useAgendaDiff(id);
  const membersQuery = useMembers();

  const meeting = meetingQuery.data;
  const agendaItems = agendaQuery.data;
  const votes = useMemo(() => votesQuery.data ?? [], [votesQuery.data]);
  const anomalies = anomaliesQuery.data;
  const documents = documentsQuery.data ?? [];

  const votesByItem = useMemo(() => {
    const map = new Map<string, Vote[]>();
    for (const vote of votes) {
      if (!vote.agenda_item_id) continue;
      const list = map.get(vote.agenda_item_id) ?? [];
      list.push(vote);
      map.set(vote.agenda_item_id, list);
    }
    return map;
  }, [votes]);

  const unlinkedVotes = votes.filter((vote) => !vote.agenda_item_id).length;

  /** Attendance is derived from the roll: members with a vote other than `absent`. */
  const attendance = useMemo(() => {
    const present = new Set<string>();
    const recorded = new Set<string>();
    const cast: VoteValue[] = ["yes", "no", "abstain"];
    for (const vote of votes) {
      recorded.add(vote.member_id);
      if (cast.includes(vote.vote)) present.add(vote.member_id);
    }
    const jurisdictionId = meeting?.commission?.jurisdiction_id;
    const roster = (membersQuery.data ?? []).filter(
      (member) => !jurisdictionId || member.jurisdiction_id === jurisdictionId,
    );
    const seats = Math.max(roster.length, recorded.size);
    if (recorded.size === 0) return { figure: "—", note: "No roll recorded" };
    return {
      figure: seats > 0 ? `${present.size}/${seats}` : String(present.size),
      note: "Voting members present",
    };
  }, [votes, membersQuery.data, meeting]);

  const sortedAnomalies = useMemo(
    () =>
      [...(anomalies ?? [])].sort(
        (a, b) => severityRank[b.severity] - severityRank[a.severity],
      ),
    [anomalies],
  );

  if (meetingQuery.isLoading) return <MeetingSkeleton />;

  if (meetingQuery.isError || !meeting) {
    const missing =
      !meeting && !meetingQuery.isError
        ? true
        : /\b404\b/.test(String(meetingQuery.error));
    return (
      <div className="max-w-4xl">
        <BackLink />
        <span className="kicker mt-6 block">
          {missing ? "Not found" : "Error"}
        </span>
        <h1 className="headline text-3xl">
          {missing
            ? "No meeting on file for this record."
            : "This meeting record could not be loaded."}
        </h1>
        {!missing && (
          <p className="mt-3 max-w-prose text-sm text-muted">
            {meetingQuery.error instanceof Error
              ? meetingQuery.error.message
              : "The request to the record service failed."}
          </p>
        )}
      </div>
    );
  }

  const jurisdiction = meeting.commission?.jurisdiction;
  const bodyName = meeting.commission?.name ?? "Commission";
  const convened = formatClock(meeting.time);
  const typeLabel =
    meeting.status === "cancelled" ? "Cancelled meeting" : "Meeting";

  return (
    <div className="max-w-4xl">
      <BackLink />

      {/* Standing head ------------------------------------------------- */}
      <header className="mt-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="kicker">
            {jurisdiction
              ? `${jurisdiction.name}, ${jurisdiction.state}`
              : "Jurisdiction not recorded"}
          </span>
          <span aria-hidden="true" className="text-rule">
            /
          </span>
          <span className="label-sm">{bodyName}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <h1 className="headline text-4xl sm:text-5xl">
            {typeLabel} of {formatMeetingDate(meeting.date)}
          </h1>
          <div className="pt-2">
            <StatusBadge status={meeting.status} />
          </div>
        </div>

        <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-ink-soft">
          <div className="flex items-baseline gap-2">
            <dt className="label-sm">Convened</dt>
            <dd>{convened ?? "Not recorded"}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="label-sm">Adjourned</dt>
            <dd>Not recorded</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="label-sm">Location</dt>
            <dd>{meeting.location ?? "Not recorded"}</dd>
          </div>
        </dl>

        {(meeting.agenda_url || meeting.minutes_url) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {meeting.agenda_url && (
              <a
                className="cite"
                href={meeting.agenda_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Agenda (PDF)
              </a>
            )}
            {meeting.minutes_url && (
              <a
                className="cite"
                href={meeting.minutes_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Minutes (PDF)
              </a>
            )}
          </div>
        )}

        {/* P7. Offered only where the record itself is short of something —
          the same condition the API derives a `missing_minutes` gap from, read
          off what this page already loaded rather than asked for again. The
          link states an absence and nothing about why. */}
        {!meeting.minutes_url && !findDocument(documents, "minutes") && (
          <p className="mt-3 text-sm text-muted">
            No minutes for this meeting are in the record.{" "}
            <Link className="cite" to={`/public-records?meeting=${meeting.id}`}>
              Request this record
            </Link>
          </p>
        )}
      </header>

      {/* Stat band ----------------------------------------------------- */}
      <div className="mt-8 grid grid-cols-2 border-y border-ink sm:grid-cols-4">
        <StatCell
          label="Agenda items"
          value={agendaQuery.isLoading ? "—" : String(agendaItems?.length ?? 0)}
        />
        <StatCell
          label="Votes"
          value={votesQuery.isLoading ? "—" : String(votes.length)}
        />
        <StatCell
          label="Flags"
          value={anomaliesQuery.isLoading ? "—" : String(anomalies?.length ?? 0)}
          emphasis={(anomalies?.length ?? 0) > 0}
        />
        <StatCell
          label="Attendance"
          value={votesQuery.isLoading ? "—" : attendance.figure}
          note={votesQuery.isLoading ? undefined : attendance.note}
        />
      </div>

      {/* Flags --------------------------------------------------------- */}
      {sortedAnomalies.length > 0 && (
        <section aria-labelledby="flags-heading" className="mt-10">
          <div className="rule-hi" />
          <div className="pt-3">
            <span className="kicker">Flagged by CommissionWatch</span>
            <h2
              id="flags-heading"
              className="font-display text-2xl leading-headline tracking-headline text-ink"
            >
              {sortedAnomalies.length === 1
                ? "One anomaly on this record"
                : `${sortedAnomalies.length} anomalies on this record`}
            </h2>
          </div>

          <div className="mt-4 space-y-5">
            {sortedAnomalies.map((anomaly) => (
              <article
                key={anomaly.id}
                className="border-l-2 border-accent py-1 pl-4"
              >
                <div className="flex items-center gap-2.5">
                  <SeverityMark severity={anomaly.severity} size="sm" />
                  <h3 className="font-sans text-base font-semibold tracking-normal text-ink">
                    {flagTypeLabels[anomaly.flag_type]}
                  </h3>
                </div>
                <p className="mt-1 max-w-prose text-sm text-ink-soft">
                  {anomaly.description}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <CitationChip
                    citation={citationFor(anomaly, meeting, documents)}
                  />
                  <span className="label-sm">
                    {anomaly.source === "auto"
                      ? "Automated check"
                      : "Added in review"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Rundown ------------------------------------------------------- */}
      {rundownQuery.data && (
        <div className="mt-10">
          <RundownViewer rundown={rundownQuery.data} />
        </div>
      )}

      {/* Agenda -------------------------------------------------------- */}
      <section aria-labelledby="agenda-heading" className="mt-10">
        <div className="rule-hi" />
        <div className="pt-3">
          <span className="kicker">The record</span>
          <h2
            id="agenda-heading"
            className="font-display text-2xl leading-headline tracking-headline text-ink"
          >
            Agenda and votes
          </h2>
        </div>

        {agendaQuery.isLoading ? (
          <div className="mt-4 space-y-3" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-10 animate-pulse bg-paper-sunk" />
            ))}
          </div>
        ) : agendaQuery.isError ? (
          <p className="mt-4 text-sm text-muted">
            The agenda for this meeting could not be loaded.
          </p>
        ) : agendaItems && agendaItems.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <thead>
                <tr className="border-y border-ink">
                  <th scope="col" className="w-14 py-2 pr-4 align-bottom">
                    <span className="label-sm">Item</span>
                  </th>
                  <th scope="col" className="py-2 pr-4 align-bottom">
                    <span className="label-sm">Title</span>
                  </th>
                  <th scope="col" className="w-24 py-2 pr-4 text-right align-bottom">
                    <span className="label-sm">Vote</span>
                  </th>
                  <th scope="col" className="w-32 py-2 text-right align-bottom">
                    <span className="label-sm">Result</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {agendaItems.map((item) => {
                  const counts = tally(votesByItem.get(item.id) ?? []);
                  const outcome = outcomeOf(counts);
                  const aside = [
                    counts.abstain > 0 ? `${counts.abstain} abstained` : null,
                    counts.absent > 0 ? `${counts.absent} absent` : null,
                  ].filter((entry): entry is string => entry !== null);

                  return (
                    <tr key={item.id} className="border-b border-rule align-top">
                      <td className="py-3 pr-4">
                        <span className="figure text-sm text-muted">
                          {item.item_number}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-[15px] font-medium text-ink">
                          {item.title}
                        </span>
                        {item.description && (
                          <p className="mt-1 max-w-prose text-sm text-muted">
                            {item.description}
                          </p>
                        )}
                        {item.category && (
                          <span className="label-sm mt-1">{item.category}</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <span className="figure text-[15px] text-ink">
                          {outcome === "none"
                            ? "—"
                            : `${counts.yes}–${counts.no}`}
                        </span>
                        {aside.length > 0 && (
                          <span className="label-sm mt-1 block">
                            {aside.join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <span
                          className={`text-[11px] font-semibold uppercase tracking-label ${outcomeText[outcome]}`}
                        >
                          {outcomeLabel[outcome]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted">
            No agenda items on file for this meeting.
          </p>
        )}

        {unlinkedVotes > 0 && (
          <p className="mt-3 text-sm text-muted">
            <span className="figure">{unlinkedVotes}</span>{" "}
            {unlinkedVotes === 1 ? "vote is" : "votes are"} recorded against this
            meeting without an agenda item.
          </p>
        )}
      </section>

      {/* Document history ---------------------------------------------- */}
      <AgendaDiffTimeline
        timelines={diffQuery.data}
        isLoading={diffQuery.isLoading}
        isError={diffQuery.isError}
      />
    </div>
  );
}

/* --------------------------------------------------------------- fragments */

function BackLink() {
  return (
    <Link
      to="/meetings"
      className="inline-flex items-center gap-1 font-sans text-sm text-muted hover:text-ink"
    >
      <span aria-hidden="true">&larr;</span> All meetings
    </Link>
  );
}

/**
 * Hairlines between the four figures: a vertical rule between columns and, on
 * the two-up mobile grid, a horizontal rule between the two rows.
 */
const STAT_CELL =
  "border-rule px-4 py-4 [&:nth-child(odd)]:border-r [&:nth-child(-n+2)]:border-b sm:[&:nth-child(2)]:border-r sm:[&:nth-child(-n+2)]:border-b-0 sm:[&:last-child]:border-r-0";

interface StatCellProps {
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
}

function StatCell({ label, value, note, emphasis }: StatCellProps) {
  return (
    <div className={STAT_CELL}>
      <span className="label-sm">{label}</span>
      <p
        className={`figure mt-1 text-3xl leading-none ${
          emphasis ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </p>
      {note && <span className="label-sm mt-1">{note}</span>}
    </div>
  );
}

function MeetingSkeleton() {
  return (
    <div className="max-w-4xl" role="status" aria-live="polite">
      <span className="label-sm">Loading meeting record…</span>
      <div className="mt-4 h-3 w-40 animate-pulse bg-paper-sunk" />
      <div className="mt-4 h-10 w-3/4 animate-pulse bg-paper-sunk" />
      <div className="mt-3 h-3 w-1/2 animate-pulse bg-paper-sunk" />
      <div className="mt-8 grid grid-cols-2 border-y border-rule sm:grid-cols-4">
        {[0, 1, 2, 3].map((cell) => (
          <div key={cell} className={STAT_CELL}>
            <div className="h-2 w-16 animate-pulse bg-paper-sunk" />
            <div className="mt-3 h-7 w-12 animate-pulse bg-paper-sunk" />
          </div>
        ))}
      </div>
    </div>
  );
}
