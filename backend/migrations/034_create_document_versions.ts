import type { Knex } from "knex";

/**
 * P5 · Agenda diff timeline — the join that was never made.
 *
 * `anomaly_flag_type` has carried `last_minute_agenda_change` since migration
 * 011 and nothing could substantiate it, because no version history was kept.
 * Yet `artifacts.sha256` has been `UNIQUE` since migration 019, so every
 * distinct version of a republished agenda has *already* been preserved from
 * the moment it was fetched twice. What was missing is that `meeting_documents`
 * and `artifacts` were never joined.
 *
 * `document_versions` is that join. The fetch stage writes a row on every
 * successful fetch and the two unique constraints decide whether it is new:
 * unchanged bytes resolve to the same artifact and collide on
 * `(meeting_document_id, artifact_id)`; changed bytes create exactly one row.
 * Version history is therefore a consequence of the existing fetch path rather
 * than new bookkeeping, and there is deliberately no "have I seen this before"
 * branch anywhere for the two to disagree about.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("document_versions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("meeting_document_id")
      .notNullable()
      .references("id")
      .inTable("meeting_documents")
      .onDelete("CASCADE");
    // No cascade from artifacts: an artifact is the evidence, and a version
    // row losing its evidence silently would leave a citation pointing at
    // nothing. Deleting a cited artifact should fail loudly.
    table.uuid("artifact_id").notNullable().references("id").inTable("artifacts");
    table.integer("version_no").notNullable();
    table.timestamp("first_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    /**
     * The agenda items extracted from *this* artifact.
     *
     * `agenda_items` cannot answer for a superseded version: `upsertAgendaItems`
     * merges on `(meeting_id, item_number)`, so parsing version 2 overwrites
     * version 1's rows. Without a per-version snapshot there is nothing left to
     * diff but bytes, and bytes differ for meaningless reasons. Written once by
     * the parse stage and never revised.
     *
     * NULL means "not extracted" — a Word document, an unparsed backfilled
     * artifact — which is not the same as "no items" and must never render as
     * one.
     */
    table.jsonb("item_snapshot").nullable();
    table.timestamps(true, true);

    // Unchanged bytes collide here. This constraint is the whole deduplication
    // mechanism; it is not a safety net over one written elsewhere.
    table.unique(["meeting_document_id", "artifact_id"], {
      indexName: "document_versions_document_artifact_unique",
    });
    table.unique(["meeting_document_id", "version_no"], {
      indexName: "document_versions_document_version_unique",
    });
    table.index("artifact_id", "idx_document_versions_artifact");
    table.index("first_seen_at", "idx_document_versions_first_seen_at");
  });

  await knex.raw(`
    ALTER TABLE document_versions
    ADD CONSTRAINT document_versions_version_no_check
    CHECK (version_no >= 1)
  `);

  /**
   * How close to the vote counts as "last minute", per jurisdiction.
   *
   * A county board that publishes a fortnight ahead and a city commission that
   * publishes on the Friday are not the same record, and one hardcoded number
   * would call one of them late by construction.
   */
  await knex.schema.alterTable("jurisdictions", (table) => {
    table.integer("agenda_change_window_hours").notNullable().defaultTo(48);
  });

  await knex.raw(`
    ALTER TABLE jurisdictions
    ADD CONSTRAINT jurisdictions_agenda_change_window_check
    CHECK (agenda_change_window_hours > 0)
  `);

  /**
   * The zone `meetings.date` + `meetings.time` are written in.
   *
   * `meetings` stores a `DATE` and a bare `TIME` with no zone, and the finding
   * this migration enables publishes a number — "republished 19 hours before
   * the meeting" — computed by subtracting an absolute `first_seen_at` from
   * that wall time. Composing it in whatever zone the server happens to run in
   * would make the published figure quietly wrong by the UTC offset, which for
   * Montana is six or seven hours against a 48-hour window. That is the
   * difference between a flag and a false statement.
   *
   * `MeetingRef.timezone` has been in the adapter contract since P1 and was
   * discarded on the way to the database. Both live adapters emit
   * `America/Denver`, which is the default.
   */
  await knex.schema.alterTable("jurisdictions", (table) => {
    table.string("timezone", 64).notNullable().defaultTo("America/Denver");
  });

  /**
   * Backfill: every artifact already fetched becomes a version of the document
   * it was fetched from.
   *
   * Two ways to make the link, because one is not enough:
   *
   * 1. `artifacts.source_url = meeting_documents.url`. Exact, and it needs no
   *    job history — but it only holds for a source that does not redirect.
   *    Gallatin's eleven artifacts match here.
   * 2. The `parse` job the fetch stage enqueued. Its target carries `sha256`,
   *    `meetingId` and `documentType`, which is precisely the artifact and
   *    precisely the document.
   *
   * Pass 2 exists because pass 1 silently misses Bozeman entirely: Granicus
   * redirects `AgendaViewer.php` to an S3 attachment and `source_url` records
   * where the bytes actually came from, not what we asked for. Verified against
   * the local sweep — 11 of 19 artifacts match on URL, 19 of 19 match through
   * the parse jobs, as a clean bijection. Trusting the URL join alone would
   * have backfilled two thirds of the record and reported success.
   *
   * `row_number()` over `fetched_at` numbers a document's artifacts
   * chronologically, so a document that already has two on file gets 1 and 2 in
   * the order they arrived rather than in whatever order the planner returns.
   *
   * `item_snapshot` stays NULL. We do not hold a per-artifact extraction for
   * these and inventing one would put a fabricated record behind a diff.
   */
  await knex.raw(`
    INSERT INTO document_versions
      (meeting_document_id, artifact_id, version_no, first_seen_at, created_at, updated_at)
    SELECT
      numbered.meeting_document_id,
      numbered.artifact_id,
      numbered.version_no,
      numbered.fetched_at,
      now(),
      now()
    FROM (
      SELECT
        pairs.meeting_document_id,
        pairs.artifact_id,
        pairs.fetched_at,
        row_number() OVER (
          PARTITION BY pairs.meeting_document_id
          ORDER BY pairs.fetched_at, pairs.artifact_id
        ) AS version_no
      FROM (
        SELECT md.id AS meeting_document_id, a.id AS artifact_id, a.fetched_at
        FROM meeting_documents md
        JOIN artifacts a ON a.source_url = md.url

        UNION

        SELECT md.id AS meeting_document_id, a.id AS artifact_id, a.fetched_at
        FROM ingestion_jobs j
        JOIN artifacts a
          ON a.sha256 = j.target->>'sha256'
        JOIN meeting_documents md
          ON md.meeting_id = (j.target->>'meetingId')::uuid
         AND md.document_type = j.target->>'documentType'
        -- \`->>\` rather than the \`?\` containment operator: Knex reads a bare
        -- \`?\` in raw SQL as a bind placeholder and rewrites it to \`$1\`.
        WHERE j.stage = 'parse'
          AND j.target->>'sha256' IS NOT NULL
          AND j.target->>'meetingId' IS NOT NULL
          AND j.target->>'documentType' IS NOT NULL
      ) AS pairs
    ) AS numbered
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    "ALTER TABLE jurisdictions DROP CONSTRAINT IF EXISTS jurisdictions_agenda_change_window_check",
  );
  await knex.schema.alterTable("jurisdictions", (table) => {
    table.dropColumn("agenda_change_window_hours");
    table.dropColumn("timezone");
  });
  await knex.schema.dropTableIfExists("document_versions");
}
