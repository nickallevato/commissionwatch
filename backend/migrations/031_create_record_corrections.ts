import type { Knex } from 'knex';

/**
 * Corrections are append-only, and the artifact is never mutated.
 *
 * A transparency project that edits its own evidence has nothing left to stand
 * on. So a correction is an added row saying who changed what, from what, to
 * what, and why — and the bytes the claim came from stay exactly as fetched.
 *
 * Append-only is enforced by the database rather than by convention, because a
 * convention is what an agent in a hurry edits around. The trigger below raises
 * on UPDATE and on DELETE. The practical cost is that tests cannot clean up
 * after themselves; they write against freshly generated target ids instead.
 *
 * Two foreign keys are deliberately absent:
 *
 *  - **To the target.** The reference is polymorphic (`target_table` +
 *    `target_id`), and a cascade from `meetings` would make the seed's
 *    `knex('meetings').del()` — which runs on every `pretest` — collide with
 *    the trigger.
 *  - **To `operators`.** `ON DELETE SET NULL` is an UPDATE, which the trigger
 *    forbids, and `NO ACTION` would make an operator undeletable. An audit log
 *    snapshots its actor, so `operator_email` is captured at write time and the
 *    row survives the operator's deletion still naming who acted.
 */

export const CORRECTABLE_TABLES = ['meetings', 'agenda_items', 'meeting_documents'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('record_corrections', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('target_table').notNullable();
    table.uuid('target_id').notNullable();
    table.text('field').notNullable();
    // NULL is a real value on both sides: a field can be corrected from
    // nothing, and to nothing. Distinguishing "was empty" from "was not
    // recorded" is exactly the kind of thing this table exists to preserve.
    table.text('old_value').nullable();
    table.text('new_value').nullable();
    // Not nullable. A correction without a stated reason is an edit.
    table.text('reason').notNullable();
    table.uuid('operator_id').nullable();
    table.text('operator_email').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // The console reads one target's history, newest first.
    table.index(['target_table', 'target_id', 'created_at'], 'idx_record_corrections_target');
  });

  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${CORRECTABLE_TABLES.map((name) => `'${name}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_reason_check
    CHECK (length(btrim(reason)) > 0)
  `);

  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_field_check
    CHECK (length(btrim(field)) > 0)
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION record_corrections_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'record_corrections is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER record_corrections_no_rewrite
    BEFORE UPDATE OR DELETE ON record_corrections
    FOR EACH ROW EXECUTE FUNCTION record_corrections_append_only()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS record_corrections_no_rewrite ON record_corrections');
  await knex.raw('DROP FUNCTION IF EXISTS record_corrections_append_only()');
  await knex.schema.dropTableIfExists('record_corrections');
}
