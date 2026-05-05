import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agenda_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.integer('item_number').notNullable();
    table.string('title').notNullable();
    table.text('description');
    table.string('category');
    table.timestamps(true, true);

    table.index('meeting_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agenda_items');
}
