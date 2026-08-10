import { after, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./helpers/expect";
import db from "../src/config/database";
import { withoutContributorPii } from "../src/services/finance/ingest";
import { toCandidate } from "../src/services/ingestion/adapters/mt-cers";

/**
 * The campaign-finance ingest must not carry donor PII, and must not quietly
 * start carrying it again.
 *
 * On 2026-08-10 the MT CERS adapter was found to be storing a donor's street
 * address, occupation and employer, and a candidate's residence city. Migration
 * 043 dropped the four columns, the adapter stopped parsing the three CERS
 * fields, and the recorded fixtures were scrubbed of 52 real values. This suite
 * is the guard on all three, because every one of them is the kind of change
 * that reverts by accident: a column re-added by a later migration, a field
 * added back to a parser because the response obviously has it, a fixture
 * re-recorded from the live host by someone who thought it looked corrupt.
 *
 * None of that would fail a test that only checked the feature still works. The
 * feature works fine with the PII in it — that is exactly the problem.
 *
 * ## What is deliberately NOT guarded against
 *
 * Donor name, transaction date and the amounts. They are the disclosure. A
 * guard that treated a donor's name as PII would be indistinguishable from
 * deleting `vote_donor_conflict`, which exists precisely to say that a named
 * donor gave a named official money before a vote. If a future change needs to
 * remove those, it is removing the feature and should say so.
 */

/**
 * Column → table. Dropped by migrations 043 (the MT CERS path) and 051 (the
 * federal one); must never come back.
 *
 * Both halves are listed together on purpose. They were removed three weeks
 * apart by two different passes, and a guard that only knew about the first
 * would have watched the second get re-added.
 */
const FORBIDDEN_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cf_transactions", "entity_address"],
  ["cf_transactions", "occupation"],
  ["cf_transactions", "employer"],
  ["cf_filers", "residence_city"],
  ["campaign_contributions", "donor_employer"],
  ["campaign_contributions", "donor_occupation"],
  ["campaign_contributions", "donor_city"],
];

/** Columns that must survive: removing these is removing the disclosure. */
const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cf_transactions", "entity_name"],
  ["cf_transactions", "transaction_date"],
  ["cf_transactions", "total_amount"],
  ["campaign_contributions", "donor_name"],
  ["campaign_contributions", "contribution_date"],
  ["campaign_contributions", "amount"],
];

/** Every finance table whose columns are checked for PII-suggesting names. */
const FINANCE_TABLES = [
  "cf_transactions",
  "cf_filers",
  "cf_reports",
  "campaign_contributions",
  "campaign_expenditures",
  // Migration 070. It stores a donor's filed name and the terms that matched,
  // because an operator judging whether two names denote the same entity has to
  // see the names. Everything else about a donor is PII and none of it belongs
  // here, so the column-name scan below covers this table too — the temptation
  // to add "employer" as a disambiguating hint is exactly what it exists to
  // catch.
  "entity_resolution_decisions",
];

/**
 * Columns the name scan is allowed to skip, one at a time, each named in full.
 *
 * There is exactly one, and it is the operator's own email on the table that
 * records **their** judgement — the audit actor, snapshotted the same way
 * `record_corrections.operator_email` and `approval_requests.reviewer_email`
 * snapshot it everywhere else in this project. The operator is this system's
 * user, with an account in `operators`; they are not a member of the public
 * whose data was ingested from a filing, which is what the standing directive
 * is about.
 *
 * Deliberately a set of `table.column` strings rather than a pattern. Exempting
 * `/operator_email/` would also exempt an `operator_email` somebody later added
 * to `campaign_contributions`, and exempting `/email/` would exempt a
 * `donor_email` outright. An exemption that can only ever cover the one column
 * it names cannot quietly widen.
 */
const EXEMPT_COLUMNS = new Set(["entity_resolution_decisions.operator_email"]);

const FIXTURE_DIR = join(__dirname, "fixtures", "mt-cers");

/** The CERS response fields that carry donor PII. */
const PII_FIELDS = ["entityAddress", "occupationDescr", "employerDescr"] as const;

/**
 * The synthetic values the scrub writes. Anything else in a PII field is a real
 * value that has come back — either a re-record against the live host, or a
 * hand edit.
 */
const SYNTHETIC_ADDRESS = /^\d+ Example Ave, Fixtureville, MT 00000$/;
const SYNTHETIC_OCCUPATION = /^Example Occupation \d+$/;
const SYNTHETIC_EMPLOYER = /^Example Employer \d+$/;

/**
 * Street-address shape, applied to *every* string in the scrubbed fixtures and
 * not only to the three known fields — so an address that arrives somewhere
 * else (a new CERS column, a `descriptionDescr` a filer typed their address
 * into) is caught too.
 *
 * Two patterns, because one is not enough and the first draft of this guard
 * proved it. A single "house number, words, state, ZIP" regex was written here
 * and it silently failed to match `742 Evergreen Terrace, Springfield, OR
 * 97477` — the real CERS format has *two* commas, and the word-run could not
 * cross the first one. It also could never have matched a PO box, which has no
 * house number at all and which this fixture set contains. A guard that cannot
 * match the shape it exists to find passes forever.
 *
 * `CITY_STATE_ZIP` does the real work: a `, ST 59715` tail is what makes a
 * string a US mailing address regardless of what precedes it. `STREET_LINE`
 * catches a street line that appears without one.
 */
const CITY_STATE_ZIP = /,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
const STREET_LINE =
  /\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*\s+(?:Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Cir|Circle|Trl|Trail|Ter|Terrace|Loop|Pl|Place|Pkwy|Parkway|Hwy|Highway)\b\.?/i;

function addressShaped(value: string): boolean {
  return CITY_STATE_ZIP.test(value) || STREET_LINE.test(value);
}

/**
 * The tokens the scrub writes into an address, in any of its renderings — a
 * bare street line, `City, ST  ZIP`, the one-line form, the ZIP+4 form.
 *
 * Testing "is this string exactly the synthetic address" was enough when only
 * `entityAddress` was scrubbed. It is not enough now: CERS ships the same
 * address as `addrLn1`, `cityStateZip`, `addrCityStateZip`, `entityAddress` and
 * `candidateAddress`, and no single literal matches all five. So a string is
 * treated as scrubbed when removing the synthetic tokens leaves nothing that
 * still looks like an address — which is true of every synthetic rendering and
 * false for a real one, whatever shape it arrives in.
 */
const SYNTHETIC_ADDRESS_TOKEN = /\d+ Example Ave|Fixtureville|\b00000(?:-0000)?\b/g;

function unscrubbedAddress(value: string): boolean {
  return addressShaped(value) && addressShaped(value.replace(SYNTHETIC_ADDRESS_TOKEN, " "));
}

/**
 * Email and telephone shapes. Neither existed in the first version of this
 * guard, which is why 42 candidates' personal email addresses and 74 of their
 * telephone numbers sat in a scanned directory and the scan passed.
 *
 * The telephone pattern deliberately does not try to match bare runs of ten
 * digits. `"phoneNum":"4065550100"` is a telephone number and `1778220000000`
 * is a timestamp, and a scanner that cannot tell them apart either misses the
 * first or cries about the second forever. Bare digits are caught by field name
 * instead, in the structural check below; this pattern covers every rendering a
 * human or a template produces.
 */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_SHAPE = /(?<!\d)(?:\(\d{3}\)\s*|\d{3}[-.])\d{3}[-.]\d{4}(?!\d)/;

const SYNTHETIC_EMAIL = /^person\d+@example\.invalid$/;
const SYNTHETIC_PHONE = /^(?:\(406\)\s*|406[-.])555[-.]0\d{3}$/;

/**
 * `$('.input-mask-phone').mask('(999) 999-9999')` is on every CERS page. It is
 * a jQuery input mask, not a telephone number, and it is the one thing in these
 * fixtures that looks like one and is not. Recognised by being all nines rather
 * than by matching the literal, so a mask written `999-999-9999` is recognised
 * too.
 */
const PHONE_MASK_TEMPLATE = /^\(?9{3}\)?[\s.-]*9{3}[.-]9{4}$/;

function unscrubbedEmail(value: string): boolean {
  return !SYNTHETIC_EMAIL.test(value);
}

function unscrubbedPhone(value: string): boolean {
  return !SYNTHETIC_PHONE.test(value) && !PHONE_MASK_TEMPLATE.test(value);
}

/** Every match of `pattern` in `text`, whatever the pattern's own flags. */
function matchesOf(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].map(
    (match) => match[0],
  );
}

/** Field names whose value is a telephone number, checked by name not shape. */
const PHONE_FIELDS = ["phoneNum", "phoneNumFormatted"];
/** Field names whose value is an email address. */
const EMAIL_FIELDS = ["email", "emailAddress"];
/** Field names whose value is part of a postal address. */
const ADDRESS_FIELDS = [
  "addrLn1",
  "addrLn2",
  "city",
  "zip5",
  "zip4",
  "cityStateZip",
  "addrCityStateZip",
  "entityAddress",
  "entityCity",
  "candidateAddress",
];

const SYNTHETIC_CITY = "Fixtureville";
const SYNTHETIC_ZIP5 = "00000";
const SYNTHETIC_ZIP4 = "0000";
const SYNTHETIC_STREET = /^\d+ Example Ave$/;
const SYNTHETIC_PHONE_DIGITS = /^406555\d{4}$/;

/** Is this value acceptable in a field of this name? */
function scrubbedFieldValue(field: string, value: string): boolean {
  if (field === "city" || field === "entityCity") return value === SYNTHETIC_CITY;
  if (field === "zip5") return value === SYNTHETIC_ZIP5;
  if (field === "zip4") return value === SYNTHETIC_ZIP4;
  if (field === "addrLn1" || field === "addrLn2") return SYNTHETIC_STREET.test(value);
  if (field === "phoneNum") {
    return SYNTHETIC_PHONE_DIGITS.test(value) || !unscrubbedPhone(value);
  }
  if (field === "phoneNumFormatted") return !unscrubbedPhone(value);
  if (EMAIL_FIELDS.includes(field)) return !unscrubbedEmail(value);
  return !unscrubbedAddress(value);
}

function scheduleFixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter(
    (name) => name.startsWith("post-financeRepDetailList-") && name.endsWith(".json"),
  );
}

/**
 * Every recorded byte in the tape, not only the schedule rows.
 *
 * The first version of this guard scanned six files out of twenty-one. The
 * roster, the report lists and the rendered C-5 HTML were the other fifteen,
 * and between them they held candidates' home addresses, personal email
 * addresses and home, work and mobile telephone numbers, plus a campaign
 * treasurer's home address. Nothing about the earlier scope was wrong except
 * that it was a scope: the scan now covers whatever is in the directory, so a
 * new endpoint added to the recorder is covered the day it lands rather than
 * the day somebody remembers to add it here.
 *
 * `.md` is excluded: `PROVENANCE.md` describes the synthetic vocabulary in
 * prose (`personN@example.invalid`, `(406) 555-01NN`) and is documentation
 * rather than recorded bytes.
 */
function tapeFixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter(
    (name) =>
      (name.endsWith(".json") || name.endsWith(".html")) && name !== "exchanges.json",
  );
}

function textOf(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), "utf8");
}

/** Every `[field, value]` string pair anywhere in a JSON value, however nested. */
function fields(value: unknown, into: [string, string][], key = ""): void {
  if (typeof value === "string") {
    if (value !== "") into.push([key, value]);
  } else if (Array.isArray(value)) {
    for (const item of value) fields(item, into, key);
  } else if (typeof value === "object" && value !== null) {
    for (const [name, item] of Object.entries(value)) fields(item, into, name);
  }
}

function rowsOf(file: string): Record<string, unknown>[] {
  const payload: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

/** Every string value anywhere in a JSON value, however nested. */
function strings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) strings(item, into);
  }
}

describe("campaign-finance schema carries no donor PII", () => {
  after(async () => {
    await db.destroy();
  });

  it("has the tables this guard is supposed to be guarding", async () => {
    // A guard that ran against a database without `cf_transactions` would pass
    // by finding nothing, forever. This is not hypothetical: the first pass had
    // a run silently pointed at the wrong database, and every column assertion
    // in it passed.
    //
    // Names the tables it could not find. Watched failing, the first version
    // said only `expected: false to be true`, which tells an operator staring
    // at a red CI log nothing about whether the schema moved or the connection
    // did.
    const absent: string[] = [];
    for (const table of FINANCE_TABLES) {
      if (!(await db.schema.hasTable(table))) absent.push(table);
    }
    expect(absent).toEqual([]);
  });

  it("does not have the columns migrations 043 and 051 dropped", async () => {
    const found: string[] = [];
    for (const [table, column] of FORBIDDEN_COLUMNS) {
      if (await db.schema.hasColumn(table, column)) found.push(`${table}.${column}`);
    }
    expect(found).toEqual([]);
  });

  it("still has the donor name, date and amount a finding is built from", async () => {
    const missing: string[] = [];
    for (const [table, column] of REQUIRED_COLUMNS) {
      if (!(await db.schema.hasColumn(table, column))) missing.push(`${table}.${column}`);
    }
    expect(missing).toEqual([]);
  });

  it("has no column whose name suggests PII on any finance table", async () => {
    // Broader than the seven: a differently named column with the same content
    // is the same defect. `residence_county` and `donor_state` are exempt — a
    // county is the jurisdiction a candidacy is filed in and a state is the
    // coarse geography that makes "out-of-state money" a sentence, neither of
    // which is a location of a person.
    const suspicious = /address|occupation|employer|phone|email|(?:^|_)city\b|birth|ssn/i;
    const offenders: string[] = [];
    for (const table of FINANCE_TABLES) {
      const info = await db(table).columnInfo();
      for (const column of Object.keys(info)) {
        if (!suspicious.test(column)) continue;
        if (EXEMPT_COLUMNS.has(`${table}.${column}`)) continue;
        offenders.push(`${table}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("recorded CERS fixtures carry no donor PII", () => {
  const files = scheduleFixtures();

  it("finds the schedule fixtures to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no unscrubbed value in any donor PII field", () => {
    const offenders: string[] = [];
    let inspected = 0;

    for (const file of files) {
      rowsOf(file).forEach((row, index) => {
        for (const field of PII_FIELDS) {
          const value = row[field];
          if (typeof value !== "string" || value === "") continue;
          inspected += 1;
          const synthetic =
            field === "entityAddress"
              ? SYNTHETIC_ADDRESS.test(value)
              : field === "occupationDescr"
                ? SYNTHETIC_OCCUPATION.test(value)
                : SYNTHETIC_EMPLOYER.test(value);
          // The offending value is deliberately not included in the message: a
          // test failure is printed to a terminal, a CI log and often a ticket.
          if (!synthetic) offenders.push(`${file} row ${index} field ${field}`);
        }
      });
    }

    expect(inspected).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("recognises the address shapes it is looking for", () => {
    // The scanner itself is asserted, because a scanner that matches nothing is
    // indistinguishable from a fixture set that contains nothing. Values here
    // are invented, not taken from the recording.
    for (const sample of [
      "742 Evergreen Terrace, Springfield, OR 97477",
      "PO Box 275, Bozeman, MT 59771",
      "1 Infinite Loop",
      "500 Main Street",
    ]) {
      expect(addressShaped(sample)).toBe(true);
    }
    for (const sample of ["DonorBox Platform Fee", "Primary", "Example Employer 110", ""]) {
      expect(addressShaped(sample)).toBe(false);
    }
  });

  it("has no address-shaped string in any field at all", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [index, row] of rowsOf(file).entries()) {
        const values: string[] = [];
        strings(row, values);
        for (const value of values) {
          if (addressShaped(value) && !SYNTHETIC_ADDRESS.test(value)) {
            offenders.push(`${file} row ${index}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises the email and telephone shapes it is looking for", () => {
    // Asserted against invented values with the same shapes as the ones the
    // roster fixture held — a scanner nobody has watched match is a scanner
    // nobody should trust. The synthetic values are asserted as *accepted*, so
    // the guard cannot pass by rejecting everything either.
    for (const sample of ["j.doe@example.org", "nobody+tag@mail.example.co.uk"]) {
      expect(EMAIL_SHAPE.test(sample)).toBe(true);
      expect(unscrubbedEmail(sample)).toBe(true);
    }
    expect(unscrubbedEmail("person7@example.invalid")).toBe(false);

    for (const sample of ["(555) 867-5309", "555-867-5309", "555.867.5309"]) {
      expect(PHONE_SHAPE.test(sample)).toBe(true);
      expect(unscrubbedPhone(sample)).toBe(true);
    }
    expect(unscrubbedPhone("(406) 555-0107")).toBe(false);
    // The jQuery input mask on every CERS page, which is markup and not a
    // number. If this ever starts failing, the guard has begun rewriting pages.
    expect(unscrubbedPhone("(999) 999-9999")).toBe(false);
    // A millisecond timestamp is not a telephone number.
    expect(PHONE_SHAPE.test("1778220000000")).toBe(false);
  });

  it("recognises a scrubbed address in every rendering CERS ships", () => {
    // One address arrives as five different strings. A guard that only knew the
    // one-line form would accept the other four unscrubbed.
    for (const sample of [
      "100 Example Ave",
      "Fixtureville, MT  00000",
      "100 Example Ave Fixtureville, MT  00000",
      "100 Example Ave, Fixtureville, MT 00000",
      "340 Example Ave Fixtureville, MT 00000-0000",
    ]) {
      expect(unscrubbedAddress(sample)).toBe(false);
    }
    for (const sample of [
      "742 Evergreen Terrace, Springfield, OR 97477",
      "PO Box 275, Bozeman, MT 59771",
      "1 Infinite Loop",
      "500 Main Street",
      "12 Elm St Belgrade, MT 59714",
    ]) {
      expect(unscrubbedAddress(sample)).toBe(true);
    }
  });

  it("has no unscrubbed contact detail anywhere in the recorded tape", () => {
    // Shape-driven and file-agnostic: every recorded byte, every field, every
    // endpoint. The roster's `personDTO`, the `candidateDTO` embedded in the
    // report lists, the rendered C-5 HTML and free text like `comments` and
    // `purposeDescr` are all in scope, because all of them turned out to hold
    // something.
    const offenders: string[] = [];
    let inspected = 0;

    for (const file of tapeFixtures()) {
      const text = textOf(file);
      for (const value of matchesOf(text, EMAIL_SHAPE)) {
        inspected += 1;
        if (unscrubbedEmail(value)) offenders.push(`${file}: email`);
      }
      for (const value of matchesOf(text, PHONE_SHAPE)) {
        inspected += 1;
        if (unscrubbedPhone(value)) offenders.push(`${file}: telephone number`);
      }
      for (const pattern of [CITY_STATE_ZIP, STREET_LINE]) {
        for (const value of matchesOf(text, pattern)) {
          inspected += 1;
          if (unscrubbedAddress(value)) offenders.push(`${file}: postal address`);
        }
      }
    }

    // The values are deliberately absent from the message. A failure here is
    // printed to a terminal, a CI log and often a ticket, and a guard that
    // republishes what it caught has defeated itself.
    expect(inspected).toBeGreaterThan(0);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("has no unscrubbed value in any contact field of the tape", () => {
    // The companion to the shape scan, and not redundant with it. `"city":
    // "Belgrade"` and `"zip5":"59714"` are PII in context and unremarkable out
    // of it, and `"phoneNum":"4065551234"` is ten bare digits the shape scan
    // deliberately will not touch. Only the field name makes these findable.
    const watched = [...ADDRESS_FIELDS, ...EMAIL_FIELDS, ...PHONE_FIELDS];
    const offenders: string[] = [];
    let inspected = 0;

    for (const file of tapeFixtures()) {
      if (!file.endsWith(".json")) continue;
      const pairs: [string, string][] = [];
      fields(JSON.parse(textOf(file)), pairs);
      for (const [field, value] of pairs) {
        if (!watched.includes(field)) continue;
        inspected += 1;
        if (!scrubbedFieldValue(field, value)) offenders.push(`${file} field ${field}`);
      }
    }

    expect(inspected).toBeGreaterThan(0);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("still exercises the fields that were left empty, so the not-filed paths run", () => {
    // The scrub had to preserve populated-ness, not merely structure. A scrub
    // that filled in the blanks would leave the parser's null handling untested
    // while every other assertion here still passed.
    //
    // The first version of this counted nulls across the whole directory and
    // asserted the total was above zero. It was watched failing to fail:
    // populating *every* optional contact field in the roster left the other
    // files' nulls in the total and the guard shrugged. A count is not a
    // property. The property is that each of these fields is still observed
    // both ways — at least one candidate filed one and at least one did not —
    // which is what makes both branches of the parser reachable.
    // Asserted on the roster alone. It holds 42 candidacies, which is the only
    // response in the tape with enough of them for "some filed one and some did
    // not" to be a property rather than an accident — the report lists carry one
    // and four, where a field being null every time is just how those
    // candidates filed.
    const optional = [
      "homeAddressDTO",
      "workPhoneDTO",
      "homeEmailDTO",
      "workEmailDTO",
      "emailAddress",
      "zip4",
    ];
    const missing: string[] = [];
    const text = textOf("get-listCandidateResults-9a8c8f9ec18c.json");

    for (const field of optional) {
      const nulls = matchesOf(text, new RegExp(`"${field}":null`)).length;
      const total = matchesOf(text, new RegExp(`"${field}":`)).length;
      if (total === 0) missing.push(`roster field ${field} is absent entirely`);
      else if (nulls === 0) missing.push(`roster field ${field} is never null`);
      else if (nulls === total) missing.push(`roster field ${field} is never populated`);
    }

    expect(missing).toEqual([]);
  });

  it("keeps the donor names, dates and amounts the tests are built on", () => {
    // The scrub must not have quietly emptied the fixture. If this ever fails,
    // somebody removed the disclosure rather than the PII.
    let named = 0;
    let dated = 0;
    let priced = 0;
    for (const file of files) {
      for (const row of rowsOf(file)) {
        if (typeof row.entityName === "string" && row.entityName !== "") named += 1;
        if (typeof row.datePaid === "number") dated += 1;
        if (typeof row.totalAmt === "number") priced += 1;
      }
    }
    expect(named).toBeGreaterThan(0);
    expect(dated).toBeGreaterThan(0);
    expect(priced).toBeGreaterThan(0);
  });
});

/**
 * Two parsers, guarded at the point where PII would enter rather than at the
 * point where it would be displayed.
 *
 * The schema assertions above catch a column coming back. They cannot catch PII
 * arriving in a column that is allowed to exist — a jsonb `raw` blob, or a
 * free-form `metadata` key — and both of this project's finance paths had
 * exactly that defect. Dropping at the parser is the rule; these are the tests
 * that say the parsers still do it.
 */
describe("the finance parsers drop contact PII before anything can store it", () => {
  it("keeps contributor PII out of campaign_contributions.raw", () => {
    // `raw` stores the OpenFEC record verbatim, and OpenFEC sends employer,
    // occupation, city, street and ZIP whether or not our interface declares
    // them. Dropping the three columns while serialising the same values one
    // column over would have been a schema change dressed as a privacy measure.
    //
    // Every value below is invented and matches the synthetic vocabulary; the
    // point of the fixture is the field names, not the contents.
    const wire = {
      contributor_name: "Ridgeline Aggregate LLC",
      contributor_employer: "Example Employer",
      contributor_occupation: "Example Occupation",
      contributor_city: "Fixtureville",
      contributor_street_1: "100 Example Ave",
      contributor_street_2: "Suite 2",
      contributor_zip: "00000",
      contributor_phone: "(406) 555-0100",
      contributor_email: "person0@example.invalid",
      contributor_state: "MT",
      contribution_receipt_amount: 2500,
      contribution_receipt_date: "2026-03-04T00:00:00",
      sub_id: "sub-1",
    };

    const kept = withoutContributorPii(wire);
    const dropped = Object.keys(wire).filter((key) => !(key in kept));

    expect(dropped.sort()).toEqual([
      "contributor_city",
      "contributor_email",
      "contributor_employer",
      "contributor_occupation",
      "contributor_phone",
      "contributor_street_1",
      "contributor_street_2",
      "contributor_zip",
    ]);

    // The disclosure survives in full. A filter that also ate the donor's name
    // or the amount would pass the assertion above and delete the feature.
    expect(kept.contributor_name).toBe("Ridgeline Aggregate LLC");
    expect(kept.contributor_state).toBe("MT");
    expect(kept.contribution_receipt_amount).toBe(2500);
    expect(kept.contribution_receipt_date).toBe("2026-03-04T00:00:00");
    expect(kept.sub_id).toBe("sub-1");
  });

  it("keeps a candidate's address out of the parsed CERS roster row", () => {
    // `toCandidate` used to parse `candidateAddress`, and `scheduleRef` put it
    // into `DocumentRef.metadata`, which round-trips through
    // `ingestion_jobs.target.metadata` — so every sweep wrote a candidate's
    // residence address into this database. The row below is shaped like the
    // real response and carries an invented address the parser must ignore.
    const parsed = toCandidate({
      candidateId: 22048,
      entId: 848716,
      candidateName: "Brown, Zach J",
      candidateAddress: "742 Evergreen Terrace, Springfield, OR 97477",
      officeCode: "29",
      officeTitle: "County Commissioner",
      resCountyCode: "3257",
      resCountyDescr: "Gallatin",
      partyDescr: "Democratic",
      electionYear: "2026",
    });

    const contact = /address|phone|email|occupation|employer|zip|residence_city/i;
    expect(Object.keys(parsed).filter((key) => contact.test(key))).toEqual([]);

    for (const value of Object.values(parsed)) {
      if (typeof value !== "string") continue;
      expect(unscrubbedAddress(value)).toBe(false);
      expect(EMAIL_SHAPE.test(value)).toBe(false);
      expect(PHONE_SHAPE.test(value)).toBe(false);
    }

    // The disclosure survives: the county, the office and the name are what a
    // finding is built from, and `resCountyDescr` is a jurisdiction rather than
    // a place a person lives.
    expect(parsed.candidateName).toBe("Brown, Zach J");
    expect(parsed.resCountyDescr).toBe("Gallatin");
    expect(parsed.officeTitle).toBe("County Commissioner");
  });
});
