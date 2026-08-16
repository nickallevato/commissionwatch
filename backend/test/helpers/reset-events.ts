/**
 * `pretest`'s third step: start every run on clean soil.
 *
 * The migrate and seed steps already ahead of this one make the *schema* and
 * the *fixtures* deterministic. They cannot make `events` deterministic,
 * because `events` is append-only — migration 083 forbids deleting it, and the
 * migration is not re-run on an existing database, so nothing else in the
 * pretest chain ever clears it. Rows therefore survive from run to run, and an
 * ad-hoc `node --test test/prerender.test.ts` or a `npm run sweep` against the
 * test database leaves more.
 *
 * Past ~200 surviving rows the batched consumers stop reaching any suite's
 * fixtures. See `helpers/events.ts` for the full account and for the four
 * conditions that make `truncateEvents` unable to run anywhere but the test
 * database.
 *
 * This prints what it found rather than tidying silently: a run that reports
 * clearing hundreds of rows is telling the operator that something outside the
 * suite has been writing to the test database.
 */
import db from "../../src/config/database";
import { truncateEvents } from "./events";

async function main(): Promise<void> {
  const removed = await truncateEvents(db);
  if (removed > 0) {
    process.stdout.write(`pretest: cleared ${removed} leftover event row(s) from the test log\n`);
  }
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
