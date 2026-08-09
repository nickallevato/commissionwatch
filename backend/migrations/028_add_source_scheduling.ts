import type { Knex } from 'knex';

/**
 * Scheduling cadence for `ingestion_sources`, so changing when a source sweeps
 * is an UPDATE rather than a deploy.
 *
 * `enabled` is deliberately NOT added here: it has existed since 016, as
 * `boolean not null default true`, and is half of
 * `idx_ingestion_sources_enabled_health`. The phase-2 spec said to add it; that
 * was wrong and the spec has been corrected.
 *
 * `expected_interval_hours` is the column that makes a silence watch possible.
 * A source that has not succeeded inside its expected interval is Suspect —
 * silence is treated as failure until proven otherwise, because otherwise a
 * dead scraper and a quiet month at City Hall render identically.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ingestion_sources', (table) => {
    // Five-field cron, evaluated in UTC. 07:17 rather than 07:00 so that
    // several sources added later do not all fire on the same second.
    table.text('cron_expression').notNullable().defaultTo('17 7 * * *');
    // NULL means no expectation has been stated for this source, which is a
    // different thing from an expectation of zero.
    table.integer('expected_interval_hours').nullable();
  });

  await knex.raw(`
    ALTER TABLE ingestion_sources
    ADD CONSTRAINT ingestion_sources_expected_interval_check
    CHECK (expected_interval_hours IS NULL OR expected_interval_hours > 0)
  `);

  await knex.raw(`
    ALTER TABLE ingestion_sources
    ADD CONSTRAINT ingestion_sources_cron_expression_check
    CHECK (length(btrim(cron_expression)) > 0)
  `);

  // The scheduler's reload query: every enabled source and its cadence.
  await knex.raw(`
    CREATE INDEX idx_ingestion_sources_enabled_cron
    ON ingestion_sources (enabled)
    WHERE enabled
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_ingestion_sources_enabled_cron');
  await knex.raw(
    'ALTER TABLE ingestion_sources DROP CONSTRAINT IF EXISTS ingestion_sources_cron_expression_check',
  );
  await knex.raw(
    'ALTER TABLE ingestion_sources DROP CONSTRAINT IF EXISTS ingestion_sources_expected_interval_check',
  );
  await knex.schema.alterTable('ingestion_sources', (table) => {
    table.dropColumn('expected_interval_hours');
    table.dropColumn('cron_expression');
  });
}
