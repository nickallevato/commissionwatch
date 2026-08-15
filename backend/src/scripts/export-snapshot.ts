import db from "../config/database";
import { listSnapshots, takeSnapshot } from "../services/export/archive";

/**
 * Record what the export holds right now, so the archive can answer for today.
 *
 * The dated archive is **forward-only** and this command is why: publication
 * state is one mutable column that withdrawing a record clears, so nothing can
 * reconstruct what was public on a date nobody recorded. Every date the archive
 * can answer for is a date somebody ran this.
 *
 *   npm run export:snapshot
 *   npm run export:snapshot -- --note "before the March bulk publish"
 *   npm run export:snapshot -- --list
 *
 * Cheap and safe to run at any time. It reads every dataset through the same
 * builders `/api/data` serves and writes two rows per dataset — no bytes are
 * stored, so a snapshot costs kilobytes and cannot become a copy of a
 * publication that a later retraction fails to reach.
 *
 * `dated_export_archive` is deliberately NOT consulted. The flag gates whether
 * readers can *reach* the archive; taking a snapshot is how the archive comes to
 * have anything to serve, and an operator who intends to turn the flag on later
 * needs to be able to start recording now. The same argument
 * `prerender-rebuild.ts` makes about `PRERENDER_ENABLED`.
 *
 * There is no scheduler behind this yet, and that is a real limit: the archive
 * is exactly as dense as an operator's habit of running it. A queue stage is the
 * right home for it and is not this task.
 */

interface Args {
  note: string | null;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { note: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--list") {
      args.list = true;
      continue;
    }
    if (flag === "--note") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error("--note needs a reason; omit the flag rather than passing an empty one");
      }
      args.note = value.trim();
      index += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const snapshots = await listSnapshots(db);
    if (snapshots.length === 0) {
      // Not "the archive is empty" — the honest statement is that no date has
      // been recorded, which is what makes every date unanswerable.
      console.log("No snapshot has been taken, so the archive can answer for no date.");
      return;
    }
    console.log(`${snapshots.length} snapshot(s), newest first:`);
    for (const snapshot of snapshots) {
      console.log(
        `  ${snapshot.taken_at.toISOString()}  ${snapshot.id}` +
          (snapshot.note === null ? "" : `  — ${snapshot.note}`),
      );
    }
    return;
  }

  const { snapshot, datasets } = await takeSnapshot(db, { note: args.note });
  const rows = datasets.reduce((total, dataset) => total + dataset.row_count, 0);
  console.log(
    `Snapshot ${snapshot.id} taken at ${snapshot.taken_at.toISOString()}: ` +
      `${datasets.length} dataset(s), ${rows} row(s).`,
  );
  for (const dataset of datasets) {
    console.log(`  ${dataset.dataset.padEnd(20)} ${String(dataset.row_count).padStart(6)}  ${dataset.sha256.slice(0, 12)}`);
  }
  console.log(
    `\nAddressable as /api/data/archive/${snapshot.taken_at.toISOString().slice(0, 10)}/{dataset}.{json|csv} ` +
      "once `dated_export_archive` is on. Records withdrawn after today will be absent from it.",
  );
}

main()
  .then(() => db.destroy())
  .catch(async (error: unknown) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });
