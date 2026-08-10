import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bandAtLeast,
  matchNameInText,
  matchNames,
  normalizeName,
  splitTerms,
} from "../src/services/finance/name-match";
import { FEDERAL_ONLY_CAVEAT, financeCoverage } from "../src/services/finance/coverage";

/**
 * The matcher, and the two things it must never do: claim certainty, and see
 * what kind of organisation it is looking at.
 */

describe("normalizeName", () => {
  it("folds case, punctuation and accents", () => {
    assert.equal(normalizeName("Ridgeline  Partners, L.L.C."), "ridgeline partners l l c");
    assert.equal(normalizeName("Muñoz-Reyes"), "munoz reyes");
  });
});

describe("splitTerms", () => {
  it("keeps distinctive terms and discards the rest", () => {
    const { distinctive, discarded } = splitTerms("Ridgeline Partners LLC");
    assert.deepEqual(distinctive, ["ridgeline"]);
    assert.ok(discarded.includes("partners"));
    assert.ok(discarded.includes("llc"));
  });

  it("discards a jurisdiction name when the caller supplies it", () => {
    const { distinctive } = splitTerms("Bozeman Ridgeline");
    assert.deepEqual(distinctive, ["bozeman", "ridgeline"]);

    const scoped = splitTerms("Bozeman Ridgeline", ["Bozeman"]);
    assert.deepEqual(scoped.distinctive, ["ridgeline"]);
    assert.ok(scoped.discarded.includes("bozeman"));
  });

  it("drops terms too short to identify anybody", () => {
    const { distinctive } = splitTerms("A B C Ridgeline");
    assert.deepEqual(distinctive, ["ridgeline"]);
  });
});

/**
 * **The non-partisanship assertion, at the lowest level it can be made.**
 *
 * Detection logic must apply identically to every entity class. Here that is
 * proved by construction rather than by inspection: the class word is removed
 * before any decision is taken, so five filings that differ *only* in whether
 * they are a corporation, a union, a PAC, a nonprofit or a developer reduce to
 * the same distinctive terms and produce byte-identical matches.
 *
 * If somebody ever adds a branch on entity type, this test is what fails.
 */
describe("entity class is invisible to the matcher", () => {
  const CLASSES = [
    "Ridgeline Partners LLC",
    "Ridgeline Workers Union Local 42",
    "Ridgeline Political Action Committee",
    "Ridgeline Foundation",
    "Ridgeline Developers Incorporated",
    "Ridgeline Trade Association",
    "Ridgeline Citizens Advocacy Cooperative",
  ];

  it("reduces every class to the same distinctive terms", () => {
    const sets = CLASSES.map((name) => splitTerms(name).distinctive);
    for (const set of sets) {
      assert.deepEqual(set, ["ridgeline"], `"${set.join(" ")}" is not the same set`);
    }
  });

  it("produces identical matches against identical record text", () => {
    const text = "Approve the Ridgeline subdivision preliminary plat";
    const results = CLASSES.map((name) => matchNameInText(name, text));
    const first = results[0];
    assert.ok(first);
    for (const result of results) {
      assert.ok(result);
      assert.equal(result.band, first.band);
      assert.equal(result.score, first.score);
      assert.deepEqual(result.matchedTerms, first.matchedTerms);
    }
  });
});

describe("matchNameInText", () => {
  it("returns null when no distinctive term appears", () => {
    assert.equal(matchNameInText("Ridgeline Partners LLC", "Approve the minutes of July 14"), null);
  });

  it("bands a full two-term match as strong", () => {
    const match = matchNameInText(
      "Ridgeline Aggregate Holdings",
      "Contract award to Ridgeline Aggregate for gravel supply",
    );
    assert.ok(match);
    assert.equal(match.band, "strong");
    assert.equal(match.score, 1);
    assert.deepEqual(match.matchedTerms, ["ridgeline", "aggregate"]);
  });

  it("never bands anything above strong", () => {
    const match = matchNameInText("Ridgeline Aggregate", "Ridgeline Aggregate");
    assert.ok(match);
    assert.ok(["weak", "moderate", "strong"].includes(match.band));
  });

  it("bands a single common surname as weak, not a match worth acting on", () => {
    const match = matchNameInText("Anderson Ridge Company", "Anderson Street sidewalk repair");
    assert.ok(match);
    assert.equal(match.band, "weak");
    assert.equal(bandAtLeast(match.band, "moderate"), false);
  });

  it("matches whole words only", () => {
    // "ridge" must not match inside "ridgeline".
    assert.equal(matchNameInText("Ridge Holdings", "Ridgeline plat approval"), null);
  });

  it("publishes what it was blind to", () => {
    const match = matchNameInText("Ridgeline Partners LLC", "Ridgeline plat");
    assert.ok(match);
    assert.ok(match.discardedTerms.includes("llc"));
    assert.ok(match.discardedTerms.includes("partners"));
  });
});

describe("matchNames", () => {
  it("is symmetric", () => {
    const left = matchNames("Dana Whitcomb", "Whitcomb Dana");
    const right = matchNames("Whitcomb Dana", "Dana Whitcomb");
    assert.ok(left && right);
    assert.equal(left.score, right.score);
    assert.equal(left.band, right.band);
  });

  it("does not assert identity from a partial name", () => {
    const match = matchNames("Sarah Jane Whitcomb", "Sarah Whitcomb");
    assert.ok(match);
    assert.notEqual(match.band, "strong");
    assert.ok(match.unmatchedTerms.includes("jane"));
  });

  it("returns null when nothing overlaps", () => {
    assert.equal(matchNames("Dana Whitcomb", "Marco Ferreira"), null);
  });
});

describe("finance coverage", () => {
  it("says the record is federal only, and says which system is missing", () => {
    const coverage = financeCoverage();
    assert.equal(coverage.federalOnly, true);
    assert.equal(coverage.caveat, FEDERAL_ONLY_CAVEAT);

    const cers = coverage.systems.find((system) => system.key === "mt_cers");
    assert.ok(cers, "CERS must be listed even though it is not built");
    assert.equal(cers.state, "planned");
  });

  it("states the limitation without stating anything about an official", () => {
    // The sentence must describe which records were consulted. It must not
    // describe, imply or excuse anybody's conduct.
    assert.match(FEDERAL_ONLY_CAVEAT, /Federal Election Commission/);
    assert.match(FEDERAL_ONLY_CAVEAT, /no federal filing was found/);
    for (const forbidden of ["clean", "innocent", "suspicious", "hiding", "undisclosed"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(FEDERAL_ONLY_CAVEAT),
        `caveat must not say "${forbidden}"`,
      );
    }
  });
});
