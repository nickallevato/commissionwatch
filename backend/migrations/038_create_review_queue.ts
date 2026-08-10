import type { Knex } from 'knex';

/**
 * B-a — the findings review queue, and B-b's replacement.
 *
 * Until this migration there was no path in the product that set
 * `anomaly_flags.review_state` to `published`. Records-derived and
 * person-naming flags were written `held` and stayed held forever, so the
 * invariant "nothing naming a person auto-publishes" was enforced by there
 * being no publish path at all. Safe, and useless.
 *
 * Three things land here.
 *
 * **`approval_requests`**, ported from the archive's
 * `024_create_approval_workflows.ts` with four changes:
 *
 *  - `reviewer_user_id → users` becomes `reviewer_operator_id → operators`.
 *    A1 landed one operator class and there is no `users` table.
 *  - `requested_by_agent_id → agent_registry` is **dropped**. The orchestration
 *    framework it referenced was not adopted; a column referencing a table that
 *    does not exist is not a port.
 *  - `meeting_id` is **nullable**. Migration 027 made `anomaly_flags.meeting_id`
 *    nullable and added `artifact_id`, so a records-derived flag has no meeting
 *    — and those are precisely the flags that are always held. NOT NULL here
 *    would make them unqueueable.
 *  - The `expired` status is **excluded**. See below.
 *
 * The unique constraint on `anomaly_flag_id` is kept: one flag, one request.
 *
 * **`review_policy`**, a single row, in place of the archive's
 * `execution_policies` engine. That engine expressed variation in who approves
 * what, and this project has one operator, so every route through it resolves
 * to the same person. What replaces it is a severity threshold and a
 * comparison. Spec § B-b is the record of why.
 *
 * **What an expiry means.** A request past `expires_at` and still
 * `pending_review` is overdue, and that is *all* it is: the queue badges it and
 * sorts it first, the flag stays `held`, nothing publishes and nothing is
 * rejected. So there is no `expired` status and no sweeper writing one. A
 * terminal status set by a clock reads, in the queue and in the audit log,
 * exactly like a decision a person made — and the one thing this table exists
 * to record is who decided. Deriving overdue at read time also cannot drift the
 * way a background job's writes can. The requirement that an expired request
 * must never silently publish is met by construction: no code path leads from
 * elapsed time to `review_state = 'published'`.
 */

/** Mirrors migration 031, plus the two subjects a review decision targets. */
const CORRECTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
  'review_policy',
] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TYPE approval_request_status AS ENUM (
      'pending_review',
      'approved',
      'rejected'
    )
  `);

  await knex.schema.createTable('approval_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('anomaly_flag_id')
      .notNullable()
      .references('id')
      .inTable('anomaly_flags')
      .onDelete('CASCADE');
    // Nullable: a records-derived flag is about an artifact, not a meeting.
    table
      .uuid('meeting_id')
      .nullable()
      .references('id')
      .inTable('meetings')
      .onDelete('CASCADE');
    table
      .specificType('status', 'approval_request_status')
      .notNullable()
      .defaultTo('pending_review');
    // Denormalised from the flag at request time. The threshold that produced
    // the hold is a fact about that moment, and an operator editing the
    // severity later must not rewrite why it was queued.
    table.string('severity', 20).notNullable();
    table
      .uuid('reviewer_operator_id')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');
    // Snapshotted beside the id, for migration 031's reason: the record must
    // still name who acted after the operator row is gone.
    table.text('reviewer_email').nullable();
    table.text('review_comment').nullable();
    table.timestamp('reviewed_at', { useTz: true }).nullable();
    // A window, not a deadline. Past it the request is overdue and still
    // pending; see the header.
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['anomaly_flag_id'], { indexName: 'uq_approval_requests_anomaly_flag' });
    table.index(['status', 'severity'], 'idx_approval_requests_status_severity');
    table.index(['status', 'expires_at'], 'idx_approval_requests_status_expires');
  });

  // ---- the threshold ------------------------------------------------------

  await knex.schema.createTable('review_policy', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // One row, enforced. A second policy row would make "which threshold is in
    // force?" a question with two answers, and the one that answered would be
    // whichever the planner reached first.
    table.boolean('singleton').notNullable().defaultTo(true).unique();
    table
      .specificType('hold_at_or_above', 'anomaly_severity')
      .notNullable()
      .defaultTo('high');
    table.integer('review_window_hours').notNullable().defaultTo(72);
    table.uuid('updated_by').nullable();
    table.text('updated_by_email').nullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE review_policy
    ADD CONSTRAINT review_policy_singleton_check CHECK (singleton)
  `);
  await knex.raw(`
    ALTER TABLE review_policy
    ADD CONSTRAINT review_policy_window_check CHECK (review_window_hours > 0)
  `);

  // The row itself. A policy table with no row would make every detection read
  // "no threshold configured", and the only safe reading of that is to hold
  // everything — which is a different decision than the one this ships.
  await knex('review_policy').insert({ singleton: true });

  // ---- one audit log, widened ---------------------------------------------

  // Review decisions are appended to `record_corrections` rather than to a
  // second table. Two logs can disagree about what happened, and the one that
  // disagreed would be believed at random.
  await knex.raw('ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check');
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${CORRECTABLE_TABLES.map((name) => `'${name}'`).join(', ')}))
  `);
}

/**
 * Rolling back narrows the CHECK again, which fails loudly if any review
 * decision has already been logged — `record_corrections` forbids DELETE, so
 * those rows cannot be removed to make room. That is the append-only guarantee
 * working, not a defect in this migration, and it is the honest failure: the
 * log cannot be un-widened once it holds a decision.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check');
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN ('meetings', 'agenda_items', 'meeting_documents'))
  `);

  await knex.schema.dropTableIfExists('review_policy');
  await knex.schema.dropTableIfExists('approval_requests');
  await knex.raw('DROP TYPE IF EXISTS approval_request_status');
}
