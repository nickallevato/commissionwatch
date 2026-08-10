import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordGap } from "../src/services/records/gaps";
import {
  daysBetween,
  isoDate,
  lawWarnings,
  renderLetter,
  VERIFICATION_MAX_AGE_DAYS,
  type JurisdictionRecordsLaw,
  type Requester,
} from "../src/services/records/letter";

/**
 * P7 · the letter.
 *
 * This suite guards a legal document. Three properties, in descending order of
 * how much damage getting them wrong would do:
 *
 * 1. **No statute is hardcoded.** The rendered text carries only what the law
 *    row supplied, and when the law row supplies no deadline the letter states
 *    none. There is a source-level assertion too: the three P7 service files
 *    must contain no Montana citation and no literal day count, because a
 *    "temporary default" is exactly how the wrong figure would get into
 *    somebody's outbox.
 * 2. **The letter alleges nothing.** Rendered for every gap kind and scanned
 *    for a list of accusatory terms. A request is not an accusation.
 * 3. **It is a function.** Same inputs, same bytes — which is what makes the
 *    public and operator surfaces provably identical rather than similar.
 */

const REQUESTER: Requester = {
  name: "A. Requester",
  email: "requester@example.invalid",
  organization: "Example Newsroom",
  address: "1 Example Street, Bozeman, MT",
  phone: "406-555-0100",
};

/** A law row with everything the table permits to be null, null. */
const BARE_LAW: JurisdictionRecordsLaw = {
  jurisdiction_id: "11111111-2222-3333-4444-555555555555",
  statute_citation: "Example Code Ann. § 0-0-0000",
  statute_url: "https://example.invalid/statute",
  acknowledge_days: null,
  respond_days: null,
  custodian_name: null,
  custodian_email: null,
  custodian_address: null,
  verified_on: "2026-08-01",
  verified_by: null,
  notes: null,
};

const FULL_LAW: JurisdictionRecordsLaw = {
  ...BARE_LAW,
  acknowledge_days: 7,
  respond_days: 30,
  custodian_name: "Example Clerk",
  custodian_email: "clerk@example.invalid",
  custodian_address: "311 W Main St, Bozeman, MT 59715",
};

function gapOf(overrides: Partial<RecordGap>): RecordGap {
  return {
    id: "missing_minutes:11111111-2222-3333-4444-555555555555",
    kind: "missing_minutes",
    jurisdiction_id: BARE_LAW.jurisdiction_id,
    jurisdiction_name: "Example County",
    summary: "No minutes are in the record for the Example Commission meeting of 2026-08-04.",
    requested_record: "the minutes of the Example Commission meeting held on 2026-08-04",
    meeting_id: "22222222-3333-4444-5555-666666666666",
    meeting_date: "2026-08-04",
    commission_name: "Example Commission",
    document_title: null,
    reference_url: null,
    ...overrides,
  };
}

const TODAY = "2026-08-10";

describe("the public-records letter", () => {
  describe("what it must contain", () => {
    const letter = renderLetter({ gap: gapOf({}), law: FULL_LAW, requester: REQUESTER, today: TODAY });

    it("names the requester, the record, the citation and its source", () => {
      assert.ok(letter.includes(REQUESTER.name));
      assert.ok(letter.includes(REQUESTER.email));
      assert.ok(letter.includes("Example Newsroom"));
      assert.ok(letter.includes("the minutes of the Example Commission meeting held on 2026-08-04"));
      assert.ok(letter.includes(FULL_LAW.statute_citation));
      assert.ok(letter.includes(FULL_LAW.statute_url));
      assert.ok(letter.includes(TODAY));
    });

    it("asks for a fee waiver without claiming an entitlement to one", () => {
      assert.match(letter, /fees .* be waived or reduced/);
      assert.match(letter, /estimated amount before any cost is incurred/);
      // The fee provisions live in the same section as the deadlines and carry
      // the same local-government split, which nobody here has read. So the
      // letter asks, and cites nothing for the asking.
      assert.ok(!/entitled to a waiver/i.test(letter));
      assert.ok(!/waiver is required/i.test(letter));
    });

    it("states a preference for electronic copies, addressed to the requester", () => {
      assert.match(letter, /electronic form/);
      assert.match(letter, /native electronic format/);
      assert.ok(letter.includes(`by email to ${REQUESTER.email}`));
    });

    it("is plain text a person can paste into a mail client", () => {
      assert.ok(!letter.includes("<"), "no markup");
      assert.ok(!letter.includes("{{"), "no unresolved placeholder");
      assert.ok(!/\bTODO\b/.test(letter));
    });
  });

  describe("the deadline sentence", () => {
    it("states the periods the law row carries, pluralised correctly", () => {
      const letter = renderLetter({ gap: gapOf({}), law: FULL_LAW, requester: REQUESTER, today: TODAY });
      assert.ok(letter.includes("acknowledgement of this request within 7 business days"));
      assert.ok(letter.includes("a response within 30 days"));

      const singular = renderLetter({
        gap: gapOf({}),
        law: { ...FULL_LAW, acknowledge_days: 1, respond_days: 1 },
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(singular.includes("within 1 business day"));
      assert.ok(singular.includes("a response within 1 day"));
    });

    it("omits the sentence entirely when no period is established", () => {
      const letter = renderLetter({ gap: gapOf({}), law: BARE_LAW, requester: REQUESTER, today: TODAY });
      assert.ok(!/provides for/.test(letter), "no deadline sentence at all");
      // And nothing plausible has been substituted for the figure that is absent.
      assert.ok(!/business day/.test(letter));
      assert.ok(!/\bwithin \d+ days?\b/.test(letter));
    });

    it("states only the period it has when the law row carries one of the two", () => {
      const ackOnly = renderLetter({
        gap: gapOf({}),
        law: { ...BARE_LAW, acknowledge_days: 5 },
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(ackOnly.includes("within 5 business days"));
      assert.ok(!ackOnly.includes("a response within"));
    });
  });

  describe("the custodian block", () => {
    it("uses the recorded custodian when there is one", () => {
      const letter = renderLetter({ gap: gapOf({}), law: FULL_LAW, requester: REQUESTER, today: TODAY });
      assert.ok(letter.includes("Example Clerk"));
      assert.ok(letter.includes("Dear Example Clerk,"));
      assert.ok(letter.includes("311 W Main St, Bozeman, MT 59715"));
    });

    it("addresses the office generically when none is recorded, rather than inventing one", () => {
      const letter = renderLetter({ gap: gapOf({}), law: BARE_LAW, requester: REQUESTER, today: TODAY });
      assert.ok(letter.includes("Public Records Custodian"));
      assert.ok(letter.includes("Example County"));
      assert.ok(letter.includes("To the records custodian,"));
    });
  });

  describe("it alleges nothing", () => {
    /**
     * The rule this project applies to findings, applied to correspondence.
     * A custodian reading a generated request must find a request in it.
     */
    const ACCUSATORY = [
      "failure",
      "failed",
      "fail to",
      "delay",
      "delayed",
      "overdue",
      "late",
      "refuse",
      "refusal",
      "denied",
      "bad faith",
      "unlawful",
      "illegal",
      "violation",
      "violated",
      "misconduct",
      "corrupt",
      "conceal",
      "cover-up",
      "deliberate",
      "intentional",
      "negligent",
      "obstruct",
      "stonewall",
      "wrongdoing",
      "improper",
      "should have",
      "required to have",
      "withheld",
    ];

    const KINDS: RecordGap[] = [
      gapOf({}),
      gapOf({
        id: "unpublished_exhibit:33333333-4444-5555-6666-777777777777",
        kind: "unpublished_exhibit",
        requested_record:
          'Exhibit B, referred to by agenda item 4 ("Zoning map amendment") of the Example Commission meeting held on 2026-08-04',
        document_title: "Zoning map amendment",
        reference_url: "https://example.invalid/agenda.pdf",
      }),
      gapOf({
        id: "disabled_source:44444444-5555-6666-7777-888888888888",
        kind: "disabled_source",
        requested_record:
          "the agendas, minutes and supporting materials for all public meetings of Example County held on or after 2026-01-01",
        meeting_id: null,
        meeting_date: null,
        commission_name: null,
      }),
      gapOf({
        id: "failed_fetch:55555555-6666-7777-8888-999999999999",
        kind: "failed_fetch",
        requested_record: 'a copy of the document titled "Exhibit C", published at https://example.invalid/c.pdf',
        meeting_id: null,
        meeting_date: null,
        commission_name: null,
        reference_url: "https://example.invalid/c.pdf",
      }),
    ];

    for (const gap of KINDS) {
      it(`says nothing accusatory for a ${gap.kind} gap`, () => {
        for (const law of [BARE_LAW, FULL_LAW]) {
          const letter = renderLetter({ gap, law, requester: REQUESTER, today: TODAY }).toLowerCase();
          for (const term of ACCUSATORY) {
            // Word-bounded: "late" must not match "related", or the test would
            // be forbidding English rather than accusation.
            const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
            assert.ok(
              !pattern.test(letter),
              `a ${gap.kind} letter used the accusatory term "${term}"`,
            );
          }
        }
      });
    }
  });

  describe("warnings", () => {
    it("warns when the verification is older than a year, and names the age and the source", () => {
      const stale = lawWarnings({ ...FULL_LAW, verified_on: "2024-01-01" }, TODAY);
      const warning = stale.find((text) => text.includes("last verified"));
      assert.ok(warning, "a stale verification warns");
      assert.ok(warning.includes("2024-01-01"));
      assert.ok(warning.includes(FULL_LAW.statute_url));
    });

    it("does not warn on a fresh verification", () => {
      const fresh = lawWarnings(FULL_LAW, TODAY);
      assert.ok(!fresh.some((text) => text.includes("last verified")));
    });

    it("warns exactly at the boundary and not a day before it", () => {
      const boundary = new Date(Date.parse(`${TODAY}T00:00:00Z`) - VERIFICATION_MAX_AGE_DAYS * 86_400_000);
      const onTheDay = lawWarnings({ ...FULL_LAW, verified_on: isoDate(boundary) }, TODAY);
      assert.ok(!onTheDay.some((text) => text.includes("last verified")));

      const dayAfter = new Date(boundary.getTime() - 86_400_000);
      const overdue = lawWarnings({ ...FULL_LAW, verified_on: isoDate(dayAfter) }, TODAY);
      assert.ok(overdue.some((text) => text.includes("last verified")));
    });

    it("says the absent deadline is correct output, not a rendering fault", () => {
      const warnings = lawWarnings(BARE_LAW, TODAY);
      assert.ok(warnings.some((text) => text.includes("No acknowledgement or response period")));
      assert.ok(warnings.some((text) => text.includes("No custodian is recorded")));
    });
  });

  describe("it is a function", () => {
    it("produces identical bytes for identical inputs", () => {
      const once = renderLetter({ gap: gapOf({}), law: FULL_LAW, requester: REQUESTER, today: TODAY });
      const twice = renderLetter({ gap: gapOf({}), law: FULL_LAW, requester: REQUESTER, today: TODAY });
      assert.equal(once, twice);
    });

    it("counts calendar days between two ISO dates without a timezone in the way", () => {
      assert.equal(daysBetween("2026-08-01", "2026-08-10"), 9);
      assert.equal(daysBetween("2026-08-10", "2026-08-10"), 0);
      assert.equal(daysBetween("not a date", "2026-08-10"), null);
    });
  });

  describe("nothing statutory is hardcoded", () => {
    const ROOT = join(__dirname, "..", "src", "services", "records");
    const FILES = ["letter.ts", "gaps.ts", "generator.ts"];

    for (const file of FILES) {
      it(`${file} contains no citation and no literal day count`, () => {
        const source = readFileSync(join(ROOT, file), "utf8");
        assert.ok(
          !/2-6-\d{4}/.test(source),
          `${file} names a Montana Code section. Citations belong in jurisdiction_records_law`,
        );
        assert.ok(
          !/\b\d+\s+(business\s+)?days?\b/.test(source),
          `${file} contains a literal day count. Deadlines belong in jurisdiction_records_law`,
        );
      });
    }
  });
});
