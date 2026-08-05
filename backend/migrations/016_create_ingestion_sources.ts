import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 'blocked' is a first-class, non-exceptional state: an adapter whose live
  // fetching is unavailable (Bozeman) sits here while every downstream stage
  // keeps running against stored artifacts.
  await knex.raw(
    `CREATE TYPE ingestion_source_health AS ENUM ('healthy', 'degraded', 'blocked')`,
  );

  await knex.schema.createTable('ingestion_sources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('jurisdiction_id')
      .notNullable()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('CASCADE');
    // Matches SourceAdapter.key, e.g. 'gallatin-civicplus', 'bozeman-akamai', 'mt-cers'.
    table.string('adapter_key', 100).notNullable();
    // Adapter-specific settings: base URLs, body filters, politeness/rate limits.
    table.jsonb('config').notNullable().defaultTo('{}');
    table.boolean('enabled').notNullable().defaultTo(true);
    table
      .specificType('health_status', 'ingestion_source_health')
      .notNullable()
      .defaultTo('healthy');
    table.timestamp('last_success_at', { useTz: true }).nullable();
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.timestamps(true, true);

    // One row per adapter per jurisdiction.
    table.unique(['jurisdiction_id', 'adapter_key'], {
      indexName: 'ingestion_sources_jurisdiction_adapter_unique',
    });
    table.index('adapter_key', 'idx_ingestion_sources_adapter');
    // The status page sweeps enabled sources ordered by health.
    table.index(['enabled', 'health_status'], 'idx_ingestion_sources_enabled_health');
  });

  await knex.raw(`
    ALTER TABLE ingestion_sources
    ADD CONSTRAINT ingestion_sources_consecutive_failures_check
    CHECK (consecutive_failures >= 0)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ingestion_sources');
  await knex.raw('DROP TYPE IF EXISTS ingestion_source_health');
}
