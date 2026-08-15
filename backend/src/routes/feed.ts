import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import db from "../config/database";
import {
  renderAtom,
  renderRss,
  type FeedDocument,
  type FeedEntry,
} from "../services/feeds/atom";
import { collectEventEntries } from "../services/feeds/entries";
import { DEFAULT_RADIUS_METRES } from "../services/places";
import {
  collectNearEntries,
  collectQueryEntries,
  parseFeedQuery,
  requireJurisdictionName,
  FeedQueryError,
  MAX_FEED_ENTRIES,
  type ParsedFeedQuery,
} from "../services/feeds/query";

/**
 * `GET /feed.xml` (Atom 1.0) and `GET /feed.rss` (RSS 2.0).
 *
 * Served from the site root, like the sitemap and for the same reason: a feed
 * reader handed `commissionwatch.bmux.sh` looks for `/feed.xml`, and a
 * discovery link that points under `/api` is a link most clients will not
 * follow. **`frontend/nginx.conf` needs an exact-match `location = /feed.xml`
 * and `location = /feed.rss` proxying here**, ahead of the
 * `location ~* \.(txt|xml|json|csv|ics|map|webmanifest)$` block — an exact
 * match beats a regex in nginx's precedence order, and without it that block
 * captures both paths and tries to serve them off the SPA's disk. That is the
 * same trap the sitemap hit, and `nginx -t` does not catch it because the
 * config parses perfectly either way.
 *
 * With no query string this is the announcement feed: one entry per public
 * event. With `?q=` it is a query feed, and **the query is the subscription** —
 * see `services/feeds/query.ts`, including the rule that nothing here logs it.
 * With `?near=lat,lon&radius=m` it is the near feed: the same subscription
 * property applied to geography, so an address never leaves the reader's own
 * client. `q` and `near` are refused together by the parser rather than
 * intersected — the two feeds read different corpora and `query.ts` says why.
 *
 * `PUBLIC_BASE_URL` has no localhost fallback, exactly as in `routes/sitemap.ts`.
 * A feed full of `http://localhost:3000` links is not a degraded feed, it is a
 * wrong one, and a reader's client would cache those links for as long as it
 * kept the entries.
 */

const router = Router();

/**
 * Feed readers poll hard — many on a fixed five-minute timer regardless of what
 * the last response said. Five minutes of cache with a validator turns most of
 * that into a 304 with no body and no database work.
 */
const CACHE_SECONDS = 300;

type FeedFormat = "atom" | "rss";

function baseUrlOr503(res: Response): string | null {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    res
      .status(503)
      .type("text/plain")
      .send("Feed unavailable: PUBLIC_BASE_URL is not configured.\n");
    return null;
  }
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The title and subtitle a reader sees in their sidebar.
 *
 * The query is echoed so somebody with six saved feeds can tell them apart —
 * and it is attacker-controlled text on its way into XML, so it goes through
 * `xmlText` in the renderer like everything else. Echoing it into the document
 * is not the same as recording it; nothing on this path writes it down.
 */
function describe(parsed: ParsedFeedQuery): { title: string; subtitle: string } {
  const filters: string[] = [];
  if (parsed.q !== null) filters.push(`matching “${parsed.q}”`);
  if (parsed.near !== null) {
    // The coordinate is echoed for the same reason the query is: somebody with
    // a feed for home and one for their kid's school has to tell them apart in
    // a sidebar. It is in their own URL and nothing here writes it down.
    filters.push(
      `within ${parsed.radius ?? DEFAULT_RADIUS_METRES} metres of ${parsed.near.lat}, ${parsed.near.lon}`,
    );
  }
  if (parsed.jurisdiction_id !== null) filters.push("in one jurisdiction");
  if (parsed.event_type !== null) filters.push(`of type ${parsed.event_type}`);
  if (parsed.search_kind !== null) filters.push(`of type ${parsed.search_kind}`);
  if (parsed.min_severity !== null) filters.push(`at severity ${parsed.min_severity} or above`);

  if (filters.length === 0) {
    return {
      title: "CommissionWatch — the published record",
      subtitle: "Every meeting, finding, claim and document as it is published.",
    };
  }

  return {
    title: `CommissionWatch — ${filters.join(", ")}`,
    subtitle: `The published record, ${filters.join(", ")}. This URL is the subscription.`,
  };
}

/**
 * A validator over what the document actually says.
 *
 * Derived from the rendered body rather than from the newest `occurred_at`
 * alone, because two different queries can share a newest event and must not
 * share an ETag — a reader subscribed to both would be served the wrong one out
 * of a shared cache. Weak, because the body is semantically but not
 * byte-for-byte stable across formats.
 */
function etagOf(body: string): string {
  return `W/"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

function newest(entries: FeedEntry[]): Date {
  let latest = 0;
  for (const entry of entries) {
    const time = entry.updated.getTime();
    if (time > latest) latest = time;
  }
  // No entries means no `Last-Modified` we could honestly claim, so the epoch:
  // a stated "nothing yet", not the request time dressed up as a change.
  return new Date(latest);
}

async function serve(req: Request, res: Response, format: FeedFormat): Promise<void> {
  const baseUrl = baseUrlOr503(res);
  if (baseUrl === null) return;

  let parsed: ParsedFeedQuery;
  try {
    parsed = parseFeedQuery(req.query);
  } catch (err) {
    if (err instanceof FeedQueryError) {
      res.status(400).type("text/plain").send(`${err.message}\n`);
      return;
    }
    throw err;
  }

  const renderedAt = new Date();
  let entries: FeedEntry[];
  try {
    // Resolved for both feeds, before either runs. An unknown jurisdiction is
    // only discoverable against the database, so it cannot be caught in the
    // parser — but it must not fall through to a valid, empty document either.
    const jurisdictionName =
      parsed.jurisdiction_id === null
        ? null
        : await requireJurisdictionName(db, parsed.jurisdiction_id);

    // Three feeds, one route. `near` is checked first because the parser has
    // already refused it alongside `q`, so the branches cannot overlap.
    if (parsed.near !== null) {
      entries = await collectNearEntries(db, baseUrl, {
        lat: parsed.near.lat,
        lon: parsed.near.lon,
        metres: parsed.radius ?? DEFAULT_RADIUS_METRES,
        jurisdiction_id: parsed.jurisdiction_id,
        limit: MAX_FEED_ENTRIES,
      });
    } else if (parsed.q === null) {
      entries = await collectEventEntries(db, baseUrl, {
        jurisdiction_id: parsed.jurisdiction_id,
        event_type: parsed.event_type,
        min_severity: parsed.min_severity,
        limit: MAX_FEED_ENTRIES,
      });
    } else {
      entries = await collectQueryEntries(db, baseUrl, {
        q: parsed.q,
        jurisdiction_name: jurisdictionName,
        search_kind: parsed.search_kind,
        min_severity: parsed.min_severity,
        limit: MAX_FEED_ENTRIES,
        renderedAt,
      });
    }
  } catch (err) {
    // Still a 400 rather than a 500: the reader asked for something that does
    // not exist, which is their request being wrong, not this route.
    if (err instanceof FeedQueryError) {
      res.status(400).type("text/plain").send(`${err.message}\n`);
      return;
    }
    throw err;
  }

  const { title, subtitle } = describe(parsed);
  const updated = newest(entries);
  const doc: FeedDocument = {
    selfUrl: `${baseUrl}${req.originalUrl}`,
    homeUrl: baseUrl,
    title,
    subtitle,
    updated,
    entries,
  };

  const body = format === "atom" ? renderAtom(doc) : renderRss(doc);
  const etag = etagOf(body);

  res
    .type(format === "atom" ? "application/atom+xml" : "application/rss+xml")
    .set("Cache-Control", `public, max-age=${CACHE_SECONDS}`)
    .set("ETag", etag)
    .set("Last-Modified", updated.toUTCString());

  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  res.send(body);
}

router.get("/feed.xml", (req, res, next) => {
  serve(req, res, "atom").catch(next);
});

router.get("/feed.rss", (req, res, next) => {
  serve(req, res, "rss").catch(next);
});

export default router;
