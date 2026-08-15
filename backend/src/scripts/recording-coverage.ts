import db from "../config/database";
import { downloadDocument } from "../services/storage";
import { formatRecordingLength } from "../services/ingestion/granicus-player";
import { recordingCoverage, totalRecordingCoverage } from "../services/recording-coverage";
import { verifyRecordings } from "../services/recording-verification";

/**
 * What recorded public meeting exists, and how much of it nobody can read.
 *
 *   npm run recordings:coverage
 *   npm run recordings:coverage -- --json
 *   npm run recordings:coverage -- --verify 20
 *
 * Read-only. It enqueues nothing, fetches nothing from any custodian and writes
 * nothing, so it is safe against production at any time — and production is the
 * only place the numbers are real.
 *
 * `--verify` is the part worth running. It re-derives each recording's length and
 * media id from the stored page bytes, checks those bytes against the hash the row
 * names, and prints the one-line command a stranger can run against Granicus to
 * check the same hash from the other end. A number nobody can re-derive is a
 * number this project has no business publishing.
 */

interface Args {
  json: boolean;
  /** Re-derive this many rows from stored bytes. 0 verifies none. */
  verify: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, verify: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag === "--verify") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--verify needs a positive integer, got ${raw ?? "nothing"}`);
      }
      args.verify = value;
      index += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await recordingCoverage(db);
  const totals = totalRecordingCoverage(rows);
  const verifications =
    args.verify > 0
      ? await verifyRecordings(db, (key) => downloadDocument(key), { limit: args.verify })
      : [];

  if (args.json) {
    console.log(JSON.stringify({ coverage: rows, totals, verifications }, null, 2));
    return;
  }

  if (rows.length === 0) {
    // Not "0 recordings". Nothing has been swept, which is a different fact from
    // a body that met and was never recorded, and this script must not let the
    // two share a line.
    console.log(
      "No published meeting carries a recording document, so recording coverage is " +
        "UNMEASURED — which is not the same as zero. Run a Bozeman sweep first.",
    );
  }

  for (const row of rows) {
    console.log(
      `${row.jurisdiction} · ${row.body} · ${row.year}: ` +
        `${row.available} recording(s), ${formatRecordingLength(row.recorded_ms)} of them, ` +
        `${row.without_transcript} with no published transcript` +
        (row.unreadable > 0 ? `; ${row.unreadable} page(s) we could not read` : "") +
        (row.unchecked > 0 ? `; ${row.unchecked} never checked` : "") +
        (row.checked_through === null ? "" : `  (last checked ${row.checked_through})`),
    );
  }

  if (rows.length > 0) {
    console.log(
      `\nTotal: ${totals.available} recording(s), ` +
        `${formatRecordingLength(totals.recorded_ms)} of recorded public meeting, ` +
        `${totals.without_transcript} of them with no transcript anyone can search. ` +
        `${totals.unchecked} never checked, ${totals.unreadable} unreadable.`,
    );
    console.log(
      "The recordings themselves are not fetched. Probed 2026-08-15: the media CDN answers a " +
        "browser user-agent string and refuses this project's honest one, so obtaining them " +
        "would mean claiming to be a browser. The route is a public-records request.",
    );
  }

  if (args.verify > 0) {
    const failed = verifications.filter((result) => result.problems.length > 0);
    console.log(
      `\nVerified ${verifications.length} row(s) against stored bytes: ` +
        `${verifications.length - failed.length} re-derived exactly, ${failed.length} did not.`,
    );
    for (const result of verifications) {
      console.log(
        `  clip ${result.clip_id.padEnd(6)} ${result.observed_sha256.slice(0, 12)}  ` +
          `${formatRecordingLength(result.duration_ms).padStart(8)}  ` +
          (result.problems.length === 0 ? "ok" : "MISMATCH"),
      );
      for (const problem of result.problems) console.log(`      ${problem}`);
    }
    const first = verifications[0];
    if (first !== undefined) {
      console.log("\nCheck one from the other end, against the custodian's own server:");
      console.log(`  ${first.reproduce}`);
      console.log(`  # expect ${first.observed_sha256}`);
    }
    if (failed.length > 0) process.exitCode = 1;
  }
}

main()
  .then(() => db.destroy())
  .catch(async (error: unknown) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });
