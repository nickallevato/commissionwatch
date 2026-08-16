import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useAgendaDiff,
  useAgendaItems,
  useMeeting,
  useMeetingDocuments,
} from "@/hooks/useMeetings";
import { useMeetingVotes } from "@/hooks/useVotes";
import { useMeetingAnomalies } from "@/hooks/useAnomalies";
import { useMembers } from "@/hooks/useMembers";
import { StatusBadge } from "@/components/StatusBadge";
import { Absence } from "@/components/ui/Absence";
import { FindingSource } from "@/components/ui/FindingSource";
import { resolveFindingSource } from "@/components/ui/finding-source";
import { AgendaDiffTimeline } from "@/components/AgendaDiffTimeline";
import { MeetingClaims } from "@/components/MeetingClaims";
import { MeetingTranscript } from "@/components/MeetingTranscript";
import { flagTypeLabels } from "@/components/flag-labels";
import { SeverityMark } from "@/components/AnomalyBadge";
import { severityRank } from "@/components/severity";
import { tallyVotes, type VoteTally } from "@/components/vote-tally";
import { formatDay } from "@/lib/dates";
import type { MeetingDocument, Vote, VoteValue } from "@/types";

/* ---------------------------------------------------------------- formatting */

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

type Outcome = "passed" | "failed" | "none";

function outcomeOf(counts: VoteTally): Outcome {
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

/**
 * The source rule this page used to own now lives in
 * `components/ui/finding-source.ts`, and the findings ledger uses the same one.
 * It had grown a second, different answer over there — `AnomalyCard` ignored
 * `metadata.source_document` and always preferred the minutes — so the two
 * surfaces sent a reader to different documents for the same finding.
 */
function minutesOnFile(documents: MeetingDocument[]): boolean {
  return documents.some(
    (doc) =>
      doc.document_type.toLowerCase().includes("minutes") ||
      doc.title.toLowerCase().includes("minutes"),
  );
}

/* --------------------------------------------------------------------- page */

export function MeetingDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const meetingQuery = useMeeting(id);
  const agendaQuery = useAgendaItems(id);
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
      note: "Officials present and voting",
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
            {typeLabel} of {formatDay(meeting.date)}
          </h1>
          <div className="pt-2">
            <StatusBadge status={meeting.status} />
          </div>
        </div>

        {/* There is no Adjourned row, and there was one until 2026-08-10.
          `meetings` has no `adjourned_at` — it has a DATE, a nullable TIME,
          a location and a status, and nothing else about the sitting — so the
          row rendered the literal string "Not recorded" on every meeting this
          site has ever held or will hold. "Not recorded" is a claim about the
          custodian's minutes; what it actually described was a column we never
          created. A field that can only ever say one thing is not reporting,
          and a field that reports our own schema gap as the city's is worse
          than absent. When an adjournment time is extracted from minutes it
          gets a column, and then it gets a row here.

          `Convened` stays: `meetings.time` is real, is nullable, and its
          "Not recorded" is true of the source — Granicus publishes a time for
          upcoming meetings only. */}
        <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-ink-soft">
          <div className="flex items-baseline gap-2">
            <dt className="label-sm">Convened</dt>
            <dd>{convened ?? "Not recorded"}</dd>
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
        {!meeting.minutes_url && !minutesOnFile(documents) && (
          <p className="mt-3 text-sm text-muted">
            No minutes for this meeting are in the record.{" "}
            <Link className="cite" to={`/public-records?meeting=${meeting.id}`}>
              Request this record
            </Link>
          </p>
        )}

        {/* B3. Offered on every meeting, unconditionally — unlike the records
          link above, which is offered only where the record is short of
          something. There is no condition under which a person named in a
          record has no standing to contest it, and putting this behind one
          would mean deciding in advance which complaints are worth hearing. */}
        <p className="mt-3 text-sm text-muted">
          <Link
            className="cite"
            to={`/corrections/dispute?table=meetings&id=${meeting.id}`}
          >
            Contest this record
          </Link>
        </p>
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
      {/* The section renders unconditionally, and it did not before 2026-08-15.
        A meeting with no published finding used to drop it silently, which is
        the one shape of empty state this project has ruled out: a reader cannot
        tell a record nothing was flagged on from a record whose findings are
        all held in review, or from a request that failed. `<Absence>` is the
        grammar for saying which — and "no findings from this record have been
        reviewed yet" is exactly true of a meeting whose flags are queued. */}
      <section aria-labelledby="flags-heading" className="mt-10">
        <div className="rule-hi" />
        <div className="pt-3">
          <span className="kicker">Flagged by CommissionWatch</span>
          <h2
            id="flags-heading"
            className="font-display text-2xl leading-headline tracking-headline text-ink"
          >
            {sortedAnomalies.length === 1
              ? "One finding on this record"
              : sortedAnomalies.length > 1
                ? `${sortedAnomalies.length} findings on this record`
                : "Nothing flagged on this record"}
          </h2>
        </div>

        {anomaliesQuery.isLoading ? (
          <p className="mt-4 text-sm text-muted" role="status">
            Loading flags…
          </p>
        ) : anomaliesQuery.isError ? (
          <Absence reason="request-failed" subject="Findings on this meeting" />
        ) : sortedAnomalies.length === 0 ? (
          <Absence reason="not-reviewed" subject="findings" />
        ) : (
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
                  <FindingSource
                    source={resolveFindingSource(anomaly, meeting, documents)}
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
        )}
      </section>


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
          <Absence reason="request-failed" subject="the agenda for this meeting" />
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
                  const counts = tallyVotes(votesByItem.get(item.id) ?? []);
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
          <Absence reason="not-yet-ingested" subject="agenda items" />
        )}

        {unlinkedVotes > 0 && (
          <p className="mt-3 text-sm text-muted">
            <span className="figure">{unlinkedVotes}</span>{" "}
            {unlinkedVotes === 1 ? "vote is" : "votes are"} recorded against this
            meeting without an agenda item.
          </p>
        )}
      </section>

      {/* Claims -------------------------------------------------------- */}
      {/* After the agenda, because a claim is a line out of the minutes of
        what the agenda records the body doing — and *on this page at all*
        because a claim is never its own page. See MeetingClaims. */}
      <MeetingClaims
        meetingId={meeting.id}
        sourceLabel={`Minutes, ${bodyName}, ${formatDay(meeting.date)}`}
      />

      {/* Transcript ---------------------------------------------------- */}
      {/* After the claims, because a transcript corroborates what was said
        and never originates who said it — see migration 090.

        `meeting.transcript` is the per-document state `GET /api/meetings/:id`
        now returns, and it is passed straight through: `undefined` (a backend
        that predates the field) and `null` (no recording filed) are different
        facts, and defaulting either one here would erase the difference before
        the component that knows how to say it ever sees it.

        The jurisdiction and body names are still passed, for the year-coverage
        fallback: `/api/transcripts/coverage` groups on `j.name` and `c.name`,
        so those are the keys that join. */}
      <MeetingTranscript
        jurisdiction={jurisdiction?.name ?? ""}
        body={bodyName}
        date={meeting.date}
        transcript={meeting.transcript}
        documents={documents}
      />

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
