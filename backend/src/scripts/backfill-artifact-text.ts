import db from "../config/database";
import { backfillArtifactText } from "../services/ingestion/backfill-artifact-text";
import { downloadDocument } from "../services/storage";

/**
 * Index the document text that the `parse_not_agenda` early return withheld.
 *
 * See `services/ingestion/backfill-artifact-text.ts` for what was wrong and why
 * this does not go through the queue. Run it once after deploying the handler
 * fix; it is idempotent, so running it twice costs a query and changes nothing.
 *
 *   npm run backfill:artifact-text
 *   npm run backfill:artifact-text -- --limit 2000
 *   npm run backfill:artifact-text -- --dry-run
 *
 * `--dry-run` counts the candidates without reading a single object out of
 * storage, which is the cheap way to find out how much of the archive this
 * affects before committing to the pass.
 */

interface Args {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 500, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (flag === "--limit") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit needs a positive integer, got ${raw ?? "nothing"}`);
      }
      args.limit = value;
      index += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    const { findUnindexedArtifacts } = await import(
      "../services/ingestion/backfill-artifact-text"
    );
    const candidates = await findUnindexedArtifacts(db, args.limit);
    console.log(
      `${candidates.length} artifact(s) reachable from a meeting document have no indexed text` +
        (candidates.length === args.limit ? ` (at the --limit of ${args.limit}; there may be more)` : ""),
    );
    return;
  }

  const result = await backfillArtifactText(db, {
    read: downloadDocument,
    limit: args.limit,
  });

  console.log(
    [
      `examined    ${result.examined}`,
      `indexed     ${result.indexed}`,
      `chars       ${result.chars}`,
      `unsupported ${result.unsupported}`,
      `unreadable  ${result.unreadable}`,
    ].join("\n"),
  );

  if (result.examined === args.limit) {
    console.log(`\nStopped at the --limit of ${args.limit}. Run again to continue.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.destroy();
  });
