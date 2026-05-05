import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('subscription_id').notNullable().references('id').inTable('alert_subscriptions').onDelete('CASCADE');
    table.uuid('anomaly_flag_id').notNullable().references('id').inTable('anomaly_flags').onDelete('CASCADE');
    table.specificType('severity', 'anomaly_severity').notNullable();
    table.boolean('read').notNullable().defaultTo(false);
    table.string('email_status', 20).notNullable().defaultTo('pending');
    table.timestamp('email_sent_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['subscription_id', 'anomaly_flag_id']);
    table.index('subscription_id', 'idx_notifications_subscription');
    table.index('anomaly_flag_id', 'idx_notifications_anomaly');
  });

  await knex.raw(`
    ALTER TABLE notifications
    ADD CONSTRAINT notifications_email_status_check
    CHECK (email_status IN ('pending', 'queued', 'sent', 'failed', 'skipped'))
  `);

  await knex.raw(`
    CREATE INDEX idx_notifications_pending_email
    ON notifications(email_status, severity)
    WHERE email_status = 'pending'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notifications');
}
