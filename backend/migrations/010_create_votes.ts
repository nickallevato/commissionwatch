import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('votes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.uuid('agenda_item_id').notNullable().references('id').inTable('agenda_items').onDelete('CASCADE');
    table.uuid('member_id').notNullable().references('id').inTable('members').onDelete('CASCADE');
    table.enum('vote', ['yes', 'no', 'abstain', 'absent'], { useNative: true, enumName: 'vote_value' }).notNullable();
    table.timestamps(true, true);

    table.index('meeting_id');
    table.index('agenda_item_id');
    table.index('member_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('votes');
  await knex.raw('DROP TYPE IF EXISTS "vote_value"');
}
