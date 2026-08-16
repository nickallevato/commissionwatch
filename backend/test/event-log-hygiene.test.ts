import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import knex from "knex";
import db from "../src/config/database";
import {
  assertTestDatabase,
  leakedEvents,
  nonTestConnectionUrl,
  truncateEvents,
} from "./helpers/events";
import { testFilesFromTestScript } from "./helpers/run-coverage";

/**
 * The suite whose subject is the run itself.
 *
 * ## The three-part mechanism this file holds in place
 *
 * `events` is append-only by design (migration 083: "Retention: never delete"),
 * and the two consumers that read it — `PrerenderConsumer` and `EventDrain` —
 * read a bounded batch in key order. Once the table holds more than a batch of
 * rows older than a suite's fixtures, that suite's ticks are spent on unrelated
 * rows and never reach the fixtures at all. The failure that surfaced was
 * `prerender.test.ts` reporting "a withdrawn meeting kept its prerendered page",
 * with nothing wrong in the code under test.
 *
 *  1. **`pretest`** clears the log, so a run starts on clean soil however many
 *     ad-hoc runs preceded it (`helpers/reset-events.ts`).
 *  2. **The suites** delete what they emit — `cleanupByPrefix` for anything on
 *     the standard fixtures, by hand for the rest.
 *  3. **`posttest`** fails the run if anything was left, naming the rows
 *     (`helpers/assert-events-clean.ts`).
 *
 * ## Why the leak check is not an assertion in this file
 *
 * Because it could not be a correct one. **`node --test` sorts the files it is
 * given**, so listing this file last in `package.json` does not make it run
 * last: it ran 114th of 403 top-level suites, where it would have reported
 * every suite that had not yet run as clean — a guard that is green precisely
 * because it is looking too early. `node --test test/version.test.ts
 * test/health.test.ts` runs `health` first; that is the whole proof.
 *
 * `posttest` has no ordering assumption to get wrong. What is left here is
 * everything that is order-independent — and one assertion that the `posttest`
 * hook still exists, because a mechanism that lives in a single npm script is
 * one careless edit from being gone with nothing to say so.
 */

/**
 * `__dirname`, not `import.meta.dirname` — tsx transpiles this suite to
 * CommonJS, the same reason `migrations-selfcontained.test.ts` gives.
 */
const PACKAGE_JSON = join(__dirname, "..", "package.json");
const TEST_DIR = __dirname;

/**
 * The one file deliberately outside `npm test`: it needs MinIO, and it has its
 * own `test:storage` script. The exemption is named here rather than implied,
 * and the script it names is asserted to exist.
 */
const NOT_IN_NPM_TEST = new Set(["test/storage.integration.test.ts"]);

function npmScript(name: "test" | "test:storage" | "test:coverage" | "pretest" | "posttest"): string {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    throw new Error("package.json has no scripts block");
  }
  const scripts = parsed.scripts;
  if (typeof scripts !== "object" || scripts === null) {
    throw new Error("package.json's scripts block is not an object");
  }
  const record: Record<string, unknown> = { ...scripts };
  const script = record[name];
  if (typeof script !== "string") throw new Error(`package.json has no ${name} script`);
  return script;
}

function testFilesOnDisk(directory: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...testFilesOnDisk(join(directory, entry.name), `${path}/`));
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * The trap this closes.
 *
 * `package.json`'s `test` script is an **explicit list of files**, not a glob.
 * A new suite that is not added to it never runs, and nothing says so — the run
 * is green and the tests simply do not exist. It has cost this repo four suites
 * and 135 tests once already (see `helpers/expect.ts`).
 *
 * That trap is what makes it worth asserting here rather than somewhere else:
 * the guard below is only a guard while it is in the list, so the suite that
 * catches a forgotten teardown also catches its own removal.
 */
describe("every suite on disk is in the run", () => {
  it("lists every test file in package.json's test script", () => {
    const script = npmScript("test");
    const listed = new Set(script.split(/\s+/).filter((token) => token.endsWith(".test.ts")));
    const onDisk = testFilesOnDisk(TEST_DIR, "test/");

    const missing = onDisk.filter((file) => !listed.has(file) && !NOT_IN_NPM_TEST.has(file));
    assert.deepEqual(
      missing,
      [],
      `these suites exist and never run — add them to package.json's "test" script:\n` +
        missing.map((file) => `  ${file}`).join("\n"),
    );

    const stale = [...listed].filter((file) => !onDisk.includes(file));
    assert.deepEqual(stale, [], `the test script names files that do not exist: ${stale.join(" ")}`);
  });

  it("gives the one exempt suite a script of its own", () => {
    const storage = npmScript("test:storage");
    for (const file of NOT_IN_NPM_TEST) {
      assert.ok(storage.includes(file), `${file} is exempt from npm test but no script runs it`);
    }
  });

  /**
   * `test:coverage` used to be a second hand-typed copy of this same file
   * list, and it had already drifted (missing `test/logger.test.ts`,
   * `test/request-context.test.ts`, `test/admin-errors.test.ts`) before
   * anyone noticed — the coverage baseline was blind to the newest code in
   * the tree while this very guard was green, because this guard only ever
   * read the `test` script. `test:coverage` now derives its file list from
   * `test` at run time (`test/helpers/run-coverage.ts`) instead of restating
   * it, so there is exactly one list to keep in sync. These two assertions
   * hold that in place: the script still delegates rather than reverting to
   * an inline list, and the derivation actually reproduces the same file set
   * this test already verified against disk.
   */
  it("test:coverage delegates to the single-source file list instead of restating it", () => {
    const coverageScript = npmScript("test:coverage");
    assert.match(
      coverageScript,
      /run-coverage\.ts/,
      "test:coverage no longer runs test/helpers/run-coverage.ts — if it now " +
        "lists .test.ts files inline again, the two-list drift this guard " +
        "exists to prevent is back.",
    );
    assert.doesNotMatch(
      coverageScript,
      /\.test\.ts/,
      "test:coverage's script string names a .test.ts file directly — it " +
        "should derive the list from the `test` script, not restate it.",
    );
  });

  it("test:coverage's derived file list matches the test script's, exactly", () => {
    const script = npmScript("test");
    const listed = new Set(script.split(/\s+/).filter((token) => token.endsWith(".test.ts")));
    const derived = new Set(testFilesFromTestScript());
    assert.deepEqual(
      [...derived].sort(),
      [...listed].sort(),
      "test/helpers/run-coverage.ts derived a different file list than " +
        "package.json's test script actually contains.",
    );
  });
});

describe("the event log is left as the run found it", () => {
  it("refuses to clear an event log outside the test database", async () => {
    // A real second connection, to a database that genuinely is not the test
    // one. `postgres` exists on every server and is never this project's.
    const elsewhere = knex({
      client: "pg",
      connection: nonTestConnectionUrl(),
      pool: { min: 0, max: 1 },
    });
    try {
      await assert.rejects(
        () => assertTestDatabase(elsewhere),
        /does not end in "_test"/,
        "the guard accepted a database that is not the test database",
      );
      // And the truncate is the guard plus a TRUNCATE, in that order, so it
      // refuses for the same reason rather than merely being documented to.
      await assert.rejects(
        () => truncateEvents(elsewhere),
        /does not end in "_test"/,
        "truncateEvents ran the guard after the delete, or not at all",
      );
    } finally {
      await elsewhere.destroy();
    }
  });

  it("accepts the test database it is actually connected to", async () => {
    const name = await assertTestDatabase(db);
    assert.match(name, /_test$/);
  });

  /**
   * The leak check itself runs in `posttest`, for the ordering reason in this
   * file's header. That makes it the one part of the mechanism with nothing
   * asserting it exists, so this does — both hooks, by the script they run.
   */
  it("keeps the clear-before and check-after hooks wired to npm", () => {
    assert.match(
      npmScript("pretest"),
      /test\/helpers\/reset-events\.ts/,
      "pretest no longer clears the event log, so a run starts on whatever the last one left",
    );
    assert.match(
      npmScript("posttest"),
      /test\/helpers\/assert-events-clean\.ts/,
      "posttest no longer checks the event log, so a suite that leaks events fails nothing",
    );
  });

  /**
   * `leakedEvents` is the reporting half of the check, and a query that grouped
   * or counted wrongly would make the `posttest` failure unreadable — or, if it
   * returned nothing, silent. This exercises it against rows this test owns.
   */
  it("reports what is in the log, grouped and with an example", async () => {
    const dedupeKey = `ops.hygiene-probe:${randomUUID()}`;
    await db("events").insert({
      event_type: "ops.hygiene-probe",
      subject_kind: "ops",
      dedupe_key: dedupeKey,
    });
    try {
      const mine = (await leakedEvents(db)).filter(
        (group) => group.event_type === "ops.hygiene-probe",
      );
      assert.deepEqual(mine, [
        {
          event_type: "ops.hygiene-probe",
          subject_kind: "ops",
          count: 1,
          sample_dedupe_key: dedupeKey,
        },
      ]);
    } finally {
      // This suite is not exempt from the rule it enforces.
      await db("events").where({ dedupe_key: dedupeKey }).del();
    }
  });
});

after(async () => {
  await db.destroy();
});
