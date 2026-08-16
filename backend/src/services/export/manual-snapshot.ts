import type { Knex } from "knex";
import { SOURCE_LOCK_NAMESPACE } from "../ingestion/scheduler";
import { takeSnapshot, type ExportSnapshot, type SnapshotDataset } from "./archive";
import {
  SNAPSHOT_LOCK_KEY,
  recordSnapshotRun,
  snapshotTakenOn,
  utcDay,
} from "./snapshot-scheduler";

/**
 * The manual writer behind `npm run export:snapshot`, and its one guard.
 *
 * ## The problem this exists to end
 *
 * The scheduler takes at most one snapshot per UTC day and writes a `taken` row
 * to `export_snapshot_runs` naming it. The manual command predates the scheduler
 * and knew nothing about the day: run on a day already recorded, it added a
 * **second** snapshot for that day.
 *
 * Nothing was corrupted — `snapshotOn` resolves a date to the latest snapshot on
 * or before it, so reads stayed coherent — but the second snapshot *silently
 * superseded* the first as the answer for that date, while the ledger's `taken`
 * row went on naming the earlier one. Two tables, two different answers to "what
 * represents 2026-08-15", and nothing anywhere saying so. The archive's whole
 * claim is that a date's answer is a snapshot somebody took; it cannot also be
 * unclear which one.
 *
 * ## Refuse by default, supersede only on `--force`
 *
 * Three behaviours were available: refuse unless forced, proceed while recording
 * a superseding row, or proceed with a printed warning.
 *
 * **A warning is the weakest of the three** and fails the operator this is
 * actually written for — the one running the command at 2am, half-attentively,
 * possibly from shell history. A warning arrives *after* the day's meaning has
 * already changed, and console output is the one artifact of this command that
 * nobody keeps. Refusal is the only outcome that is free to be wrong: it costs a
 * retyped flag, whereas an unwanted supersession cannot be undone by taking
 * another snapshot.
 *
 * **Proceeding-while-recording** keeps the two tables agreeing, which is the hard
 * requirement, but it decides for the operator that superseding today is what
 * they meant. They usually have not thought about it: the reason to run this by
 * hand is a `--note` around a deliberate change, and whether that note should
 * become the day's answer is exactly the judgement worth a second of friction.
 *
 * So: **refuse by default**, naming the snapshot that already holds the day and
 * when it was taken, and offer `--force`. Refusal writes nothing at all, which is
 * itself why the tables still agree afterwards.
 *
 * `--force` then does the recording half — the ledger's `taken` row for the day
 * is upserted to name the new snapshot, so the supersession is *stated* rather
 * than merely permitted, and `detail` names the snapshot it displaced. That is
 * the property the acceptance turns on and the reason `recordSnapshotRun` now
 * carries `snapshot_id` through its merge.
 *
 * ## The day is always recorded, forced or not
 *
 * A manual snapshot on a day with no snapshot writes a `taken` row too. Without
 * it the day would hold a snapshot no ledger row claimed, and the scheduler's
 * next cycle would file a lone `skipped_same_day` — the same disagreement in the
 * opposite direction. One writer, one rule: whoever takes the day's snapshot says
 * so in the ledger, in the same transaction.
 *
 * ## The lock
 *
 * `pg_try_advisory_xact_lock` on the scheduler's own key, so a manual run and a
 * scheduled tick cannot both pass the same-day check and both take one. Not
 * acquiring it is not a `skipped_locked` row — that outcome belongs to the loop,
 * which will come back in an hour. A human gets told to try again.
 */

export interface ManualSnapshotOptions {
  note?: string | null;
  /** Take a snapshot even on a day that already has one, superseding it. */
  force?: boolean;
  /** Injected for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface ManualSnapshotTaken {
  outcome: "taken";
  day: string;
  snapshot: ExportSnapshot;
  datasets: SnapshotDataset[];
  /** The snapshot this one displaced as the day's answer, if any. */
  superseded: { id: string; taken_at: Date } | null;
}

export interface ManualSnapshotRefused {
  outcome: "refused_same_day" | "refused_locked";
  day: string;
  /** The snapshot already holding the day. Null when the lock was the refusal. */
  existing: { id: string; taken_at: Date } | null;
  reason: string;
}

export type ManualSnapshotResult = ManualSnapshotTaken | ManualSnapshotRefused;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tryLock(trx: Knex.Transaction): Promise<boolean> {
  const locked: unknown = await trx.raw("SELECT pg_try_advisory_xact_lock(?, ?) AS locked", [
    SOURCE_LOCK_NAMESPACE,
    SNAPSHOT_LOCK_KEY,
  ]);
  const row = isRecord(locked) && Array.isArray(locked.rows) ? locked.rows[0] : undefined;
  return isRecord(row) && row.locked === true;
}

/**
 * Take a snapshot by hand, refusing to silently supersede the day's existing one.
 *
 * `dated_export_archive` is deliberately not consulted — the flag gates whether
 * readers can *reach* the archive, and an operator preparing to turn it on has to
 * be able to start recording first. That division is unchanged; only the same-day
 * behaviour is new.
 */
export async function takeManualSnapshot(
  db: Knex,
  options: ManualSnapshotOptions = {},
): Promise<ManualSnapshotResult> {
  const day = utcDay((options.now ?? ((): Date => new Date()))());

  return db.transaction(async (trx) => {
    if (!(await tryLock(trx))) {
      return {
        outcome: "refused_locked",
        day,
        existing: null,
        reason:
          "another process holds the snapshot lock — the scheduler is most likely mid-cycle. " +
          "Nothing was written; try again in a moment.",
      };
    }

    const existing = await snapshotTakenOn(trx, day);
    if (existing !== null && options.force !== true) {
      return {
        outcome: "refused_same_day",
        day,
        existing,
        reason:
          `${day} already has snapshot ${existing.id}, taken at ` +
          `${existing.taken_at.toISOString()}. Taking another would make it the archive's ` +
          `answer for ${day}, superseding that one. Nothing was written. Re-run with --force ` +
          "if that is what you mean.",
      };
    }

    // The snapshot and its ledger row commit together, so the ledger cannot claim
    // a snapshot that rolled back — nor omit one that did not.
    const { snapshot, datasets } = await takeSnapshot(trx, { note: options.note ?? null });
    const rows = datasets.reduce((total, dataset) => total + dataset.row_count, 0);
    const displaced =
      existing === null
        ? ""
        : `, superseding ${existing.id} taken at ${existing.taken_at.toISOString()}`;

    await recordSnapshotRun(trx, {
      day,
      outcome: "taken",
      snapshotId: snapshot.id,
      detail: `manual run: ${datasets.length} dataset(s), ${rows} row(s)${displaced}`,
    });

    return { outcome: "taken", day, snapshot, datasets, superseded: existing };
  });
}

/* ---------------------------------------------------------------------------
   The command line
   --------------------------------------------------------------------------- */

export interface SnapshotCommandArgs {
  note: string | null;
  list: boolean;
  force: boolean;
}

/**
 * Parsed here rather than in the script so the flags are testable without the
 * script's top-level `main()` running on import.
 */
export function parseSnapshotArgs(argv: string[]): SnapshotCommandArgs {
  const args: SnapshotCommandArgs = { note: null, list: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--list") {
      args.list = true;
      continue;
    }
    if (flag === "--force") {
      args.force = true;
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
