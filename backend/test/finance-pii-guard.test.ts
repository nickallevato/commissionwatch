import { after, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "./helpers/expect";
import db from "../src/config/database";

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

/** Column → table. Dropped by migration 043; must never come back. */
const FORBIDDEN_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cf_transactions", "entity_address"],
  ["cf_transactions", "occupation"],
  ["cf_transactions", "employer"],
  ["cf_filers", "residence_city"],
];

/** Columns that must survive: removing these is removing the disclosure. */
const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cf_transactions", "entity_name"],
  ["cf_transactions", "transaction_date"],
  ["cf_transactions", "total_amount"],
];

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

function scheduleFixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter(
    (name) => name.startsWith("post-financeRepDetailList-") && name.endsWith(".json"),
  );
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
    // by finding nothing, forever.
    for (const table of ["cf_transactions", "cf_filers"]) {
      expect(await db.schema.hasTable(table)).toBe(true);
    }
  });

  it("does not have the columns migration 043 dropped", async () => {
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

  it("has no column whose name suggests PII on either finance table", async () => {
    // Broader than the four: a differently named column with the same content
    // is the same defect. `residence_county` is exempt — a county is the
    // jurisdiction a candidacy is filed in, not a location of a person.
    const suspicious = /address|occupation|employer|phone|email|residence_city|birth|ssn/i;
    const offenders: string[] = [];
    for (const table of ["cf_transactions", "cf_filers", "cf_reports"]) {
      const info = await db(table).columnInfo();
      for (const column of Object.keys(info)) {
        if (suspicious.test(column)) offenders.push(`${table}.${column}`);
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
