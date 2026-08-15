import { Router, type Response } from "express";
import db from "../config/database";
import { EXPORT_DATASETS, findDataset, readBatch, type ExportDataset } from "../services/export/datasets";
import { buildOcdExport } from "../services/export/ocd";
import { csvRow, projectRow } from "../services/export/serialize";
import { buildManifest, DATA_LICENSE, DATA_ATTRIBUTION_HEADER } from "../services/export/manifest";
import {
  ARCHIVE_DAY_RE,
  archivedDatasetDefinition,
  listSnapshots,
  readArchivedDataset,
  snapshotDataset,
  snapshotDatasets,
  snapshotOn,
} from "../services/export/archive";
import { featureEnabled } from "../services/features/registry";

/**
 * `/api/data` — the bulk export. Public, unauthenticated, no key, no signup.
 *
 * "Here is what the record shows" is only a checkable claim if you can get the
 * record, so putting a form in front of it would be friction that buys nothing.
 *
 * Three routes and nothing else:
 *
 *   GET /api/data                     the manifest — datasets, columns, counts,
 *                                     licence, and the publication rule
 *   GET /api/data/:dataset.json       every published row, one JSON envelope
 *   GET /api/data/:dataset.csv        the same rows, RFC 4180
 *
 * The extension is parsed here rather than declared as `/:dataset.json` in the
 * path, because a route pattern with a dot in it is exactly the kind of thing
 * whose meaning changes under a path-to-regexp major and takes a public URL
 * with it.
 *
 * Every response is written incrementally: a batch is read, serialised and
 * flushed before the next is asked for, so a corpus larger than memory still
 * exports and a slow reader costs a socket rather than a heap. See
 * `services/export/datasets.ts` for the publication wall these queries route
 * through — that file, and not this one, is where an export could go wrong in
 * the way that matters.
 */
const router = Router();

/** Public data. Cache for five minutes; the record changes at sweep cadence. */
const CACHE_CONTROL = "public, max-age=300";

/**
 * Writes and waits for drain when the socket is full.
 *
 * Without this the loop would queue every batch in the socket's write buffer,
 * which is the same unbounded memory the keyset batching exists to avoid — just
 * moved one layer down where it is harder to see.
 */
async function write(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => res.once("drain", resolve));
}

/**
 * Walks a dataset in keyset batches, handing each row to `emit`.
 *
 * Returns the number of rows written, which the JSON envelope publishes so a
 * reader can tell a truncated download from an empty dataset.
 */
async function streamDataset(
  dataset: ExportDataset,
  emit: (row: Record<string, unknown>, index: number) => Promise<void>,
): Promise<number> {
  let after: string | null = null;
  let written = 0;

  for (;;) {
    const rows = await readBatch(db, dataset, after);
    if (rows.length === 0) return written;

    for (const row of rows) {
      await emit(projectRow(dataset.columns, row), written);
      written += 1;
    }

    const last = rows[rows.length - 1].id;
    // Every dataset is keyed on a uuid `id`; a batch whose last row has none
    // would loop forever on the same window, so stop rather than spin.
    if (typeof last !== "string") return written;
    after = last;
  }
}

router.get("/", async (_req, res, next) => {
  try {
    const manifest = await buildManifest(db, "/api/data");
    res.set("Cache-Control", CACHE_CONTROL);
    res.json(manifest);
  } catch (err) {
    next(err);
  }
});

/**
 * The corpus in Open Civic Data's shape, for a consumer ingesting the record
 * rather than reading it.
 *
 * Declared **before** `/:file` on purpose: that handler splits on the last dot
 * and looks the stem up in `EXPORT_DATASETS`, so `ocd.json` would resolve to a
 * dataset named `ocd` and 404. Express matches in declaration order, and this
 * is the same class of precedence trap `frontend/nginx.conf` documents twice.
 */
/* ---------------------------------------------------------------------------
   The dated archive — F7, behind `dated_export_archive`, default off
   --------------------------------------------------------------------------- */

/**
 * Declared **before** `/:file`, for the reason `/ocd.json` gives: that handler
 * splits on the last dot and would resolve `archive` to a dataset named
 * `archive` and 404.
 *
 * Off, both archive paths answer **404** — not 503 and not "disabled" — because
 * "this site has no dated archive" is the true statement while the flag is off,
 * and it is the same choice `/mcp` makes. Resolved per request through the
 * registry's cached read, so an operator turning it on does not need a redeploy.
 */
function archiveOff(res: Response): boolean {
  if (featureEnabled("dated_export_archive")) return false;
  res.status(404).json({
    error: "No such endpoint",
    statusCode: 404,
  });
  return true;
}

/**
 * What the archive can and cannot answer.
 *
 * The boundary is published rather than left to be discovered by a 404: a reader
 * asking for a date before the first snapshot is told that nothing was recorded
 * then, which is a different fact from the site having said nothing.
 */
router.get("/archive", async (_req, res, next) => {
  if (archiveOff(res)) return;
  try {
    const snapshots = await listSnapshots(db);
    const earliest = snapshots[snapshots.length - 1];
    res.set("Cache-Control", CACHE_CONTROL);
    res.json({
      description:
        "Point-in-time exports, addressed by UTC date. Each one is the set of rows the export " +
        "held when the snapshot was taken, filtered through today's publication rule — so it is " +
        "the rows that were published then and are still published now.",
      // The honest limits, on the response rather than in a document.
      answerable_from: earliest === undefined ? null : earliest.taken_at.toISOString(),
      forward_only:
        "Publication state is a single mutable column and withdrawing a record clears it, so what " +
        "was public on a date before the first snapshot cannot be reconstructed from the record. " +
        "This archive answers from the first snapshot onward and does not guess before it.",
      retraction:
        "A record withdrawn since a snapshot was taken is absent from that snapshot's export too. " +
        "The archive re-reads through the same publication wall as /api/data; it does not serve " +
        "stored copies. `withheld_since` on each dataset counts what has gone.",
      snapshots: snapshots.map((snapshot) => ({
        date: snapshot.taken_at.toISOString().slice(0, 10),
        taken_at: snapshot.taken_at.toISOString(),
        note: snapshot.note,
      })),
      datasets: EXPORT_DATASETS.map((dataset) => dataset.name),
      formats: ["json", "csv"],
      path: "/api/data/archive/{date}/{dataset}.{json|csv}",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/archive/:day", async (req, res, next) => {
  if (archiveOff(res)) return;
  try {
    const { day } = req.params;
    if (!ARCHIVE_DAY_RE.test(day)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD", statusCode: 400 });
      return;
    }
    const snapshot = await snapshotOn(db, day);
    if (snapshot === null) {
      // Not "there is nothing", which would be a claim about the record.
      res.status(404).json({
        error: `No snapshot had been taken on or before ${day}, so what this site published that ` +
          "day was never recorded and cannot be reconstructed.",
        statusCode: 404,
      });
      return;
    }
    const recorded = await snapshotDatasets(db, snapshot.id);
    res.set("Cache-Control", CACHE_CONTROL);
    res.json({
      requested_date: day,
      taken_at: snapshot.taken_at.toISOString(),
      note: snapshot.note,
      datasets: recorded.map((entry) => ({
        dataset: entry.dataset,
        row_count: entry.row_count,
        sha256: entry.sha256,
        // Inert rather than an error: a snapshot naming a dataset this build no
        // longer ships is what a rollback leaves behind.
        available: archivedDatasetDefinition(entry.dataset) !== null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/archive/:day/:file", async (req, res, next) => {
  if (archiveOff(res)) return;
  try {
    const { day, file } = req.params;
    const dot = file.lastIndexOf(".");
    const name = dot === -1 ? file : file.slice(0, dot);
    const format = dot === -1 ? "" : file.slice(dot + 1);

    if (!ARCHIVE_DAY_RE.test(day)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD", statusCode: 400 });
      return;
    }
    const definition = archivedDatasetDefinition(name);
    if (definition === null || (format !== "json" && format !== "csv")) {
      res.status(404).json({
        error: "No such dataset",
        datasets: EXPORT_DATASETS.map((entry) => entry.name),
        formats: ["json", "csv"],
        statusCode: 404,
      });
      return;
    }

    const snapshot = await snapshotOn(db, day);
    if (snapshot === null) {
      res.status(404).json({
        error: `No snapshot had been taken on or before ${day}.`,
        statusCode: 404,
      });
      return;
    }
    const recorded = await snapshotDataset(db, snapshot.id, name);
    if (recorded === null) {
      res.status(404).json({
        error: `The snapshot of ${snapshot.taken_at.toISOString().slice(0, 10)} did not record ${name}.`,
        statusCode: 404,
      });
      return;
    }

    const archived = await readArchivedDataset(db, definition, recorded);

    res.set("Cache-Control", CACHE_CONTROL);
    res.set("X-License", DATA_LICENSE.dataset.name);
    res.set("X-Attribution", DATA_ATTRIBUTION_HEADER);
    res.set(
      "Content-Disposition",
      `inline; filename="commissionwatch-${name}-${day}.${format}"`,
    );

    if (format === "csv") {
      res.type("text/csv; charset=utf-8");
      await write(res, `${definition.columns.join(",")}\r\n`);
      for (const row of archived.rows) await write(res, csvRow(definition.columns, row));
      res.end();
      return;
    }

    res.type("application/json; charset=utf-8");
    res.json({
      dataset: name,
      requested_date: day,
      taken_at: snapshot.taken_at.toISOString(),
      license: DATA_LICENSE.dataset.name,
      attribution: DATA_LICENSE.dataset.attribution,
      provenance: definition.provenance,
      // The claim, stated on the file rather than in a document somebody may not
      // have read: this is not the bytes we served that day.
      served_through_todays_wall:
        "These are the rows this dataset held on that date and which remain published today. " +
        "Records withdrawn since are absent.",
      rows_recorded: archived.recorded,
      rows_served: archived.served,
      withheld_since: archived.withheld_since,
      sha256_then: archived.sha256_then,
      sha256_now: archived.sha256_now,
      unchanged: archived.sha256_then === archived.sha256_now,
      columns: definition.columns,
      rows: archived.rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ocd.json", async (_req, res, next) => {
  try {
    const ocd = await buildOcdExport(db);
    res.set("Cache-Control", CACHE_CONTROL);
    res.json(ocd);
  } catch (err) {
    next(err);
  }
});

router.get("/:file", async (req, res, next) => {
  const file = req.params.file;
  const dot = file.lastIndexOf(".");
  const name = dot === -1 ? file : file.slice(0, dot);
  const format = dot === -1 ? "" : file.slice(dot + 1);
  const dataset = findDataset(name);

  if (dataset === undefined || (format !== "json" && format !== "csv")) {
    res.status(404).json({
      error: "No such dataset",
      datasets: EXPORT_DATASETS.map((entry) => entry.name),
      formats: ["json", "csv"],
      manifest: "/api/data",
    });
    return;
  }

  try {
    res.set("Cache-Control", CACHE_CONTROL);
    // Attribution in a header as well as in the body: a `curl -O` of the CSV
    // keeps no envelope, and the licence has to travel with the file rather
    // than with the page somebody found it on.
    res.set("X-License", DATA_LICENSE.dataset.name);
    res.set("X-Attribution", DATA_ATTRIBUTION_HEADER);
    res.set("Content-Disposition", `inline; filename="commissionwatch-${name}.${format}"`);

    if (format === "csv") {
      res.type("text/csv; charset=utf-8");
      await write(res, `${dataset.columns.join(",")}\r\n`);
      // No trailing row count: a comment line would break RFC 4180. The count
      // lives in the manifest and in the JSON envelope instead.
      await streamDataset(dataset, async (row) => {
        await write(res, csvRow(dataset.columns, row));
      });
      res.end();
      return;
    }

    res.type("application/json; charset=utf-8");
    await write(
      res,
      `{"dataset":${JSON.stringify(name)},` +
        `"license":${JSON.stringify(DATA_LICENSE.dataset.name)},` +
        `"attribution":${JSON.stringify(DATA_LICENSE.dataset.attribution)},` +
        `"provenance":${JSON.stringify(dataset.provenance)},` +
        `"generated_at":${JSON.stringify(new Date().toISOString())},` +
        `"columns":${JSON.stringify(dataset.columns)},` +
        `"rows":[`,
    );
    const count = await streamDataset(dataset, async (row, index) => {
      await write(res, `${index === 0 ? "" : ","}\n${JSON.stringify(row)}`);
    });
    await write(res, `\n],"row_count":${count}}\n`);
    res.end();
  } catch (err) {
    // Once the first chunk is out the status line is gone and the error handler
    // cannot answer with JSON. Destroying the socket makes the download fail
    // loudly at the client rather than arriving truncated and well-formed,
    // which on an export is a silently incomplete public record.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
});

export default router;
