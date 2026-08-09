import db from "../config/database";
import { DeliveryDispatcher } from "../services/delivery/dispatcher";
import { opsEventPayload, parseOpsEventArgs } from "../services/delivery/ops-events";

/**
 * Emit one operational event through the delivery dispatcher.
 *
 * `deploy/backup.sh` knows how to run `pg_dump`. It does not, and must not, know
 * how `deliveries` rows are written, how routes resolve, or how Discord is
 * addressed. This is the seam: a shell script says what happened, and the
 * application decides who hears about it, over channels an operator has already
 * configured.
 *
 * It exits non-zero when the dispatch itself fails, so a caller can tell
 * "the backup failed" apart from "the backup failed and nobody was told" —
 * different incidents, and the second one is worse.
 *
 *   node dist/src/scripts/emit-ops-event.js \
 *     --event ops.backup_failed --detail "pg_dump exited 1" --source backup.sh
 */

async function main(): Promise<number> {
  const args = parseOpsEventArgs(process.argv.slice(2));
  const dispatcher = new DeliveryDispatcher(db);
  try {
    const result = await dispatcher.dispatch({
      event_type: args.event,
      payload: opsEventPayload(args, process.env.HOSTNAME ?? "unknown"),
      severity: args.severity,
    });
    await dispatcher.flushAll();
    console.log(
      `${args.event}: queued=${result.queued.length} deferred=${result.deferred.length} ` +
        `channels=${result.channels} duplicates=${result.duplicates}`,
    );
    if (result.channels === 0) {
      // Not an error — an operator may genuinely have no ops channel yet — but
      // it must never read as "delivered".
      console.warn(
        `${args.event} matched no delivery channel; nobody was notified. ` +
          "Add a channel and a route for 'ops.*' if this event should reach someone.",
      );
    }
    return 0;
  } finally {
    dispatcher.close();
  }
}

main()
  .then(async (code) => {
    await db.destroy();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error("emit-ops-event failed", error);
    await db.destroy();
    process.exit(1);
  });
