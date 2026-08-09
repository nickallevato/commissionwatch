import type { Knex } from 'knex';

/**
 * B-d — public-records requests, and documents obtained by hand.
 *
 * `artifacts` already anticipated this: its `source_url` is nullable precisely
 * so a document obtained by public-records request flows through the identical
 * pipeline as an automatically fetched one. Nothing here duplicates document
 * storage, and the archive's bespoke FOIA document tables are not ported.
 */
export async function up(knex: Knex): Promise<void> {
  // ---- the request lifecycle, and only the lifecycle ---------------------

  await knex.schema.createTable('records_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('jurisdiction_id')
      .nullable()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('SET NULL');
    table.text('subject').notNullable();
    table.string('status', 30).notNullable().defaultTo('draft');
    table.timestamp('submitted_at', { useTz: true }).nullable();
    table.timestamp('response_due_at', { useTz: true }).nullable();
    table.timestamp('responded_at', { useTz: true }).nullable();
    table.text('notes').nullable();
    table.timestamps(true, true);

    table.index('jurisdiction_id', 'idx_records_requests_jurisdiction');
    table.index('status', 'idx_records_requests_status');
  });

  await knex.raw(`
    ALTER TABLE records_requests
    ADD CONSTRAINT records_requests_status_check
    CHECK (status IN (
      'draft', 'submitted', 'acknowledged', 'partially_fulfilled',
      'fulfilled', 'denied', 'withdrawn'
    ))
  `);

  // Many-to-many: one request usually returns several documents, and one
  // content-addressed artifact can satisfy two requests. A column on either
  // side would be wrong in one of those directions.
  await knex.schema.createTable('records_request_artifacts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('request_id')
      .notNullable()
      .references('id')
      .inTable('records_requests')
      .onDelete('CASCADE');
    table
      .uuid('artifact_id')
      .notNullable()
      .references('id')
      .inTable('artifacts')
      .onDelete('CASCADE');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['request_id', 'artifact_id'], {
      indexName: 'records_request_artifacts_unique',
    });
  });

  // ---- extraction, append-only -------------------------------------------

  await knex.schema.createTable('record_extractions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('artifact_id')
      .notNullable()
      .references('id')
      .inTable('artifacts')
      .onDelete('CASCADE');
    // { people: [{value, confidence}], organizations: [...], amounts: [...], dates: [...] }
    table.jsonb('entities').notNullable();
    table.string('extractor_version', 20).notNullable();
    // A correction inserts a row pointing at the one it replaces. Nothing is
    // ever updated, so what the machine originally said survives the
    // correction — which is the entire point of an append-only path on a
    // project whose subject is the public record.
    table
      .uuid('supersedes_id')
      .nullable()
      .references('id')
      .inTable('record_extractions')
      .onDelete('SET NULL');
    table
      .uuid('corrected_by')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');
    table.text('note').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['artifact_id', 'created_at'], 'idx_record_extractions_artifact');
  });

  // ---- anomaly_flags: flags that are about a document, not a meeting -----

  await knex.schema.alterTable('anomaly_flags', (table) => {
    table
      .uuid('artifact_id')
      .nullable()
      .references('id')
      .inTable('artifacts')
      .onDelete('CASCADE');
    table.index('artifact_id', 'idx_anomaly_flags_artifact');
  });

  await knex.raw('ALTER TABLE anomaly_flags ALTER COLUMN meeting_id DROP NOT NULL');
  await knex.raw(`
    ALTER TABLE anomaly_flags
    ADD CONSTRAINT anomaly_flags_subject_check
    CHECK (meeting_id IS NOT NULL OR artifact_id IS NOT NULL)
  `);

  /**
   * The publication gate.
   *
   * GET /api/anomalies is a public route. Extraction from a records document
   * names people — that is what it is for — so a records-derived flag would be
   * publicly readable the moment it was written, which is exactly what "nothing
   * naming a person auto-publishes" forbids.
   *
   * The default is `published` on purpose. Meeting-derived flags describe a
   * meeting's procedure, carry no extracted personal names, and are what the
   * site publishes today; changing that is a different decision than this one.
   * Every records-derived flag is written `held`. B-a generalises this column
   * into the review queue.
   */
  await knex.schema.alterTable('anomaly_flags', (table) => {
    table.string('review_state', 20).notNullable().defaultTo('published');
    table.index('review_state', 'idx_anomaly_flags_review_state');
  });

  await knex.raw(`
    ALTER TABLE anomaly_flags
    ADD CONSTRAINT anomaly_flags_review_state_check
    CHECK (review_state IN ('published', 'held'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE anomaly_flags DROP CONSTRAINT IF EXISTS anomaly_flags_review_state_check');
  await knex.raw('ALTER TABLE anomaly_flags DROP CONSTRAINT IF EXISTS anomaly_flags_subject_check');
  await knex.schema.alterTable('anomaly_flags', (table) => {
    table.dropColumn('review_state');
    table.dropColumn('artifact_id');
  });
  await knex.raw('ALTER TABLE anomaly_flags ALTER COLUMN meeting_id SET NOT NULL');

  await knex.schema.dropTableIfExists('record_extractions');
  await knex.schema.dropTableIfExists('records_request_artifacts');
  await knex.schema.dropTableIfExists('records_requests');
}
