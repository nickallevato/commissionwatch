import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
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

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rundown_sheets');
}
