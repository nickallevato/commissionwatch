import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import db from "../config/database";

/**
 * Load a roster into `members`, and refuse to load one that cannot prove where
 * it came from.
 *
 * This is step 1's second half. Migration 103 gave `members` `source_url`,
 * `fetched_at` and `artifact_sha256` with an all-or-nothing CHECK; this is the
 * writer that fills them, and the only writer in this repo that does. It exists
 * because the obvious alternative — an operator screen with a name box — would
 * manufacture precisely the unsourced roster the columns were added to stop.
 *
 *   npx tsx src/scripts/roster-load.ts \
 *     --jurisdiction <uuid> \
 *     --artifact ./bozeman-commission.html \
 *     --source-url https://example.gov/commission \
 *     --fetched-at 2026-08-15T17:04:00Z \
 *     --roster ./bozeman-roster.json \
 *     [--commit]
 *
 * **Dry run by default.** Nothing is written without `--commit`.
 *
 * The `--artifact` file is the bytes the operator actually fetched, and the
 * sha256 written onto every row is the sha of *those* bytes. The roster JSON is
 * the operator's transcription of them:
 *
 *   [{ "name": "Emma Bode", "title": "Commissioner",
 *      "term_start": "2026-01-01", "term_end": null }]
 *
 * **Every name must appear in the fetched bytes.** That is the check that makes
 * the transcription worth anything: without it the artifact would be decoration
 * beside a hand-typed list, which is the current state of the table with a hash
 * bolted on. Tags are stripped and punctuation is flattened before the search —
 * deterministic, no similarity scoring, no initials, no near-matches. A name the
 * bytes do not contain is a refusal, not a warning, and there is no flag to
 * override it.
 *
 * **It fetches nothing.** The operator fetches, keeps the bytes, and passes
 * them. A loader that fetched would put this script's user agent and this
 * script's judgement between the record and the row, and the point of the sha
 * is that somebody else can re-fetch and compare.
 */

export interface RosterEntry {
  name: string;
  title?: string | null;
  /** `YYYY-MM-DD`. Required — a seat with no start date dates nothing. */
  term_start: string;
  term_end?: string | null;
}

export interface RosterLoadInput {
  jurisdictionId: string;
  /** The exact bytes the operator fetched. */
  artifact: Buffer;
  sourceUrl: string;
  /** ISO 8601. */
  fetchedAt: string;
  entries: readonly RosterEntry[];
}

export interface PlannedMember {
  jurisdiction_id: string;
  name: string;
  title: string | null;
  term_start: string;
  term_end: string | null;
  source_url: string;
  fetched_at: Date;
  artifact_sha256: string;
}

export interface RosterLoadPlan {
  artifact_sha256: string;
  rows: PlannedMember[];
}

/** Every refusal, collected, so one run tells an operator all of what is wrong. */
export class RosterLoadError extends Error {
  readonly refusals: readonly string[];

  constructor(refusals: readonly string[]) {
    super(`roster refused:\n  ${refusals.join("\n  ")}`);
    this.name = "RosterLoadError";
    this.refusals = refusals;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The fetched bytes as searchable text.
 *
 * Tags out, everything that is not a letter to a space, whitespace collapsed.
 * `<b>Emma</b> Bode` and `Emma&#160;Bode` both have to read as `emma bode` or
 * the name check would refuse every real HTML roster page and teach whoever hit
 * it to look for a way around the check.
 */
export function searchableText(bytes: Buffer): string {
  return bytes
    .toString("utf8")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** A name found in the text, by the same flattening, as a whole run of words. */
export function bytesContainName(text: string, name: string): boolean {
  const needle = name.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (needle === "") return false;
  return ` ${text} `.includes(` ${needle} `);
}

/**
 * Whether these bytes are text at all.
 *
 * A PDF roster is a real thing an operator will have, and this loader cannot
 * stand behind a name it cannot find in the bytes — so it says so plainly
 * rather than skipping the check for anything it fails to decode. The check is
 * a NUL byte, which no UTF-8 text carries and every binary container does.
 */
export function looksLikeText(bytes: Buffer): boolean {
  return bytes.length > 0 && !bytes.includes(0);
}

/**
 * What would be written, or every reason it must not be.
 *
 * Pure: no filesystem, no database, no clock beyond the one it compares
 * `fetchedAt` against. That is what makes the refusals testable, and the
 * refusals are the whole product here.
 */
export function planRosterLoad(input: RosterLoadInput, now: Date = new Date()): RosterLoadPlan {
  const refusals: string[] = [];

  if (!UUID_RE.test(input.jurisdictionId)) {
    refusals.push(`jurisdiction id is not a uuid: ${input.jurisdictionId}`);
  }

  let url: URL | null = null;
  try {
    url = new URL(input.sourceUrl);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    refusals.push(`source url is not an http(s) address: ${input.sourceUrl}`);
  }

  const fetchedAt = new Date(input.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) {
    refusals.push(`fetched-at is not a date: ${input.fetchedAt}`);
  } else if (fetchedAt.getTime() > now.getTime()) {
    // A future fetch time is either a typo or a fabrication, and both make the
    // column a worse record than leaving it empty.
    refusals.push(`fetched-at is in the future: ${input.fetchedAt}`);
  }

  if (!looksLikeText(input.artifact)) {
    refusals.push(
      "the artifact is empty or is not UTF-8 text, so no name in it can be checked; " +
        "extract the text and pass that, keeping the same source url",
    );
  }

  if (input.entries.length === 0) refusals.push("the roster is empty");

  const text = looksLikeText(input.artifact) ? searchableText(input.artifact) : "";
  const rows: PlannedMember[] = [];
  const seen = new Set<string>();

  for (const entry of input.entries) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name === "") {
      refusals.push("a roster entry has no name");
      continue;
    }
    if (!DAY_RE.test(entry.term_start)) {
      refusals.push(`${name}: term_start must be YYYY-MM-DD, got ${String(entry.term_start)}`);
      continue;
    }
    const termEnd = entry.term_end ?? null;
    if (termEnd !== null && !DAY_RE.test(termEnd)) {
      refusals.push(`${name}: term_end must be YYYY-MM-DD or null, got ${String(termEnd)}`);
      continue;
    }
    if (termEnd !== null && termEnd < entry.term_start) {
      refusals.push(`${name}: term ends before it starts`);
      continue;
    }

    const key = `${name.toLowerCase()}|${entry.term_start}`;
    if (seen.has(key)) {
      refusals.push(`${name}: listed twice for the same term start`);
      continue;
    }
    seen.add(key);

    if (text !== "" && !bytesContainName(text, name)) {
      refusals.push(`${name}: does not appear in the fetched bytes`);
      continue;
    }

    rows.push({
      jurisdiction_id: input.jurisdictionId,
      name,
      title: typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title.trim() : null,
      term_start: entry.term_start,
      term_end: termEnd,
      source_url: input.sourceUrl,
      fetched_at: Number.isNaN(fetchedAt.getTime()) ? new Date(0) : fetchedAt,
      artifact_sha256: sha256Of(input.artifact),
    });
  }

  if (refusals.length > 0) throw new RosterLoadError(refusals);
  return { artifact_sha256: sha256Of(input.artifact), rows };
}

interface Args {
  jurisdiction: string;
  artifact: string;
  sourceUrl: string;
  fetchedAt: string;
  roster: string;
  commit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { commit: false };
  const takes: Record<string, keyof Args> = {
    "--jurisdiction": "jurisdiction",
    "--artifact": "artifact",
    "--source-url": "sourceUrl",
    "--fetched-at": "fetchedAt",
    "--roster": "roster",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--commit") {
      args.commit = true;
      continue;
    }
    const key = takes[flag];
    if (key === undefined) throw new Error(`unknown flag ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (key !== "commit") args[key] = value;
    index += 1;
  }
  for (const flag of Object.keys(takes)) {
    const key = takes[flag];
    if (key !== "commit" && args[key] === undefined) throw new Error(`${flag} is required`);
  }
  return {
    jurisdiction: String(args.jurisdiction),
    artifact: String(args.artifact),
    sourceUrl: String(args.sourceUrl),
    fetchedAt: String(args.fetchedAt),
    roster: String(args.roster),
    commit: args.commit === true,
  };
}

function readEntries(path: string): RosterEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} must hold a JSON array of roster entries`);
  return parsed.map((row): RosterEntry => {
    if (typeof row !== "object" || row === null) throw new Error("a roster entry is not an object");
    const record = row as Record<string, unknown>;
    const name = record.name;
    const termStart = record.term_start;
    if (typeof name !== "string") throw new Error("a roster entry has a non-string name");
    if (typeof termStart !== "string") throw new Error(`${name}: term_start must be a string`);
    return {
      name,
      title: typeof record.title === "string" ? record.title : null,
      term_start: termStart,
      term_end: typeof record.term_end === "string" ? record.term_end : null,
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifact = readFileSync(args.artifact);
  const entries = readEntries(args.roster);

  const plan = planRosterLoad({
    jurisdictionId: args.jurisdiction,
    artifact,
    sourceUrl: args.sourceUrl,
    fetchedAt: args.fetchedAt,
    entries,
  });

  console.log(`artifact sha256 ${plan.artifact_sha256}`);
  console.log(`${plan.rows.length} seat(s) found in those bytes:`);
  for (const row of plan.rows) {
    console.log(`  ${row.name} — ${row.title ?? "no title"} — from ${row.term_start}`);
  }

  if (!args.commit) {
    console.log("Dry run. Nothing written. Re-run with --commit.");
    return;
  }

  const jurisdiction = await db("jurisdictions").where({ id: args.jurisdiction }).first();
  if (jurisdiction === undefined) throw new Error(`no jurisdiction ${args.jurisdiction}`);

  let inserted = 0;
  let updated = 0;
  // One transaction: a half-loaded roster is a body that reads partly traceable
  // and is neither state honestly.
  await db.transaction(async (trx) => {
    for (const row of plan.rows) {
      const existing = await trx("members")
        .where({ jurisdiction_id: row.jurisdiction_id, name: row.name, term_start: row.term_start })
        .first<{ id: string } | undefined>("id");
      if (existing === undefined) {
        await trx("members").insert(row);
        inserted += 1;
      } else {
        await trx("members")
          .where({ id: existing.id })
          .update({
            title: row.title,
            term_end: row.term_end,
            source_url: row.source_url,
            fetched_at: row.fetched_at,
            artifact_sha256: row.artifact_sha256,
            updated_at: db.fn.now(),
          });
        updated += 1;
      }
    }
  });

  console.log(`Wrote ${inserted} new seat(s) and re-sourced ${updated}.`);
}

// `require.main` rather than an unconditional call: this module is imported by
// its own test suite for `planRosterLoad`, and importing it must not run a load.
if (require.main === module) {
  main()
    .then(() => db.destroy())
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      await db.destroy();
      process.exitCode = 1;
    });
}
