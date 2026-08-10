import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  buildCalendar,
  buildEvent,
  escapeText,
  eventUid,
  foldLine,
  wallTimeToUtc,
  type CalendarMeeting,
} from "../src/services/calendar/ical";
import type { CalendarJurisdiction } from "../src/services/calendar/meetings";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * The public calendar and the per-jurisdiction iCal feeds.
 *
 * Two properties, and the second is the one that reaches into somebody's real
 * life:
 *
 * 1. **Published meetings only.** A subscribed calendar keeps fetching long
 *    after anyone last looked at the site, so an unpublished meeting leaking
 *    into a feed is a withheld record sitting in a stranger's phone until they
 *    delete the subscription. Asserted in both directions.
 *
 * 2. **The timezone trap.** `meetings` has a `DATE` and a **nullable** `TIME`,
 *    naive, with the zone on `jurisdictions.timezone`. Two ways to get this
 *    wrong and both put a meeting on the wrong hour: composing the instant in
 *    the server's zone, and treating a null time as midnight. Both are pinned
 *    here with arithmetic a reader can check by hand, on either side of a
 *    daylight-saving transition, because the failure is invisible to anyone
 *    running in `America/Denver` themselves.
 */

const PREFIX = "calendar-test";
const DOMAIN = "commissionwatch.bmux.sh";

/**
 * The fixture jurisdiction sits in Honolulu, which is a deliberate choice.
 *
 * The feed is windowed to a year either side of today, so the fixture dates
 * have to be relative or the suite quietly stops testing anything the moment it
 * drifts out of the window. Relative dates mean the expected UTC instant cannot
 * be written as a literal — unless the zone has no daylight saving at all.
 * `Pacific/Honolulu` is UTC-10 on every day there has ever been, so 19:00 local
 * is 05:00 UTC the next morning whatever the date, and a route composing the
 * instant in the server's zone or in the project's default `America/Denver`
 * fails loudly. The transition arithmetic itself is pinned in the suite above.
 */
const FIXTURE_ZONE = "Pacific/Honolulu";

/** An ISO date `days` from now, so the fixtures never leave the feed window. */
function isoPlusDays(days: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

const TIMED_DATE = isoPlusDays(30);
const UNTIMED_DATE = isoPlusDays(31);
const WITHHELD_DATE = isoPlusDays(32);

/** `YYYYMMDD`, for reading an ICS DATE value back. */
function compact(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

const FEED_OPTIONS = {
  name: "Test feed",
  siteUrl: "https://commissionwatch.bmux.sh",
  domain: DOMAIN,
  now: new Date("2026-08-01T12:00:00Z"),
};

function meetingFixture(overrides: Partial<CalendarMeeting> = {}): CalendarMeeting {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    date: "2026-08-04",
    time: "19:00",
    timezone: "America/Denver",
    bodyName: "Gallatin County Commission",
    jurisdictionName: "Gallatin County",
    location: "Community Room, 311 W Main St",
    status: "scheduled",
    updatedAt: new Date("2026-07-30T10:00:00Z"),
    ...overrides,
  };
}

/* ===========================================================================
   The format, with no database in the way
   =========================================================================== */

describe("iCalendar emission", () => {
  it("converts a wall time in a named zone to the right instant, in summer", () => {
    // 4 August 2026 is MDT, UTC-6. 19:00 local is 01:00 the next day in UTC.
    const instant = wallTimeToUtc("2026-08-04", "19:00", "America/Denver");
    assert.ok(instant !== null);
    assert.equal(instant.toISOString(), "2026-08-05T01:00:00.000Z");
  });

  it("converts a wall time in a named zone to the right instant, in winter", () => {
    // 14 January is MST, UTC-7. The same wall time is an hour later in UTC, and
    // a conversion that used one fixed offset all year would be wrong for half
    // of every calendar it is subscribed into.
    const instant = wallTimeToUtc("2026-01-14", "19:00", "America/Denver");
    assert.ok(instant !== null);
    assert.equal(instant.toISOString(), "2026-01-15T02:00:00.000Z");
  });

  it("does not silently fall back to UTC for a zone it does not know", () => {
    assert.equal(wallTimeToUtc("2026-08-04", "19:00", "Mars/Olympus"), null);
  });

  it("emits a meeting with no published time as an all-day event, never as midnight", () => {
    const lines = buildEvent(meetingFixture({ time: null }), FEED_OPTIONS);
    assert.ok(lines !== null);
    const body = lines.join("\n");

    assert.ok(body.includes("DTSTART;VALUE=DATE:20260804"));
    // DTEND on an all-day event is exclusive: the day after.
    assert.ok(body.includes("DTEND;VALUE=DATE:20260805"));
    assert.ok(
      !/DTSTART:\d{8}T000000Z/.test(body),
      "a meeting with no published time was emitted at midnight",
    );
    assert.match(body, /DESCRIPTION:.*no start time/);
  });

  it("emits a meeting with a published time as a UTC instant and no invented end", () => {
    const lines = buildEvent(meetingFixture(), FEED_OPTIONS);
    assert.ok(lines !== null);
    const body = lines.join("\n");

    assert.ok(body.includes("DTSTART:20260805T010000Z"));
    // No DTEND and no DURATION. `meetings` has no adjournment column, so any
    // end time would be this project's assumption published as the county's
    // record — the same defect as the meeting page's old "Adjourned: Not
    // recorded" row, in a file people subscribe to.
    assert.ok(!body.includes("DTEND"));
    assert.ok(!body.includes("DURATION"));
  });

  it("omits an event it cannot place in time rather than guessing", () => {
    assert.equal(buildEvent(meetingFixture({ timezone: "Mars/Olympus" }), FEED_OPTIONS), null);
  });

  it("names the body in SUMMARY and keys the UID on the meeting alone", () => {
    const lines = buildEvent(meetingFixture(), FEED_OPTIONS);
    assert.ok(lines !== null);
    assert.ok(lines.includes("SUMMARY:Gallatin County Commission"));
    assert.ok(
      lines.includes(`UID:meeting-11111111-2222-3333-4444-555555555555@${DOMAIN}`),
      "the UID is not the meeting id",
    );
    // Stable across a reschedule: the same meeting moved to another date must
    // update the subscriber's entry, not appear beside the stale one.
    assert.equal(
      eventUid("11111111-2222-3333-4444-555555555555", DOMAIN),
      lines.filter((line) => line.startsWith("UID:"))[0].slice("UID:".length),
    );
  });

  it("marks a cancelled meeting in both the status and the words", () => {
    const lines = buildEvent(meetingFixture({ status: "cancelled" }), FEED_OPTIONS);
    assert.ok(lines !== null);
    assert.ok(lines.includes("STATUS:CANCELLED"));
    assert.ok(lines.includes("SUMMARY:Cancelled: Gallatin County Commission"));
  });

  it("escapes the characters RFC 5545 reserves", () => {
    assert.equal(escapeText("a,b;c\\d"), "a\\,b\\;c\\\\d");
    assert.equal(escapeText("line\nbreak"), "line\\nbreak");
    // The location is where a comma actually turns up in practice.
    const lines = buildEvent(meetingFixture(), FEED_OPTIONS);
    assert.ok(lines !== null);
    assert.ok(lines.includes("LOCATION:Community Room\\, 311 W Main St"));
  });

  it("folds a long line at 75 octets, counting bytes and not characters", () => {
    const long = `SUMMARY:${"a".repeat(200)}`;
    for (const segment of foldLine(long).split("\r\n")) {
      assert.ok(
        Buffer.byteLength(segment, "utf8") <= 75,
        `a folded segment is ${Buffer.byteLength(segment, "utf8")} octets`,
      );
    }
    // A multi-byte character must not be split across the fold, or the file is
    // no longer valid UTF-8 once it is unfolded.
    const wide = `SUMMARY:${"é".repeat(80)}`;
    const rejoined = foldLine(wide)
      .split("\r\n ")
      .join("");
    assert.equal(rejoined, wide);
  });

  it("wraps events in a VCALENDAR with CRLF line endings", () => {
    const body = buildCalendar([meetingFixture()], FEED_OPTIONS);
    assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(body.includes("VERSION:2.0\r\n"));
    assert.ok(body.trimEnd().endsWith("END:VCALENDAR"));
    assert.ok(body.includes("BEGIN:VEVENT\r\n"));
    assert.ok(body.includes("END:VEVENT\r\n"));
    // A bare LF anywhere would be a malformed content line.
    assert.equal(body.split("\n").length, body.split("\r\n").length);
  });
});

/* ===========================================================================
   The routes, and the wall
   =========================================================================== */

describe("the public meeting calendar", () => {
  let jurisdictionId = "";
  let publishedMeeting = "";
  let withheldMeeting = "";
  let untimedMeeting = "";

  before(async () => {
    await cleanupByPrefix(PREFIX);
    const fixture = await createSource(PREFIX);
    jurisdictionId = fixture.jurisdictionId;
    await db("jurisdictions").where({ id: jurisdictionId }).update({ timezone: FIXTURE_ZONE });

    publishedMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: TIMED_DATE,
      location: "Published Chamber",
    });
    await db("meetings").where({ id: publishedMeeting }).update({ time: "19:00:00" });

    withheldMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: WITHHELD_DATE,
      location: "Withheld Chamber",
    });
    await db("meetings").where({ id: withheldMeeting }).update({ time: "19:00:00" });

    untimedMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: UNTIMED_DATE,
      location: "Published Chamber",
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  async function feed(): Promise<string> {
    const res = await request(app).get(`/api/calendar/${jurisdictionId}.ics`).expect(200);
    return res.text;
  }

  it("serves an iCal feed as text/calendar", async () => {
    const res = await request(app).get(`/api/calendar/${jurisdictionId}.ics`).expect(200);
    assert.match(res.headers["content-type"], /text\/calendar/);
    assert.ok(res.text.startsWith("BEGIN:VCALENDAR"));
  });

  it("never puts an unpublished meeting in the feed", async () => {
    const body = await feed();
    assert.ok(body.includes(publishedMeeting), "the published meeting is missing from the feed");
    assert.ok(!body.includes(withheldMeeting), "a withheld meeting reached a subscribable feed");
    assert.ok(!body.includes("Withheld Chamber"));
  });

  it("publishing the meeting puts it in the feed", async () => {
    await db("meetings").where({ id: withheldMeeting }).update({ published_at: new Date() });
    try {
      const body = await feed();
      assert.ok(
        body.includes(withheldMeeting),
        "publishing changed nothing, so the filter is not the wall",
      );
    } finally {
      await db("meetings").where({ id: withheldMeeting }).update({ published_at: null });
    }
  });

  it("emits the meeting with no published time as an all-day event", async () => {
    const body = await feed();
    const event = body
      .split("BEGIN:VEVENT")
      .find((block) => block.includes(untimedMeeting));
    assert.ok(event, "the untimed meeting is not in the feed");
    assert.ok(event.includes(`DTSTART;VALUE=DATE:${compact(UNTIMED_DATE)}`));
    assert.ok(event.includes(`DTEND;VALUE=DATE:${compact(isoPlusDays(32))}`));
    assert.ok(!/DTSTART:\d{8}T000000Z/.test(event));
  });

  it("converts the published time through the jurisdiction's zone", async () => {
    const body = await feed();
    const event = body
      .split("BEGIN:VEVENT")
      .find((block) => block.includes(publishedMeeting));
    assert.ok(event);
    // 19:00 in Honolulu is 05:00 UTC the next morning, on every day there has
    // ever been. A route composing the instant in the server's zone, or in the
    // project's default `America/Denver`, lands somewhere else.
    assert.ok(
      event.includes(`DTSTART:${compact(isoPlusDays(31))}T050000Z`),
      "the wall time was not converted through the jurisdiction's zone",
    );
  });

  it("answers 404 for a jurisdiction that does not exist, and for a bad id", async () => {
    await request(app).get("/api/calendar/11111111-2222-3333-4444-555555555555.ics").expect(404);
    // A malformed uuid reaches the driver as a cast error; it must read as a
    // miss and not as a server fault.
    await request(app).get("/api/calendar/not-a-uuid.ics").expect(404);
  });

  it("lists upcoming and recent meetings per jurisdiction, published only", async () => {
    const res = await request(app).get("/api/calendar").expect(200);
    const body = res.body as { data: CalendarJurisdiction[] };
    const jurisdiction = body.data.find((entry) => entry.id === jurisdictionId);
    assert.ok(jurisdiction, "the fixture jurisdiction is not on the calendar");

    const upcomingIds = jurisdiction.upcoming.map((meeting) => meeting.id);
    assert.ok(upcomingIds.includes(publishedMeeting));
    assert.ok(upcomingIds.includes(untimedMeeting));
    assert.ok(!upcomingIds.includes(withheldMeeting), "a withheld meeting is on the calendar");
    assert.ok(!jurisdiction.recent.map((meeting) => meeting.id).includes(withheldMeeting));

    // The null time is carried as null, not as "00:00" — the page has to be
    // able to say the record states no time.
    const untimed = jurisdiction.upcoming.find((meeting) => meeting.id === untimedMeeting);
    assert.ok(untimed);
    assert.equal(untimed.time, null);
    assert.equal(untimed.date, UNTIMED_DATE);
    assert.equal(jurisdiction.ics_url, `/api/calendar/${jurisdictionId}.ics`);
  });
});
