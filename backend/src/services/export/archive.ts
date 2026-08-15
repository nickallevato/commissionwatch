import { createHash } from "node:crypto";
import type { Knex } from "knex";
import {
  EXPORT_DATASETS,
  findDataset,
  readBatch,
  type ExportDataset,
} from "./datasets";
import { csvRow, projectRow } from "./serialize";

/**
 * The dated export archive — F7, behind `dated_export_archive`, default off.
 *
 * ## What a point in time means here, and what it cannot mean
 *
 * It means **a snapshot somebody took**, never a reconstruction. The schema
 * cannot honestly answer "what was public on 12 March": publication state is
 * `meetings.published_at`, one mutable timestamp that `unpublishMeeting` sets to
 * NULL, and `anomaly_flags.review_state` is one mutable column overwritten in
 * place. Filtering on `published_at <= '2026-03-12'` would return today's
 * survivors wearing March's date, and would be most wrong precisely about the
 * records that were later withdrawn — the ones a reader asking that question
 * most needs to know about.
 *
 * So the archive is **forward-only**. It can answer for dates from the first
 * snapshot onward and says so, rather than computing a plausible answer for
 * dates before it. `/data` already tells readers the question is unanswerable;
 * this narrows that statement rather than replacing it with a guess.
 *
 * ## One publication wall, applied at read time
 *
 * Nothing here writes a query against a record table. A snapshot records which
 * row ids the export held; serving one calls the same `ExportDataset.build` that
 * `/api/data` calls and intersects it with those ids. There is exactly one
 * implementation of the wall in the export path and this is a caller of it, not
 * a second copy — a second copy of a wall rule is how `emitEvent`'s claim wall
 * went a clause stale, which is the most repeated failure in this codebase's
 * history.
 *
 * **Retraction therefore reaches the archive by construction.** A row an
 * operator has withdrawn is absent from the builder's output, so it is absent
 * from every archived export that ever contained it, including ones taken before
 * the withdrawal. No code here knows what a retraction is, which is the point.
 *
 * The honest cost, stated on every response rather than buried: an archived
 * export is **the rows that were published then and are still published now**.
 * That is a narrower claim than "the bytes we served that day", and
 * `withheld_since` counts the difference so a reader can see how much has gone
 * rather than being quietly handed a shorter file.
 */

export interface ExportSnapshot {
  id: string;
  taken_at: Date;
  note: string | null;
}

export interface SnapshotDataset {
  dataset: string;
  /** Rows in the export when the snapshot was taken. */
  row_count: number;
  row_ids: string[];
  /** Of the CSV bytes as they were then. */
  sha256: string;
}

interface SnapshotDatasetRow {
  dataset: string;
  row_count: number;
  row_ids: unknown;
  sha256: string;
}

function asIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/* ---------------------------------------------------------------------------
   Taking one
   --------------------------------------------------------------------------- */

/**
 * Read every dataset through its own builder and record what was there.
 *
 * The bytes are hashed, not kept. Keeping them would be keeping a copy of a
 * publication that no later retraction could reach — see the header — and the
 * hash is what lets `readArchivedDataset` say the bytes have changed rather than
 * implying they have not.
 *
 * One transaction, so a snapshot cannot record half an export. A row published
 * between two dataset reads would otherwise appear in one dataset and not in the
 * one that references it, and a reader would have no way to see that the file
 * was internally inconsistent.
 */
export async function takeSnapshot(
  db: Knex,
  options: { note?: string | null } = {},
): Promise<{ snapshot: ExportSnapshot; datasets: SnapshotDataset[] }> {
  return db.transaction(async (trx) => {
    const [snapshot] = await trx("export_snapshots")
      .insert({ note: options.note ?? null })
      .returning<ExportSnapshot[]>(["id", "taken_at", "note"]);

    const datasets: SnapshotDataset[] = [];
    for (const dataset of EXPORT_DATASETS) {
      const recorded = await recordDataset(trx, snapshot.id, dataset);
      datasets.push(recorded);
    }
    return { snapshot, datasets };
  });
}

async function recordDataset(
  trx: Knex.Transaction,
  snapshotId: string,
  dataset: ExportDataset,
): Promise<SnapshotDataset> {
  const ids: string[] = [];
  const hash = createHash("sha256");
  // The header is part of the file, so it is part of the hash.
  hash.update(`${dataset.columns.join(",")}\r\n`);

  let after: string | null = null;
  for (;;) {
    const rows = await readBatch(trx, dataset, after);
    if (rows.length === 0) break;

    for (const row of rows) {
      hash.update(csvRow(dataset.columns, projectRow(dataset.columns, row)));
      const id = row.id;
      if (typeof id === "string") ids.push(id);
    }

    const last = rows[rows.length - 1].id;
    if (typeof last !== "string") break;
    after = last;
  }

  const recorded: SnapshotDataset = {
    dataset: dataset.name,
    row_count: ids.length,
    row_ids: ids,
    sha256: hash.digest("hex"),
  };

  await trx("export_snapshot_datasets").insert({
    snapshot_id: snapshotId,
    dataset: recorded.dataset,
    row_count: recorded.row_count,
    row_ids: JSON.stringify(recorded.row_ids),
    sha256: recorded.sha256,
  });

  return recorded;
}

/* ---------------------------------------------------------------------------
   Finding one
   --------------------------------------------------------------------------- */

export async function listSnapshots(db: Knex): Promise<ExportSnapshot[]> {
  return db("export_snapshots")
    .orderBy("taken_at", "desc")
    .select<ExportSnapshot[]>("id", "taken_at", "note");
}

/** `YYYY-MM-DD`, as the archive addresses a day. */
export const ARCHIVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The snapshot in effect at the end of a given UTC day, or null.
 *
 * The latest one taken on or before that day, so a date between two snapshots
 * answers with what the export said at the time — the alternative, an exact-date
 * match, would 404 for every day nobody happened to run one, which reads as "the
 * site said nothing that day".
 *
 * Null for a date before the first snapshot ever taken. That is the forward-only
 * boundary and the route states it in those words; it must never be filled in by
 * reaching for the earliest snapshot instead, which would answer a March
 * question with April's record.
 */
export async function snapshotOn(db: Knex, day: string): Promise<ExportSnapshot | null> {
  if (!ARCHIVE_DAY_RE.test(day)) return null;
  const end = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(end.getTime())) return null;

  const row = await db("export_snapshots")
    .where("taken_at", "<=", end)
    .orderBy("taken_at", "desc")
    .first<ExportSnapshot | undefined>("id", "taken_at", "note");
  return row ?? null;
}

export async function snapshotDatasets(db: Knex, snapshotId: string): Promise<SnapshotDataset[]> {
  const rows = await db("export_snapshot_datasets")
    .where({ snapshot_id: snapshotId })
    .orderBy("dataset", "asc")
    .select<SnapshotDatasetRow[]>("dataset", "row_count", "row_ids", "sha256");

  return rows.map((row) => ({
    dataset: row.dataset,
    row_count: row.row_count,
    row_ids: asIdArray(row.row_ids),
    sha256: row.sha256,
  }));
}

export async function snapshotDataset(
  db: Knex,
  snapshotId: string,
  dataset: string,
): Promise<SnapshotDataset | null> {
  const row = await db("export_snapshot_datasets")
    .where({ snapshot_id: snapshotId, dataset })
    .first<SnapshotDatasetRow | undefined>("dataset", "row_count", "row_ids", "sha256");
  if (row === undefined) return null;
  return {
    dataset: row.dataset,
    row_count: row.row_count,
    row_ids: asIdArray(row.row_ids),
    sha256: row.sha256,
  };
}

/* ---------------------------------------------------------------------------
   Reading one
   --------------------------------------------------------------------------- */

export interface ArchivedDataset {
  dataset: ExportDataset;
  rows: Array<Record<string, unknown>>;
  /** Rows the snapshot recorded. */
  recorded: number;
  /** Rows still published, which is what `rows` holds. */
  served: number;
  /** Rows recorded then and not public now. The difference, stated. */
  withheld_since: number;
  /** The hash of the file as it was then. Recomputed below for comparison. */
  sha256_then: string;
  /** The hash of what is being served now. Equal only if nothing changed. */
  sha256_now: string;
}

/** How many ids to hand a single `whereIn`. Postgres takes far more; this bounds the SQL. */
const ID_BATCH = 500;

/**
 * The archived rows of one dataset, walled by today's rule.
 *
 * `dataset.build(db)` is the same call `/api/data` makes — the intersection is
 * the only thing added, and it can only ever remove rows. A row cannot enter an
 * archived export by being published after the snapshot, because its id is not
 * in the recorded set; and it cannot survive being withdrawn, because it is not
 * in the builder's output. Both directions fall out of reusing the builder, and
 * neither is enforced by anything written here.
 */
export async function readArchivedDataset(
  db: Knex,
  dataset: ExportDataset,
  recorded: SnapshotDataset,
): Promise<ArchivedDataset> {
  const key = dataset.keyColumn ?? "id";
  const byId = new Map<string, Record<string, unknown>>();

  for (let index = 0; index < recorded.row_ids.length; index += ID_BATCH) {
    const window = recorded.row_ids.slice(index, index + ID_BATCH);
    const rows: unknown = await dataset.build(db).whereIn(key, window);
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = row.id;
      if (typeof id === "string") byId.set(id, projectRow(dataset.columns, row));
    }
  }

  // The snapshot's own order, so an archived export is stable across reads and
  // comparable with the file taken that day rather than merely containing the
  // same rows.
  const rows: Array<Record<string, unknown>> = [];
  for (const id of recorded.row_ids) {
    const row = byId.get(id);
    if (row !== undefined) rows.push(row);
  }

  const hash = createHash("sha256");
  hash.update(`${dataset.columns.join(",")}\r\n`);
  for (const row of rows) hash.update(csvRow(dataset.columns, row));

  return {
    dataset,
    rows,
    recorded: recorded.row_count,
    served: rows.length,
    withheld_since: recorded.row_count - rows.length,
    sha256_then: recorded.sha256,
    sha256_now: hash.digest("hex"),
  };
}

/** The dataset by name, or null when this build no longer ships it. */
export function archivedDatasetDefinition(name: string): ExportDataset | null {
  return findDataset(name) ?? null;
}
