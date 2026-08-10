import { Router, type Response } from "express";
import db from "../config/database";
import { EXPORT_DATASETS, findDataset, readBatch, type ExportDataset } from "../services/export/datasets";
import { csvRow, projectRow } from "../services/export/serialize";
import { buildManifest, DATA_LICENSE, DATA_ATTRIBUTION_HEADER } from "../services/export/manifest";

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
