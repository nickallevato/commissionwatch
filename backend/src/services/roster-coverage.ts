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
 * **What a real roster needs.** `members` has `name`, `title`, `term_start` and
 * `term_end`, and since **migration 103** it has `source_url`, `fetched_at` and
 * `artifact_sha256` too. Closing the gap needs, in order:
 *
 *  1. provenance columns on `members` (`source_url`, `artifact_sha256`,
 *     `fetched_at`), and a loader that refuses a roster without them —
 *     **done**: migration 103 adds the columns with an all-or-nothing CHECK,
 *     and `src/scripts/roster-load.ts` is the loader that refuses;
 *  2. a jurisdiction-scoped, term-dated import from a published roster page —
 *     Bozeman via `bozeman.granicus.com`, Gallatin via CivicPlus — or from the
 *     Montana Secretary of State's CERS, which is structured and is already an
 *     adapter target. **Not done.** Nothing here fetches;
 *  3. attendance rolls used only as *corroboration*, parsed deterministically
 *     rather than by the model, and reconciled against 1 or 2. **Not done.**
 *
 * Step 1 landing changes what this module can say, and changes nothing about
 * what the table holds: migration 103 backfilled nothing, because every
 * existing row is genuinely unsourced. `seats_traceable` is read off the real
 * columns now rather than hardcoded, so the day step 2 lands the number moves
 * on its own — and until then it reports zero because zero is true.
 */

/**
 * Whether the seats counted for a body can prove where they came from.
 *
 * `partial` is its own value rather than being rounded to either neighbour. A
 * body with three sourced seats and two typed ones is not a sourced roster, and
 * calling it one publishes the typed rows under the sourced rows' credibility;
 * calling it `unsourced` throws away the fact that somebody did the work on
 * three of them, which is the thing an operator needs to see to finish the job.
 */
export type RosterProvenanceState = "unsourced" | "partial" | "sourced";

export interface RosterCoverage {
  jurisdiction_id: string;
  jurisdiction_name: string;
  /** Member rows whose term covers `asOf`. */
  seats_sourced: number;
  /**
   * Of those, the rows carrying a source URL, a fetched-at and an artifact sha.
   *
   * Read off migration 103's columns. The CHECK there is all-or-nothing, so a
   * row counted here carries all three and not one of them.
   */
  seats_traceable: number;
  /** Distinct office-holders the stored claims name. A lower bound. */
  seats_implied: number;
  /** Implied names with no member row. Every one is a rejection waiting to happen. */
  unmatched: string[];
  /**
   * Where the sourced seats came from.
   *
   * `unsourced` for every body today — migration 103 added the columns and
   * deliberately backfilled nothing, so nothing yet fills them. This is derived
   * from the rows, not asserted: it moves the day a loader writes one.
   */
  provenance: RosterProvenanceState;
}

/**
 * Which coverage bucket a body falls in.
 *
 * Exported and used by `rosterProvenance` rather than duplicated there, because
 * the public distribution and the operator's per-body roll disagreeing about
 * what "accounted" means is a bug that would show up as an argument between two
 * screens.
 */
export type RosterCoverageState = "accounted" | "partial" | "none" | "unmeasured";

export function coverageState(row: RosterCoverage): RosterCoverageState {
  // A body with nothing to match against matches everything. That is the
  // confident zero this project exists to catch, so it gets its own bucket
  // rather than being counted as full coverage.
  if (row.seats_implied === 0) return "unmeasured";
  if (row.unmatched.length === 0) return "accounted";
  // Keyed on the names accounted for, not on whether any roster row exists: a
  // body with five rows that match none of the five names the minutes print
  // accounts for nothing, and calling that partial coverage would flatter it.
  if (row.unmatched.length === row.seats_implied) return "none";
  return "partial";
}

/**
 * How the bodies are distributed across coverage states — with no body named.
 *
 * The summed figures on `/api/metrics` cannot answer "is this project's roster
 * trustworthy?": one fully accounted body and one wholly unaccounted body add
 * up to totals that read as partial coverage in both. The obvious fix — a
 * per-body roll, "Gallatin County: 0 of 3" — is the wrong one for a *public*
 * endpoint, and it was written that way first and caught by
 * `metrics.test.ts`'s leak assertion. `/api/metrics` is public and takes no id,
 * and the publication wall answers 404 rather than 403 precisely so a stranger
 * cannot enumerate what has been ingested and withheld. A body name in a
 * breakdown undoes that in one field: "0 of 3 seats" for a named county tells a
 * reader we hold records for that county before any operator has published one.
 *
 * So the public shape is the distribution. It answers the question a reader is
 * actually asking — how much of this site's roster can be relied on — and names
 * nobody. The per-body roll is an operator's view, where naming the body is the
 * entire point because the operator is the person who has to go and source it;
 * `rosterCoverage` returns it in full, unmatched names included, for exactly
 * that use.
 *
 * The buckets are mutually exclusive and are keyed on `unmatched` rather than on
 * comparing the two seat counts: "every officeholder the record names has a
 * roster row" is the claim worth making, and two counts can agree by
 * coincidence.
 */
export interface RosterProvenance {
  /** Bodies considered. */
  jurisdictions: number;
  /** Bodies where every officeholder the record names has a roster row. */
  accounted: number;
  /** Bodies whose roster accounts for some of the names, not all. */
  partial: number;
  /** Bodies whose roster accounts for none of them. */
  none: number;
  /**
   * Bodies where nothing we have read names an officeholder at all.
   *
   * Its own bucket, not folded into `accounted`. A body with nothing to match
   * against matches everything, and counting that as full coverage is the same
   * confident zero this project exists to catch — there is no evidence either
   * way, and the honest report says so.
   */
  unmeasured: number;
  /**
   * Bodies whose roster rows can *all* prove where they came from.
   *
   * Zero today for every body, and now zero by measurement rather than by
   * assertion: migration 103 added `source_url`, `fetched_at` and
   * `artifact_sha256` to `members` and backfilled nothing, so the count is read
   * off real columns and will move the day a loader writes one. Published
   * rather than omitted, because a zero somebody can see is a commitment.
   *
   * A body whose roster is *partly* traceable does not count here. Half a
   * sourced roster is not a sourced roster, and this is the number a reader
   * uses to decide whether to trust the names on the site.
   */
  traceable: number;
}

export function rosterProvenance(coverage: RosterCoverage[]): RosterProvenance {
  const provenance: RosterProvenance = {
    jurisdictions: coverage.length,
    accounted: 0,
    partial: 0,
    none: 0,
    unmeasured: 0,
    traceable: 0,
  };

  for (const row of coverage) {
    if (row.provenance === "sourced") provenance.traceable += 1;
    // `coverageState` rather than the comparison inline: the operator console's
    // per-body roll labels each row with the same function, and two copies of
    // this would eventually disagree in front of the person fixing it.
    switch (coverageState(row)) {
      case "unmeasured":
        provenance.unmeasured += 1;
        break;
      case "accounted":
        provenance.accounted += 1;
        break;
      case "none":
        provenance.none += 1;
        break;
      case "partial":
        provenance.partial += 1;
        break;
    }
  }

  return provenance;
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
      .select("name", "source_url", "fetched_at", "artifact_sha256");
    const memberRows = (Array.isArray(members) ? members : [])
      .filter(isRecord)
      .filter((member) => typeof member.name === "string" && member.name !== "");
    const memberNames = memberRows.map((member) => String(member.name));

    // Migration 103's CHECK is all-or-nothing, so the sha alone decides. Reading
    // one column rather than three keeps this from disagreeing with the
    // constraint about what a half-filled row counts as — it cannot exist.
    const seatsTraceable = memberRows.filter(
      (member) => typeof member.artifact_sha256 === "string" && member.artifact_sha256 !== "",
    ).length;

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
      seats_traceable: seatsTraceable,
      seats_implied: implied.size,
      unmatched,
      // A body with no seats at all is `unsourced`, not `sourced` by vacuity —
      // the same confident-zero refusal `unmeasured` makes on the other axis.
      provenance:
        seatsTraceable === 0
          ? "unsourced"
          : seatsTraceable === memberNames.length
            ? "sourced"
            : "partial",
    });
  }

  return coverage;
}

/** One ingestion source already registered against the body. */
export interface RosterRollSource {
  adapter_key: string;
  enabled: boolean;
}

/**
 * One body's row in the operator's roll: the coverage, its bucket, and the two
 * facts an operator needs to act on it.
 *
 * `website_url` and `sources` are stored columns, not suggestions. Nothing here
 * proposes a roster URL: this module has never fetched one and inventing a
 * likely-looking address for an operator to trust is the same fabrication the
 * `members` table is being fixed to stop.
 */
export interface RosterRollRow extends RosterCoverage {
  state: RosterCoverageState;
  /** `jurisdictions.website_url`. Null means the record does not hold one. */
  website_url: string | null;
  /** Adapters already registered against this body, whether or not enabled. */
  sources: RosterRollSource[];
}

export interface RosterRollTotals {
  seats_sourced: number;
  seats_traceable: number;
  seats_implied: number;
  unmatched: number;
}

/**
 * The per-body roll, for the operator console and for nowhere else.
 *
 * This names bodies. `/api/metrics` publishes `rosterProvenance` — the same
 * facts with every name removed — because a per-body list on a public, id-less
 * endpoint tells a stranger which counties we hold withheld records for, which
 * is the enumeration the 404-not-403 publication design exists to prevent. The
 * route that serves this sits behind `requireOperator`, and naming the body is
 * the entire point there: the operator is the person who has to go and source
 * it.
 */
export interface RosterRoll {
  /** The day the terms were evaluated against. */
  as_of: string;
  data: RosterRollRow[];
  totals: RosterRollTotals;
  /** The same distribution `/api/metrics` publishes, for the summary strip. */
  provenance: RosterProvenance;
}

export async function rosterRoll(
  db: Knex,
  options: RosterCoverageOptions = {},
): Promise<RosterRoll> {
  const asOf = options.asOf ?? new Date();
  const coverage = await rosterCoverage(db, { asOf });

  const jurisdictions: unknown = await db("jurisdictions").select("id", "website_url");
  const websiteById = new Map<string, string | null>();
  for (const row of Array.isArray(jurisdictions) ? jurisdictions : []) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    websiteById.set(row.id, typeof row.website_url === "string" ? row.website_url : null);
  }

  const sourceRows: unknown = await db("ingestion_sources")
    .orderBy("adapter_key", "asc")
    .select("jurisdiction_id", "adapter_key", "enabled");
  const sourcesById = new Map<string, RosterRollSource[]>();
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    if (!isRecord(row) || typeof row.jurisdiction_id !== "string") continue;
    if (typeof row.adapter_key !== "string") continue;
    const list = sourcesById.get(row.jurisdiction_id) ?? [];
    list.push({ adapter_key: row.adapter_key, enabled: row.enabled === true });
    sourcesById.set(row.jurisdiction_id, list);
  }

  const data: RosterRollRow[] = coverage.map((row) => ({
    ...row,
    state: coverageState(row),
    website_url: websiteById.get(row.jurisdiction_id) ?? null,
    sources: sourcesById.get(row.jurisdiction_id) ?? [],
  }));

  return {
    as_of: asOf.toISOString().slice(0, 10),
    data,
    totals: {
      seats_sourced: coverage.reduce((total, row) => total + row.seats_sourced, 0),
      seats_traceable: coverage.reduce((total, row) => total + row.seats_traceable, 0),
      seats_implied: coverage.reduce((total, row) => total + row.seats_implied, 0),
      unmatched: coverage.reduce((total, row) => total + row.unmatched.length, 0),
    },
    provenance: rosterProvenance(coverage),
  };
}
