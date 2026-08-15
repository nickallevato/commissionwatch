import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Set before anything imports `src/app` — `signInOperator` does, and the app
// pulls in the event spine's dispatcher config, which resolves this key at
// module load. Same reason `place-review.test.ts` sets it at the top.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import request from "supertest";
import express from "express";

import db from "../src/config/database";
import { errorHandler } from "../src/middleware/errorHandler";
import { requireOperator } from "../src/middleware/requireOperator";
import rosterRouter from "../src/routes/admin/roster";
import {
  coverageState,
  rosterCoverage,
  rosterProvenance,
  rosterRoll,
  type RosterCoverage,
} from "../src/services/roster-coverage";
import {
  RosterLoadError,
  bytesContainName,
  planRosterLoad,
  searchableText,
  sha256Of as sha256OfBytes,
  type RosterLoadInput,
} from "../src/scripts/roster-load";
import { cleanupByPrefix, createMeeting, createSource, sha256Of, signInOperator } from "./helpers/pressroom";

/**
 * The roster roll: the per-body view of a gap that has only ever been visible
 * as an aggregate, and the provenance columns that let it stop being a
 * hardcoded zero.
 *
 * What this suite holds:
 *
 *  - **migration 103's CHECK is all-or-nothing.** A row carrying a source URL
 *    and no hash is worse than a row carrying nothing: it looks sourced in
 *    every listing and proves nothing;
 *  - **`seats_traceable` is measured, not asserted.** It moves when a row gains
 *    provenance and only then. A number that reports zero because it is written
 *    `0` is indistinguishable from one that reports zero because it counted;
 *  - **a partly-sourced body is `partial`, and `partial` is not `traceable`.**
 *    Half a sourced roster is not a sourced roster;
 *  - **the roll names bodies and the public metrics do not.** This route is
 *    behind `requireOperator` and 401s without a session, which is the whole
 *    reason it is allowed to name anything;
 *  - **the loader refuses.** Every refusal in `planRosterLoad` is a way an
 *    unsourced roster could have got in wearing a hash.
 *
 * Every name here is invented. `PREFIX` scopes the fixtures, because
 * `rosterCoverage` reads whole tables and a suite that assumed it owned the
 * database would pass alone and fail beside the seed.
 */

const PREFIX = "roster-console-test";

const SHA = sha256Of(`${PREFIX}-minutes`);

interface Fixture {
  /** Two members in term, one of them sourced, and two names in the minutes. */
  partialJurisdictionId: string;
  /** No members, no claims: the `unmeasured` bucket. */
  emptyJurisdictionId: string;
  cookie: string;
}

let fixture: Fixture;

const adminApp = express();
adminApp.use(express.json());
adminApp.use("/api/admin/roster", requireOperator, rosterRouter);
adminApp.use(errorHandler);

/** The same mount without the guard, to prove the guard is what 401s. */
const guardedApp = express();
guardedApp.use("/api/admin/roster", requireOperator, rosterRouter);
guardedApp.use(errorHandler);

const TODAY = new Date().toISOString().slice(0, 10);

async function addMember(
  jurisdictionId: string,
  name: string,
  provenance: { sourceUrl: string; fetchedAt: Date; sha: string } | null,
): Promise<string> {
  const [row] = await db("members")
    .insert({
      jurisdiction_id: jurisdictionId,
      name,
      title: "Commissioner",
      term_start: "2026-01-01",
      term_end: null,
      source_url: provenance?.sourceUrl ?? null,
      fetched_at: provenance?.fetchedAt ?? null,
      artifact_sha256: provenance?.sha ?? null,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

async function addClaim(meetingId: string, subject: string): Promise<void> {
  await db("minute_claims").insert({
    meeting_id: meetingId,
    artifact_sha256: SHA,
    subject_name: subject,
    action: "voted_yes",
    quote: `${subject} – Aye`,
    quote_offset: 10,
    model: "test",
    prompt_version: "test",
    status: "held",
  });
}

before(async () => {
  await cleanupByPrefix(PREFIX);

  const partial = await createSource(`${PREFIX} Partial`);
  const empty = await createSource(`${PREFIX} Empty`);

  await db("jurisdictions")
    .where({ id: partial.jurisdictionId })
    .update({ website_url: "https://example.invalid/commission" });

  await addMember(partial.jurisdictionId, "Emma Bode", {
    sourceUrl: "https://example.invalid/commission",
    fetchedAt: new Date("2026-08-15T00:00:00.000Z"),
    sha: SHA,
  });
  await addMember(partial.jurisdictionId, "Ines Vogel", null);

  const meetingId = await createMeeting(partial.commissionId, { publishedAt: null });
  // One name the roster accounts for and one it does not — so the body lands in
  // `partial` on the coverage axis as well as on the provenance one.
  await addClaim(meetingId, "Commissioner Bode");
  await addClaim(meetingId, "Commissioner Nowak");

  fixture = {
    partialJurisdictionId: partial.jurisdictionId,
    emptyJurisdictionId: empty.jurisdictionId,
    cookie: await signInOperator(`${PREFIX}@example.invalid`, "Roster Operator"),
  };
});

after(async () => {
  await db("operators").where({ email: `${PREFIX}@example.invalid` }).del();
  await cleanupByPrefix(PREFIX);
});

describe("migration 103: provenance on members", () => {
  it("added the three columns", async () => {
    const row = await db("members")
      .where({ jurisdiction_id: fixture.partialJurisdictionId })
      .whereNotNull("artifact_sha256")
      .first<Record<string, unknown> | undefined>(
        "source_url",
        "fetched_at",
        "artifact_sha256",
      );
    assert.ok(row, "the sourced fixture member should be readable");
    assert.equal(row.source_url, "https://example.invalid/commission");
    assert.equal(row.artifact_sha256, SHA);
    assert.ok(row.fetched_at instanceof Date);
  });

  it("refuses a row with a source url and no hash", async () => {
    await assert.rejects(
      () =>
        db("members").insert({
          jurisdiction_id: fixture.partialJurisdictionId,
          name: "Half Sourced",
          term_start: "2026-01-01",
          source_url: "https://example.invalid/commission",
        }),
      /members_provenance_check/,
    );
  });

  it("refuses a hash that is not a sha256", async () => {
    await assert.rejects(
      () =>
        db("members").insert({
          jurisdiction_id: fixture.partialJurisdictionId,
          name: "Bad Hash",
          term_start: "2026-01-01",
          source_url: "https://example.invalid/commission",
          fetched_at: new Date(),
          artifact_sha256: "not-a-hash",
        }),
      /members_provenance_check/,
    );
  });

  it("still accepts a row with no provenance at all, because every existing row is one", async () => {
    const [row] = await db("members")
      .insert({
        jurisdiction_id: fixture.partialJurisdictionId,
        name: "Unsourced By Design",
        term_start: "2026-01-01",
      })
      .returning<Array<{ id: string }>>("id");
    await db("members").where({ id: row.id }).del();
  });
});

describe("rosterCoverage reads provenance off the columns", () => {
  it("counts the traceable seats and calls the body partial", async () => {
    const coverage = await rosterCoverage(db);
    const row = coverage.find((entry) => entry.jurisdiction_id === fixture.partialJurisdictionId);
    assert.ok(row, "the fixture jurisdiction should appear");
    assert.equal(row.seats_sourced, 2);
    assert.equal(row.seats_traceable, 1);
    assert.equal(row.provenance, "partial");
  });

  it("calls a body with no seats unsourced rather than sourced by vacuity", async () => {
    const coverage = await rosterCoverage(db);
    const row = coverage.find((entry) => entry.jurisdiction_id === fixture.emptyJurisdictionId);
    assert.ok(row);
    assert.equal(row.seats_sourced, 0);
    assert.equal(row.seats_traceable, 0);
    assert.equal(row.provenance, "unsourced");
    assert.equal(coverageState(row), "unmeasured");
  });

  it("moves to sourced only when every seat carries provenance", async () => {
    const id = await addMember(fixture.emptyJurisdictionId, "Sole Seat", {
      sourceUrl: "https://example.invalid/roster",
      fetchedAt: new Date("2026-08-15T00:00:00.000Z"),
      sha: SHA,
    });
    try {
      const coverage = await rosterCoverage(db);
      const row = coverage.find((entry) => entry.jurisdiction_id === fixture.emptyJurisdictionId);
      assert.ok(row);
      assert.equal(row.provenance, "sourced");
      assert.equal(row.seats_traceable, 1);
    } finally {
      await db("members").where({ id }).del();
    }
  });
});

describe("rosterProvenance", () => {
  function row(overrides: Partial<RosterCoverage>): RosterCoverage {
    return {
      jurisdiction_id: "id",
      jurisdiction_name: "A Body",
      seats_sourced: 0,
      seats_traceable: 0,
      seats_implied: 0,
      unmatched: [],
      provenance: "unsourced",
      ...overrides,
    };
  }

  it("counts a fully sourced body as traceable and a partly sourced one as not", () => {
    const distribution = rosterProvenance([
      row({ provenance: "sourced", seats_sourced: 3, seats_traceable: 3 }),
      row({ provenance: "partial", seats_sourced: 3, seats_traceable: 1 }),
      row({ provenance: "unsourced" }),
    ]);
    assert.equal(distribution.jurisdictions, 3);
    assert.equal(distribution.traceable, 1);
  });

  it("agrees with coverageState on every bucket", () => {
    const rows = [
      row({ seats_implied: 0 }),
      row({ seats_implied: 2, unmatched: [] }),
      row({ seats_implied: 2, unmatched: ["a", "b"] }),
      row({ seats_implied: 2, unmatched: ["a"] }),
    ];
    const distribution = rosterProvenance(rows);
    assert.deepEqual(
      rows.map(coverageState),
      ["unmeasured", "accounted", "none", "partial"],
    );
    assert.equal(distribution.unmeasured, 1);
    assert.equal(distribution.accounted, 1);
    assert.equal(distribution.none, 1);
    assert.equal(distribution.partial, 1);
  });
});

describe("rosterRoll", () => {
  it("carries the body's own site and the adapters already registered against it", async () => {
    const roll = await rosterRoll(db);
    const row = roll.data.find((entry) => entry.jurisdiction_id === fixture.partialJurisdictionId);
    assert.ok(row);
    assert.equal(row.website_url, "https://example.invalid/commission");
    assert.deepEqual(
      row.sources.map((source) => source.adapter_key),
      [`${PREFIX} Partial-adapter`],
    );
    assert.equal(row.state, "partial");
    assert.deepEqual(row.unmatched, ["nowak"]);
    assert.equal(roll.as_of, TODAY);
  });

  it("totals what the rows say, so the strip and the list cannot disagree", async () => {
    const roll = await rosterRoll(db);
    assert.equal(
      roll.totals.seats_sourced,
      roll.data.reduce((total, row) => total + row.seats_sourced, 0),
    );
    assert.equal(
      roll.totals.unmatched,
      roll.data.reduce((total, row) => total + row.unmatched.length, 0),
    );
    assert.equal(roll.provenance.jurisdictions, roll.data.length);
  });
});

describe("GET /api/admin/roster", () => {
  it("401s without a session", async () => {
    await request(guardedApp).get("/api/admin/roster").expect(401);
  });

  it("serves the roll, naming the body and the unaccounted officeholder", async () => {
    const res = await request(adminApp)
      .get("/api/admin/roster")
      .set("Cookie", fixture.cookie)
      .expect(200);

    const body = res.body as {
      as_of: string;
      data: Array<{ jurisdiction_name: string; unmatched: string[]; state: string }>;
      totals: { seats_traceable: number };
      provenance: { jurisdictions: number };
    };
    const row = body.data.find((entry) => entry.jurisdiction_name === `${PREFIX} Partial County`);
    assert.ok(row, "the operator roll must name the body — that is what it is for");
    assert.deepEqual(row.unmatched, ["nowak"]);
    assert.equal(row.state, "partial");
    assert.equal(body.as_of, TODAY);
    assert.ok(body.provenance.jurisdictions >= 2);
  });

  it("refuses an as_of it cannot parse rather than silently answering for today", async () => {
    await request(adminApp)
      .get("/api/admin/roster?as_of=last%20tuesday")
      .set("Cookie", fixture.cookie)
      .expect(400);
  });

  it("answers an earlier as_of with the roster in term then", async () => {
    const res = await request(adminApp)
      .get("/api/admin/roster?as_of=2025-01-01")
      .set("Cookie", fixture.cookie)
      .expect(200);
    const body = res.body as {
      as_of: string;
      data: Array<{ jurisdiction_id: string; seats_sourced: number }>;
    };
    assert.equal(body.as_of, "2025-01-01");
    const row = body.data.find((entry) => entry.jurisdiction_id === fixture.partialJurisdictionId);
    assert.ok(row);
    // Terms start 2026-01-01, so nobody held a seat on this day.
    assert.equal(row.seats_sourced, 0);
  });

  it("writes nothing: there is no POST here", async () => {
    await request(adminApp)
      .post("/api/admin/roster")
      .set("Cookie", fixture.cookie)
      .send({ name: "Typed In" })
      .expect(404);
  });
});

describe("the loader refuses what it cannot source", () => {
  const PAGE = Buffer.from(
    "<html><body><h1>Commission</h1><ul>" +
      "<li><b>Emma</b> Bode — Commissioner</li>" +
      "<li>Ines Vogel — Commissioner</li>" +
      "</ul></body></html>",
    "utf8",
  );
  const JURISDICTION = "11111111-2222-4333-8444-555555555555";
  const NOW = new Date("2026-08-15T18:00:00.000Z");

  function input(overrides: Partial<RosterLoadInput> = {}): RosterLoadInput {
    return {
      jurisdictionId: JURISDICTION,
      artifact: PAGE,
      sourceUrl: "https://example.invalid/commission",
      fetchedAt: "2026-08-15T17:00:00.000Z",
      entries: [{ name: "Emma Bode", title: "Commissioner", term_start: "2026-01-01" }],
      ...overrides,
    };
  }

  it("reads a name split by markup, because a real roster page is markup", () => {
    const text = searchableText(PAGE);
    assert.ok(bytesContainName(text, "Emma Bode"));
    assert.ok(!bytesContainName(text, "Emma Nowak"));
  });

  it("plans the rows with the sha of the bytes it was given", () => {
    const plan = planRosterLoad(input(), NOW);
    assert.equal(plan.artifact_sha256, sha256OfBytes(PAGE));
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].source_url, "https://example.invalid/commission");
    assert.equal(plan.rows[0].artifact_sha256, sha256OfBytes(PAGE));
  });

  it("refuses a name the bytes do not contain", () => {
    assert.throws(
      () =>
        planRosterLoad(
          input({ entries: [{ name: "Nils Hartmann", term_start: "2026-01-01" }] }),
          NOW,
        ),
      (error: unknown) =>
        error instanceof RosterLoadError &&
        error.refusals.some((refusal) => refusal.includes("does not appear in the fetched bytes")),
    );
  });

  it("refuses bytes it cannot read as text, rather than skipping the name check", () => {
    assert.throws(
      () => planRosterLoad(input({ artifact: Buffer.from([0x25, 0x50, 0x00, 0x44]) }), NOW),
      (error: unknown) =>
        error instanceof RosterLoadError &&
        error.refusals.some((refusal) => refusal.includes("not UTF-8 text")),
    );
  });

  it("refuses a fetch time in the future and a source that is not an address", () => {
    assert.throws(
      () => planRosterLoad(input({ fetchedAt: "2027-01-01T00:00:00.000Z" }), NOW),
      (error: unknown) =>
        error instanceof RosterLoadError &&
        error.refusals.some((refusal) => refusal.includes("in the future")),
    );
    assert.throws(
      () => planRosterLoad(input({ sourceUrl: "the county website" }), NOW),
      (error: unknown) =>
        error instanceof RosterLoadError &&
        error.refusals.some((refusal) => refusal.includes("http(s)")),
    );
  });

  it("collects every refusal in one run", () => {
    try {
      planRosterLoad(
        input({
          sourceUrl: "nope",
          entries: [
            { name: "Emma Bode", term_start: "01/01/2026" },
            { name: "Nils Hartmann", term_start: "2026-01-01" },
          ],
        }),
        NOW,
      );
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof RosterLoadError);
      assert.equal(error.refusals.length, 3);
    }
  });

  it("refuses the same seat listed twice", () => {
    assert.throws(
      () =>
        planRosterLoad(
          input({
            entries: [
              { name: "Emma Bode", term_start: "2026-01-01" },
              { name: "emma bode", term_start: "2026-01-01" },
            ],
          }),
          NOW,
        ),
      (error: unknown) =>
        error instanceof RosterLoadError &&
        error.refusals.some((refusal) => refusal.includes("listed twice")),
    );
  });
});

/**
 * File scope. node:test runs a describe's `after` as soon as that block ends,
 * so tearing the pool down inside the first one would kill every suite below.
 */
after(async () => {
  await db.destroy();
});
