import type { Knex } from "knex";
import { countDataset, EXPORT_DATASETS } from "./datasets";

/**
 * The manifest — what is in the export, under what terms, and how fresh it is.
 *
 * Everything on it is computed. There is no maintained list of datasets, no
 * hand-written row count and no hardcoded date, for the same reason `/status`
 * has none: a description of a dataset kept by hand is a description that is
 * wrong eventually, and this project's whole subject is publications that drift
 * from the record they claim to describe.
 */

/** Attribution string the licence asks for. One line, copy-pasteable. */
export const DATA_ATTRIBUTION = "CommissionWatch — commissionwatch.bmux.sh";

/**
 * The same attribution, ASCII only, for an HTTP header.
 *
 * Node rejects a header value outside latin-1 with `ERR_INVALID_CHAR`, and the
 * em dash above is outside it. Transliterating here rather than dropping the
 * header keeps the licence travelling with a `curl -O` of a CSV, which is the
 * one place a reader has no envelope to read it from.
 */
export const DATA_ATTRIBUTION_HEADER = "CommissionWatch, commissionwatch.bmux.sh";

/**
 * The compiled dataset is CC BY 4.0. The code is MIT, per the repository
 * `LICENSE`. The government documents underneath are public records and this
 * project asserts no licence over them at all — they are not ours.
 *
 * These are three different questions and conflating them is the usual mistake.
 * A single "MIT" on the whole project would be claiming a licence over the
 * county's agendas; a single "CC BY" would be relicensing the code.
 */
export const DATA_LICENSE = {
  dataset: {
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    covers:
      "The compiled dataset: the selection, structure and generated text assembled here. Not the underlying facts, which are not copyrightable and belong to nobody.",
    attribution: `Data from ${DATA_ATTRIBUTION}, CC BY 4.0.`,
  },
  code: {
    name: "MIT",
    url: "https://github.com/nickallevato/commissionwatch/blob/main/LICENSE",
    covers: "Everything in the repository — adapters, parsers, detectors, API and site.",
  },
  documents: {
    name: "No licence asserted",
    url: null,
    covers:
      "Agendas, minutes and their attachments are public records produced by the jurisdictions. They are not this project's to relicense, and their bytes are not redistributed here.",
  },
} as const;

/**
 * A request, stated as a request.
 *
 * CC BY forbids imposing further restrictions, so describing this as a term
 * would be a false claim about the licence — on a project whose subject is
 * false claims.
 */
export const REPUBLICATION_REQUEST =
  "If you republish a finding, republish its corrections status with it. This is asked, not required.";

export interface ManifestDataset {
  name: string;
  description: string;
  provenance: string | null;
  columns: readonly string[];
  row_count: number;
  json_url: string;
  csv_url: string;
}

/**
 * An export that is not a table.
 *
 * `datasets` describes row-shaped files: columns, a row count, a CSV and a JSON
 * URL. The OCD export is none of those — it is nested documents in somebody
 * else's schema — so listing it there would have meant inventing a column list
 * for a thing that has no columns.
 *
 * It needs listing *somewhere*, though, and that is the point: `/bot` tells a
 * machine consumer this manifest is where to start rather than guessing at
 * paths, and for a while the manifest omitted the one export built specifically
 * for machines. A discovery document that does not list an endpoint is that
 * endpoint not existing, as far as anything reading it is concerned.
 */
export interface ManifestStructuredExport {
  name: string;
  description: string;
  /** The vocabulary it speaks, so a consumer knows what to validate against. */
  schema: string;
  url: string;
}

export interface ExportManifest {
  generated_at: string;
  schema_migration: string | null;
  attribution: string;
  license: typeof DATA_LICENSE;
  republication_request: string;
  publication_rule: string;
  datasets: ManifestDataset[];
  structured: ManifestStructuredExport[];
}

/** The newest applied migration, so a reader can pin what shape they received. */
async function schemaMigration(db: Knex): Promise<string | null> {
  const row: unknown = await db("knex_migrations").orderBy("id", "desc").first("name");
  const name = (row as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : null;
}

export async function buildManifest(db: Knex, basePath: string): Promise<ExportManifest> {
  const datasets: ManifestDataset[] = [];
  for (const dataset of EXPORT_DATASETS) {
    datasets.push({
      name: dataset.name,
      description: dataset.description,
      provenance: dataset.provenance,
      columns: dataset.columns,
      row_count: await countDataset(db, dataset),
      json_url: `${basePath}/${dataset.name}.json`,
      csv_url: `${basePath}/${dataset.name}.csv`,
    });
  }

  const structured: ManifestStructuredExport[] = [
    {
      name: "ocd",
      description:
        "The published corpus as Open Civic Data Events, for a consumer ingesting the record rather than reading it. Every event carries at least one source; a published meeting we hold no source URL for is omitted and counted rather than emitted unsourced.",
      schema: "open-civic-data/event",
      url: `${basePath}/ocd.json`,
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    schema_migration: await schemaMigration(db),
    attribution: DATA_LICENSE.dataset.attribution,
    license: DATA_LICENSE,
    republication_request: REPUBLICATION_REQUEST,
    publication_rule:
      "Only records an operator has published appear here. A meeting awaiting review, its agenda items, its documents, its votes and any finding about it are all absent, and a finding that is still held is absent whatever its meeting's state.",
    datasets,
    structured,
  };
}
