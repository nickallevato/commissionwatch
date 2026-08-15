import db from "../config/database";
import { PrerenderConsumer } from "../services/prerender/consumer";

/**
 * Rebuild every prerendered page from the database, ignoring the event cursor.
 *
 * The operator's repair tool. `PrerenderConsumer.rebuild()` walks the published
 * meetings and their dependents rather than replaying the event log, so it fixes
 * the cases the incremental loop cannot:
 *
 *   - the volume was empty when prerendering was first switched on, and there is
 *     no event to replay for a meeting published weeks ago;
 *   - a single page threw during a tick. The loop logs it and advances the
 *     cursor deliberately — one bad record must not wedge the batch — so nothing
 *     retries that page until its subject is touched again;
 *   - the cursor file was lost or the volume was recreated.
 *
 * Safe at any time, and cheap to reach for: rendering is idempotent and produces
 * byte-identical files for anything already correct. It also DELETES the page of
 * anything no longer public, which is the half that matters most — a prerendered
 * page outliving its withdrawal is the worst failure this feature can produce.
 *
 * Two variables must be set or this does the wrong thing quietly:
 *
 *   PRERENDER_OUTPUT_DIR   unset, it writes to `$PWD/.prerender` — correct pages
 *                          in a directory nothing serves. Production sets it in
 *                          deploy/docker-compose.shared.yml.
 *   PUBLIC_BASE_URL        unset, this throws before writing anything, because
 *                          every page carries an absolute canonical.
 *
 * `PRERENDER_ENABLED` is deliberately NOT consulted. That flag gates the
 * background loop; an operator running this command has already decided.
 *
 *   # in the repository
 *   npm run prerender:rebuild
 *
 *   # in the production container, which ships dist/ and not src/
 *   docker exec commissionwatch-backend node dist/src/scripts/prerender-rebuild.js
 */

async function main(): Promise<void> {
  const consumer = new PrerenderConsumer(db);

  console.log(`prerender: rebuilding into ${consumer.store.root} for ${consumer.baseUrl}`);

  const result = await consumer.rebuild();

  console.log([`written ${result.written}`, `removed ${result.removed}`].join("\n"));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.destroy();
  });
