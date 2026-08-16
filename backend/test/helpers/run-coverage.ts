/**
 * `test:coverage`'s driver — the fix for the drift `event-log-hygiene.test.ts`
 * only ever guarded half of.
 *
 * ## The trap this closes
 *
 * `package.json` used to carry the test-file list twice: once as the literal
 * argument list on `test`, once again, hand-typed, on `test:coverage`. They
 * diverged the same day a third hand-maintained list drifted elsewhere in this
 * repo (the vote vocabulary, the palette) — `test:coverage` was missing
 * `test/logger.test.ts`, `test/request-context.test.ts` and
 * `test/admin-errors.test.ts`, so the coverage baseline was blind to the
 * newest code in the tree while every other guard in this file's neighbourhood
 * (`event-log-hygiene.test.ts`) was green, because that guard reads the `test`
 * script only.
 *
 * The fix is not to re-sync the two lists — that recreates the same trap with
 * a fresh copy the next time a suite is added. Instead there is now exactly
 * **one** list: `package.json`'s `test` script. This script reads it back out
 * and runs the same files under `--experimental-test-coverage`. A suite added
 * to `test` is in the coverage run automatically; nothing here can drift from
 * it because nothing here restates it.
 *
 * ## Why a script and not another npm one-liner
 *
 * The extraction (`node -pe "require(...).scripts.test.match(...)"` spliced
 * into a single quoted npm script string) is exactly the kind of thing that
 * silently breaks the next time someone edits the `test` script and cannot
 * read the regex through three layers of shell quoting. A small, typed,
 * commented file that a test can import and exercise directly is worth the
 * extra file.
 *
 * ## Behaviour preserved from the old inline script
 *
 * `npm run pretest && <run> ; npm run posttest` — `pretest` still gates the
 * run (a failed migrate/seed means no test run and no posttest), and
 * `posttest` still runs unconditionally afterward, whatever the test run's own
 * exit code was. That is unchanged; only where the file list comes from
 * changed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const PACKAGE_JSON = join(ROOT, "package.json");

/**
 * Exported so `test/coverage-drift.test.ts`-style suites can assert the
 * extraction itself rather than only the end-to-end run.
 */
export function testFilesFromTestScript(packageJsonPath: string = PACKAGE_JSON): string[] {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    throw new Error("package.json has no scripts block");
  }
  const scripts = (parsed as { scripts: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) {
    throw new Error("package.json's scripts block is not an object");
  }
  const record = scripts as Record<string, unknown>;
  const testScript = record.test;
  if (typeof testScript !== "string") throw new Error("package.json has no test script");

  const files = testScript.split(/\s+/).filter((token) => token.endsWith(".test.ts"));
  if (files.length === 0) {
    throw new Error("no .test.ts files found in package.json's test script");
  }
  return files;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(): void {
  const pretestStatus = run("npm", ["run", "pretest"]);
  if (pretestStatus !== 0) process.exit(pretestStatus);

  const files = testFilesFromTestScript();
  run(
    "node",
    ["--import", "tsx", "--test", "--experimental-test-coverage", "--test-concurrency=1", ...files],
    { ...process.env, NODE_ENV: "test" },
  );

  // Mirrors the old `; npm run posttest`: runs regardless of the test run's
  // own exit code, and its exit code is what this process exits with.
  process.exit(run("npm", ["run", "posttest"]));
}

if (require.main === module) {
  main();
}
