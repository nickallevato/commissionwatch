import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // One row per sweep. 'partial' records a sweep that produced work but also
  // errors, because a sweep that half-failed must not be reported as success.
  await knex.raw(
    `CREATE TYPE ingestion_run_status AS ENUM ('running', 'succeeded', 'partial', 'failed')`,
  );

  await knex.schema.createTable('ingestion_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('source_id')
      .notNullable()
      .references('id')
      .inTable('ingestion_sources')
      .onDelete('CASCADE');
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true }).nullable();
    table
      .specificType('status', 'ingestion_run_status')
      .notNullable()
      .defaultTo('running');
    // Per-stage tallies, e.g. { "discovered": 12, "fetched": 9, "parsed": 9, "failed": 1 }.
    table.jsonb('counts').notNullable().defaultTo('{}');
    // Never swallowed: a failed sweep terminates here with its error text.
    table.text('error').nullable();
    table.timestamps(true, true);

    // Status page query: latest runs for a source, newest first.
    table.index(['source_id', 'started_at'], 'idx_ingestion_runs_source_started');
    table.index('status', 'idx_ingestion_runs_status');
  });

  await knex.raw(`
    ALTER TABLE ingestion_runs
    ADD CONSTRAINT ingestion_runs_finished_after_started_check
    CHECK (finished_at IS NULL OR finished_at >= started_at)
  `);

  // A run is only terminal once it has a finish time.
  await knex.raw(`
    ALTER TABLE ingestion_runs
    ADD CONSTRAINT ingestion_runs_terminal_finished_check
    CHECK (status = 'running' OR finished_at IS NOT NULL)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ingestion_runs');
  await knex.raw('DROP TYPE IF EXISTS ingestion_run_status');
}
