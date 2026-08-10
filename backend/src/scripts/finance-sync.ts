import db from "../config/database";
import { financeCoverage } from "../services/finance/coverage";
import { ingestFederalFinance } from "../services/finance/ingest";
import { HttpCache } from "../services/http-cache";
import { OpenFecClient } from "../services/openfec-client";

/**
 * Pull federal campaign finance for the roster, now, from the command line.
 *
 * Deliberately not on a cron and not on the ingestion scheduler's tick. The
 * scheduler exists to visit government web sites that publish new documents on
 * their own clock; the FEC's filing periods are quarterly, and a sweep every
 * fifteen minutes would spend a public API's rate limit re-reading the same
 * three months. An operator runs this after a filing deadline, and the
 * six-hour `http_cache` TTL makes a second run inside the same session free.
 *
 *   npm run finance-sync -- --coverage
 *   npm run finance-sync -- --jurisdiction <uuid>
 *   npm run finance-sync -- --cycle 2026
 *
 * `OPENFEC_API_KEY` is required and the client refuses without it. **Do not
 * use `DEMO_KEY`** — its ceiling is ten requests per window, and a roster of a
 * dozen officials is two requests each.
 */

interface Args {
  coverage: boolean;
  jurisdiction: string | null;
  cycle: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { coverage: false, jurisdiction: null, cycle: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--coverage":
        args.coverage = true;
        break;
      case "--jurisdiction":
        if (value === undefined) throw new Error("--jurisdiction needs a value");
        args.jurisdiction = value;
        index += 1;
        break;
      case "--cycle": {
        if (value === undefined) throw new Error("--cycle needs a value");
        const cycle = Number(value);
        if (!Number.isInteger(cycle) || cycle < 1980) throw new Error("--cycle must be a year");
        args.cycle = cycle;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unrecognised argument: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const coverage = financeCoverage();

  // Printed on every run, not only under --coverage. The operator reading the
  // counts is the person most likely to mistake "0 contributions" for a
  // finding about the officials rather than a fact about the FEC.
  console.log(coverage.caveat);
  console.log("");

  if (args.coverage) {
    for (const system of coverage.systems) {
      console.log(`${system.state === "active" ? "[active] " : "[planned]"} ${system.name} — ${system.scope}`);
    }
    await db.destroy();
    return;
  }

  const client = new OpenFecClient({ cacheStore: new HttpCache(db) });
  const counts = await ingestFederalFinance(db, {
    client,
    jurisdictionId: args.jurisdiction ?? undefined,
    cycle: args.cycle ?? undefined,
  });

  console.log(`officials queried      ${counts.officialsQueried}`);
  console.log(`contributions returned ${counts.contributionsSeen}`);
  console.log(`contributions stored   ${counts.contributionsInserted}`);
  console.log(`expenditures returned  ${counts.expendituresSeen}`);
  console.log(`expenditures stored    ${counts.expendituresInserted}`);
  console.log(`records rejected       ${counts.recordsRejected}`);

  await db.destroy();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await db.destroy();
  process.exitCode = 1;
});
