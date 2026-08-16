import { Link } from "react-router-dom";
import { useAgendaItems, useMeetings } from "@/hooks/useMeetings";
import { useMeetingVotes } from "@/hooks/useVotes";
import { useAnomalies } from "@/hooks/useAnomalies";
import { flagTypeLabels } from "@/components/flag-labels";
import { formatDay } from "@/lib/dates";
import type {
  AnomalyFlag,
  AnomalySeverity,
  Meeting,
  Vote,
  VoteValue,
} from "@/types";

/* ---------------------------------------------------------------------------
   The lead column, and the fallback for when there is no finding in it
   ------------------------------------------------------------------------- */

/**
 * The lead story of the front page. Findings are editorial write-ups of a
 * reviewed meeting — a headline, a dek, and the provenance behind them.
 */
interface FrontPageFinding {
  readonly kicker: string;
  readonly headline: string;
  readonly dek: string;
}

/**
 * No finding has been published, and this says so.
 *
 * This used to be called `PLACEHOLDER_FINDING`, which invited exactly the wrong
 * repair: filling a placeholder in. There is nothing to fill in. Any headline
 * here would otherwise be a claim this site cannot source, and the subject of a
 * front-page claim on this site is a real, living, named official. That is the
 * one thing the project must never do by accident.
 *
 * ## Corrected 2026-08-16: it is now a fallback, not the only thing rendered
 *
 * This docblock used to say findings "do not exist in the data model — there is
 * no `findings` table, no `/findings` endpoint and no hook", and that "when they
 * land, this constant is deleted and the lead column reads the latest
 * *published* finding from the hook."
 *
 * They landed. `anomaly_flags` is the table, `GET /api/anomalies` is the
 * endpoint, `useAnomalies` is the hook — and this very file already imported and
 * called it, for the flags rail. Only the lead column was never wired, so it
 * rendered this constant **unconditionally**.
 *
 * That made it a latent lie rather than an honest absence: correct only while
 * zero findings are published, and wrong the moment the first one is. The front
 * page would have gone on saying no finding had been published while `/findings`
 * and the feeds carried one. A site whose purpose is to surface findings must
 * not under-report its own.
 *
 * **It composes nothing.** The lead renders `flagTypeLabels[flag_type]` as the
 * headline and the detector's own `description` as the dek — the same two fields
 * `/findings` renders — because a finding here is the detector's sentence, not
 * composed prose. And it can only ever show a **published** flag:
 * `/api/anomalies` applies the publication wall server-side, so an unreviewed or
 * held flag never reaches this component at all.
 */
const NO_FINDING_YET: FrontPageFinding = {
  kicker: "Latest finding",
  headline: "No finding has been published yet",
  dek:
    "This column carries the most recent published finding: what the record shows, " +
    "which meeting it came from, and the agenda, minutes and vote tallies it was " +
    "drawn from. Until the review pipeline publishes its first write-up, the " +
    "meeting record below is the primary source.",
};

/* ---------------------------------------------------------------------------
   Formatting helpers
   ------------------------------------------------------------------------- */

function jurisdictionOf(meeting: Meeting | undefined): string | null {
  const jurisdiction = meeting?.commission?.jurisdiction;
  if (!jurisdiction) return null;
  return `${jurisdiction.name}, ${jurisdiction.state}`;
}

/* ---------------------------------------------------------------------------
   Vote arithmetic
   ------------------------------------------------------------------------- */

type Outcome = "passed" | "failed" | "unrecorded";

interface Tally {
  readonly counts: Record<VoteValue, number>;
  readonly cast: number;
  readonly outcome: Outcome;
}

function tally(votes: readonly Vote[]): Tally {
  const counts: Record<VoteValue, number> = {
    yes: 0,
    no: 0,
    abstain: 0,
    absent: 0,
  };
  votes.forEach((vote) => {
    counts[vote.vote] += 1;
  });
  const cast = counts.yes + counts.no;
  const outcome: Outcome =
    votes.length === 0 ? "unrecorded" : counts.yes > counts.no ? "passed" : "failed";
  return { counts, cast, outcome };
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  unrecorded: "No vote recorded",
};

const OUTCOME_CLASS: Record<Outcome, string> = {
  passed: "text-pass",
  failed: "text-fail",
  unrecorded: "text-muted",
};

/* ---------------------------------------------------------------------------
   Severity
   ------------------------------------------------------------------------- */

/** Severity squares: 4-5 accent red, 3 amber, 1-2 grey. */
const SEVERITY_SQUARE: Record<AnomalySeverity, string> = {
  critical: "bg-sev4",
  high: "bg-sev4",
  medium: "bg-sev3",
  low: "bg-sev2",
};

const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/* ---------------------------------------------------------------------------
   Selection
   ------------------------------------------------------------------------- */

function byDateDesc(a: Meeting, b: Meeting): number {
  return b.date.localeCompare(a.date);
}

function byDateAsc(a: Meeting, b: Meeting): number {
  return a.date.localeCompare(b.date);
}

/** The most recently held meeting — the one the front page reports on. */
function pickLastMeeting(meetings: readonly Meeting[]): Meeting | undefined {
  return [...meetings].filter((m) => m.status === "completed").sort(byDateDesc)[0];
}

function pickUpcoming(meetings: readonly Meeting[]): Meeting[] {
  return [...meetings]
    .filter((m) => m.status === "scheduled")
    .sort(byDateAsc)
    .slice(0, 4);
}

/**
 * The finding the lead column carries: the most recently published one.
 *
 * Ordered by `created_at` alone, deliberately **not** by severity. The rail
 * beside it is the severity-ranked view; a front page that led with the worst
 * thing ever found rather than the latest would be editorialising by ordering,
 * and would keep one finding at the masthead indefinitely.
 *
 * Every flag reaching here is already published — `/api/anomalies` applies the
 * wall server-side.
 */
function pickLeadFinding(flags: readonly AnomalyFlag[]): AnomalyFlag | undefined {
  return [...flags].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

function pickOpenFlags(flags: readonly AnomalyFlag[]): AnomalyFlag[] {
  return [...flags]
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.created_at.localeCompare(a.created_at),
    )
    .slice(0, 6);
}

/* ---------------------------------------------------------------------------
   Shared small parts
   ------------------------------------------------------------------------- */

function Notice({ children }: { children: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      {children}
    </p>
  );
}

function ErrorNotice({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm text-accent">
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------------------
   Page
   ------------------------------------------------------------------------- */

export function HomePage() {
  const {
    data: meetings,
    isLoading: meetingsLoading,
    isError: meetingsError,
  } = useMeetings();
  const {
    data: flags,
    isLoading: flagsLoading,
    isError: flagsError,
  } = useAnomalies();

  const allMeetings = meetings ?? [];
  const lastMeeting = pickLastMeeting(allMeetings);
  const upcoming = pickUpcoming(allMeetings);
  const openFlags = pickOpenFlags(flags ?? []);
  const leadFinding = pickLeadFinding(flags ?? []);
  const meetingById = new Map(allMeetings.map((m) => [m.id, m]));
  const lastMeetingFlagCount = lastMeeting
    ? (flags ?? []).filter((f) => f.meeting_id === lastMeeting.id).length
    : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="lg:grid lg:grid-cols-3 lg:gap-0">
        {/* ---------------- Main column ---------------- */}
        {/* A <div>, not a <main>. "Main column" here is the newspaper sense —
          the wide column beside the rail — but the element it was written as
          is a landmark, and `Layout` already renders the document's <main>
          around this page. Two main landmarks is a violation
          (`landmark-main-is-top-level`), and the practical cost is that a
          screen-reader user jumping by landmark lands in an ambiguous place on
          the one page most readers see first. The column is layout; the rail
          beside it is an <aside> because that one really is complementary. */}
        <div className="lg:col-span-2 lg:pr-10">
          <p className="kicker">{NO_FINDING_YET.kicker}</p>
          <h1 className="headline mt-2" data-testid="lead-finding-headline">
            {leadFinding ? flagTypeLabels[leadFinding.flag_type] : NO_FINDING_YET.headline}
          </h1>
          <p className="mt-4 max-w-prose text-base text-ink-soft">
            {leadFinding ? leadFinding.description : NO_FINDING_YET.dek}
          </p>
          {leadFinding && (
            <p className="mt-3 text-sm">
              <Link
                className="underline decoration-rule hover:decoration-accent"
                to={`/meetings/${leadFinding.meeting_id}`}
              >
                The meeting this came from
              </Link>
              <span className="text-muted"> · </span>
              <Link
                className="underline decoration-rule hover:decoration-accent"
                to="/findings"
              >
                Every published finding
              </Link>
            </p>
          )}
          {/* This byline used to read "Generated {today} · N meetings
            reviewed". Both halves were false. Nothing was generated — there is
            no finding above it — and `allMeetings` is what the meetings
            endpoint returned, which is a count of meetings *in the record*, not
            a count of meetings anybody reviewed. A site that exists to catch
            unsourced claims does not get to publish two of them under its own
            masthead. It now says what the number is. */}
          <p className="mt-4 text-xs text-muted">
            <span className="figure">{allMeetings.length}</span>{" "}
            {allMeetings.length === 1
              ? "meeting in the published record"
              : "meetings in the published record"}
          </p>

          <hr className="mt-8 border-t border-rule" />

          <LastMeetingSection
            meeting={lastMeeting}
            flagCount={lastMeetingFlagCount}
            isLoading={meetingsLoading}
            isError={meetingsError}
          />
        </div>

        {/* ---------------- Rail ---------------- */}
        <aside className="mt-12 border-t border-rule pt-8 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <section aria-labelledby="open-flags-heading">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                id="open-flags-heading"
                className="font-display text-xl tracking-headline"
              >
                Open flags
              </h2>
              <Link to="/findings" className="label-sm hover:text-ink">
                All flags
              </Link>
            </div>
            <hr className="mt-3 rule-hi" />

            {flagsError ? (
              <div className="mt-4">
                <ErrorNotice>Open flags could not be loaded.</ErrorNotice>
              </div>
            ) : flagsLoading ? (
              <div className="mt-4">
                <Notice>Loading open flags…</Notice>
              </div>
            ) : openFlags.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No open flags.</p>
            ) : (
              <ul className="mt-2">
                {openFlags.map((flag) => (
                  <FlagRow
                    key={flag.id}
                    flag={flag}
                    meeting={meetingById.get(flag.meeting_id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <hr className="my-8 border-t border-rule" />

          <section aria-labelledby="next-up-heading">
            <h2
              id="next-up-heading"
              className="font-display text-xl tracking-headline"
            >
              Next up
            </h2>
            <hr className="mt-3 rule-hi" />

            {meetingsError ? (
              <div className="mt-4">
                <ErrorNotice>Upcoming meetings could not be loaded.</ErrorNotice>
              </div>
            ) : meetingsLoading ? (
              <div className="mt-4">
                <Notice>Loading upcoming meetings…</Notice>
              </div>
            ) : upcoming.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No meetings scheduled.</p>
            ) : (
              <ul className="mt-2">
                {upcoming.map((meeting) => (
                  <UpcomingRow key={meeting.id} meeting={meeting} />
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Last meeting
   ------------------------------------------------------------------------- */

interface LastMeetingSectionProps {
  meeting: Meeting | undefined;
  flagCount: number;
  isLoading: boolean;
  isError: boolean;
}

function LastMeetingSection({
  meeting,
  flagCount,
  isLoading,
  isError,
}: LastMeetingSectionProps) {
  if (isError) {
    return (
      <section className="mt-6">
        <p className="label-sm">Last meeting</p>
        <div className="mt-3">
          <ErrorNotice>
            The meeting record could not be loaded. Try again shortly.
          </ErrorNotice>
        </div>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="mt-6">
        <p className="label-sm">Last meeting</p>
        <div className="mt-3">
          <Notice>Loading the meeting record…</Notice>
        </div>
      </section>
    );
  }

  if (!meeting) {
    return (
      <section className="mt-6">
        <p className="label-sm">Last meeting</p>
        <p className="mt-3 text-sm text-muted">
          No completed meeting is on the record yet.
        </p>
      </section>
    );
  }

  const jurisdiction = jurisdictionOf(meeting);

  return (
    <section className="mt-6" aria-labelledby="last-meeting-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="flex items-baseline gap-2 text-xs text-muted">
            <span className="label-sm">Last meeting</span>
            <span aria-hidden="true">·</span>
            <span className="figure">{formatDay(meeting.date)}</span>
          </p>
          <h2
            id="last-meeting-heading"
            className="mt-2 font-display text-2xl tracking-headline"
          >
            <Link to={`/meetings/${meeting.id}`} className="hover:text-accent">
              {meeting.commission?.name ?? "Commission meeting"}
            </Link>
          </h2>
          {jurisdiction && (
            <p className="mt-1 text-sm text-muted">{jurisdiction}</p>
          )}
        </div>
        <p
          className={`text-xs ${flagCount > 0 ? "text-accent" : "text-muted"}`}
        >
          <span className="figure">{flagCount}</span>{" "}
          {flagCount === 1 ? "flag" : "flags"}
        </p>
      </div>

      <AgendaTable meetingId={meeting.id} />
    </section>
  );
}

function AgendaTable({ meetingId }: { meetingId: string }) {
  const {
    data: items,
    isLoading: itemsLoading,
    isError: itemsError,
  } = useAgendaItems(meetingId);
  const { data: votes, isError: votesError } = useMeetingVotes(meetingId);

  if (itemsError) {
    return (
      <div className="mt-6">
        <ErrorNotice>Agenda items could not be loaded.</ErrorNotice>
      </div>
    );
  }

  if (itemsLoading) {
    return (
      <div className="mt-6">
        <Notice>Loading agenda items…</Notice>
      </div>
    );
  }

  const rows = [...(items ?? [])].sort((a, b) => a.item_number - b.item_number);

  if (rows.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted">
        No agenda items were recorded for this meeting.
      </p>
    );
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Agenda items from the last meeting, with vote tallies and results
        </caption>
        <thead>
          <tr className="border-b border-ink">
            <th scope="col" className="label-sm w-12 pb-2 pr-3 align-bottom">
              Item
            </th>
            <th scope="col" className="label-sm pb-2 pr-3 align-bottom">
              Title
            </th>
            <th
              scope="col"
              className="label-sm w-20 pb-2 pr-3 text-right align-bottom"
            >
              Vote
            </th>
            <th scope="col" className="label-sm w-36 pb-2 text-right align-bottom">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const result = tally(
              (votes ?? []).filter((v) => v.agenda_item_id === item.id),
            );
            return (
              <tr key={item.id} className="border-b border-rule align-top">
                <td className="figure py-3 pr-3 text-sm text-muted">
                  {item.item_number}
                </td>
                <td className="py-3 pr-3 text-sm text-ink">{item.title}</td>
                <td className="figure py-3 pr-3 text-right text-sm text-ink">
                  {result.outcome === "unrecorded"
                    ? "—"
                    : `${result.counts.yes}–${result.counts.no}`}
                </td>
                <td
                  className={`py-3 text-right text-sm ${OUTCOME_CLASS[result.outcome]}`}
                >
                  {OUTCOME_LABEL[result.outcome]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {votesError && (
        <div className="mt-3">
          <ErrorNotice>Vote tallies could not be loaded.</ErrorNotice>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Rail rows
   ------------------------------------------------------------------------- */

function FlagRow({
  flag,
  meeting,
}: {
  flag: AnomalyFlag;
  meeting: Meeting | undefined;
}) {
  const jurisdiction = jurisdictionOf(meeting);
  const when = formatDay(meeting?.date ?? flag.created_at);

  return (
    <li className="border-b border-rule py-3 last:border-b-0">
      <Link
        to={`/meetings/${flag.meeting_id}`}
        className="flex items-start gap-3 hover:text-accent"
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 flex-shrink-0 ${SEVERITY_SQUARE[flag.severity]}`}
        />
        <span className="min-w-0">
          <span className="block text-sm leading-snug text-ink">
            {flagTypeLabels[flag.flag_type]}
          </span>
          <span className="sr-only">{` — severity ${flag.severity}`}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {jurisdiction ? `${jurisdiction} · ` : null}
            <span className="figure">{when}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

function UpcomingRow({ meeting }: { meeting: Meeting }) {
  const jurisdiction = jurisdictionOf(meeting);
  const agendaPosted = Boolean(meeting.agenda_url);

  return (
    <li className="border-b border-rule py-3 last:border-b-0">
      <Link to={`/meetings/${meeting.id}`} className="block hover:text-accent">
        <span className="block text-sm leading-snug text-ink">
          {meeting.commission?.name ?? "Commission meeting"}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          <span className="figure">{formatDay(meeting.date)}</span>
          {jurisdiction ? ` · ${jurisdiction}` : null}
        </span>
      </Link>
      <p
        className={`mt-1 text-xs ${agendaPosted ? "text-muted" : "text-accent"}`}
      >
        {agendaPosted ? "Agenda posted" : "Agenda not posted"}
      </p>
    </li>
  );
}
