import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('alert_subscriptions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).notNullable();
    table.uuid('jurisdiction_id').notNullable().references('id').inTable('jurisdictions').onDelete('CASCADE');
    table.boolean('email_enabled').notNullable().defaultTo(true);
    table.boolean('digest_only').notNullable().defaultTo(false);
    table.boolean('verified').notNullable().defaultTo(false);
    table.string('verify_token', 64).notNullable();
    table.string('unsubscribe_token', 64).notNullable();
    table.timestamps(true, true);

    table.unique(['email', 'jurisdiction_id']);
    table.index('jurisdiction_id', 'idx_subscriptions_jurisdiction');
    table.index('email', 'idx_subscriptions_email');
    table.index('verify_token', 'idx_subscriptions_verify_token');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('alert_subscriptions');
}
