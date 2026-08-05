import { useState, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMeetings, useJurisdictions } from "@/hooks/useMeetings";
import { useAnomalies } from "@/hooks/useAnomalies";
import { StatusBadge } from "@/components/StatusBadge";
import { AnomalyBadge, severityOrder } from "@/components/AnomalyBadge";
import type { Meeting, MeetingStatus, AnomalyFlag } from "@/types";

/** Hairline control on paper — square corners, ink on hover. No pills. */
const controlClass =
  "rounded-none border border-rule bg-paper px-2 py-1 text-sm text-ink hover:border-ink focus:border-ink";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format a `YYYY-MM-DD` meeting date in UTC, so a date-only value never slides
 * a day backwards for a reader west of Greenwich.
 */
function formatMeetingDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[Number(month) - 1]} ${Number(
    day,
  )}, ${year}`;
}

/** `18:00:00` → `18:00`. The seconds the API sends are never meaningful here. */
function formatMeetingTime(value: string): string {
  const match = /^(\d{2}:\d{2})/.exec(value);
  return match ? match[1] : value;
}

/** Jurisdiction dateline, or an honest note that the record does not carry one. */
function datelineOf(meeting: Meeting): string {
  const jurisdiction = meeting.commission?.jurisdiction;
  return jurisdiction
    ? `${jurisdiction.name}, ${jurisdiction.state}`
    : "Jurisdiction unrecorded";
}

interface FilterFieldProps {
  id: string;
  label: string;
  children: ReactNode;
}

/**
 * One control in the filter strap, with a *visible* micro-label bound by
 * `htmlFor`/`id`. Explicit association rather than a wrapping <label>: an
 * `<input type="date">` renders no placeholder text, so the label is the only
 * thing — for a screen reader and for a sighted reader alike — that says which
 * end of the range a box is.
 */
function FilterField({ id, label, children }: FilterFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="label-sm">
        {label}
      </label>
      {children}
    </div>
  );
}

export function MeetingsPage() {
  const [jurisdictionId, setJurisdictionId] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: jurisdictions } = useJurisdictions();
  const { data: allAnomalies } = useAnomalies();

  const anomaliesByMeeting = useMemo(() => {
    const map = new Map<string, AnomalyFlag[]>();
    for (const a of allAnomalies ?? []) {
      const list = map.get(a.meeting_id) ?? [];
      list.push(a);
      map.set(a.meeting_id, list);
    }
    return map;
  }, [allAnomalies]);

  const {
    data: meetings,
    isLoading,
    isError,
  } = useMeetings({
    jurisdiction_id: jurisdictionId || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  });

  const filtersActive = Boolean(jurisdictionId || status || dateFrom || dateTo);

  return (
    <div>
      <header>
        <p className="kicker">The calendar</p>
        <h2 className="headline mt-1">Meetings</h2>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Every sitting we track, newest first — when it was held, who held it,
          and what our checks flagged in the record it left behind.
        </p>
      </header>

      <div className="rule-hi mt-6" />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-rule py-3">
        <FilterField id="meetings-jurisdiction" label="Jurisdiction">
          <select
            id="meetings-jurisdiction"
            value={jurisdictionId}
            onChange={(e) => setJurisdictionId(e.target.value)}
            className={controlClass}
          >
            <option value="">All jurisdictions</option>
            {jurisdictions?.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}, {j.state}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="meetings-status" label="Status">
          <select
            id="meetings-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={controlClass}
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </FilterField>

        <FilterField id="meetings-date-from" label="From">
          <input
            id="meetings-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className={`${controlClass} figure`}
          />
        </FilterField>

        <FilterField id="meetings-date-to" label="To">
          <input
            id="meetings-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className={`${controlClass} figure`}
          />
        </FilterField>

        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setJurisdictionId("");
              setStatus("");
              setDateFrom("");
              setDateTo("");
            }}
            className="label-sm underline underline-offset-4 hover:text-ink"
          >
            Clear filters
          </button>
        )}

        {meetings && (
          <p className="label-sm ml-auto">
            <span className="figure text-sm text-ink">{meetings.length}</span>{" "}
            {meetings.length === 1 ? "meeting" : "meetings"}
          </p>
        )}
      </div>

      {isError ? (
        <p className="border-b border-rule py-12 text-center text-sm text-accent">
          The meeting calendar could not be loaded.
        </p>
      ) : isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading meetings</span>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse border-b border-rule py-5"
              aria-hidden="true"
            >
              <div className="h-5 w-64 max-w-full bg-paper-sunk" />
              <div className="mt-2 h-3 w-48 max-w-full bg-paper-sunk" />
            </div>
          ))}
        </div>
      ) : meetings && meetings.length > 0 ? (
        <div>
          {meetings.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              anomalies={anomaliesByMeeting.get(meeting.id)}
            />
          ))}
        </div>
      ) : (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          {filtersActive
            ? "No meetings match these filters."
            : "No meetings on record yet."}
        </p>
      )}
    </div>
  );
}

interface MeetingRowProps {
  meeting: Meeting;
  anomalies: AnomalyFlag[] | undefined;
}

/**
 * One sitting in the calendar: a hairline row, not a card. Serif commission
 * name, dateline and date in muted sans, flags and status set to the right.
 */
function MeetingRow({ meeting, anomalies }: MeetingRowProps) {
  const name = meeting.commission?.name ?? "Commission meeting";
  const date = formatMeetingDate(meeting.date);
  const maxSeverity = anomalies?.length
    ? (severityOrder.find((s) => anomalies.some((a) => a.severity === s)) ??
      "low")
    : null;

  return (
    <article aria-label={`${name}, ${date}`} className="border-b border-rule">
      <Link
        to={`/meetings/${meeting.id}`}
        className="group flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-5"
      >
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold leading-snug tracking-headline text-ink underline-offset-4 group-hover:underline">
            {name}
          </h3>
          {/* Prose dateline, so the numerals are tabular but not mono — a
              monospaced weekday and month read as data, not as a dateline. */}
          <p className="tabular mt-1 text-[0.8125rem] leading-normal text-muted">
            {datelineOf(meeting)}
            {" · "}
            {date}
            {meeting.time && ` at ${formatMeetingTime(meeting.time)}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {maxSeverity && anomalies && (
            <AnomalyBadge count={anomalies.length} maxSeverity={maxSeverity} />
          )}
          <StatusBadge status={meeting.status} />
        </div>
      </Link>
    </article>
  );
}

export function meetingStatusLabel(status: MeetingStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
