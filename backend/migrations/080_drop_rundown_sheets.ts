import type { Knex } from 'knex';

/**
 * `rundown_sheets` had one writer, the rundown generator in
 * `agents/meeting-monitor`, and that package was deleted on 2026-08-14. What was
 * left was a table nothing filled behind a route that could only ever answer
 * "Rundown not yet generated for this meeting" — a promise about something no
 * code in this repository produces.
 *
 * Retired rather than left in place, because a dead table is the kind of thing a
 * future reader mistakes for a plan. The claim card is what it was reaching for;
 * see the 2026-08-14 published-claim design, §9.
 *
 * `down()` rebuilds the table exactly as migration 006 created it, so a rollback
 * lands on the schema the rest of that lineage expects. It cannot bring the rows
 * back: nothing wrote any, so there are none to lose.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rundown_sheets');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.createTable('rundown_sheets', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.text('summary');
    table.jsonb('key_items');
    table.timestamp('generated_at');
    table.timestamps(true, true);

    table.index('meeting_id');
  });
}
