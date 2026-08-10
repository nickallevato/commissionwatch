import { Router } from "express";
import db from "../config/database";
import { listCalendar, loadFeed } from "../services/calendar/meetings";
import { buildCalendar } from "../services/calendar/ical";

/**
 * `/api/calendar` — when these bodies sit, in JSON and as a subscribable feed.
 *
 *   GET /api/calendar                 upcoming and recent, grouped by jurisdiction
 *   GET /api/calendar/:id.ics         one jurisdiction's iCal feed
 *
 * Public and unauthenticated like the rest of the read API, and restricted to
 * published meetings inside `services/calendar/meetings.ts`.
 *
 * The `.ics` extension is parsed from the parameter rather than written into
 * the route pattern, for the reason `routes/data.ts` gives: a dot in a path
 * pattern is a thing whose meaning changes under a router major, and this URL
 * is one somebody's calendar client will hold for years.
 */
const router = Router();

/** The public site, for per-event URLs and the UID domain. */
const SITE_URL = process.env.PUBLIC_SITE_URL ?? "https://commissionwatch.bmux.sh";
const DOMAIN = new URL(SITE_URL).host;

/**
 * An hour. A calendar client refetches a subscription on its own schedule and
 * the record moves at sweep cadence, so anything shorter is load without news.
 */
const FEED_CACHE_CONTROL = "public, max-age=3600";

router.get("/", async (_req, res, next) => {
  try {
    const jurisdictions = await listCalendar(db);
    res.set("Cache-Control", "public, max-age=300");
    res.json({ data: jurisdictions, total: jurisdictions.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:file", async (req, res, next) => {
  const file = req.params.file;
  if (!file.endsWith(".ics")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const jurisdictionId = file.slice(0, -".ics".length);

  try {
    const feed = await loadFeed(db, jurisdictionId);
    // A malformed uuid reaches the driver as a cast error, not as a miss, so
    // the catch below turns both into the same 404 rather than a 500.
    if (feed === undefined) {
      res.status(404).json({ error: "No such jurisdiction" });
      return;
    }

    const body = buildCalendar(feed.meetings, {
      name: `${feed.jurisdiction.name}, ${feed.jurisdiction.state} — CommissionWatch`,
      siteUrl: SITE_URL,
      domain: DOMAIN,
    });

    res.set("Cache-Control", FEED_CACHE_CONTROL);
    res.set("Content-Disposition", `inline; filename="commissionwatch-${jurisdictionId}.ics"`);
    res.type("text/calendar; charset=utf-8");
    res.send(body);
  } catch (err) {
    if (err instanceof Error && /invalid input syntax for type uuid/i.test(err.message)) {
      res.status(404).json({ error: "No such jurisdiction" });
      return;
    }
    next(err);
  }
});

export default router;
