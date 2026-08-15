import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every public router either reaches the wall or says why it does not.
 *
 * On 2026-08-15 `GET /api/votes` was found serving **every row of the `votes`
 * table**, published or not. It disclosed the `meeting_id` of every meeting an
 * operator had ingested and withheld — the enumeration `findPublishedMeeting`
 * answers 404 rather than 403 to prevent — and it published how a named
 * official voted at a meeting nobody had approved. The `POST` handler on the
 * next line of that same file says "a vote row is this project's core published
 * claim about how a named official acted. Writing one is an operator act."
 * Reading one was not.
 *
 * It had never leaked only because no vote row had been ingested yet.
 *
 * Nothing caught it. `publication.ts`'s own header says the rule "has to be one
 * rule in one place", and `meeting-publication.test.ts` "walks every public path
 * that takes a meeting id" — but `/api/votes?meeting_id=` was one of those paths
 * and was not walked, because that suite enumerates paths by hand and a hand-kept
 * list beside a growing router drifts by default rather than by accident. Both
 * documents were describing an intention, not a property.
 *
 * This test measures the property. It is deliberately structural rather than
 * behavioural: a behavioural test can only assert about routes somebody thought
 * to write it for, and the failure here was a route nobody thought about.
 *
 * The rule: a router under `src/routes/` that names a walled table in a knex
 * call must do at least one of
 *
 *   - import from `services/publication`, or
 *   - apply `requireOperator` to the whole router, or
 *   - appear in `ALLOWED` below with a written reason.
 *
 * A router that delegates to a walled service names no table and is not in
 * scope; the services carry their own tests. This checks the files where a
 * `db("meetings")` can be typed straight into a public handler, which is where
 * it was.
 */

const ROUTES = join(__dirname, "..", "src", "routes");

/**
 * Tables whose rows are, or describe, something an operator decides to publish.
 *
 * `members` is deliberately absent from the exemptions and present here: the
 * roster is public by design, which is a decision, and the decision is recorded
 * in `ALLOWED` rather than by quietly leaving the table off this list.
 */
const WALLED_TABLES = new Set([
  "meetings",
  "agenda_items",
  "meeting_documents",
  "anomaly_flags",
  "minute_claims",
  "votes",
  "matters",
  "place_links",
  "members",
  "transcript_cues",
  "vote_events",
]);

/** A router that touches a walled table without the wall, and why that is right. */
const ALLOWED: Readonly<Record<string, string>> = {
  // The roster is public on purpose: a sitting official's name is not a record
  // an operator withholds, it is the index the records are read through. It is
  // also unsourced, which is a different problem, disclosed by
  // `roster_sourced: false` on /api/metrics and in the reader's words on
  // /metrics — not one this wall would fix.
  "members.ts": "the roster is public by design; its problem is provenance, not publication",
};

function knexTables(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/db\(\s*["'](\w+)["']/g)) {
    if (WALLED_TABLES.has(match[1])) found.add(match[1]);
  }
  // `.from("meetings")` and `.join("meetings", …)` reach the same rows.
  for (const match of source.matchAll(/\.(?:from|join|leftJoin|innerJoin)\(\s*["'](\w+)["']/g)) {
    if (WALLED_TABLES.has(match[1])) found.add(match[1]);
  }
  return [...found].sort();
}

describe("the publication wall is reached by every public router that needs it", () => {
  it("finds no router naming a walled table without the wall, a guard, or a reason", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(ROUTES)) {
      // `src/routes/admin/` is a directory and is not read: everything under it
      // sits behind `requireOperator` in `admin/index.ts`, and the console must
      // see unpublished rows — that is its entire job.
      if (!file.endsWith(".ts")) continue;

      const source = readFileSync(join(ROUTES, file), "utf8");
      const tables = knexTables(source);
      if (tables.length === 0) continue;

      const walled = /from ["']\.\.\/services\/publication["']/.test(source);
      const guarded = /router\.use\(requireOperator\)/.test(source);
      if (walled || guarded || ALLOWED[file]) continue;

      offenders.push(`${file} queries ${tables.join(", ")}`);
    }

    assert.deepEqual(
      offenders,
      [],
      `these public routers read a walled table and never ask publication.ts whether they may: ${offenders.join("; ")}`,
    );
  });

  /**
   * The exemptions are the weak point of a test like this — an allow-list is
   * how a guard quietly stops guarding. So an entry must name a file that
   * exists and still queries a walled table; when it stops doing either, the
   * exemption is stale and has to be removed rather than left as cover for
   * whatever is written there next.
   */
  it("carries no stale exemption", () => {
    const files = new Set(readdirSync(ROUTES).filter((name) => name.endsWith(".ts")));

    for (const [file, reason] of Object.entries(ALLOWED)) {
      assert.ok(files.has(file), `ALLOWED names ${file}, which no longer exists`);
      assert.ok(reason.length > 20, `${file} is exempted with no real reason`);

      const source = readFileSync(join(ROUTES, file), "utf8");
      assert.ok(
        knexTables(source).length > 0,
        `${file} no longer queries a walled table; its exemption is stale`,
      );
    }
  });

  /**
   * The guard is worth nothing if its own extractor cannot see a query. This
   * asserts it against the file the whole test was written for: `votes.ts`
   * queries `votes` and reaches the wall, and if the extractor ever stops
   * seeing one of those, the assertion above starts passing for the wrong
   * reason.
   */
  it("can actually see a query, checked against the route that failed", () => {
    const source = readFileSync(join(ROUTES, "votes.ts"), "utf8");
    assert.ok(knexTables(source).includes("votes"), "the extractor cannot see db(\"votes\")");
    assert.match(source, /from ["']\.\.\/services\/publication["']/);
    assert.match(source, /whereMeetingPublished/);
  });
});
