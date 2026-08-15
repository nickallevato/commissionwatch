import db from "../config/database";
import {
  extractionBacklog,
  extractionDistribution,
  listUnextractedMeetings,
} from "../services/extraction/distribution";

/**
 * Read the extraction failure distribution off the corpus.
 *
 * The design of record (§1) says: widen the error, run the corpus, and **read
 * the distribution before changing anything else** — because whether the fix is
 * chunk splitting, a prompt change or abandoning the free tier is decided by
 * which reason dominates, and guessing wrong costs a day. `failed_chunks` has
 * carried a structured reason since the widening; this is the tally over it.
 *
 *   npm run extraction:distribution
 *   npm run extraction:distribution -- --json
 *   npm run extraction:distribution -- --backlog 20
 *
 * Read-only. It enqueues nothing and writes nothing, so it is safe to run
 * against production at any time — which matters, because production is the
 * only place the distribution is real.
 */

interface Args {
  json: boolean;
  /** List this many unread meetings by id. 0 lists none. */
  backlog: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, backlog: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag === "--backlog") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--backlog needs a positive integer, got ${raw ?? "nothing"}`);
      }
      args.backlog = value;
      index += 1;
    }
  }
  return args;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const distribution = await extractionDistribution(db);
  const backlog = await extractionBacklog(db);
  const meetings =
    args.backlog > 0 ? await listUnextractedMeetings(db, { limit: args.backlog }) : [];

  if (args.json) {
    console.log(JSON.stringify({ distribution, backlog, unread_meetings: meetings }, null, 2));
    return;
  }

  if (distribution.runs === 0) {
    // Not "0%". An unmeasured distribution and a measured zero are different
    // facts, and this is the whole subject of the exercise.
    console.log(
      "No finished extraction run exists, so the failure distribution is UNMEASURED — " +
        "which is not the same as zero. Run an extraction first.",
    );
  } else {
    console.log(
      `${distribution.runs} finished run(s) over ${distribution.meetings} meeting(s): ` +
        `${distribution.unread} of ${distribution.chunks} chunk(s) unread ` +
        `(${percent(distribution.unread_fraction)}).`,
    );
    console.log(
      `  runs: succeeded ${distribution.by_status.succeeded}, ` +
        `partial ${distribution.by_status.partial}, failed ${distribution.by_status.failed}; ` +
        `${distribution.runs_wholly_unread} read nothing at all, ` +
        `${distribution.runs_refused} hit a content filter.`,
    );
    console.log("  by reason (chunks, runs):");
    if (distribution.by_reason.length === 0) {
      console.log("    — none. Every chunk was read.");
    }
    for (const tally of distribution.by_reason) {
      const share = distribution.unread > 0 ? tally.chunks / distribution.unread : 0;
      console.log(
        `    ${tally.reason.padEnd(18)} ${String(tally.chunks).padStart(5)} chunks ` +
          `(${percent(share).padStart(6)} of unread) in ${tally.runs} run(s), ` +
          `${tally.recovered} claim(s) salvaged`,
      );
    }
  }

  console.log(
    `Backlog: ${backlog.unread} of ${backlog.eligible} meeting(s) with stored minutes have never ` +
      `been read (${backlog.read} have). Jobs: ${backlog.queued} queued, ` +
      `${backlog.blocked} blocked, ${backlog.failed} failed.`,
  );
  for (const meeting of meetings) {
    console.log(
      `  ${meeting.meeting_id}  ${meeting.sha256.slice(0, 12)}  ` +
        `${meeting.published ? "published" : "unpublished"}`,
    );
  }
}

main()
  .then(() => db.destroy())
  .catch(async (error: unknown) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });
