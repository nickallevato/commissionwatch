import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import db from "../src/config/database";

/**
 * The Postgres `vote_value` enum and every hand-written copy of that
 * vocabulary — frontend and backend — must not drift apart.
 *
 * ## What this file covers, exactly
 *
 * An earlier version of this file checked three places and its own docblock
 * read as though it covered "the vote vocabulary." It covered two names in
 * one file and a docblock's worth of confidence. Grepping the repository for
 * every place that spells out `yes` / `no` / `abstain` / `absent` as a closed
 * set found **ten** hand-written copies. This file now checks all ten. The
 * list, with what each one is *for*:
 *
 *  1. `frontend/src/types/index.ts` — the `VoteValue` union. The type every
 *     other frontend vote-value type ultimately depends on.
 *  2. `frontend/src/components/vote-tally.ts` — `VOTE_ORDER`. The render
 *     order for a tally.
 *  3. `frontend/src/components/vote-tally.ts` — `VOTE_LABEL`. The English
 *     word shown for each value.
 *  4. `backend/src/services/vote-events.ts` — `VOTE_OPTIONS`. Validates
 *     `vote_events.counts` on read, and is the source `VoteCounts` and
 *     `VoteTallyCheck` are built from.
 *  5. `backend/src/routes/votes.ts` — `VALID_VOTES`. **The dangerous one.**
 *     It validates an incoming vote at `POST /api/votes` before the row ever
 *     reaches Postgres. If the enum gains a member this list does not know
 *     about, a legitimate vote is rejected at the door — the enum-vs-frontend
 *     guard alone would stay green while that happened, because it never
 *     looks at this file.
 *  6. `backend/src/services/officials.ts` — the inline union type on
 *     `VoteRow.vote`. Types every vote row `buildProfile` reads before
 *     bucketing it into a record.
 *  7. `frontend/src/components/officials/VoteBar.tsx` — the `key` field of
 *     each `SEGMENTS` entry. Drives which bar segment and legend line each
 *     vote value gets; a value missing here silently renders no segment for
 *     real votes.
 *  8. `backend/src/services/officials.ts` — the `VotingRecord` interface
 *     (`yes` / `no` / `abstain` / `absent`, excluding `total`). The shape
 *     `buildProfile` increments a vote count into.
 *  9. `frontend/src/types/index.ts` — the `OfficialVotingRecord` interface.
 *     The frontend's independent copy of the same shape, rendered by
 *     `VoteBar.tsx` and `OfficialsPage.tsx`.
 * 10. `frontend/src/components/MemberCard.tsx` — the `MemberVotingRecord`
 *     interface. A third, separate copy of the same shape, rendered by
 *     `MemberCard.tsx` on the roster page.
 *
 * For 8–10: a vote value missing from one of these record interfaces does not
 * NaN the way `tallyVotes` does. It compiles, the object literal that seeds
 * it (`{ yes: 0, no: 0, abstain: 0, absent: 0, total: 0 }`) still typechecks,
 * and a member's real vote of the new kind is simply never added to any
 * field — an official's record silently undercounts forever. Quieter than a
 * NaN, not less wrong.
 *
 * ## What is deliberately NOT checked here, and why that is safe
 *
 * `frontend/src/components/VoteBreakdown.tsx`'s `voteColor` and
 * `frontend/src/components/vote-tally.ts`'s `VoteTally` type are each
 * declared as `Record<VoteValue, string>` / `Record<VoteValue, number>` —
 * mapped types keyed directly off `VoteValue` (copy 1), not independent
 * hand-typed lists. TypeScript's excess/missing-property checking on a
 * `Record<VoteValue, _>` object literal already refuses to compile if a
 * member of `VoteValue` has no entry, so these are guarded transitively by
 * copy 1 plus `tsc`, not by this file. The mutation section below confirms
 * this holds rather than asserting it.
 *
 * `backend/src/services/vote-events.ts`'s `VoteCounts` type
 * (`Record<VoteOption, number>`) is likewise a mapped type off `VoteOption`,
 * which is derived from `VOTE_OPTIONS` (copy 4) via `(typeof VOTE_OPTIONS)[number]`
 * — one guard, not two.
 *
 * ## The bug this exists to prevent
 *
 * `vote_value` is a Postgres enum created in migration 010. Every copy above
 * is an independent, hand-written restatement of it. Nothing connects them
 * to the database or to each other. They agree today because somebody typed
 * the same four words correctly, ten separate times.
 *
 * Add a fifth member to the enum — `recused` is the realistic one — and every
 * check this repository ran *before this file grew* still passed. The
 * migration is valid SQL. The backend typechecks, because most of these read
 * the value as a plain string. The frontend typechecks, because each union or
 * interface is a separate declaration that knows nothing about the database.
 * Existing unit tests pass, because they assert a copy against a literal list
 * written in the same style by the same hand.
 *
 * What happens instead is a family of runtime faults, all silent until
 * something depends on the missing member: `tallyVotes` seeds a counts object
 * with exactly the four keys it knows and runs `counts[vote.vote] += 1`; for a
 * member it has never heard of that is `undefined + 1`, which is **NaN**, and
 * the meeting page renders the tally with a NaN in it. `VALID_VOTES` rejects
 * the vote at the API boundary before it is ever stored. The three record
 * interfaces undercount forever without erroring.
 *
 * That is the exact failure mode `CLAUDE.md` names: *"A frontend type that
 * compiles but misnames a column is a runtime bug typechecking cannot catch —
 * and it is exactly how `main` broke."* The database is the source of truth for
 * types; this test is what makes that sentence enforceable rather than
 * aspirational.
 *
 * ## Why it reads source as text
 *
 * The backend cannot import from the frontend — separate packages, separate
 * tsconfigs, no dependency between them, and creating one so a test can run
 * would be a large architectural change bought for a small guard. So every
 * file below is read from disk as the artefact it is, the same way
 * `workflow-monitor-env.test.ts` reads the workflow YAML rather than adding a
 * YAML parser. A guard that needs a new dependency acquires a reason not to
 * run. Backend sources are read as text too, for consistency and because a
 * text matcher is what makes a mutation test of this file meaningful: it
 * proves the matcher, not the compiler, is doing the checking.
 *
 * The cost is honest and worth stating: this matches on source text, so it
 * verifies the *declarations* rather than the compiled types. A sufficiently
 * exotic rewrite of those declarations would defeat a matcher — which is why
 * every matcher below fails loudly when it finds nothing at all, rather than
 * comparing two empty sets and reporting success. Every matcher name is
 * anchored with `\b` for the reason given below: a prefix match let a rename
 * slip past this file once already.
 *
 * ## Why the enum is read from the live database
 *
 * Reading migration 010's `CREATE TYPE` text would only prove that the
 * migration agrees with the copies. A later migration can `ALTER TYPE ... ADD
 * VALUE`, and that is the likelier way a fifth member arrives. `pg_enum` is
 * what the running system actually enforces, so `pg_enum` is what gets asked.
 */

const FRONTEND = path.resolve(__dirname, "..", "..", "frontend", "src");

const TYPES_FILE = path.join(FRONTEND, "types", "index.ts");
const TALLY_FILE = path.join(FRONTEND, "components", "vote-tally.ts");
const VOTE_BAR_FILE = path.join(FRONTEND, "components", "officials", "VoteBar.tsx");
const MEMBER_CARD_FILE = path.join(FRONTEND, "components", "MemberCard.tsx");

const BACKEND = path.resolve(__dirname, "..", "src");
const VOTE_EVENTS_FILE = path.join(BACKEND, "services", "vote-events.ts");
const VOTES_ROUTE_FILE = path.join(BACKEND, "routes", "votes.ts");
const OFFICIALS_FILE = path.join(BACKEND, "services", "officials.ts");

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

/**
 * Extract the string-literal entries of `const <name> ... = [...]`, exported
 * or not. `backend/src/routes/votes.ts`'s `VALID_VOTES` is module-private —
 * `export` is never in front of it — so this cannot reuse {@link arrayMembers},
 * which requires the `export` keyword as part of what makes its match unique.
 */
function constArrayMembers(source: string, name: string): string[] {
  const declaration = new RegExp(
    `(?<!export )const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Extract the string-literal members of an inline union type on a struct
 * field: `fieldName: "a" | "b" | "c";`. Requires at least one `|`, so a
 * single-valued object property (`vote: "absent"` inside a `.whereNot({...})`
 * call, say) can never match — those have no pipe and are not a vocabulary
 * declaration at all.
 */
function inlineUnionFieldMembers(source: string, fieldName: string): string[] {
  const declaration = new RegExp(
    `\\b${fieldName}:\\s*("[^"]+"(?:\\s*\\|\\s*"[^"]+")+)\\s*;`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Extract the `key: "..."` value of every object literal inside
 * `const <name> ... = [ { key: "a", ... }, ... ];` — the shape
 * `VoteBar.tsx`'s `SEGMENTS` uses to pair a vote value with its bar segment.
 */
function objectArrayKeyMembers(source: string, name: string): string[] {
  const declaration = new RegExp(
    `const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/\bkey:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/**
 * Extract the field names of `(export )?interface <name> { a: T; b: U; ... }`,
 * excluding any name in `exclude` — every one of the three record shapes below
 * also carries a `total: number` field that is not a vote value.
 */
function interfaceFields(source: string, name: string, exclude: string[] = []): string[] {
  const declaration = new RegExp(
    `interface ${name}\\b\\s*\\{([^}]*)\\}`,
    "m",
  ).exec(source);
  if (declaration === null) return [];
  const fields = [...declaration[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map(
    (match) => match[1],
  );
  return fields.filter((field) => !exclude.includes(field));
}

describe("the vote_value enum and every hand-written copy of it", () => {
  let dbMembers: string[];
  let typesSource: string;
  let tallySource: string;
  let voteBarSource: string;
  let memberCardSource: string;
  let voteEventsSource: string;
  let votesRouteSource: string;
  let officialsSource: string;

  before(async () => {
    dbMembers = await enumMembers("vote_value");
    typesSource = readFileSync(TYPES_FILE, "utf8");
    tallySource = readFileSync(TALLY_FILE, "utf8");
    voteBarSource = readFileSync(VOTE_BAR_FILE, "utf8");
    memberCardSource = readFileSync(MEMBER_CARD_FILE, "utf8");
    voteEventsSource = readFileSync(VOTE_EVENTS_FILE, "utf8");
    votesRouteSource = readFileSync(VOTES_ROUTE_FILE, "utf8");
    officialsSource = readFileSync(OFFICIALS_FILE, "utf8");
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

  it("backend VOTE_OPTIONS (vote-events.ts) lists every enum member, in order", () => {
    const options = arrayMembers(voteEventsSource, "VOTE_OPTIONS");
    assert.ok(
      options.length > 0,
      `could not find "export const VOTE_OPTIONS = [...]" in ${VOTE_EVENTS_FILE}. ` +
        "The matcher is broken — this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      options,
      dbMembers,
      "VOTE_OPTIONS and the vote_value enum disagree. VOTE_OPTIONS is what " +
        "readCounts() validates vote_events.counts against and what VoteCounts " +
        "is keyed on — a member missing here is silently unrepresentable in " +
        "any stored tally.",
    );
  });

  it("backend VALID_VOTES (routes/votes.ts) lists every enum member — the vote is rejected at the door otherwise", () => {
    const valid = constArrayMembers(votesRouteSource, "VALID_VOTES");
    assert.ok(
      valid.length > 0,
      `could not find "const VALID_VOTES = [...]" in ${VOTES_ROUTE_FILE}. ` +
        "The matcher is broken — this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      [...valid].sort(),
      [...dbMembers].sort(),
      "VALID_VOTES and the vote_value enum disagree. This is the dangerous " +
        "direction: VALID_VOTES gates POST /api/votes, so a member the enum " +
        "has and this list does not means a legitimate vote of that kind is " +
        "rejected with 400 before it ever reaches Postgres.",
    );
  });

  it("officials.ts VoteRow.vote's inline union lists every enum member", () => {
    const members = inlineUnionFieldMembers(officialsSource, "vote");
    assert.ok(
      members.length > 0,
      `could not find a "vote: \\"a\\" | \\"b\\" | ...;" union field in ` +
        `${OFFICIALS_FILE}. The matcher is broken, or the declaration moved — ` +
        "this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      [...members].sort(),
      [...dbMembers].sort(),
      "VoteRow.vote's union type has drifted from the vote_value enum. Every " +
        "vote officials.ts reads is typed through this field before it is " +
        "bucketed into a VotingRecord.",
    );
  });

  it("VoteBar.tsx SEGMENTS has a bar segment for every enum member and no extras", () => {
    const keys = objectArrayKeyMembers(voteBarSource, "SEGMENTS");
    assert.ok(
      keys.length > 0,
      `could not find "const SEGMENTS = [ { key: ..., ... }, ... ]" in ` +
        `${VOTE_BAR_FILE}. The matcher is broken — this is a failure of the ` +
        "guard, not a pass.",
    );
    assert.deepEqual(
      [...keys].sort(),
      [...dbMembers].sort(),
      "SEGMENTS and the vote_value enum disagree. A member missing here " +
        "renders no bar segment and no legend entry for a real vote; a key " +
        "with no enum member is a segment the record can never populate.",
    );
  });

  it("officials.ts VotingRecord has a field for every enum member", () => {
    const fields = interfaceFields(officialsSource, "VotingRecord", ["total"]);
    assert.ok(
      fields.length > 0,
      `could not find "interface VotingRecord { ... }" in ${OFFICIALS_FILE}. ` +
        "The matcher is broken — this is a failure of the guard, not a pass.",
    );
    assert.deepEqual(
      [...fields].sort(),
      [...dbMembers].sort(),
      "VotingRecord and the vote_value enum disagree. A member missing here " +
        "does not crash — the object literal that seeds a fresh record still " +
        "typechecks — it just means that vote is never added to any field, " +
        "and an official's record undercounts silently forever.",
    );
  });

  it("types/index.ts OfficialVotingRecord has a field for every enum member", () => {
    const fields = interfaceFields(typesSource, "OfficialVotingRecord", ["total"]);
    assert.ok(
      fields.length > 0,
      `could not find "export interface OfficialVotingRecord { ... }" in ` +
        `${TYPES_FILE}. The matcher is broken — this is a failure of the ` +
        "guard, not a pass.",
    );
    assert.deepEqual(
      [...fields].sort(),
      [...dbMembers].sort(),
      "OfficialVotingRecord and the vote_value enum disagree — the same " +
        "silent-undercount failure as VotingRecord, on the frontend's own " +
        "copy of the shape.",
    );
  });

  it("MemberCard.tsx MemberVotingRecord has a field for every enum member", () => {
    const fields = interfaceFields(memberCardSource, "MemberVotingRecord", ["total"]);
    assert.ok(
      fields.length > 0,
      `could not find "export interface MemberVotingRecord { ... }" in ` +
        `${MEMBER_CARD_FILE}. The matcher is broken — this is a failure of ` +
        "the guard, not a pass.",
    );
    assert.deepEqual(
      [...fields].sort(),
      [...dbMembers].sort(),
      "MemberVotingRecord and the vote_value enum disagree — a third, " +
        "independent copy of the same record shape with the same silent-" +
        "undercount failure.",
    );
  });
});
