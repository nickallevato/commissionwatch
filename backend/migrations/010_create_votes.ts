import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE vote_value AS ENUM ('yes', 'no', 'abstain', 'absent')`);

  await knex.schema.createTable('votes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.uuid('agenda_item_id').references('id').inTable('agenda_items').onDelete('SET NULL');
    table.uuid('member_id').notNullable().references('id').inTable('members').onDelete('CASCADE');
    table.specificType('vote', 'vote_value').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index('meeting_id');
    table.index('member_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('votes');
  await knex.raw('DROP TYPE IF EXISTS vote_value');
}
