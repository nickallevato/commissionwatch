import type { Knex } from 'knex';

/**
 * B3 — the dispute route, and the link that makes the audit trail followable.
 *
 * A person named in a record can contest it. That contest is not a finding: a
 * finding is something this project asserts, produced by a detector and gated
 * by the review queue, and writing a stranger's assertion into `anomaly_flags`
 * would put it one operator misclick from being published under this project's
 * name. So it gets its own table, and shares the operator surface and the audit
 * log rather than the type.
 *
 * **A dispute is never published.** `review_state` has exactly one legal value.
 * A dispute is a private communication from a member of the public; it may name
 * people, it may be wrong, and it arrives unauthenticated. There is no public
 * read route for this table, and the CHECK is the second lock rather than the
 * first — it is what keeps the guarantee true when somebody later adds a route
 * without thinking about this comment.
 *
 * **We collect three things and no more.** What is contested, the contester's
 * own account of it, and a contact. No identity documents, no address, no
 * account, no IP. Data that is not held cannot leak, and a person contesting a
 * public record about themselves should not have to identify themselves to this
 * project to do it. Rate limiting is done without storing anything about the
 * submitter — see `services/rate-limit.ts` and `services/disputes.ts`.
 *
 * Lengths are capped in the database as well as at the route. The route is one
 * caller; the column is the guarantee.
 *
 * Two things land beside the table:
 *
 *  - **`record_corrections.dispute_id`**, so a correction can name the dispute
 *    that prompted it. `ALTER TABLE ... ADD COLUMN` is DDL, and a nullable
 *    column with no default rewrites no rows, so migration 031's row-level
 *    `BEFORE UPDATE OR DELETE` trigger does not fire.
 *  - **A widened `target_table` CHECK**, admitting `record_disputes`, exactly as
 *    038 widened it for `anomaly_flags`. One log, not two: a dispute's arrival
 *    and its resolution are appended to `record_corrections` like every other
 *    decision this product records.
 */

/** Mirrors 031 and 038, plus the subject this migration adds. */
const CORRECTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
  'review_policy',
  'record_disputes',
] as const;

/** What a dispute may be filed against. Every one of these is publicly visible. */
const DISPUTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
] as const;

/**
 * `received` on arrival; `upheld` or `declined` by an operator.
 *
 * Text with a CHECK rather than a native enum, deliberately: 037 records that
 * PostgreSQL will not *use* an enum value added in the same transaction, which
 * forced that migration to run without one. A three-value set that a later
 * migration may want to extend is not worth that cost.
 *
 * There is no `expired`, for migration 038's reason: a terminal status written
 * by a clock reads in the audit log exactly like a decision a person made.
 */
const DISPUTE_STATUSES = ['received', 'upheld', 'declined'] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('record_disputes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // The reference the submitter is given, and the only handle they have on
    // their own dispute. Unique, and generated in the application from
    // `node:crypto` so it carries no sequence a reader could count.
    table.text('reference').notNullable().unique();

    // Polymorphic, like `record_corrections`, and for the same reason: a
    // cascade from `meetings` would collide with the append-only trigger on
    // the log rows this table's decisions write.
    table.text('target_table').notNullable();
    table.uuid('target_id').notNullable();

    table.text('contested').notNullable();
    table.text('account').notNullable();
    table.text('contact').notNullable();

    table.text('status').notNullable().defaultTo('received');

    // One legal value. See the header.
    table.text('review_state').notNullable().defaultTo('held');

    table
      .uuid('reviewer_operator_id')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');
    // Snapshotted beside the id, for migration 031's reason: the record must
    // still name who acted after the operator row is gone.
    table.text('reviewer_email').nullable();
    table.text('review_reason').nullable();
    table.timestamp('reviewed_at', { useTz: true }).nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // The queue reads undecided first, oldest first.
    table.index(['status', 'created_at'], 'idx_record_disputes_status_created');
    // The per-target cap counts on this one.
    table.index(['target_table', 'target_id'], 'idx_record_disputes_target');
  });

  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_target_table_check
    CHECK (target_table IN (${quoted(DISPUTABLE_TABLES)}))
  `);

  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_status_check
    CHECK (status IN (${quoted(DISPUTE_STATUSES)}))
  `);

  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_never_published_check
    CHECK (review_state = 'held')
  `);

  // Non-empty and bounded. A blank contest is not a contest, and an unbounded
  // text column on an unauthenticated public write is a storage bomb.
  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_contested_check
    CHECK (length(btrim(contested)) > 0 AND length(contested) <= 300)
  `);
  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_account_check
    CHECK (length(btrim(account)) > 0 AND length(account) <= 4000)
  `);
  await knex.raw(`
    ALTER TABLE record_disputes
    ADD CONSTRAINT record_disputes_contact_check
    CHECK (length(btrim(contact)) > 0 AND length(contact) <= 200)
  `);

  // ---- the link, and the one log ------------------------------------------

  await knex.schema.alterTable('record_corrections', (table) => {
    // No foreign key, matching the rest of this table: `ON DELETE SET NULL` is
    // an UPDATE, which migration 031's trigger forbids, and `NO ACTION` would
    // make a dispute undeletable. The reference is carried in the log row
    // itself when the correction is written.
    table.uuid('dispute_id').nullable();
    table.index(['dispute_id'], 'idx_record_corrections_dispute');
  });

  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES)}))
  `);
}

/**
 * Rolling back narrows the CHECK again, which fails loudly once any dispute has
 * been logged — `record_corrections` forbids DELETE, so those rows cannot be
 * removed to make room. Migration 038 documents the same honest failure: the
 * log cannot be un-widened once it holds a decision.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN ('meetings', 'agenda_items', 'meeting_documents', 'anomaly_flags', 'review_policy'))
  `);

  await knex.schema.alterTable('record_corrections', (table) => {
    table.dropIndex(['dispute_id'], 'idx_record_corrections_dispute');
    table.dropColumn('dispute_id');
  });

  await knex.schema.dropTableIfExists('record_disputes');
}
