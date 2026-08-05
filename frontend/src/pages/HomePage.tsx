import { Link } from "react-router-dom";
import { useAgendaItems, useMeetings } from "@/hooks/useMeetings";
import { useMeetingVotes } from "@/hooks/useVotes";
import { useAnomalies } from "@/hooks/useAnomalies";
import { flagTypeLabels } from "@/components/AnomalyCard";
import type {
  AnomalyFlag,
  AnomalySeverity,
  Meeting,
  Vote,
  VoteValue,
} from "@/types";

/* ---------------------------------------------------------------------------
   Placeholder finding
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
 * TODO(W3): findings do not exist in the data model yet. W3 owns the findings
 * table, the `/findings` endpoint and the `useFindings` hook. When that lands,
 * delete this constant and read the latest published finding from the hook.
 * Deliberately neutral copy — never ship a fabricated finding about a real
 * person or a real vote.
 */
const PLACEHOLDER_FINDING: FrontPageFinding = {
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Format a `YYYY-MM-DD` (or full ISO timestamp) as "March 4, 2026".
 *
 * Parsed off the string rather than through `Date`, because `new Date("2024-12-10")`
 * is UTC midnight and renders as the previous day west of Greenwich.
 */
function formatDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const name = MONTHS[month - 1];
  if (!year || !name || !day) return iso;
  return `${name} ${day}, ${year}`;
}

/** Today as `YYYY-MM-DD` in the reader's own timezone. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

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
  const meetingById = new Map(allMeetings.map((m) => [m.id, m]));
  const lastMeetingFlagCount = lastMeeting
    ? (flags ?? []).filter((f) => f.meeting_id === lastMeeting.id).length
    : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="lg:grid lg:grid-cols-3 lg:gap-0">
        {/* ---------------- Main column ---------------- */}
        <main className="lg:col-span-2 lg:pr-10">
          <p className="kicker">{PLACEHOLDER_FINDING.kicker}</p>
          <h1 className="headline mt-2">{PLACEHOLDER_FINDING.headline}</h1>
          <p className="mt-4 max-w-prose text-base text-ink-soft">
            {PLACEHOLDER_FINDING.dek}
          </p>
          <p className="mt-4 text-xs text-muted">
            Generated <span className="figure">{formatDay(todayIso())}</span>
            {" · "}
            <span className="figure">{allMeetings.length}</span>{" "}
            {allMeetings.length === 1 ? "meeting reviewed" : "meetings reviewed"}
          </p>

          <hr className="mt-8 border-t border-rule" />

          <LastMeetingSection
            meeting={lastMeeting}
            flagCount={lastMeetingFlagCount}
            isLoading={meetingsLoading}
            isError={meetingsError}
          />
        </main>

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
              <Link to="/anomalies" className="label-sm hover:text-ink">
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
