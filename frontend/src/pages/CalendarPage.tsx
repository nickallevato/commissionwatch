import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { formatDayShort } from "@/lib/dates";
import type {
  CalendarJurisdiction,
  CalendarMeetingSummary,
  CalendarResponse,
} from "@/types";

/**
 * `/calendar` — when these bodies sit, and how to put that in your own calendar.
 *
 * The whole page is one query. There is no maintained schedule here and there
 * could not be: a commission that adds a special session should appear because
 * the record says so, not because somebody edited a page.
 *
 * Two things it refuses to do, both of which are the easy thing:
 *
 * 1. **It never prints a time the record does not state.** Most rows have no
 *    published start time — the archive states one for upcoming meetings only —
 *    and `meetings` stores a nullable TIME beside its DATE. A null there renders
 *    as *Time not published*, never as 12:00 AM. The same rule holds in the iCal
 *    feed, where the meeting becomes an all-day entry.
 * 2. **It never fills an empty calendar with reassurance.** A jurisdiction with
 *    nothing upcoming says so plainly, and points at `/status`, because "no
 *    meetings listed" and "we have stopped collecting" look identical from here
 *    and only one of them is about the city.
 */

type LoadResult = { ok: true; data: CalendarJurisdiction[] } | { ok: false };

/** `19:00` → `7:00 PM`. The value is already local to the jurisdiction. */
function formatTime(time: string | null): string | null {
  if (time === null) return null;
  const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const suffix = hours < 12 ? "AM" : "PM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

const STATUS_LABEL: Record<CalendarMeetingSummary["status"], string> = {
  scheduled: "Scheduled",
  completed: "Held",
  cancelled: "Cancelled",
};

export function CalendarPage() {
  const [jurisdictions, setJurisdictions] = useState<CalendarJurisdiction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/calendar");
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as CalendarResponse;
      return { ok: true, data: body.data };
    } catch {
      return { ok: false };
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await load();
      if (ignore) return;
      if (result.ok) {
        setJurisdictions(result.data);
        setError("");
      } else {
        // Said plainly. An empty calendar rendered after a failed request would
        // be this site asserting that nobody is meeting.
        setError(
          "The calendar could not be loaded, so this page is not reporting on it. It is not saying there are no meetings.",
        );
      }
      setLoading(false);
    })();
    return () => {
      ignore = true;
    };
  }, [load]);

  return (
    <div>
      <p className="kicker">Meeting calendar</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">When these bodies sit</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Every meeting on this page is one an operator has published to the
        record. Each jurisdiction has a calendar feed you can subscribe to in
        your own calendar application, so a special session appears where you
        already look rather than where you have to remember to.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 max-w-prose border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading the calendar…
        </p>
      ) : jurisdictions !== null && jurisdictions.length === 0 ? (
        <div className="mt-8 max-w-prose border-l-2 border-accent bg-paper-sunk px-4 py-3">
          <p className="text-sm text-ink">No jurisdiction is on the record yet.</p>
          <p className="mt-2 text-sm leading-relaxed text-accent">
            That is a collection gap, not a quiet month. The{" "}
            <Link className="cite" to="/status">
              collection status
            </Link>{" "}
            says which sources are switched on.
          </p>
        </div>
      ) : (
        (jurisdictions ?? []).map((jurisdiction) => (
          <JurisdictionCalendar key={jurisdiction.id} jurisdiction={jurisdiction} />
        ))
      )}

      <section className="mt-14 max-w-prose" aria-labelledby="subscribing">
        <h2 id="subscribing" className="font-display text-xl font-semibold text-ink">
          Subscribing
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Each feed above is an ordinary iCalendar file. Copy its address into
          Google Calendar (<span className="font-mono text-sm">Other calendars → From URL</span>),
          Apple Calendar (<span className="font-mono text-sm">File → New Calendar Subscription</span>)
          or Outlook, and your calendar will refetch it on its own schedule. The
          feed carries a year ahead and six months back.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Two things about how the entries are written, because getting either
          wrong would put a meeting on the wrong hour in your real calendar.{" "}
          <strong className="font-semibold text-ink">
            A meeting with no published start time is an all-day entry
          </strong>{" "}
          rather than an appointment at midnight — the record does not say when
          it begins, so neither does the feed. And a meeting that does have a
          time carries no end time, because nothing in the published record
          states when a meeting adjourned and a default length would be this
          project&rsquo;s guess wearing the jurisdiction&rsquo;s name.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Times are converted from the jurisdiction&rsquo;s own timezone, which
          is printed beside each feed. If a meeting is rescheduled its entry is
          updated in place rather than added again, because the entry is keyed
          on the meeting and not on its date.
        </p>
      </section>

      <section className="mt-10 max-w-prose" aria-labelledby="everything">
        <h2 id="everything" className="font-display text-xl font-semibold text-ink">
          Or take the whole record
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The calendar is a view of the published record.{" "}
          <Link className="cite" to="/data">
            Open data
          </Link>{" "}
          has the same meetings as CSV and JSON, with the agenda items, votes
          and the content address of the document each one was read out of.
        </p>
      </section>
    </div>
  );
}

function JurisdictionCalendar({ jurisdiction }: { jurisdiction: CalendarJurisdiction }) {
  return (
    <section className="mt-12" aria-labelledby={`jurisdiction-${jurisdiction.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2">
        <h2
          id={`jurisdiction-${jurisdiction.id}`}
          className="font-display text-2xl font-semibold tracking-headline text-ink"
        >
          {jurisdiction.name}, {jurisdiction.state}
        </h2>
        <span className="label-sm">{jurisdiction.timezone}</span>
      </div>

      <p className="mt-3">
        <a className="cite" href={jurisdiction.ics_url} data-testid={`ics-${jurisdiction.id}`}>
          Subscribe · {jurisdiction.ics_url}
        </a>
      </p>

      <div className="mt-6 grid gap-10 md:grid-cols-2">
        <MeetingColumn
          title="Upcoming"
          meetings={jurisdiction.upcoming}
          empty="No upcoming meeting is on the published record for this jurisdiction."
        />
        <MeetingColumn
          title="Recent"
          meetings={jurisdiction.recent}
          empty="No past meeting has been published for this jurisdiction."
        />
      </div>
    </section>
  );
}

function MeetingColumn({
  title,
  meetings,
  empty,
}: {
  title: string;
  meetings: CalendarMeetingSummary[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="label-sm">{title}</h3>
      {meetings.length === 0 ? (
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule border-t border-rule">
          {meetings.map((meeting) => (
            <MeetingRow key={meeting.id} meeting={meeting} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MeetingRow({ meeting }: { meeting: CalendarMeetingSummary }) {
  const time = formatTime(meeting.time);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time dateTime={meeting.date} className="figure text-sm text-ink tabular">
          {formatDayShort(meeting.date)}
        </time>
        {time === null ? (
          // Never 12:00 AM. The record does not state a start time, and saying
          // midnight would be this site's cast published as the city's schedule.
          <span className="text-xs text-muted">Time not published</span>
        ) : (
          <span className="text-xs text-ink-soft tabular">{time}</span>
        )}
        {meeting.status !== "scheduled" && (
          <span
            className={`text-[11px] font-semibold uppercase tracking-label ${
              meeting.status === "cancelled" ? "text-accent" : "text-muted"
            }`}
          >
            {STATUS_LABEL[meeting.status]}
          </span>
        )}
      </div>
      <Link
        to={`/meetings/${meeting.id}`}
        className="mt-1 block font-display text-base leading-snug text-ink hover:text-accent"
      >
        {meeting.body_name}
      </Link>
      {meeting.location !== null && meeting.location.length > 0 && (
        <span className="mt-0.5 block text-xs text-muted">{meeting.location}</span>
      )}
    </li>
  );
}
