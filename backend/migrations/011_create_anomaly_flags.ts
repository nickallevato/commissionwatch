import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('anomaly_flags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('meeting_id').notNullable().references('id').inTable('meetings').onDelete('CASCADE');
    table.enum('flag_type', [
      'emergency_session',
      'closed_door_vote',
      'last_minute_agenda_change',
      'quorum_issue',
      'unanimous_controversial',
      'missing_minutes',
    ], { useNative: true, enumName: 'anomaly_flag_type' }).notNullable();
    table.text('description');
    table.enum('severity', ['low', 'medium', 'high', 'critical'], { useNative: true, enumName: 'anomaly_severity' }).notNullable();
    table.timestamps(true, true);

    table.index('meeting_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('anomaly_flags');
  await knex.raw('DROP TYPE IF EXISTS "anomaly_flag_type"');
  await knex.raw('DROP TYPE IF EXISTS "anomaly_severity"');
}
