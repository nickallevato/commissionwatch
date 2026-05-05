import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('title');
    table.uuid('jurisdiction_id').notNullable().references('id').inTable('jurisdictions').onDelete('CASCADE');
    table.date('term_start');
    table.date('term_end');
    table.timestamps(true, true);

    table.index('jurisdiction_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('members');
}
