import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import db from "../src/config/database";
import { buildReceipt } from "../src/services/export/receipt";

/**
 * The record receipt: what this site said on one day, with hashes.
 *
 * A receipt is the most quotable artefact this project produces — it exists to
 * be handed to somebody as evidence — so a withheld record leaking into one is
 * worse than leaking onto a page. A page can be corrected; a receipt is meant to
 * be immutable and to have been copied.
 */

const JURISDICTION_NAME = "Receipt Test County";
const WITHHELD_TITLE = "Ordinance 5150 withheld-from-receipt probe";

let jurisdictionId: string;
let publishedId: string;
let withheldId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) await db("jurisdictions").where({ id: row.id }).del();
}

before(async () => {
  await removeFixtures();
  const [j] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  jurisdictionId = typeof j === "string" ? j : j.id;
  const [c] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "Receipt Board" })
    .returning("id");
  const commissionId = typeof c === "string" ? c : c.id;

  const [pub] = await db("meetings")
    .insert({
      commission_id: commissionId,
      date: "2026-05-06",
      published_at: new Date("2026-05-08T00:00:00Z"),
    })
    .returning("id");
  publishedId = typeof pub === "string" ? pub : pub.id;

  const [hid] = await db("meetings")
    .insert({ commission_id: commissionId, date: "2026-05-20" })
    .returning("id");
  withheldId = typeof hid === "string" ? hid : hid.id;

  await db("agenda_items").insert({
    meeting_id: withheldId,
    item_number: 1,
    title: WITHHELD_TITLE,
  });
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

describe("record receipt", () => {
  it("lists a published meeting and omits a withheld one", async () => {
    const receipt = await buildReceipt(db);
    const meetings = receipt.files.find((f) => f.name === "meetings.csv");
    assert.ok(meetings);
    assert.ok(meetings.contents.includes(publishedId), "the published meeting must be in the receipt");
    assert.ok(!meetings.contents.includes(withheldId), "a withheld meeting must not be");
  });

  it("leaks nothing about a withheld record anywhere in the file set", async () => {
    const receipt = await buildReceipt(db);
    const everything = receipt.files.map((f) => f.contents).join("\n");
    assert.ok(!everything.includes(withheldId));
    assert.ok(!everything.includes(WITHHELD_TITLE), "an agenda item title is a record too");
  });

  /**
   * The manifest is the whole mechanism. `sha256sum -c` must verify it without
   * anyone writing a verifier, which means the format and the hashes both have
   * to be right — this recomputes them rather than trusting the field.
   */
  it("hashes every file, and the hashes are the real ones", async () => {
    const receipt = await buildReceipt(db);
    for (const file of receipt.files) {
      const actual = createHash("sha256").update(file.contents, "utf8").digest("hex");
      assert.equal(file.sha256, actual, `${file.name} carries a hash of different bytes`);
      assert.ok(
        receipt.manifest.includes(`${actual}  ${file.name}`),
        `${file.name} is missing from the manifest, or the format is not sha256sum's`,
      );
    }
  });

  it("does not hash the manifest into itself", async () => {
    const receipt = await buildReceipt(db);
    assert.ok(!receipt.manifest.includes("MANIFEST.sha256"));
  });

  it("carries the sources a holder needs to check our work", async () => {
    const receipt = await buildReceipt(db);
    const sources = receipt.files.find((f) => f.name === "sources.csv");
    assert.ok(sources, "a receipt with no sources is unverifiable");
    assert.ok(sources.contents.startsWith("sha256,source_url"));
  });

  /**
   * The pin is what makes a published sentence checkable against what an
   * operator actually approved. A receipt recording the sentence without it
   * would preserve the claim and lose the guarantee.
   */
  it("records the render pin alongside each claim", async () => {
    const receipt = await buildReceipt(db);
    const claims = receipt.files.find((f) => f.name === "claims.csv");
    assert.ok(claims);
    assert.ok(claims.contents.includes("render_sha256"));
    assert.ok(claims.contents.includes("rendered_text"));
  });

  it("explains itself, including how to verify it", async () => {
    const receipt = await buildReceipt(db);
    const readme = receipt.files.find((f) => f.name === "README.md");
    assert.ok(readme);
    assert.ok(readme.contents.includes("sha256sum -c MANIFEST.sha256"));
    assert.match(readme.contents, /what we said on a date/i);
  });

  it("is dated, because an undated snapshot answers no question", async () => {
    const receipt = await buildReceipt(db, new Date("2026-05-09T12:00:00Z"));
    assert.equal(receipt.date, "2026-05-09");
    const readme = receipt.files.find((f) => f.name === "README.md");
    assert.ok(readme?.contents.includes("2026-05-09"));
  });
});
