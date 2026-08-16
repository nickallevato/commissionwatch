/**
 * `posttest`: the run is not green until it has left the event log as it found
 * it.
 *
 * ## Why this is a script and not a test
 *
 * The obvious design is a suite listed last in `package.json`'s `test` script,
 * asserting the table is empty. It does not work, and the way it fails is
 * quiet: **`node --test` sorts the files it is given.** Listing
 * `event-log-hygiene.test.ts` last put it 114th of 403 top-level suites,
 * where it would have reported every suite that had not yet run as clean.
 * Verified directly — `node --test test/version.test.ts test/health.test.ts`
 * runs `health` first.
 *
 * `posttest` has no such assumption to get wrong. npm runs it after `test`
 * exits, whatever order the runner chose, so "nothing was left behind" is
 * asked exactly once, at the only moment the answer means anything.
 *
 * The one thing it gives up: npm skips `posttest` when `test` fails. That is
 * the right trade — a failing run is already red, and a leak found underneath a
 * genuine failure is the second thing to fix, not the first.
 *
 * ## What a failure here means
 *
 * A suite emitted events and did not delete them in its teardown. `events` is
 * append-only in production by design (migration 083: "Retention: never
 * delete"), nothing cascades to it, and `pretest` is the only thing that ever
 * clears it — so the rows survive into every later run. Past ~200 of them the
 * batched consumers (`PrerenderConsumer`, `EventDrain`) spend their whole batch
 * before reaching any suite's own fixtures, and the suite that breaks first is
 * `prerender.test.ts`, on "a withdrawn meeting kept its prerendered page".
 *
 * The fix is always in the suite named below, never here: delete what you
 * emitted, in `after`. `helpers/pressroom.ts`'s `cleanupByPrefix` already does
 * it for anything built on the standard fixtures.
 */
import db from "../../src/config/database";
import { assertTestDatabase, leakedEvents } from "./events";

async function main(): Promise<void> {
  await assertTestDatabase(db);
  const leaked = await leakedEvents(db);
  if (leaked.length === 0) return;

  const total = leaked.reduce((sum, group) => sum + group.count, 0);
  const lines = leaked.map(
    (group) =>
      `  ${group.count} x ${group.event_type} (${group.subject_kind}) ` +
      `e.g. ${group.sample_dedupe_key}`,
  );
  throw new Error(
    `${total} event row(s) were left in the test log by this run.\n` +
      "A suite emitted events and did not delete them in its teardown. `events` is\n" +
      "append-only and nothing cascades to it, so these rows outlive the run and\n" +
      "eventually stop the batched consumers reaching any suite's own fixtures.\n" +
      `${lines.join("\n")}\n` +
      "Delete what you emit, in `after`. See test/helpers/assert-events-clean.ts.",
  );
}

main()
  .then(async () => {
    await db.destroy();
  })
  .catch(async (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await db.destroy();
  });
