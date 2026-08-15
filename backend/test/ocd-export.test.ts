import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { buildOcdExport, type OcdEvent } from "../src/services/export/ocd";

/**
 * `/api/data/ocd.json` — the corpus in Open Civic Data's shape.
 *
 * Two properties carry the weight, and both are the same property seen from
 * different sides: OCD requires `sources` to have at least one entry, which is
 * that schema's statement of this project's oldest invariant. An export that
 * quietly emitted an event with no source would break the schema *and* the
 * invariant in one field.
 */

const JURISDICTION_NAME = "OCD Export Test County";

let jurisdictionId: string;
let commissionId: string;
let publishedId: string;
let withheldId: string;
let unsourcedId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) await db("jurisdictions").where({ id: row.id }).del();
}

async function insertMeeting(fields: Record<string, unknown>): Promise<string> {
  const [row] = await db("meetings")
    .insert({ commission_id: commissionId, ...fields })
    .returning("id");
  return typeof row === "string" ? row : row.id;
}

before(async () => {
  await removeFixtures();
  const [j] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  jurisdictionId = typeof j === "string" ? j : j.id;

  const [c] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "OCD Test Board" })
    .returning("id");
  commissionId = typeof c === "string" ? c : c.id;

  publishedId = await insertMeeting({
    date: "2026-03-04",
    status: "completed",
    agenda_url: "https://example.invalid/ocd/agenda-0304",
    published_at: new Date("2026-03-10T00:00:00Z"),
  });
  await db("agenda_items").insert([
    { meeting_id: publishedId, item_number: 2, title: "Ordinance 3311 second reading" },
    { meeting_id: publishedId, item_number: 1, title: "Roll call", description: "All present" },
  ]);

  withheldId = await insertMeeting({
    date: "2026-03-18",
    status: "completed",
    agenda_url: "https://example.invalid/ocd/agenda-0318",
  });
  await db("agenda_items").insert({
    meeting_id: withheldId,
    item_number: 1,
    title: "Ordinance 9999 withheld-from-ocd probe",
  });

  // Published, but the record carries no source URL of any kind.
  unsourcedId = await insertMeeting({
    date: "2026-03-25",
    status: "completed",
    published_at: new Date("2026-03-26T00:00:00Z"),
  });
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

function eventsForFixture(events: readonly OcdEvent[]): OcdEvent[] {
  return events.filter((event) => event.jurisdiction.startsWith(JURISDICTION_NAME));
}

describe("OCD export", () => {
  it("is served at /api/data/ocd.json and not swallowed by the :file handler", async () => {
    const res = await request(app).get("/api/data/ocd.json");
    assert.equal(res.status, 200);
    assert.equal(res.body.schema, "open-civic-data/event");
  });

  it("emits a published meeting as an Event with its agenda in order", async () => {
    const ocd = await buildOcdExport(db);
    const mine = eventsForFixture(ocd.events);
    const event = mine.find((e) => e._id === `ocd-event/${publishedId}`);

    assert.ok(event, "the published meeting must be exported");
    assert.equal(event.start_date, "2026-03-04");
    assert.equal(event.status, "passed");
    assert.deepEqual(
      event.agenda.map((item) => item.order),
      ["1", "2"],
      "agenda items must be in item_number order, not insertion order",
    );
  });

  /**
   * The wall. A bulk export takes no id, so nobody has to guess one — the same
   * reason /api/anomalies, /search and the sitemap each needed their own guard.
   */
  it("excludes an unpublished meeting, and its agenda items with it", async () => {
    const res = await request(app).get("/api/data/ocd.json");
    const body = JSON.stringify(res.body);

    assert.ok(!body.includes(withheldId), "leaked an unpublished meeting id");
    assert.ok(
      !body.includes("Ordinance 9999"),
      "leaked an agenda item from an unpublished meeting",
    );
  });

  /**
   * The other half. A test that only proves nothing comes back also passes when
   * the export is broken, so publish the withheld meeting and assert it appears.
   */
  it("includes that meeting once it is published", async () => {
    await db("meetings")
      .where({ id: withheldId })
      .update({ published_at: new Date("2026-03-20T00:00:00Z") });
    try {
      const ocd = await buildOcdExport(db);
      assert.ok(
        ocd.events.some((event) => event._id === `ocd-event/${withheldId}`),
        "publishing must make the meeting appear",
      );
    } finally {
      await db("meetings").where({ id: withheldId }).update({ published_at: null });
    }
  });

  it("gives every emitted event at least one source, as the schema requires", async () => {
    const ocd = await buildOcdExport(db);
    for (const event of ocd.events) {
      assert.ok(
        Array.isArray(event.sources) && event.sources.length >= 1,
        `${event._id} has no source; OCD requires minItems 1 and so do we`,
      );
      for (const source of event.sources) {
        assert.match(source.url, /^https?:\/\//);
      }
    }
  });

  /**
   * A published meeting with no source URL is withheld rather than emitted with
   * an invented one — and the count is published, because a consumer needs to
   * know the export is incomplete and by how much.
   */
  it("omits an unsourced meeting and says how many it omitted", async () => {
    const ocd = await buildOcdExport(db);
    assert.ok(
      !ocd.events.some((event) => event._id === `ocd-event/${unsourcedId}`),
      "a meeting with no source must not be exported",
    );
    assert.ok(ocd.omitted_unsourced >= 1, "the omission must be counted, not hidden");
  });

  it("reports a count that matches the events it actually emitted", async () => {
    const ocd = await buildOcdExport(db);
    assert.equal(ocd.count, ocd.events.length);
  });
});
