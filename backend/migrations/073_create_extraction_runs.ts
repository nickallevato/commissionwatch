import type { Knex } from 'knex';

/**
 * One attempt to extract a meeting's minutes, and what it cost.
 *
 * Added because the first two live extractions both told the operator nothing
 * useful. The first failed on every chunk — the configured model had silently
 * stopped being free — and the second was cut off by nginx's 60-second
 * `proxy_read_timeout`, which rendered as a 504 with no JSON body at all while
 * the work carried on server-side. In both cases the console could show only
 * "0 claims", which is indistinguishable from a meeting where nobody voted.
 *
 * That is the failure this project explicitly refuses to have. The invariant is
 * that every failure path lands in a row with its error text and is readable
 * from the console; `ingestion_runs` does it for sweeps and this does it for
 * extraction.
 *
 * `rejected` and `failed_chunks` are kept as written rather than summarised to
 * a count. A model whose output is 90% rejected is a fact about the model, and
 * the count alone does not say whether it invented quotations, misattributed
 * real ones, or was simply throttled — three different problems with three
 * different responses.
 */

export const EXTRACTION_RUN_STATUSES = [
  'running',
  'succeeded',
  'partial',
  'failed',
] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('extraction_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('meeting_id')
      .notNullable()
      .references('id')
      .inTable('meetings')
      .onDelete('CASCADE');

    // Null until the artifact is located: a run that fails because no minutes
    // were ever fetched is still a run, and still worth showing.
    table.string('artifact_sha256', 64).nullable();

    /** The model REQUESTED. May be a router id that serves others. */
    table.text('model').nullable();
    /** Every model that actually answered a chunk. */
    table.specificType('served_models', 'text[]').nullable();
    table.text('prompt_version').nullable();

    table.integer('chunks').notNullable().defaultTo(0);
    table.integer('proposed').notNullable().defaultTo(0);
    table.integer('verified').notNullable().defaultTo(0);
    table.integer('stored').notNullable().defaultTo(0);

    table.jsonb('rejected').notNullable().defaultTo('[]');
    table.jsonb('failed_chunks').notNullable().defaultTo('[]');

    table.text('status').notNullable().defaultTo('running');
    /** Verbatim. A summarised error is an error nobody can act on. */
    table.text('error').nullable();

    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true }).nullable();

    table.index(['meeting_id', 'started_at'], 'idx_extraction_runs_meeting');
  });

  await knex.raw(`
    ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_status_check
    CHECK (status IN (${EXTRACTION_RUN_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_sha_check
    CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$')
  `);

  // A finished run must say how it finished, and a running one must not
  // pretend to have. Without this a crashed process leaves rows that read as
  // healthy in-progress work forever.
  await knex.raw(`
    ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_finished_check
    CHECK ((status = 'running') = (finished_at IS NULL))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('extraction_runs');
}
