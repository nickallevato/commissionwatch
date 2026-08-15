import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { readSourceWindow, WINDOW_CHARS } from "../src/services/source-viewer";

/**
 * `/api/source/:sha256` — the address every citation points at.
 *
 * The wall here is the one that matters most on the whole site: this endpoint
 * returns the *text of a document*, so a hole in it does not leak a title or an
 * id, it leaks the record itself.
 */

const JURISDICTION_NAME = "Source Viewer Test County";
const PUBLISHED_SHA = createHash("sha256").update("source-viewer-published").digest("hex");
const WITHHELD_SHA = createHash("sha256").update("source-viewer-withheld").digest("hex");
const ORPHAN_SHA = createHash("sha256").update("source-viewer-orphan").digest("hex");

const SECRET = "WITHHELD MINUTES: the commission met in closed session.";
const PUBLIC_TEXT = `Preamble. ${"filler ".repeat(400)}Commissioner Sample voted no on Ordinance 2145. ${"tail ".repeat(400)}`;
const QUOTE_OFFSET = PUBLIC_TEXT.indexOf("Commissioner Sample");

let jurisdictionId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) await db("jurisdictions").where({ id: row.id }).del();
  await db("artifacts").whereIn("sha256", [PUBLISHED_SHA, WITHHELD_SHA, ORPHAN_SHA]).del();
}

async function makeArtifact(sha: string, text: string): Promise<string> {
  const [row] = await db("artifacts")
    .insert({
      sha256: sha,
      storage_key: `artifacts/${sha.slice(0, 2)}/${sha}`,
      content_type: "application/pdf",
      byte_size: text.length,
      source_url: `https://example.invalid/${sha.slice(0, 8)}.pdf`,
    })
    .returning("id");
  const id = typeof row === "string" ? row : row.id;
  await db("artifact_texts").insert({ artifact_id: id, text, char_count: text.length });
  return id;
}

async function attach(artifactId: string, meetingId: string, title: string): Promise<void> {
  const [doc] = await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title,
      document_type: "minutes",
      url: `https://example.invalid/${title}.pdf`,
    })
    .returning("id");
  const docId = typeof doc === "string" ? doc : doc.id;
  await db("document_versions").insert({
    meeting_document_id: docId,
    artifact_id: artifactId,
    version_no: 1,
    first_seen_at: new Date(),
  });
}

before(async () => {
  await removeFixtures();
  const [j] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  jurisdictionId = typeof j === "string" ? j : j.id;
  const [c] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "Source Viewer Board" })
    .returning("id");
  const commissionId = typeof c === "string" ? c : c.id;

  const [pub] = await db("meetings")
    .insert({
      commission_id: commissionId,
      date: "2026-03-12",
      published_at: new Date("2026-03-14T00:00:00Z"),
    })
    .returning("id");
  const [hid] = await db("meetings")
    .insert({ commission_id: commissionId, date: "2026-04-02" })
    .returning("id");

  await attach(await makeArtifact(PUBLISHED_SHA, PUBLIC_TEXT), typeof pub === "string" ? pub : pub.id, "March Minutes");
  await attach(await makeArtifact(WITHHELD_SHA, SECRET), typeof hid === "string" ? hid : hid.id, "April Minutes");
  // Stored, never attached to a meeting — a campaign filing, an orphan.
  await makeArtifact(ORPHAN_SHA, "Unattached filing text.");
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

describe("GET /api/source/:sha256", () => {
  it("serves a document on a published meeting", async () => {
    const res = await request(app).get(`/api/source/${PUBLISHED_SHA}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sha256, PUBLISHED_SHA);
    assert.ok(res.body.source_label.includes("March Minutes"));
  });

  it("404s a document whose meeting is not published, and leaks none of its text", async () => {
    const res = await request(app).get(`/api/source/${WITHHELD_SHA}`);
    assert.equal(res.status, 404);
    assert.ok(!JSON.stringify(res.body).includes("closed session"), "leaked withheld document text");
  });

  /**
   * The second half. Absence alone would also hold for a query that is simply
   * broken, which is the failure mode this project has been bitten by before.
   */
  it("serves that same document once its meeting is published", async () => {
    const meetings = await db("meetings")
      .join("commissions as c", "c.id", "meetings.commission_id")
      .where("c.jurisdiction_id", jurisdictionId)
      .whereNull("meetings.published_at")
      .select("meetings.id");
    await db("meetings")
      .whereIn("id", meetings.map((m: { id: string }) => m.id))
      .update({ published_at: new Date("2026-04-05T00:00:00Z") });
    try {
      const res = await request(app).get(`/api/source/${WITHHELD_SHA}`);
      assert.equal(res.status, 200, "publishing the meeting must make its document readable");
      assert.ok(res.body.text.includes("closed session"));
    } finally {
      await db("meetings")
        .whereIn("id", meetings.map((m: { id: string }) => m.id))
        .update({ published_at: null });
    }
  });

  /**
   * An artifact with no `document_versions` row has no meeting, so there is no
   * rule under which it becomes public. Defaulting to visible is how a bulk
   * endpoint leaks.
   */
  it("does not serve an artifact that is attached to no meeting", async () => {
    const res = await request(app).get(`/api/source/${ORPHAN_SHA}`);
    assert.equal(res.status, 404);
  });

  it("rejects a malformed hash with 400, not 404", async () => {
    // A caller mistake is not a withheld record, and conflating them would make
    // the 404 less informative than it is.
    for (const bad of ["not-a-hash", "ABC", PUBLISHED_SHA.toUpperCase(), `${PUBLISHED_SHA}0`]) {
      const res = await request(app).get(`/api/source/${bad}`);
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
    }
  });

  it("windows around the offset a citation carries", async () => {
    const window = await readSourceWindow(db, PUBLISHED_SHA, QUOTE_OFFSET);
    assert.ok(window, "the published document must be readable");
    assert.ok(
      window.text.includes("Commissioner Sample voted no"),
      "the window must contain the quote it was asked about",
    );
    assert.ok(window.window_start <= QUOTE_OFFSET);
    assert.ok(window.text.length <= WINDOW_CHARS);
    assert.equal(window.truncated, true, "a long document must say it was cut");
  });

  /**
   * A citation whose offset drifted past a re-extracted document should still
   * open the document. Showing the wrong part of the right file is a far better
   * failure than a 404, which reads as "we made this up".
   */
  it("clamps an offset past the end rather than refusing", async () => {
    const window = await readSourceWindow(db, PUBLISHED_SHA, 10_000_000);
    assert.ok(window, "an out-of-range offset must still open the document");
    assert.ok(window.text.length > 0);
  });

  it("carries provenance without presenting the fetch URL as the address", async () => {
    const res = await request(app).get(`/api/source/${PUBLISHED_SHA}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.source_url.startsWith("https://"));
    assert.equal(res.body.sha256, PUBLISHED_SHA);
    assert.ok(typeof res.body.fetched_at === "string");
  });
});
