import type { Knex } from "knex";
import { whereMeetingPublished } from "../publication";
import type { CalendarMeeting, MeetingStatus } from "./ical";

/**
 * What the public calendar and the iCal feeds read.
 *
 * Published meetings only, through `whereMeetingPublished` rather than a
 * retyped predicate — a subscribed calendar is a public surface that keeps
 * pulling long after anyone looked at the site, so a meeting that is later
 * unpublished has to leave the feed on the next fetch, and that only holds if
 * the feed asks the same question as every other public route.
 *
 * Every date and time is rendered to text in SQL. The pg driver returns a `DATE`
 * as a JS `Date` at the *process's* local midnight and a `TIME` as `HH:MM:SS`,
 * and re-deriving a calendar date from the first of those in a container running
 * UTC moves meetings across midnight. The zone that matters is the
 * jurisdiction's, and it travels with the row.
 */

/** Rows per side of the calendar page. Enough to be a calendar, not an archive. */
export const CALENDAR_WINDOW = 25;

export interface CalendarJurisdiction {
  id: string;
  name: string;
  state: string;
  timezone: string;
  /** Where a reader subscribes. Absolute path on this API. */
  ics_url: string;
  upcoming: PublicCalendarMeeting[];
  recent: PublicCalendarMeeting[];
}

/** One meeting as the `/calendar` page renders it. */
export interface PublicCalendarMeeting {
  id: string;
  date: string;
  /** `HH:MM` local, or null where the source publishes no time. */
  time: string | null;
  body_name: string;
  location: string | null;
  status: MeetingStatus;
}

interface MeetingRow {
  id: string;
  date: string;
  time: string | null;
  body_name: string;
  jurisdiction_id: string;
  jurisdiction_name: string;
  timezone: string;
  location: string | null;
  status: MeetingStatus;
  updated_at: Date;
}

function baseQuery(db: Knex): Knex.QueryBuilder {
  return whereMeetingPublished(
    db("meetings")
      .join("commissions", "commissions.id", "meetings.commission_id")
      .join("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id")
      .select(
        "meetings.id",
        db.raw("to_char(meetings.date, 'YYYY-MM-DD') AS date"),
        db.raw("to_char(meetings.time, 'HH24:MI') AS time"),
        "commissions.name AS body_name",
        "jurisdictions.id AS jurisdiction_id",
        "jurisdictions.name AS jurisdiction_name",
        "jurisdictions.timezone",
        "meetings.location",
        "meetings.status",
        "meetings.updated_at",
      ),
    "meetings.published_at",
  );
}

/**
 * "Today" in the jurisdiction's own zone, not the server's.
 *
 * A meeting at 9am in Bozeman is still today at 4am UTC tomorrow, and a feed
 * that decided otherwise would drop this morning's meeting off the upcoming
 * list several hours before it happened.
 */
const LOCAL_TODAY = "(now() AT TIME ZONE jurisdictions.timezone)::date";

function toPublic(row: MeetingRow): PublicCalendarMeeting {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    body_name: row.body_name,
    location: row.location,
    status: row.status,
  };
}

/** The whole calendar, grouped by jurisdiction. Jurisdictions with no published meetings are included, because an empty calendar is a fact about the record and hiding it would read as the body not sitting. */
export async function listCalendar(db: Knex): Promise<CalendarJurisdiction[]> {
  const jurisdictions = await db("jurisdictions")
    .orderBy("name", "asc")
    .select<Array<{ id: string; name: string; state: string; timezone: string }>>(
      "id",
      "name",
      "state",
      "timezone",
    );

  const upcoming = (await baseQuery(db)
    .whereRaw(`meetings.date >= ${LOCAL_TODAY}`)
    .orderBy([
      { column: "meetings.date", order: "asc" },
      { column: "meetings.time", order: "asc" },
    ])
    .limit(CALENDAR_WINDOW * Math.max(jurisdictions.length, 1))) as MeetingRow[];

  const recent = (await baseQuery(db)
    .whereRaw(`meetings.date < ${LOCAL_TODAY}`)
    .orderBy([
      { column: "meetings.date", order: "desc" },
      { column: "meetings.time", order: "desc" },
    ])
    .limit(CALENDAR_WINDOW * Math.max(jurisdictions.length, 1))) as MeetingRow[];

  return jurisdictions.map((jurisdiction) => ({
    id: jurisdiction.id,
    name: jurisdiction.name,
    state: jurisdiction.state,
    timezone: jurisdiction.timezone,
    ics_url: `/api/calendar/${jurisdiction.id}.ics`,
    upcoming: upcoming
      .filter((row) => row.jurisdiction_id === jurisdiction.id)
      .slice(0, CALENDAR_WINDOW)
      .map(toPublic),
    recent: recent
      .filter((row) => row.jurisdiction_id === jurisdiction.id)
      .slice(0, CALENDAR_WINDOW)
      .map(toPublic),
  }));
}

export interface FeedContents {
  jurisdiction: { id: string; name: string; state: string; timezone: string };
  meetings: CalendarMeeting[];
}

/**
 * One jurisdiction's feed, or `undefined` when there is no such jurisdiction.
 *
 * The window is deliberately wide in both directions — a subscriber's calendar
 * is also where they look back at what has already sat — and bounded, so a feed
 * cannot grow into a megabyte a client re-downloads every hour.
 */
export async function loadFeed(
  db: Knex,
  jurisdictionId: string,
  options: { pastDays?: number; futureDays?: number } = {},
): Promise<FeedContents | undefined> {
  const pastDays = options.pastDays ?? 180;
  const futureDays = options.futureDays ?? 365;

  const jurisdiction: unknown = await db("jurisdictions")
    .where({ id: jurisdictionId })
    .first("id", "name", "state", "timezone");
  if (typeof jurisdiction !== "object" || jurisdiction === null) return undefined;

  const rows = (await baseQuery(db)
    .whereRaw(`meetings.date >= ${LOCAL_TODAY} - ?::int`, [pastDays])
    .whereRaw(`meetings.date <= ${LOCAL_TODAY} + ?::int`, [futureDays])
    .andWhere("jurisdictions.id", jurisdictionId)
    .orderBy([
      { column: "meetings.date", order: "asc" },
      { column: "meetings.time", order: "asc" },
    ])) as MeetingRow[];

  return {
    jurisdiction: jurisdiction as FeedContents["jurisdiction"],
    meetings: rows.map((row) => ({
      id: row.id,
      date: row.date,
      time: row.time,
      timezone: row.timezone,
      bodyName: row.body_name,
      jurisdictionName: row.jurisdiction_name,
      location: row.location,
      status: row.status,
      updatedAt: row.updated_at,
    })),
  };
}
