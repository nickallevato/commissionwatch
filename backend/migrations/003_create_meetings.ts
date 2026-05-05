import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('meetings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('commission_id').notNullable().references('id').inTable('commissions').onDelete('CASCADE');
    table.date('date').notNullable();
    table.time('time');
    table.string('location');
    table.enum('status', ['scheduled', 'completed', 'cancelled'], { useNative: true, enumName: 'meeting_status' }).notNullable().defaultTo('scheduled');
    table.string('agenda_url');
    table.string('minutes_url');
    table.timestamps(true, true);

    table.index('commission_id');
    table.index('date');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('meetings');
  await knex.raw('DROP TYPE IF EXISTS "meeting_status"');
}
