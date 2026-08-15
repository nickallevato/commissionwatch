import db from "../config/database";
import { listUnextractedMeetings } from "../services/extraction/distribution";
import { ExtractionUnavailable } from "../services/extraction/run";
import { enqueueExtraction } from "../services/extraction/stage";
import { buildIngestionStack } from "../services/ingestion";

/**
 * Queue the corpus's unread minutes for extraction.
 *
 * §2 of the design of record says a scheduled backfill "is a job enqueuer,
 * nothing more", and its open question asks whether extraction should run
 * automatically on newly ingested meetings. The recommendation there was to
 * wait for §1's distribution before automating, and the distribution — measured
 * 2026-08-15 over the ten stored minutes documents — says wait a while longer:
 * a third of chunks came back truncated, and until that stops, an automatic
 * nightly sweep would turn one visible number into a nightly pile of partial
 * runs nobody asked for. So this is a script an operator runs, not a cron entry.
 *
 *   npm run extraction:backfill -- --dry-run
 *   npm run extraction:backfill -- --limit 10
 *   npm run extraction:backfill -- --published-only
 *
 * It enqueues and returns. The `extract` worker drains the queue one job at a
 * time (`EXTRACT_CONCURRENCY`), because the free tier is rate-limited per
 * minute — so a large `--limit` is a long queue, not a thundering herd.
 *
 * Nothing here reaches the network for source data. An `extract` job carries a
 * content address, the worker loads the stored bytes, and the only outbound call
 * is to the model.
 */

interface Args {
  limit: number;
  dryRun: boolean;
  publishedOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 10, dryRun: false, publishedOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (flag === "--published-only") {
      args.publishedOnly = true;
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
      continue;
    }
    throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await listUnextractedMeetings(db, {
    limit: args.limit,
    publishedOnly: args.publishedOnly,
  });

  console.log(
    `${candidates.length} meeting(s) with stored minutes and no reading of them` +
      (args.dryRun ? " (dry run — nothing enqueued)" : ""),
  );
  for (const meeting of candidates) {
    console.log(
      `  ${meeting.meeting_id}  ${meeting.sha256.slice(0, 12)}  ` +
        `${meeting.published ? "published" : "unpublished"}`,
    );
  }
  if (args.dryRun || candidates.length === 0) return;

  // Built only when there is work: constructing the stack wires MinIO and a
  // model client, and a dry run should need neither.
  const { queue } = buildIngestionStack(db);
  let enqueued = 0;
  for (const meeting of candidates) {
    try {
      const job = await enqueueExtraction(db, queue, meeting.meeting_id);
      enqueued += 1;
      console.log(`  queued job ${job.job_id} for meeting ${meeting.meeting_id}`);
    } catch (error) {
      // A meeting can become ineligible between the list and the enqueue — an
      // operator queues one by hand, a 409 comes back. Reported per meeting and
      // never fatal: one refusal must not abandon the rest of the backlog.
      if (error instanceof ExtractionUnavailable) {
        console.warn(`  skipped ${meeting.meeting_id}: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
  console.log(`Enqueued ${enqueued} extraction job(s).`);
}

main()
  .then(() => db.destroy())
  .catch(async (error: unknown) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });
