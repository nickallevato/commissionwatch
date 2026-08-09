import db from "../config/database";
import { buildIngestionStack } from "../services/ingestion";
import { registerSources } from "../services/ingestion/registration";

/**
 * Run one sweep, now, from the command line.
 *
 * The scheduler never sweeps on start, which is correct and also means there
 * has to be some way to make a sweep happen deliberately — for the first live
 * run against a source, and for an operator who wants one before the next cron
 * tick. This is that way. It is the identical code path the cron tick uses,
 * including the advisory lock, so a manual sweep and a scheduled one cannot
 * disagree about what a sweep is.
 *
 *   npm run sweep -- --list
 *   npm run sweep -- --adapter gallatin-civicplus
 *   npm run sweep -- --source <uuid>
 *
 * `--enable` flips `ingestion_sources.enabled` for the named source first,
 * because a source registered by a boot is deliberately disabled.
 */

interface Args {
  list: boolean;
  adapter: string | null;
  source: string | null;
  enable: boolean;
  lookbackDays: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, adapter: null, source: null, enable: false, lookbackDays: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--list":
        args.list = true;
        break;
      case "--enable":
        args.enable = true;
        break;
      case "--adapter":
        if (value === undefined) throw new Error("--adapter needs a value");
        args.adapter = value;
        index += 1;
        break;
      case "--source":
        if (value === undefined) throw new Error("--source needs a value");
        args.source = value;
        index += 1;
        break;
      case "--lookback-days": {
        if (value === undefined) throw new Error("--lookback-days needs a value");
        const days = Number(value);
        if (!Number.isFinite(days) || days <= 0) {
          throw new Error("--lookback-days must be a positive number");
        }
        args.lookbackDays = days;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Registration is idempotent and touches no network, so running it here means
  // a fresh database needs no manual SQL before its first sweep.
  await registerSources(db, buildIngestionStack(db).registry);

  const sources = await db("ingestion_sources")
    .select("id", "adapter_key", "enabled", "cron_expression", "health_status", "last_success_at")
    .orderBy("adapter_key");

  if (args.list || (args.adapter === null && args.source === null)) {
    for (const source of sources) {
      console.log(
        [
          source.id,
          source.adapter_key,
          source.enabled ? "enabled" : "disabled",
          `cron='${source.cron_expression}'`,
          source.health_status,
          `last_success=${source.last_success_at ?? "never"}`,
        ].join("  "),
      );
    }
    if (!args.list) {
      console.log("\nPass --adapter <key> or --source <uuid> to sweep one of these.");
    }
    return 0;
  }

  const target = sources.find(
    (source) => source.id === args.source || source.adapter_key === args.adapter,
  );
  if (target === undefined) {
    console.error(`No ingestion source matches ${args.source ?? args.adapter}`);
    return 2;
  }

  if (args.enable && !target.enabled) {
    await db("ingestion_sources").where({ id: target.id }).update({ enabled: true });
    console.log(`Enabled source ${target.id}`);
  }

  // `enabled: true` here overrides the SCHEDULER_ENABLED default; this process
  // arms no cron job, it only calls sweepSource once.
  const stack = buildIngestionStack(db, {
    enabled: true,
    ...(args.lookbackDays === null ? {} : { lookbackDays: args.lookbackDays }),
  });
  const outcome = await stack.scheduler.sweepSource(target.id);
  console.log(JSON.stringify(outcome, null, 2));

  if (outcome.kind !== "ran") return 3;
  return outcome.status === "failed" ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.destroy();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error("sweep failed", error);
    await db.destroy();
    process.exit(1);
  });
