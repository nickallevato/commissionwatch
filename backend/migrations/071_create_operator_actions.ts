import type { Knex } from 'knex';

/**
 * Operator decisions about the *system*, kept apart from corrections to the
 * *record*.
 *
 * The first of these is turning an ingestion source on. That is a real decision
 * with real consequences — it starts fetching a county's web server — and it
 * deserves the same "who, when, why" the record already gets. The obvious move
 * was to reuse `record_corrections`, and the database refused it: migration 031
 * puts a CHECK on `target_table` restricting it to `meetings`, `agenda_items`
 * and `meeting_documents`. That constraint is right, and the refusal is the
 * schema making a distinction worth keeping.
 *
 * `record_corrections` answers *"what does the site now say, and what did it say
 * before?"* Its rows are the public corrections log — `services/public-corrections.ts`
 * publishes them behind an allowlist. Widening its CHECK to admit an operations
 * table would put configuration changes one allowlist edit away from the public
 * corrections page, where they would read as corrections to the record. They are
 * not. Nobody's agenda was misstated because a source was disabled.
 *
 * So: a second log, same discipline, different subject. Append-only by trigger
 * for migration 031's reason — a convention is what gets edited around — and
 * with no foreign key to `operators`, because `ON DELETE SET NULL` is an UPDATE
 * the trigger forbids and `NO ACTION` would make an operator undeletable. The
 * actor is snapshotted, so the row still names who acted after they are gone.
 *
 * Deliberately not exposed publicly. This is the operator's record of their own
 * decisions, and the public-facing analogue already exists: a disabled source
 * stays listed on the public status page carrying the reason it is off.
 */

/** Actions this log accepts. Widened by migration, never by a string literal. */
export const OPERATOR_ACTIONS = ['source.enabled', 'source.disabled'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('operator_actions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('action').notNullable();
    // Polymorphic, like record_corrections and for the same reason: the next
    // operator decision will not be about an ingestion source.
    table.text('target_table').notNullable();
    table.uuid('target_id').notNullable();
    // Both sides of the change, as text. "Was already on" and "was off" are
    // different facts about a decision to turn something on.
    table.text('old_value').nullable();
    table.text('new_value').nullable();
    // Not nullable, and non-blank below. A decision without a stated reason is
    // an accident with a timestamp.
    table.text('reason').notNullable();
    table.uuid('operator_id').nullable();
    table.text('operator_email').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['target_table', 'target_id', 'created_at'], 'idx_operator_actions_target');
  });

  await knex.raw(`
    ALTER TABLE operator_actions
    ADD CONSTRAINT operator_actions_action_check
    CHECK (action IN (${OPERATOR_ACTIONS.map((name) => `'${name}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE operator_actions
    ADD CONSTRAINT operator_actions_reason_check
    CHECK (length(btrim(reason)) > 0)
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION operator_actions_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'operator_actions is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER operator_actions_no_update_or_delete
    BEFORE UPDATE OR DELETE ON operator_actions
    FOR EACH ROW EXECUTE FUNCTION operator_actions_append_only()
  `);
}

export async function down(knex: Knex): Promise<void> {
  // The trigger fires on DELETE, not on DROP TABLE, so this succeeds — but drop
  // it first anyway so the intent survives a partial rollback.
  await knex.raw('DROP TRIGGER IF EXISTS operator_actions_no_update_or_delete ON operator_actions');
  await knex.raw('DROP FUNCTION IF EXISTS operator_actions_append_only()');
  await knex.schema.dropTableIfExists('operator_actions');
}
