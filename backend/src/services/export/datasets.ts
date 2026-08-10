import type { Knex } from "knex";
import { whereFindingPublic, whereMeetingPublished } from "../publication";

/**
 * The bulk export — what leaves this project as open data, and what does not.
 *
 * Three properties hold across every dataset below, and each of them is the
 * kind of thing that erodes silently rather than breaking loudly:
 *
 * 1. **Only the published record leaves.** Every query that touches a meeting
 *    reaches the wall through `services/publication.ts` — `whereMeetingPublished`
 *    and `whereFindingPublic` — rather than retyping `whereNotNull("published_at")`
 *    in ten places. An export is the largest public surface this product has: it
 *    takes no id, so unlike a meeting page it cannot be protected by a reader
 *    being unable to guess one, and a single missed predicate would hand over
 *    the whole review queue in one file. `test/data-export.test.ts` asserts the
 *    wall in both directions on every dataset, withheld then published, because
 *    absence alone would also hold for a query that is simply broken.
 *
 * 2. **Provenance travels with the row.** A row without its artifact reference
 *    is a claim without a source, which is precisely what this project exists
 *    not to publish. Every dataset derived from a document carries
 *    `source_artifact_sha256`, and the `artifact_references` dataset carries the
 *    full document-to-artifact mapping with the original `source_url`. Where the
 *    schema records no artifact — `members`, `jurisdictions`, `commissions` —
 *    the column is absent rather than null, and `/data` says so in words. An
 *    empty provenance column would read as "we lost the source"; no column reads
 *    as "there was never one", which is the true statement.
 *
 * 3. **Nothing is buffered.** Each dataset is read in keyset batches ordered by
 *    `id` and written to the response as it arrives. Knex's `.stream()` needs
 *    `pg-query-stream`, which is not a dependency here and is not worth becoming
 *    one; keyset pagination gets the same bounded memory with no new package and
 *    no cursor held open across a slow client.
 *
 * `storage_key` is never exported. It is the MinIO object key — an internal
 * address for bytes we do not redistribute anyway — and the useful half of an
 * artifact row is the `sha256` and the `source_url`, which are exactly what let
 * a reader fetch the same file from the government and check it byte for byte.
 */

/** Rows per round trip. Bounded memory; the export is written as it is read. */
export const EXPORT_BATCH_SIZE = 500;

export interface ExportDataset {
  /** Path segment and file stem: `/api/data/meetings.csv`. */
  readonly name: string;
  /** One sentence, rendered on `/data` and carried in the manifest. */
  readonly description: string;
  /**
   * How a row in this dataset traces to a stored document, in words. `null`
   * where the schema records no artifact for it — stated, never implied.
   */
  readonly provenance: string | null;
  /** Column order, which is also the CSV header order. Stable within a release. */
  readonly columns: readonly string[];
  /**
   * The column the keyset window walks, **qualified** where the query joins.
   *
   * `ORDER BY id` resolves against the select list and is fine; `WHERE id > ?`
   * resolves against the tables and is ambiguous the moment two of them carry an
   * `id`. That fails on the *second* batch only — the loop always asks once more
   * than it needs to — so a dataset small enough to fit one batch would look
   * correct in every test that does not exercise the boundary. Naming the column
   * removes the class of bug rather than the instance.
   */
  readonly keyColumn?: string;
  /**
   * The rows this dataset publishes, unordered and unpaginated. The caller adds
   * the keyset window, so the publication predicates live here exactly once.
   */
  build(db: Knex): Knex.QueryBuilder;
}

/* ---------------------------------------------------------------------------
   Shared SQL fragments
   --------------------------------------------------------------------------- */

/**
 * The newest stored artifact behind a meeting's document of a given kind.
 *
 * Ordered by `version_no` descending, so a republished agenda exports the
 * version the current rows were extracted from rather than the first one ever
 * seen. NULL where nothing has been fetched and stored for that meeting — a
 * Word document that failed to parse still has an artifact; a meeting we only
 * ever saw on a listing page does not.
 */
function newestArtifactSha(db: Knex, meetingColumn: string, kinds: readonly string[]): Knex.Raw {
  return db.raw(
    `(
       SELECT a.sha256
       FROM document_versions dv
       JOIN meeting_documents md ON md.id = dv.meeting_document_id
       JOIN artifacts a ON a.id = dv.artifact_id
       WHERE md.meeting_id = ${meetingColumn}
         AND md.document_type IN (${kinds.map(() => "?").join(", ")})
       ORDER BY array_position(ARRAY[${kinds.map(() => "?").join(", ")}]::text[], md.document_type),
                dv.version_no DESC
       LIMIT 1
     ) AS source_artifact_sha256`,
    [...kinds, ...kinds],
  );
}

/** Restricts a query to rows whose `meeting_id` names a published meeting. */
function whereMeetingIdPublished<T extends Knex.QueryBuilder>(
  db: Knex,
  query: T,
  table: string,
): T {
  // `EXISTS` rather than a join, for the reason B3 gives: an `EXISTS` that is
  // wrong returns nothing, and a join that is wrong returns everything. On an
  // export the second failure mode empties the review queue onto the internet.
  query.whereExists(
    whereMeetingPublished(
      db("meetings").whereRaw(`meetings.id = ${table}.meeting_id`),
      "meetings.published_at",
    ),
  );
  return query;
}

/* ---------------------------------------------------------------------------
   The datasets
   --------------------------------------------------------------------------- */

const jurisdictions: ExportDataset = {
  name: "jurisdictions",
  description:
    "Every city, county or state body this project watches, with the timezone its meeting times are expressed in.",
  provenance: null,
  columns: [
    "id",
    "name",
    "state",
    "type",
    "website_url",
    "timezone",
    "agenda_change_window_hours",
    "created_at",
    "updated_at",
  ],
  build: (db) =>
    db("jurisdictions").select(
      "id",
      "name",
      "state",
      "type",
      "website_url",
      "timezone",
      "agenda_change_window_hours",
      "created_at",
      "updated_at",
    ),
};

const commissions: ExportDataset = {
  name: "commissions",
  description:
    "The commissions, boards and committees within each jurisdiction. A body appears here whether or not any of its meetings are published.",
  provenance: null,
  columns: [
    "id",
    "jurisdiction_id",
    "name",
    "description",
    "meeting_schedule",
    "created_at",
    "updated_at",
  ],
  build: (db) =>
    db("commissions").select(
      "id",
      "jurisdiction_id",
      "name",
      "description",
      "meeting_schedule",
      "created_at",
      "updated_at",
    ),
};

const meetings: ExportDataset = {
  name: "meetings",
  description:
    "Published meetings. `time` is null where the source states no start time — it is not midnight.",
  provenance:
    "`source_artifact_sha256` is the newest stored agenda for the meeting, or null where no agenda has been fetched and stored.",
  columns: [
    "id",
    "commission_id",
    "date",
    "time",
    "location",
    "status",
    "agenda_url",
    "minutes_url",
    "external_id",
    "published_at",
    "created_at",
    "updated_at",
    "source_artifact_sha256",
  ],
  build: (db) =>
    whereMeetingPublished(
      db("meetings").select(
        "meetings.id",
        "meetings.commission_id",
        // `date` and `time` are rendered in SQL rather than by the pg driver,
        // which hands a DATE back as a JS Date at the *server's* local midnight.
        // Serialising that would shift a Montana meeting onto the previous day
        // for anyone running the export in a positive UTC offset.
        db.raw("to_char(meetings.date, 'YYYY-MM-DD') AS date"),
        db.raw("to_char(meetings.time, 'HH24:MI') AS time"),
        "meetings.location",
        "meetings.status",
        "meetings.agenda_url",
        "meetings.minutes_url",
        "meetings.external_id",
        "meetings.published_at",
        "meetings.created_at",
        "meetings.updated_at",
        newestArtifactSha(db, "meetings.id", ["agenda"]),
      ),
      "meetings.published_at",
    ),
};

const agendaItems: ExportDataset = {
  name: "agenda_items",
  description:
    "Items extracted from published agendas. `field_confidence` records per-column extraction confidence where the extractor was unsure.",
  provenance:
    "`source_artifact_sha256` is the agenda these items were extracted from.",
  columns: [
    "id",
    "meeting_id",
    "item_number",
    "title",
    "description",
    "category",
    "field_confidence",
    "created_at",
    "updated_at",
    "source_artifact_sha256",
  ],
  build: (db) =>
    whereMeetingIdPublished(
      db,
      db("agenda_items").select(
        "agenda_items.id",
        "agenda_items.meeting_id",
        "agenda_items.item_number",
        "agenda_items.title",
        "agenda_items.description",
        "agenda_items.category",
        "agenda_items.field_confidence",
        "agenda_items.created_at",
        "agenda_items.updated_at",
        newestArtifactSha(db, "agenda_items.meeting_id", ["agenda"]),
      ),
      "agenda_items",
    ),
};

const meetingDocuments: ExportDataset = {
  name: "meeting_documents",
  description:
    "Documents a published meeting links to, with the content address of the copy this project stored.",
  provenance:
    "`source_artifact_sha256` is the newest stored version of this document. `url` is where the jurisdiction published it.",
  columns: [
    "id",
    "meeting_id",
    "title",
    "document_type",
    "url",
    "created_at",
    "updated_at",
    "source_artifact_sha256",
  ],
  build: (db) =>
    whereMeetingIdPublished(
      db,
      db("meeting_documents").select(
        "meeting_documents.id",
        "meeting_documents.meeting_id",
        "meeting_documents.title",
        "meeting_documents.document_type",
        "meeting_documents.url",
        "meeting_documents.created_at",
        "meeting_documents.updated_at",
        db.raw(
          `(
             SELECT a.sha256
             FROM document_versions dv
             JOIN artifacts a ON a.id = dv.artifact_id
             WHERE dv.meeting_document_id = meeting_documents.id
             ORDER BY dv.version_no DESC
             LIMIT 1
           ) AS source_artifact_sha256`,
        ),
      ),
      "meeting_documents",
    ),
};

const members: ExportDataset = {
  name: "members",
  description:
    "Elected and appointed officials. `email` is the official government address the jurisdiction publishes; no personal address is ever collected. `party` is blank for nonpartisan offices, which means unknown and never independent.",
  provenance: null,
  columns: [
    "id",
    "jurisdiction_id",
    "name",
    "title",
    "term_start",
    "term_end",
    "email",
    "party",
    "created_at",
    "updated_at",
  ],
  build: (db) =>
    db("members").select(
      "id",
      "jurisdiction_id",
      "name",
      "title",
      db.raw("to_char(term_start, 'YYYY-MM-DD') AS term_start"),
      db.raw("to_char(term_end, 'YYYY-MM-DD') AS term_end"),
      "email",
      "party",
      "created_at",
      "updated_at",
    ),
};

const votes: ExportDataset = {
  name: "votes",
  description: "Recorded votes on published meetings, one row per member per item.",
  provenance:
    "`source_artifact_sha256` is the meeting's stored minutes where one exists, otherwise its agenda. Null where neither has been fetched.",
  columns: [
    "id",
    "meeting_id",
    "agenda_item_id",
    "member_id",
    "vote",
    "created_at",
    "source_artifact_sha256",
  ],
  build: (db) =>
    whereMeetingIdPublished(
      db,
      db("votes").select(
        "votes.id",
        "votes.meeting_id",
        "votes.agenda_item_id",
        "votes.member_id",
        "votes.vote",
        "votes.created_at",
        newestArtifactSha(db, "votes.meeting_id", ["minutes", "agenda"]),
      ),
      "votes",
    ),
};

const findings: ExportDataset = {
  name: "findings",
  description:
    "Anomaly flags an operator has approved for publication. A flag is a reason to look, never a conclusion, and one that is still held never appears here.",
  provenance:
    "`source_artifact_sha256` is the flag's own cited artifact where it has one, otherwise the stored agenda of the meeting it describes.",
  columns: [
    "id",
    "meeting_id",
    "agenda_item_id",
    "flag_type",
    "severity",
    "description",
    "metadata",
    "source",
    "review_state",
    "created_at",
    "source_artifact_sha256",
  ],
  build: (db) =>
    whereFindingPublic(
      db,
      db("anomaly_flags").select(
        "anomaly_flags.id",
        "anomaly_flags.meeting_id",
        "anomaly_flags.agenda_item_id",
        "anomaly_flags.flag_type",
        "anomaly_flags.severity",
        "anomaly_flags.description",
        "anomaly_flags.metadata",
        "anomaly_flags.source",
        "anomaly_flags.review_state",
        "anomaly_flags.created_at",
        db.raw(
          `COALESCE(
             (SELECT a.sha256 FROM artifacts a WHERE a.id = anomaly_flags.artifact_id),
             (
               SELECT a.sha256
               FROM document_versions dv
               JOIN meeting_documents md ON md.id = dv.meeting_document_id
               JOIN artifacts a ON a.id = dv.artifact_id
               WHERE md.meeting_id = anomaly_flags.meeting_id
                 AND md.document_type = 'agenda'
               ORDER BY dv.version_no DESC
               LIMIT 1
             )
           ) AS source_artifact_sha256`,
        ),
      ),
    ),
};

const artifactReferences: ExportDataset = {
  name: "artifact_references",
  keyColumn: "document_versions.id",
  description:
    "The full document-to-artifact mapping for published meetings: every stored version of every linked document, in the order it was first seen.",
  provenance:
    "This dataset is the provenance. `sha256` addresses the bytes; `source_url` is where they were actually fetched from, after redirects.",
  columns: [
    "id",
    "meeting_id",
    "meeting_document_id",
    "document_type",
    "document_url",
    "artifact_id",
    "sha256",
    "source_url",
    "content_type",
    "byte_size",
    "version_no",
    "first_seen_at",
  ],
  build: (db) =>
    whereMeetingIdPublished(
      db,
      db("document_versions")
        .join("meeting_documents", "meeting_documents.id", "document_versions.meeting_document_id")
        .join("artifacts", "artifacts.id", "document_versions.artifact_id")
        .select(
          "document_versions.id",
          "meeting_documents.meeting_id",
          "document_versions.meeting_document_id",
          "meeting_documents.document_type",
          "meeting_documents.url AS document_url",
          "document_versions.artifact_id",
          "artifacts.sha256",
          "artifacts.source_url",
          "artifacts.content_type",
          "artifacts.byte_size",
          "document_versions.version_no",
          "document_versions.first_seen_at",
        ),
      "meeting_documents",
    ),
};

const artifacts: ExportDataset = {
  name: "artifacts",
  description:
    "Metadata for every stored document behind a published meeting. The bytes are not redistributed — they are not this project's documents to relicense — but the content address and the original URL are, so anyone can fetch the same file from the government and verify it is the one that was parsed.",
  provenance: "Each row *is* an artifact reference: `sha256` addresses the bytes.",
  columns: [
    "id",
    "sha256",
    "source_url",
    "content_type",
    "byte_size",
    "fetched_at",
    "created_at",
  ],
  build: (db) =>
    db("artifacts")
      .select(
        "artifacts.id",
        "artifacts.sha256",
        "artifacts.source_url",
        "artifacts.content_type",
        "artifacts.byte_size",
        "artifacts.fetched_at",
        "artifacts.created_at",
      )
      // An artifact reaches the export only by being cited from the published
      // record. An artifact belonging to a withheld meeting carries that
      // meeting's document URL in `source_url`, and a Granicus URL carries the
      // meeting title in its query string — so an unfiltered artifacts table
      // would leak the withheld record's existence and its subject through a
      // dataset that looks like nothing but hashes.
      .whereExists(
        whereMeetingIdPublished(
          db,
          db("document_versions")
            .join(
              "meeting_documents",
              "meeting_documents.id",
              "document_versions.meeting_document_id",
            )
            .whereRaw("document_versions.artifact_id = artifacts.id")
            .select(db.raw("1")),
          "meeting_documents",
        ),
      ),
};

/**
 * Every dataset, in the order `/data` lists them: the shape of the record
 * first, then what was extracted from it, then the evidence underneath.
 */
export const EXPORT_DATASETS: readonly ExportDataset[] = Object.freeze([
  jurisdictions,
  commissions,
  meetings,
  agendaItems,
  meetingDocuments,
  members,
  votes,
  findings,
  artifactReferences,
  artifacts,
]);

export function findDataset(name: string): ExportDataset | undefined {
  return EXPORT_DATASETS.find((dataset) => dataset.name === name);
}

/**
 * One keyset window of a dataset.
 *
 * Ordered by `id` and resumed from the last id seen, rather than by `OFFSET`:
 * an offset scan re-reads everything before it on every batch, and a row
 * inserted mid-export shifts the window and silently drops a row from the file.
 */
export async function readBatch(
  db: Knex,
  dataset: ExportDataset,
  after: string | null,
): Promise<Array<Record<string, unknown>>> {
  const key = dataset.keyColumn ?? "id";
  const query = dataset.build(db).orderBy(key, "asc").limit(EXPORT_BATCH_SIZE);
  if (after !== null) query.where(key, ">", after);
  const rows: unknown = await query;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** Row count for the manifest. Same predicates, so it cannot disagree. */
export async function countDataset(db: Knex, dataset: ExportDataset): Promise<number> {
  const row: unknown = await db
    .from(dataset.build(db).as("dataset"))
    .count<Array<{ count: string }>>({ count: "*" })
    .first();
  const count = (row as { count?: string } | undefined)?.count;
  return count === undefined ? 0 : Number.parseInt(count, 10);
}
