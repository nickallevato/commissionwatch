import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  assessPosture,
  listRegionPostures,
  loadAccessPolicy,
  POSTURE_STALE_AFTER_DAYS,
  type AccessPolicy,
} from "../src/services/regions/policy";

/**
 * The regions module.
 *
 * The rule under test throughout is the one the migration argues for: a stated
 * posture is a promise, and the code refuses to act on a promise it cannot
 * currently keep. Most of these assert a *refusal*, which is the direction that
 * matters — a permissive bug here fetches somebody's website under a policy no
 * human agreed to.
 */

const NOW = new Date("2026-08-14T12:00:00Z");

// File scope, not inside the first describe. node:test runs a describe's `after`
// as soon as that describe's tests finish, so a pool destroyed in the first one
// leaves every later suite failing with "Unable to acquire a connection".
after(async () => {
  await db.destroy();
});

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    jurisdiction_id: "00000000-0000-0000-0000-000000000000",
    vendor_platform: "granicus",
    robots_posture: "respect",
    disclosure_required: false,
    crawl_delay_seconds: 10,
    max_concurrency: 1,
    user_agent: null,
    tos_notes: null,
    notes: null,
    verified_on: "2026-08-04",
    verified_by: null,
    ...overrides,
  };
}

describe("access posture", () => {
  it("refuses a jurisdiction with no policy at all", () => {
    const verdict = assessPosture(undefined, NOW);
    assert.equal(verdict.fetchable, false);
    assert.match(verdict.summary, /No access policy recorded/);
  });

  it("allows a plain respect-robots region and says so in one sentence", () => {
    const verdict = assessPosture(policy({ crawl_delay_seconds: 2 }), NOW);
    assert.equal(verdict.fetchable, true);
    assert.match(verdict.summary, /robots\.txt is respected/);
    assert.match(verdict.summary, /every 2s/);
  });

  it("allows a disclosed vendor exception, and names it as one", () => {
    const verdict = assessPosture(
      policy({ robots_posture: "vendor_exception", disclosure_required: true }),
      NOW,
    );
    assert.equal(verdict.fetchable, true);
    assert.match(verdict.summary, /disclosed vendor-robots exception/);
  });

  /**
   * The one that matters most. An exception without its disclosure is a
   * published policy we are knowingly breaking, which SKILL.md forbids
   * outright. The database CHECK makes this row illegal; this proves the sweep
   * would still refuse it if one arrived from a restore or a hand-edited
   * staging database.
   */
  it("refuses an undisclosed vendor exception even though the table forbids one", () => {
    const verdict = assessPosture(
      policy({ robots_posture: "vendor_exception", disclosure_required: false }),
      NOW,
    );
    assert.equal(verdict.fetchable, false);
    assert.match(verdict.summary, /without the disclosure/);
  });

  it("refuses a blocked region and points at the records request instead", () => {
    const verdict = assessPosture(policy({ robots_posture: "blocked" }), NOW);
    assert.equal(verdict.fetchable, false);
    assert.match(verdict.summary, /public-records request/);
  });

  it("goes stale a day past the window, and not a day before", () => {
    const justInside = new Date(NOW);
    justInside.setUTCDate(justInside.getUTCDate() + POSTURE_STALE_AFTER_DAYS);
    const justOutside = new Date(justInside);
    justOutside.setUTCDate(justOutside.getUTCDate() + 1);

    assert.equal(assessPosture(policy({ verified_on: NOW }), justInside).stale, false);
    assert.equal(assessPosture(policy({ verified_on: NOW }), justOutside).stale, true);
  });

  it("staleness does not silently stop a sweep", () => {
    const long = new Date("2030-01-01T00:00:00Z");
    const verdict = assessPosture(policy(), long);
    assert.equal(verdict.stale, true);
    assert.equal(
      verdict.fetchable,
      true,
      "a stale posture must be surfaced for a human, not enforced by a clock",
    );
  });
});

describe("the seeded regions", () => {
  it("records Bozeman's exception as disclosed, at the delay the vendor publishes", async () => {
    const jurisdiction = await db("jurisdictions").where({ name: "City of Bozeman" }).first();
    if (!jurisdiction) return; // a database seeded without Bozeman is not this test's subject

    const found = await loadAccessPolicy(db, jurisdiction.id);
    assert.ok(found, "City of Bozeman has no access policy row");
    assert.equal(found.robots_posture, "vendor_exception");
    assert.equal(found.disclosure_required, true);
    assert.equal(found.crawl_delay_seconds, 10);
  });

  it("claims no exception for Gallatin, because none is needed", async () => {
    const jurisdiction = await db("jurisdictions").where({ name: "Gallatin County" }).first();
    if (!jurisdiction) return;

    const found = await loadAccessPolicy(db, jurisdiction.id);
    assert.ok(found, "Gallatin County has no access policy row");
    assert.equal(found.robots_posture, "respect");
    assert.equal(found.disclosure_required, false);
  });

  it("lists every jurisdiction, including any with no policy", async () => {
    const postures = await listRegionPostures(db);
    const total = Number((await db("jurisdictions").count("* as n").first())?.n ?? 0);

    assert.equal(
      postures.length,
      total,
      "a jurisdiction without a policy vanished from the listing — the left join is the point",
    );
    for (const posture of postures) {
      assert.ok(posture.summary.length > 0, `${posture.jurisdiction_name} has no summary`);
    }
  });

  it("publishes no operator identity in a posture", async () => {
    const postures = await listRegionPostures(db);
    const serialised = JSON.stringify(postures);
    assert.ok(!serialised.includes("verified_by"), "verified_by reached a publishable projection");
    assert.ok(!serialised.includes("@"), "an address reached a publishable projection");
  });
});

describe("the database refuses an illegitimate policy", () => {
  it("rejects an undisclosed vendor exception", async () => {
    const jurisdiction = await db("jurisdictions").first();
    if (!jurisdiction) return;

    await assert.rejects(
      () =>
        db("jurisdiction_access_policy").insert({
          jurisdiction_id: jurisdiction.id,
          robots_posture: "vendor_exception",
          disclosure_required: false,
          verified_on: "2026-08-14",
        }),
      /exception_is_disclosed|violates check constraint/i,
    );
  });

  it("rejects an impolite crawl delay", async () => {
    const jurisdiction = await db("jurisdictions").first();
    if (!jurisdiction) return;

    await assert.rejects(
      () =>
        db("jurisdiction_access_policy").insert({
          jurisdiction_id: jurisdiction.id,
          robots_posture: "respect",
          crawl_delay_seconds: 0,
          verified_on: "2026-08-14",
        }),
      /delay_is_polite|violates check constraint/i,
    );
  });

  it("rejects a posture outside the three we understand", async () => {
    const jurisdiction = await db("jurisdictions").first();
    if (!jurisdiction) return;

    await assert.rejects(
      () =>
        db("jurisdiction_access_policy").insert({
          jurisdiction_id: jurisdiction.id,
          robots_posture: "whatever_we_feel_like",
          verified_on: "2026-08-14",
        }),
      /robots_posture_check|violates check constraint/i,
    );
  });
});
