import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE anomaly_flag_type AS ENUM ('emergency_session', 'closed_door_vote', 'last_minute_agenda_change', 'quorum_issue', 'unanimous_controversial', 'missing_minutes')`);
  await knex.raw(`CREATE TYPE anomaly_severity AS ENUM ('low', 'medium', 'high', 'critical')`);

  await knex.schema.createTable('anomaly_flags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.specificType('flag_type', 'anomaly_flag_type').notNullable();
    table.text('description').notNullable();
    table.specificType('severity', 'anomaly_severity').notNullable();
    table.jsonb('metadata');
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index('meeting_id');
    table.index('flag_type');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('anomaly_flags');
  await knex.raw('DROP TYPE IF EXISTS anomaly_severity');
  await knex.raw('DROP TYPE IF EXISTS anomaly_flag_type');
}
