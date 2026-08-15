import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSitemap, collectSitemapEntries } from "../src/routes/sitemap";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * The sitemap is the fourth public surface that takes no id.
 *
 * `/api/anomalies`, `/search` and `/corrections` all had to be walled
 * separately, each for the same reason: every other public path takes a meeting
 * id, so a reader who cannot guess one cannot reach a withheld record. A
 * document that *lists* URLs hands the ids out. So this is tested in both
 * directions — withheld then published — because absence alone would also hold
 * for a query that is simply broken.
 */

const PREFIX = "sitemap-test";
const BASE = "https://commissionwatch.example";

describe("the sitemap", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let unpublishedId: string;
  let publishedId: string;

  before(async () => {
    await cleanupByPrefix(PREFIX);
    fixture = await createSource(PREFIX, { enabled: false });
    unpublishedId = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-04",
    });
    publishedId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-05",
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
  });

  it("lists a published meeting and omits an unpublished one", async () => {
    const entries = await collectSitemapEntries(db);
    const paths = entries.map((e) => e.path);

    assert.ok(
      paths.includes(`/meetings/${publishedId}`),
      "a published meeting is missing from the sitemap",
    );
    assert.ok(
      !paths.includes(`/meetings/${unpublishedId}`),
      "an unpublished meeting leaked into the sitemap",
    );
  });

  it("adds the meeting the moment it is published, so the absence above means something", async () => {
    await db("meetings").where({ id: unpublishedId }).update({ published_at: new Date() });

    const entries = await collectSitemapEntries(db);
    assert.ok(
      entries.map((e) => e.path).includes(`/meetings/${unpublishedId}`),
      "publishing a meeting did not add it to the sitemap — the omission above proves nothing",
    );

    await db("meetings").where({ id: unpublishedId }).update({ published_at: null });
  });

  it("never contains a meeting id that is not published, however many exist", async () => {
    const withheld = await db("meetings")
      .whereNull("published_at")
      .pluck<string[]>("id");
    const body = renderSitemap(BASE, await collectSitemapEntries(db));

    for (const id of withheld) {
      assert.ok(!body.includes(id), `withheld meeting ${id} appears in the sitemap document`);
    }
  });

  it("carries the static public pages and no admin path", async () => {
    const body = renderSitemap(BASE, await collectSitemapEntries(db));

    assert.match(body, /<loc>https:\/\/commissionwatch\.example\/methodology<\/loc>/);
    assert.match(body, /<loc>https:\/\/commissionwatch\.example\/corrections<\/loc>/);
    assert.ok(!body.includes("/admin"), "an operator path appears in the public sitemap");
  });

  it("renders a well-formed document with lastmod only where we have one", () => {
    const body = renderSitemap(`${BASE}/`, [
      { path: "/", lastmod: null },
      { path: "/meetings/abc", lastmod: "2026-08-14T00:00:00.000Z" },
    ]);

    assert.equal(
      body,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "  <url>\n    <loc>https://commissionwatch.example/</loc>\n  </url>\n" +
        "  <url>\n    <loc>https://commissionwatch.example/meetings/abc</loc>\n" +
        "    <lastmod>2026-08-14T00:00:00.000Z</lastmod>\n  </url>\n" +
        "</urlset>\n",
    );
  });

  it("escapes XML rather than emitting a document a parser rejects", () => {
    const body = renderSitemap(BASE, [{ path: "/search?q=a&b<c", lastmod: null }]);
    assert.ok(body.includes("&amp;"), "an ampersand went out raw");
    assert.ok(!body.includes("&b<c"), "a raw < survived into the document");
  });

  it("refuses to serve invented URLs when PUBLIC_BASE_URL is unset", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const res = await request(app).get("/sitemap.xml").expect(503);
      assert.match(res.text, /PUBLIC_BASE_URL/);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });

  it("serves XML over HTTP when it is configured", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = BASE;
    try {
      const res = await request(app).get("/sitemap.xml").expect(200);
      assert.match(res.headers["content-type"], /xml/);
      assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      assert.ok(res.text.includes(`${BASE}/meetings/${publishedId}`));
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });
});

/**
 * Matters reached the sitemap after they got pages of their own. The wall is a
 * different rule for a matter than for a meeting — public when *any* appearance
 * is on a published meeting — so it gets its own both-directions test rather
 * than riding on the meeting one.
 */
describe("sitemap · matters", () => {
  it("lists a matter once one of its appearances is published, and not before", async () => {
    const [j] = await db("jurisdictions")
      .insert({ name: "Sitemap Matters County", state: "MT", type: "county" })
      .returning("id");
    const jurisdictionId = typeof j === "string" ? j : j.id;
    try {
      const [c] = await db("commissions")
        .insert({ jurisdiction_id: jurisdictionId, name: "Sitemap Matters Board" })
        .returning("id");
      const commissionId = typeof c === "string" ? c : c.id;

      const [m] = await db("meetings")
        .insert({ commission_id: commissionId, date: "2026-04-07" })
        .returning("id");
      const meetingId = typeof m === "string" ? m : m.id;

      const [item] = await db("agenda_items")
        .insert({ meeting_id: meetingId, item_number: 1, title: "Ordinance 4242 sitemap probe" })
        .returning("id");
      const itemId = typeof item === "string" ? item : item.id;

      const [mt] = await db("matters")
        .insert({
          commission_id: commissionId,
          identity_key: "ordinance 4242",
          designator: "Ordinance 4242",
          title: "Ordinance 4242 sitemap probe",
        })
        .returning("id");
      const matterId = typeof mt === "string" ? mt : mt.id;
      await db("matter_appearances").insert({
        matter_id: matterId,
        agenda_item_id: itemId,
        match_rule: "designator",
      });

      const withheld = await collectSitemapEntries(db);
      assert.ok(
        !withheld.some((entry) => entry.path === `/matters/${matterId}`),
        "a matter with no published appearance must not be listed",
      );

      // The second half. Absence alone would also hold for a query that is
      // simply broken.
      await db("meetings")
        .where({ id: meetingId })
        .update({ published_at: new Date("2026-04-10T00:00:00Z") });

      const published = await collectSitemapEntries(db);
      assert.ok(
        published.some((entry) => entry.path === `/matters/${matterId}`),
        "publishing the meeting must put its matter in the sitemap",
      );
    } finally {
      await db("jurisdictions").where({ id: jurisdictionId }).del();
    }
  });
});

/**
 * File scope, not inside a describe.
 *
 * node:test runs a describe's `after` the moment that block's tests finish, so
 * `db.destroy()` in the first describe kills the pool for every suite declared
 * below it — the second one here failed with "Unable to acquire a connection"
 * before it ran a single query. This project has been bitten by that before;
 * pool teardown belongs where the file ends, not where the first block does.
 */
after(async () => {
  await db.destroy();
});

/**
 * The sitemap against the router that actually exists.
 *
 * `STATIC_PATHS` is a hand-kept list beside a growing `App.tsx`, which drifts by
 * default rather than by accident. When this was written it had drifted by
 * three: `/map`, `/data-license` and `/corrections/dispute` had all shipped,
 * were all linked from other pages, and were offered to no crawler. The last is
 * the route by which somebody named in a record contests it.
 *
 * The test reads the router rather than a copy of it. A route is either in the
 * sitemap or in `NOT_IN_SITEMAP` with a reason somebody wrote down.
 */
describe("the sitemap keeps up with the router", () => {
  /** Public, no-id routes deliberately absent, and why. */
  const NOT_IN_SITEMAP: Readonly<Record<string, string>> = {
    "/anomalies": "a permanent redirect to /findings; a sitemap lists destinations",
    "/members": "a permanent redirect to /officials",
  };

  it("offers every public page, or says why not", async () => {
    const app = readFileSync(join(__dirname, "..", "..", "frontend", "src", "App.tsx"), "utf8");

    const routes = [...app.matchAll(/<Route\s+path="([^"]*)"/g)]
      .map((match) => match[1])
      .filter((path) => path !== "*")
      // Ids are covered by the database-driven half of the sitemap, not here.
      .filter((path) => !path.includes(":"))
      // The console is not for readers and must never be advertised.
      .filter((path) => !path.startsWith("admin"))
      .map((path) => `/${path}`);

    assert.ok(routes.length > 10, `expected the route table, parsed ${routes.length}`);

    // The real output, not the constant behind it: `collectSitemapEntries` is
    // what a crawler reads, and a static path that never reached it would pass
    // an assertion made against the array it was declared in.
    const offered = new Set((await collectSitemapEntries(db)).map((entry) => entry.path));
    const missing = routes.filter((path) => !offered.has(path) && !NOT_IN_SITEMAP[path]);

    assert.deepEqual(
      missing,
      [],
      `these public pages are offered to no crawler and no reason is recorded: ${missing.join(", ")}`,
    );
  });

  it("advertises no admin path, whatever the router grows", async () => {
    const offered = (await collectSitemapEntries(db)).map((entry) => entry.path);
    const admin = offered.filter((path) => path.startsWith("/admin"));
    assert.deepEqual(admin, [], `the sitemap names admin routes: ${admin.join(", ")}`);
  });
});
