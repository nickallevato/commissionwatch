import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import db from "../src/config/database";

/**
 * The Postgres `vote_value` enum and the frontend's vote vocabulary must not
 * drift apart.
 *
 * ## The bug this exists to prevent
 *
 * `vote_value` is a Postgres enum created in migration 010. The frontend
 * declares its own, independent, hand-written copy of that vocabulary in three
 * places: the `VoteValue` union in `types/index.ts`, and `VOTE_ORDER` and
 * `VOTE_LABEL` in `components/vote-tally.ts`. Nothing connects the two. They
 * agree today because somebody typed the same four words twice.
 *
 * Add a fifth member to the enum — `recused` is the realistic one — and every
 * check this repository runs still passes. The migration is valid SQL. The
 * backend typechecks, because it reads the value as a string. The frontend
 * typechecks, because its union is a separate declaration that knows nothing
 * about the database. The frontend's own unit tests pass, because they assert
 * `VOTE_ORDER` against a literal list written in the same style by the same
 * hand.
 *
 * What happens instead is a runtime fault on a public page. `tallyVotes` seeds
 * a counts object with exactly the four keys it knows and then runs
 * `counts[vote.vote] += 1`; for a member it has never heard of that is
 * `undefined + 1`, which is **NaN**, and the meeting page renders the tally
 * with a NaN in it. The recused vote is not miscounted — it is absent from the
 * count entirely, while the page goes on presenting the tally as complete.
 *
 * That is the exact failure mode `CLAUDE.md` names: *"A frontend type that
 * compiles but misnames a column is a runtime bug typechecking cannot catch —
 * and it is exactly how `main` broke."* The database is the source of truth for
 * types; this test is what makes that sentence enforceable rather than
 * aspirational.
 *
 * ## Why it reads the frontend as text
 *
 * The backend cannot import from the frontend — separate packages, separate
 * tsconfigs, no dependency between them, and creating one so a test can run
 * would be a large architectural change bought for a small guard. So the
 * frontend sources are read from disk as the artefacts they are, the same way
 * `workflow-monitor-env.test.ts` reads the workflow YAML rather than adding a
 * YAML parser. A guard that needs a new dependency acquires a reason not to
 * run.
 *
 * The cost is honest and worth stating: this matches on source text, so it
 * verifies the *declarations* rather than the compiled types. A sufficiently
 * exotic rewrite of those declarations would defeat the matcher — which is why
 * the matcher fails loudly when it finds nothing at all, rather than comparing
 * two empty sets and reporting success.
 *
 * ## Why the enum is read from the live database
 *
 * Reading migration 010's `CREATE TYPE` text would only prove that the
 * migration agrees with the frontend. A later migration can `ALTER TYPE ... ADD
 * VALUE`, and that is the likelier way a fifth member arrives. `pg_enum` is
 * what the running system actually enforces, so `pg_enum` is what gets asked.
 */

const FRONTEND = path.resolve(__dirname, "..", "..", "frontend", "src");

const TYPES_FILE = path.join(FRONTEND, "types", "index.ts");
const TALLY_FILE = path.join(FRONTEND, "components", "vote-tally.ts");

/**
 * Read the members of a Postgres enum type, in the order the type declares
 * them. `enumsortorder` is the declared order, which is also the order the
 * frontend renders a tally in, so ordering is compared rather than ignored.
 */
async function enumMembers(typeName: string): Promise<string[]> {
  const result = await db.raw(
    `select e.enumlabel as label
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = ?
      order by e.enumsortorder`,
    [typeName],
  );
  const rows = result.rows as Array<{ label: string }>;
  return rows.map((row) => row.label);
}

/**
 * Every matcher below anchors the identifier with `\b`.
 *
 * Without it the name is matched as a *prefix*, and `VOTE_ORDER` happily
 * matches a declaration renamed to `VOTE_ORDER_RENAMED` — so the guard would
 * keep reading a constant the interface no longer uses and report success.
 * This was not theoretical: the first version of this file omitted the anchor,
 * and the mutation that renamed the declaration passed. `_` is a word
 * character, so `\b` is exactly what refuses the suffixed name.
 */

/** Extract the string-literal members of `export type <name> = "a" | "b";`. */
function unionMembers(source: string, name: string): string[] {
  const declaration = new RegExp(
    `export type ${name}\\b\\s*=\\s*([^;]+);`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Extract the string-literal entries of `export const <name> ... = [...]`. */
function arrayMembers(source: string, name: string): string[] {
  const declaration = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Extract the keys of `export const <name>: Record<...> = { a: "A", ... }`. */
function recordKeys(source: string, name: string): string[] {
  const declaration = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\{([^}]*)\\}`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
    (match) => match[1],
  );
}

describe("the vote_value enum and the frontend vote vocabulary", () => {
  let dbMembers: string[];
  let typesSource: string;
  let tallySource: string;

  before(async () => {
    dbMembers = await enumMembers("vote_value");
    typesSource = readFileSync(TYPES_FILE, "utf8");
    tallySource = readFileSync(TALLY_FILE, "utf8");
  });

  after(async () => {
    await db.destroy();
  });

  it("the database declares a vote_value enum with members", () => {
    assert.ok(
      dbMembers.length > 0,
      "no vote_value enum found in pg_enum — either the migrations have not " +
        "run against this database, or the type was renamed. Either way this " +
        "test cannot compare anything, and reporting success would be a lie.",
    );
  });

  it("the frontend VoteValue union matches the database enum exactly", () => {
    const frontend = unionMembers(typesSource, "VoteValue");
    assert.ok(
      frontend.length > 0,
      `could not find an "export type VoteValue = ..." declaration in ` +
        `${TYPES_FILE}. The matcher is broken, or the declaration moved — ` +
        "this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      [...frontend].sort(),
      [...dbMembers].sort(),
      "the frontend VoteValue union has drifted from the Postgres vote_value " +
        "enum. The database is the source of truth: a member it stores and " +
        "the interface does not know about is counted as NaN by tallyVotes " +
        "and vanishes from a tally the page still presents as complete.",
    );
  });

  it("VOTE_ORDER lists every enum member, in the enum's declared order", () => {
    const order = arrayMembers(tallySource, "VOTE_ORDER");
    assert.ok(
      order.length > 0,
      `could not find "export const VOTE_ORDER = [...]" in ${TALLY_FILE}. ` +
        "The matcher is broken — this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      order,
      dbMembers,
      "VOTE_ORDER and the vote_value enum disagree. Order is compared, not " +
        "just membership, because VOTE_ORDER is the order a tally renders in " +
        "and the enum's declared order is the one the record uses.",
    );
  });

  it("VOTE_LABEL has a label for every enum member and no extras", () => {
    const keys = recordKeys(tallySource, "VOTE_LABEL");
    assert.ok(
      keys.length > 0,
      `could not find "export const VOTE_LABEL = { ... }" in ${TALLY_FILE}. ` +
        "The matcher is broken — this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      [...keys].sort(),
      [...dbMembers].sort(),
      "VOTE_LABEL and the vote_value enum disagree. A member with no label " +
        "renders as undefined in the interface; a label with no member is a " +
        "vote vocabulary the record cannot produce.",
    );
  });
});
