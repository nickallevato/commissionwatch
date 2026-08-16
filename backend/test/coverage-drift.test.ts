import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { FINANCE_SYSTEMS, FEDERAL_ONLY_CAVEAT } from "../src/services/finance/coverage";

/**
 * The finance coverage table must not call a system `planned` once we hold its
 * records.
 *
 * ## The lie this prevents
 *
 * `FINANCE_SYSTEMS` is a hardcoded literal. `mt_cers` is written there as
 * `planned`, and the last sentence of `FEDERAL_ONLY_CAVEAT` — published
 * verbatim on the official page, in the donor overlay, and inside every
 * vote-donor correlation payload — reads "Montana state and local filings are
 * held by CERS, which this site does not yet read."
 *
 * Nothing updates either one. The CERS adapter has existed since 2026-08-10 and
 * has swept 384 filers, 35 filed reports and 127 itemised transactions against
 * a local database. It is registered **disabled** in production, which is the
 * only reason the sentence is still true there.
 *
 * So the failure is one operator action away: enable the source, let a sweep
 * land, and the site renders CERS-derived contribution figures directly
 * alongside a sentence saying it does not read CERS. Every test passes. Every
 * typecheck passes. The page looks right. The claim about our own sourcing —
 * on the surface that exists to keep our sourcing honest — is simply false.
 *
 * ## What is asserted
 *
 * That no `source_system` present in `campaign_contributions` or
 * `campaign_expenditures` is still described as `planned`. The check is against
 * **stored records**, because holding a system's records is the thing that
 * makes "we have not consulted it" untrue.
 *
 * ## What is deliberately NOT asserted
 *
 * The converse — that an `active` system has rows — is not checked here, and
 * that omission is the design question rather than an oversight. A system that
 * was swept and genuinely returned nothing is not the same as a system never
 * consulted, and collapsing the two would make an empty donor panel read as our
 * gap rather than as a real absence, which is the precise misreading
 * `coverage.ts` was written to prevent. See
 * `docs/superpowers/specs/2026-08-16-finance-coverage-drift-design.md`.
 *
 * This test therefore only catches drift in the direction that publishes a
 * falsehood: **claiming less than we hold.** Claiming more is caught by the
 * existing coverage tests, which assert the caveat's exact wording.
 */

const TABLES = ["campaign_contributions", "campaign_expenditures"] as const;

/** Every `source_system` value for which this database actually holds records. */
async function storedSourceSystems(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const table of TABLES) {
    const rows = await db(table).distinct<Array<{ source_system: string }>>("source_system");
    for (const row of rows) found.add(row.source_system);
  }
  return found;
}

describe("finance coverage must not understate what it holds", () => {
  let stored: Set<string>;

  before(async () => {
    stored = await storedSourceSystems();
  });

  after(async () => {
    await db.destroy();
  });

  it("the coverage table is not empty", () => {
    assert.ok(
      FINANCE_SYSTEMS.length > 0,
      "FINANCE_SYSTEMS is empty — there is nothing to check, and reporting " +
        "success would be a lie about a guard that examined nothing.",
    );
  });

  it("no system with stored records is still described as planned", () => {
    const understated = FINANCE_SYSTEMS.filter(
      (system) => system.state === "planned" && stored.has(system.key),
    ).map((system) => system.key);

    assert.deepEqual(
      understated,
      [],
      `these finance systems hold records in this database but are still ` +
        `listed as "planned" in FINANCE_SYSTEMS: ${understated.join(", ")}. ` +
        `The site is publishing a claim that it has not consulted a system ` +
        `whose records it is displaying. Move the entry to "active" and ` +
        `revise FEDERAL_ONLY_CAVEAT, whose final sentence names CERS ` +
        `specifically as unread.`,
    );
  });

  it("the caveat still names CERS as unread only while CERS is planned", () => {
    const cers = FINANCE_SYSTEMS.find((system) => system.key === "mt_cers");
    assert.ok(
      cers !== undefined,
      "no mt_cers entry in FINANCE_SYSTEMS — the caveat names CERS by name, " +
        "so an entry for it must exist for that sentence to be checkable.",
    );

    const caveatClaimsUnread = FEDERAL_ONLY_CAVEAT.includes("does not yet read");
    if (cers.state === "active") {
      assert.equal(
        caveatClaimsUnread,
        false,
        "mt_cers is marked active, but FEDERAL_ONLY_CAVEAT still tells every " +
          "reader that CERS is a system this site 'does not yet read'. That " +
          "sentence is rendered on the official page, in the donor overlay, " +
          "and in every vote-donor correlation payload. Two surfaces, one " +
          "contradiction, published.",
      );
    } else {
      assert.equal(
        caveatClaimsUnread,
        true,
        "mt_cers is still planned, but the caveat no longer says CERS is " +
          "unread. An absent caveat is how a reader concludes that an empty " +
          "donor panel means an official received nothing.",
      );
    }
  });
});
