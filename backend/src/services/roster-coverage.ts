import type { Knex } from "knex";
import { namesAnOfficial, RECORDED_OFFICES } from "./extraction/verify";

/**
 * How much of each roster is actually sourced — and the honest answer is: none
 * of it.
 *
 * `verify.ts` rejects a claim as `not-an-official` unless the subject leads with
 * one of `RECORDED_OFFICES` and, where a name is checked against the `members`
 * table, that table holds it. **No sourced roster could be found on
 * 2026-08-11.** Seed data deliberately names no real person and seeds never run
 * in production, so the check is only as good as a list nobody has filled in:
 * too small a roster rejects true claims about real officials, and a roster
 * assembled from the model's own output would let a hallucinated name validate
 * itself.
 *
 * This module does not fetch a roster and does not guess one. It makes the gap
 * **countable**, because "Bozeman: 5 of 5 seats sourced; Gallatin: 0 of 3" is
 * the number that predicts the rejection rate, and inferring it from a
 * mysterious pile of `not-an-official` rejections is how it stayed invisible.
 *
 * **Seats implied by the record, not asserted by us.** The implied count is the
 * distinct office-holding names the stored claims contain. That is a lower
 * bound and it is derived from documents the extractor also read — which is
 * precisely why it is reported as *implied* and never written into `members`.
 * A roster derived from the corpus the extractor reads is circular, and this
 * module exists to measure the hole, not to fill it.
 *
 * **What a real roster needs, and what the schema is missing.** `members` has
 * `name`, `title`, `term_start` and `term_end` — the term columns are already
 * there — and no provenance at all: no source URL, no fetched-at, no artifact
 * sha. So a row saying "Emma Bode, Commissioner" is indistinguishable from a
 * row somebody typed, which is why `provenance` below reports `unsourced` for
 * every jurisdiction rather than pretending. Closing this needs, in order:
 *
 *  1. provenance columns on `members` (`source_url`, `artifact_sha256`,
 *     `fetched_at`), and a loader that refuses a roster without them;
 *  2. a jurisdiction-scoped, term-dated import from a published roster page —
 *     Bozeman via `bozeman.granicus.com`, Gallatin via CivicPlus — or from the
 *     Montana Secretary of State's CERS, which is structured and is already an
 *     adapter target;
 *  3. attendance rolls used only as *corroboration*, parsed deterministically
 *     rather than by the model, and reconciled against 1 or 2.
 *
 * None of that is done here and none of it should be inferred from what is.
 */

export interface RosterCoverage {
  jurisdiction_id: string;
  jurisdiction_name: string;
  /** Member rows whose term covers `asOf`. */
  seats_sourced: number;
  /** Distinct office-holders the stored claims name. A lower bound. */
  seats_implied: number;
  /** Implied names with no member row. Every one is a rejection waiting to happen. */
  unmatched: string[];
  /**
   * Where the sourced seats came from.
   *
   * Always `unsourced` today: `members` carries no provenance columns, so no
   * row can prove where it came from. A second value here means the loader in
   * the header note exists.
   */
  provenance: "unsourced";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercased, punctuation dropped, whitespace collapsed. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name inside "Commissioner Emma Bode".
 *
 * The office is stripped because the minutes print it and `members.name` does
 * not. Nothing else is interpreted.
 */
export function nameWithoutOffice(subject: string): string {
  const lower = normalise(subject);
  for (const office of RECORDED_OFFICES) {
    if (lower.startsWith(`${office} `)) return lower.slice(office.length + 1).trim();
  }
  return lower;
}

/**
 * Does this member row account for the name the minutes printed?
 *
 * Two deterministic rules and no third: the whole name matches, or the minutes
 * printed a bare surname and it is this member's last name. Minutes routinely
 * say "Commissioner Bode" where the roster says "Emma Bode", so surname
 * matching is required to count anything at all — but it stops there. No
 * similarity, no trigram, no initials: a near-match between two officials'
 * names is an inference, and this project does not publish inferences about who
 * did what.
 */
export function memberAccountsFor(memberName: string, printedName: string): boolean {
  const member = normalise(memberName);
  const printed = normalise(printedName);
  if (member === printed) return true;
  const tokens = member.split(" ");
  const surname = tokens[tokens.length - 1];
  return printed !== "" && printed === surname;
}

export interface RosterCoverageOptions {
  /** Which day's roster to count. Defaults to today. */
  asOf?: Date;
}

/**
 * Roster coverage per jurisdiction, sourced against implied.
 *
 * Reads only. It writes no member row and resolves no name — a coverage report
 * that quietly created the rows it was measuring would report full coverage
 * forever.
 */
export async function rosterCoverage(
  db: Knex,
  options: RosterCoverageOptions = {},
): Promise<RosterCoverage[]> {
  const asOf = options.asOf ?? new Date();
  const day = asOf.toISOString().slice(0, 10);

  const jurisdictions: unknown = await db("jurisdictions").orderBy("name", "asc").select("id", "name");

  const coverage: RosterCoverage[] = [];
  for (const row of Array.isArray(jurisdictions) ? jurisdictions : []) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const jurisdictionId = row.id;

    const members: unknown = await db("members")
      .where({ jurisdiction_id: jurisdictionId })
      .where("term_start", "<=", day)
      .where((builder) => builder.whereNull("term_end").orWhere("term_end", ">=", day))
      .select("name");
    const memberNames = (Array.isArray(members) ? members : [])
      .filter(isRecord)
      .map((member) => (typeof member.name === "string" ? member.name : ""))
      .filter((name) => name !== "");

    const claims: unknown = await db("minute_claims as c")
      .join("meetings as m", "c.meeting_id", "m.id")
      .join("commissions as com", "m.commission_id", "com.id")
      .where("com.jurisdiction_id", jurisdictionId)
      .distinct("c.subject_name as subject_name");

    const implied = new Set<string>();
    for (const claim of Array.isArray(claims) ? claims : []) {
      if (!isRecord(claim) || typeof claim.subject_name !== "string") continue;
      // Only names the record gives an office. A member of the public in the
      // claims table is a bug elsewhere, not a seat this roster is missing.
      if (!namesAnOfficial(claim.subject_name)) continue;
      const printed = nameWithoutOffice(claim.subject_name);
      if (printed !== "") implied.add(printed);
    }

    const unmatched = [...implied]
      .filter((printed) => !memberNames.some((member) => memberAccountsFor(member, printed)))
      .sort();

    coverage.push({
      jurisdiction_id: jurisdictionId,
      jurisdiction_name: typeof row.name === "string" ? row.name : "",
      seats_sourced: memberNames.length,
      seats_implied: implied.size,
      unmatched,
      provenance: "unsourced",
    });
  }

  return coverage;
}
