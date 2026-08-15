import { Router } from "express";
import type { Knex } from "knex";
import db from "../config/database";
import { whereMeetingPublished } from "../services/publication";

const router = Router();

/**
 * The sitemap, and `robots.txt`'s reason for existing.
 *
 * This is served from the site root, not from `/api`, because that is the only
 * place a crawler looks for it. `frontend/nginx.conf` has an exact-match
 * location that proxies `/sitemap.xml` here.
 *
 * **It goes through the publication wall like every other public surface.** A
 * sitemap is a list of URLs a stranger is invited to fetch, so listing an
 * unpublished meeting would disclose that the record exists and hand over its
 * id — through a document that, like `/api/anomalies` and `/search` and
 * `/corrections`, takes no id and therefore cannot be reached only by guessing
 * one. `sitemap.test.ts` asserts that in both directions, withheld then
 * published, because absence alone would also hold for a query that is simply
 * broken.
 *
 * `lastmod` is `updated_at` from the row, never the build or request time. A
 * build timestamp on every URL is a claim that the whole site changed whenever
 * we deployed, and Google's documented response to a site whose `lastmod` it
 * cannot trust is to stop believing the field everywhere on that host. A
 * wrong freshness signal is worse than none.
 */

/** Public routes with no id in them. Kept in the order a reader meets them. */
const STATIC_PATHS = [
  "/",
  "/meetings",
  "/matters",
  "/officials",
  "/votes",
  "/elections",
  "/findings",
  "/search",
  "/calendar",
  "/data",
  "/corrections",
  "/public-records",
  "/status",
  "/methodology",
  "/privacy",
  "/subscribe",
] as const;

/**
 * `&`, `<` and `>` are the three that break a parser; the quote entities matter
 * only inside attributes, and this document has none. Escaping is applied to
 * every value rather than only to the ones that look risky — a path is
 * built from a database id today and could carry a slug tomorrow.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** W3C datetime. `lastmod` may be a date or a full timestamp; we have timestamps. */
function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface SitemapEntry {
  path: string;
  lastmod: string | null;
}

/**
 * Pure, so the document can be asserted character by character and so the
 * ordering is not at the mercy of whatever the database returns first.
 *
 * Deliberately omits `<changefreq>` and `<priority>`: Google ignores both, and
 * a field nobody reads that we would have to keep true is a maintenance cost
 * with no reader.
 */
export function renderSitemap(baseUrl: string, entries: SitemapEntry[]): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const urls = entries
    .map(({ path, lastmod }) => {
      const loc = `    <loc>${escapeXml(origin + path)}</loc>`;
      const mod = lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "";
      return `  <url>\n${loc}${mod}\n  </url>`;
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls}\n` +
    "</urlset>\n"
  );
}

/**
 * Every URL a crawler is invited to fetch.
 *
 * An official appears only when they have a vote on a **published** meeting.
 * Listing the `members` table wholesale would put the seed fixtures — "Avery
 * Sample", "Riley Fixture" — in a document we hand to search engines, and
 * those names have reached a page before. Presence in the published record is
 * the only evidence that a roster row describes a real officeholder.
 */
export async function collectSitemapEntries(conn: Knex): Promise<SitemapEntry[]> {
  const meetings = await whereMeetingPublished(conn("meetings"), "meetings.published_at")
    .select("meetings.id", "meetings.updated_at")
    .orderBy("meetings.date", "desc");

  const officials = await conn("members")
    .distinct("members.id")
    .select("members.updated_at")
    .join("votes", "votes.member_id", "members.id")
    .whereIn("votes.meeting_id", whereMeetingPublished(conn("meetings"), "meetings.published_at").select("meetings.id"))
    .orderBy("members.updated_at", "desc");

  return [
    ...STATIC_PATHS.map((path) => ({ path, lastmod: null })),
    ...meetings.map((row: { id: string; updated_at: Date | null }) => ({
      path: `/meetings/${row.id}`,
      lastmod: isoDate(row.updated_at),
    })),
    ...officials.map((row: { id: string; updated_at: Date | null }) => ({
      path: `/officials/${row.id}`,
      lastmod: isoDate(row.updated_at),
    })),
  ];
}

/**
 * `PUBLIC_BASE_URL` has no fallback to a localhost default on purpose. A
 * sitemap full of `http://localhost:3000` URLs is not a degraded sitemap, it is
 * a wrong one, and it would be served with a 200 to whoever asked. Absent
 * configuration the route answers 503 and says which variable is missing.
 */
router.get("/", async (_req, res, next) => {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      res.status(503).type("text/plain").send(
        "Sitemap unavailable: PUBLIC_BASE_URL is not configured.\n",
      );
      return;
    }

    const entries = await collectSitemapEntries(db);
    res
      .type("application/xml")
      .set("Cache-Control", "public, max-age=3600")
      .send(renderSitemap(baseUrl, entries));
  } catch (err) {
    next(err);
  }
});

export default router;
