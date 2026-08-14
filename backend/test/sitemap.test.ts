import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
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
    await db.destroy();
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
