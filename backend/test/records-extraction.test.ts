import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, namesAPerson } from "../src/services/records/extraction";
import { detectRecordsFlags } from "../src/services/records/detectors";

// Every name and organisation below is invented. Seed and fixture data in this
// project never names a real person, and a records fixture is no exception.
const SOLE_SOURCE_DOC = `
CONTRACT AWARD MEMORANDUM

The Placeholder County Procurement Office recommends a sole source award to
Fictional Paving LLC. The initial estimate was $40,000. The revised award is
$390,000.

Submitted by Jordan Placeholder on 2026-03-01.
`;

const FAST_TRACK_DOC = `
PERMIT DECISION

An expedited review was granted for the application received 2026-04-01 and
approved 2026-04-09 under administrative approval.
`;

describe("records extraction", () => {
  it("finds amounts, and rates a currency-marked one higher than a bare number", () => {
    const entities = extractEntities("The award was $390,000 against a cap of 1,250,000 units.");
    const values = entities.amounts.map((a) => a.value);

    assert.ok(values.some((v) => v.includes("390,000")));
    const marked = entities.amounts.find((a) => a.value.trim().startsWith("$"));
    const bare = entities.amounts.find((a) => !a.value.trim().startsWith("$"));
    assert.equal(marked?.confidence, "high");
    assert.equal(bare?.confidence, "medium");
  });

  it("rates an ISO date higher than a slash date, which is ambiguous by convention", () => {
    const entities = extractEntities("Filed 2026-03-01, acknowledged 3/4/2026.");
    const iso = entities.dates.find((d) => d.value === "2026-03-01");
    const slash = entities.dates.find((d) => d.value === "3/4/2026");

    assert.equal(iso?.confidence, "high");
    assert.equal(slash?.confidence, "medium");
  });

  it("finds organisations by their suffix and does not also call them people", () => {
    const entities = extractEntities(SOLE_SOURCE_DOC);
    const orgs = entities.organizations.map((o) => o.value);
    assert.ok(orgs.some((o) => o.includes("Fictional Paving LLC")), orgs.join(" | "));

    for (const person of entities.people) {
      assert.equal(
        orgs.some((org) => org.includes(person.value)),
        false,
        `"${person.value}" was claimed as both a person and part of an organisation`,
      );
    }
  });

  it("reports every person as low confidence, because the heuristic is weak", () => {
    // "Commission Room" matches a two-capitalised-word pattern exactly as
    // readily as a name. Saying so in the data is what makes the operator
    // review meaningful rather than a rubber stamp.
    const entities = extractEntities(SOLE_SOURCE_DOC);
    assert.ok(entities.people.length > 0);
    assert.equal(
      entities.people.every((p) => p.confidence === "low"),
      true,
    );
  });

  it("reports whether the document names anyone at all", () => {
    assert.equal(namesAPerson(extractEntities(SOLE_SOURCE_DOC)), true);
    assert.equal(namesAPerson(extractEntities("Total: $12,000.00 on 2026-01-01.")), false);
  });

  it("deduplicates repeated values", () => {
    const entities = extractEntities("$500 and $500 and $500");
    assert.equal(entities.amounts.length, 1);
  });
});

describe("records detectors", () => {
  it("flags sole-source language and says which terms it saw", () => {
    const entities = extractEntities(SOLE_SOURCE_DOC);
    const flags = detectRecordsFlags(SOLE_SOURCE_DOC, entities);
    const flag = flags.find((f) => f.flag_type === "no_bid_contract");

    assert.ok(flag);
    assert.equal(flag.severity, "high");
    assert.deepEqual(flag.evidence.matched_terms, ["sole source"]);
    // Describe the record, never the motive.
    assert.doesNotMatch(flag.description, /corrupt|illegal|fraud|intent/i);
  });

  it("flags a budget delta only when it is both large and proportionally large", () => {
    const big = extractEntities("Estimate $40,000. Award $390,000.");
    assert.ok(detectRecordsFlags("x", big).some((f) => f.flag_type === "budget_spike"));

    // 3x but only $20 apart — proportion alone is not a budget spike.
    const proportionalButTiny = extractEntities("Estimate $10. Award $30.");
    assert.equal(
      detectRecordsFlags("x", proportionalButTiny).some((f) => f.flag_type === "budget_spike"),
      false,
    );

    // $100,000 apart but only 1.2x — a large project is not a spike either.
    const largeButFlat = extractEntities("Estimate $500,000. Award $600,000.");
    assert.equal(
      detectRecordsFlags("x", largeButFlat).some((f) => f.flag_type === "budget_spike"),
      false,
    );
  });

  it("flags a compressed permit timeline, and not a normal one", () => {
    const fast = extractEntities(FAST_TRACK_DOC);
    const flag = detectRecordsFlags(FAST_TRACK_DOC, fast).find(
      (f) => f.flag_type === "fast_tracked_permit",
    );
    assert.ok(flag);
    assert.equal(flag.evidence.day_gap, 8);

    const slow = "An expedited review was received 2026-01-01 and approved 2026-06-01.";
    assert.equal(
      detectRecordsFlags(slow, extractEntities(slow)).some(
        (f) => f.flag_type === "fast_tracked_permit",
      ),
      false,
    );
  });

  it("raises nothing on an ordinary document", () => {
    const text = "Minutes of the regular meeting. The motion carried 4-1 on 2026-02-02.";
    assert.deepEqual(detectRecordsFlags(text, extractEntities(text)), []);
  });

  it("does not vary with who the counterparty is", () => {
    // Non-partisanship: the detectors take language, numbers and dates. There
    // is no entity-class input, so substituting one counterparty for another
    // cannot change the outcome.
    const a = "A sole source award to Fictional Paving LLC for $390,000, estimate $40,000.";
    const b = "A sole source award to Placeholder Labor Council for $390,000, estimate $40,000.";

    const flagsA = detectRecordsFlags(a, extractEntities(a)).map((f) => f.flag_type).sort();
    const flagsB = detectRecordsFlags(b, extractEntities(b)).map((f) => f.flag_type).sort();
    assert.deepEqual(flagsA, flagsB);
  });
});
