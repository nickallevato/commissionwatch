import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('commissions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('jurisdiction_id').notNullable().references('id').inTable('jurisdictions').onDelete('CASCADE');
    table.string('name').notNullable();
    table.text('description');
    table.string('meeting_schedule');
    table.timestamps(true, true);

    table.index('jurisdiction_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('commissions');
}
