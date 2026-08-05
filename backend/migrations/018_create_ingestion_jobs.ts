import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE TYPE ingestion_job_stage AS ENUM ('discover', 'fetch', 'parse', 'analyze')`,
  );
  // 'blocked' means the job cannot proceed for a reason retrying will not fix
  // (e.g. the source's live fetching is unavailable). It is held, not lost.
  await knex.raw(
    `CREATE TYPE ingestion_job_status AS ENUM ('pending', 'running', 'done', 'failed', 'blocked')`,
  );

  await knex.schema.createTable('ingestion_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('run_id')
      .notNullable()
      .references('id')
      .inTable('ingestion_runs')
      .onDelete('CASCADE');
    table.specificType('stage', 'ingestion_job_stage').notNullable();
    // What this job acts on: a MeetingRef, a DocumentRef, an artifact sha256, etc.
    table.jsonb('target').notNullable().defaultTo('{}');
    table
      .specificType('status', 'ingestion_job_status')
      .notNullable()
      .defaultTo('pending');
    table.integer('attempts').notNullable().defaultTo(0);
    // NOT NULL so every pending job is claimable and the claim index gives a
    // total ordering; a job scheduled for "now" is due immediately.
    table
      .timestamp('next_attempt_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.text('last_error').nullable();
    table.timestamps(true, true);

    table.index('run_id', 'idx_ingestion_jobs_run');
    table.index(['stage', 'status'], 'idx_ingestion_jobs_stage_status');
  });

  await knex.raw(`
    ALTER TABLE ingestion_jobs
    ADD CONSTRAINT ingestion_jobs_attempts_check
    CHECK (attempts >= 0)
  `);

  // The worker's claim query is:
  //   SELECT ... FROM ingestion_jobs
  //   WHERE status = 'pending' AND next_attempt_at <= now()
  //   ORDER BY next_attempt_at
  //   FOR UPDATE SKIP LOCKED
  // The partial predicate keeps the index to only claimable rows and the
  // next_attempt_at ordering lets SKIP LOCKED walk it without a sort.
  await knex.raw(`
    CREATE INDEX idx_ingestion_jobs_claim
    ON ingestion_jobs (next_attempt_at)
    WHERE status = 'pending'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ingestion_jobs');
  await knex.raw('DROP TYPE IF EXISTS ingestion_job_status');
  await knex.raw('DROP TYPE IF EXISTS ingestion_job_stage');
}
