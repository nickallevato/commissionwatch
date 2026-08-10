/**
 * iCalendar (RFC 5545) emission, by hand.
 *
 * An `.ics` file is text. Adding a runtime dependency to produce a few hundred
 * bytes of it would be more supply chain than saving, and the two things that
 * are actually hard here — the timezone and the missing start time — are not
 * things a library would decide correctly on this schema's behalf anyway.
 *
 * ## The timezone trap
 *
 * `meetings` has no `scheduled_at`. It has a `DATE` and a **nullable** `TIME`,
 * both naive, and the zone they are expressed in lives on
 * `jurisdictions.timezone` (default `America/Denver`). Two failure modes follow,
 * and both put a meeting on the wrong hour in somebody's real calendar:
 *
 *  - **Composing the instant in the server's zone.** A container running UTC
 *    would publish a 7pm Bozeman meeting as 7pm UTC — one o'clock in the
 *    afternoon, local. So the wall time is converted using the jurisdiction's
 *    zone, via `Intl`, and emitted as a UTC `DATE-TIME` with a `Z`. UTC needs no
 *    `VTIMEZONE` block, and a `TZID` without one is a reference to a definition
 *    the file does not contain.
 *
 *  - **Treating a null time as midnight.** Most rows have no published time —
 *    Granicus states one for upcoming meetings only. `2026-08-14T00:00` is not
 *    what the record says; it is what a naive cast produces. Those meetings are
 *    emitted as **all-day events**: `DTSTART;VALUE=DATE` with a `DTEND;VALUE=DATE`
 *    on the following day, which is how RFC 5545 spells "this day", and which
 *    renders in every client as a banner on the correct date rather than an
 *    appointment at midnight.
 *
 * ## Why a timed event carries no DTEND
 *
 * The record does not state when a meeting ended. `meetings` has no adjournment
 * column — an earlier version of the meeting page rendered one and it could
 * only ever say "Not recorded", which was this project's schema gap published as
 * a claim about the city's minutes. A default `DURATION:PT2H` would be the same
 * mistake in a file people subscribe to. RFC 5545 §3.6.1 defines a `VEVENT` with
 * a DATE-TIME `DTSTART` and no `DTEND` as ending at its start, and clients
 * render that as a moment on the calendar, which is exactly what is known.
 */

/** Fold column. RFC 5545 §3.1: no line may exceed 75 octets. */
const FOLD_OCTETS = 75;

/**
 * Escapes a TEXT value. RFC 5545 §3.3.11.
 *
 * Backslash first, or every subsequently inserted escape would be re-escaped.
 * Newlines become the literal two characters `\n`, which is how a multi-line
 * location survives into a calendar entry.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds one content line onto continuation lines of at most 75 **octets**.
 *
 * Counted in octets and not characters on purpose: an agenda title with a
 * typographic dash is three bytes for one character, and a fold measured in
 * characters produces lines that are legal to look at and over-length on the
 * wire. Continuation lines begin with a single space, which the unfolder strips.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= FOLD_OCTETS) return line;

  const parts: string[] = [];
  let offset = 0;
  let limit = FOLD_OCTETS;

  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    // Never split a multi-byte character: continuation bytes are 10xxxxxx.
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
    // Continuation lines spend one octet on the leading space.
    limit = FOLD_OCTETS - 1;
  }

  return parts.join("\r\n ");
}

/** `YYYYMMDD`, from an ISO calendar date. RFC 5545 DATE. */
export function icalDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

/** `YYYYMMDDTHHMMSSZ`, from an instant. RFC 5545 UTC DATE-TIME. */
export function icalUtc(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** The day after an ISO date, as an ISO date. All-day `DTEND` is exclusive. */
export function nextIsoDate(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * The UTC instant of a naive wall time in a named IANA zone.
 *
 * `Intl` is the only zone database Node ships, and it answers the question
 * backwards: given an instant it will tell you the wall time. So this guesses
 * the instant, asks what wall time that guess lands on, and corrects by the
 * difference. One correction is enough away from a transition; the second pass
 * settles the case where the first guess crossed a DST boundary that the
 * corrected instant does not.
 *
 * Returns `null` for an unrecognised zone rather than falling back to UTC. A
 * silent fallback would publish a Montana meeting six hours early, which is
 * worse than the meeting not appearing in the feed at all.
 */
export function wallTimeToUtc(isoDate: string, time: string, timeZone: string): Date | null {
  const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const target = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(target)) return null;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }

  const wanted = target + (hour * 60 + minute) * 60_000;
  let guess = wanted;

  for (let pass = 0; pass < 2; pass += 1) {
    const parts = format.formatToParts(new Date(guess));
    const read = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((candidate) => candidate.type === type);
      return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
    };
    // `hour12: false` renders midnight as 24 in some ICU versions.
    const readHour = read("hour") % 24;
    const asUtc = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      readHour,
      read("minute"),
      read("second"),
    );
    if (Number.isNaN(asUtc)) return null;
    const drift = asUtc - guess;
    const corrected = wanted - drift;
    if (corrected === guess) break;
    guess = corrected;
  }

  return new Date(guess);
}

/* ---------------------------------------------------------------------------
   Events
   --------------------------------------------------------------------------- */

/** Mirrors the `meeting_status` enum from migration 003. */
export type MeetingStatus = "scheduled" | "completed" | "cancelled";

export interface CalendarMeeting {
  /** `meetings.id`. The stable half of the event UID. */
  id: string;
  /** `YYYY-MM-DD` in the jurisdiction's zone. */
  date: string;
  /** `HH:MM` in the jurisdiction's zone, or null where the source states none. */
  time: string | null;
  /** `jurisdictions.timezone`, an IANA name. */
  timezone: string;
  /** `commissions.name` — the body that sits. This is the event's SUMMARY. */
  bodyName: string;
  jurisdictionName: string;
  location: string | null;
  status: MeetingStatus;
  /** `meetings.updated_at`, for LAST-MODIFIED. */
  updatedAt: Date;
}

export interface CalendarFeedOptions {
  /** Feed name, e.g. "Gallatin County — CommissionWatch". */
  name: string;
  /** Absolute base of the public site, for per-meeting URLs. */
  siteUrl: string;
  /** UID domain and PRODID vendor. */
  domain: string;
  /** Clock, injected so the DTSTAMP a test reads is the one it set. */
  now?: Date;
}

const STATUS_LINE: Record<MeetingStatus, string> = {
  scheduled: "TENTATIVE",
  completed: "CONFIRMED",
  cancelled: "CANCELLED",
};

/**
 * A stable UID.
 *
 * Keyed on the meeting's own uuid and nothing else — not the date, not the
 * body — so a meeting that is rescheduled updates the subscriber's existing
 * entry instead of leaving the old time on their calendar beside the new one.
 */
export function eventUid(meetingId: string, domain: string): string {
  return `meeting-${meetingId}@${domain}`;
}

/**
 * One VEVENT, or `null` when the meeting cannot be placed in time.
 *
 * The null case is an unrecognised timezone on a meeting that does state a
 * time. Omitting it is the honest failure: a feed missing one entry is a gap
 * somebody can notice, and a feed with one entry at the wrong hour is not.
 */
export function buildEvent(
  meeting: CalendarMeeting,
  options: CalendarFeedOptions,
): string[] | null {
  const now = options.now ?? new Date();
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${eventUid(meeting.id, options.domain)}`,
    `DTSTAMP:${icalUtc(now)}`,
  ];

  if (meeting.time === null) {
    // All-day. DTEND is exclusive, so the day after.
    lines.push(`DTSTART;VALUE=DATE:${icalDate(meeting.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icalDate(nextIsoDate(meeting.date))}`);
  } else {
    const start = wallTimeToUtc(meeting.date, meeting.time, meeting.timezone);
    if (start === null) return null;
    lines.push(`DTSTART:${icalUtc(start)}`);
    // No DTEND. See the note at the top of this file: the record does not say
    // when a meeting ends, and inventing a length would be a claim.
  }

  const summary =
    meeting.status === "cancelled" ? `Cancelled: ${meeting.bodyName}` : meeting.bodyName;
  lines.push(`SUMMARY:${escapeText(summary)}`);

  const description =
    meeting.time === null
      ? `${meeting.jurisdictionName}. The published record states no start time for this meeting, so it appears as an all-day entry rather than at an assumed hour.`
      : `${meeting.jurisdictionName}. Start time as published by the jurisdiction. The record does not state an end time.`;
  lines.push(`DESCRIPTION:${escapeText(description)}`);

  if (meeting.location !== null && meeting.location.length > 0) {
    lines.push(`LOCATION:${escapeText(meeting.location)}`);
  }
  lines.push(`URL:${options.siteUrl}/meetings/${meeting.id}`);
  lines.push(`STATUS:${STATUS_LINE[meeting.status]}`);
  lines.push(`LAST-MODIFIED:${icalUtc(meeting.updatedAt)}`);
  lines.push("END:VEVENT");

  return lines;
}

/** A complete VCALENDAR. CRLF-delimited and folded, per RFC 5545. */
export function buildCalendar(
  meetings: readonly CalendarMeeting[],
  options: CalendarFeedOptions,
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${options.domain}//CommissionWatch//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(options.name)}`,
    `X-WR-CALNAME:${escapeText(options.name)}`,
  ];

  for (const meeting of meetings) {
    const event = buildEvent(meeting, options);
    if (event !== null) lines.push(...event);
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
