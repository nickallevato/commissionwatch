import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('delivery_channels', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('channel_type', 20).notNullable();
    table.string('name', 120).notNullable();
    // AES-256-GCM ciphertext of the channel config (webhook URL etc).
    // Never stored, returned, or logged in plaintext.
    table.binary('config_encrypted').notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.unique(['name']);
    table.index('channel_type', 'idx_delivery_channels_type');
  });

  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_type_check
    CHECK (channel_type IN ('discord', 'email', 'webhook'))
  `);

  await knex.schema.createTable('channel_routes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('channel_id')
      .notNullable()
      .references('id')
      .inTable('delivery_channels')
      .onDelete('CASCADE');
    table.string('event_type', 80).notNullable();
    // NULL means "no filter" for both of these.
    table.string('min_severity', 20).nullable();
    table
      .uuid('jurisdiction_id')
      .nullable()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('CASCADE');
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.index(['event_type', 'enabled'], 'idx_channel_routes_event');
    table.index('channel_id', 'idx_channel_routes_channel');
  });

  await knex.raw(`
    ALTER TABLE channel_routes
    ADD CONSTRAINT channel_routes_min_severity_check
    CHECK (min_severity IS NULL OR min_severity IN ('info', 'low', 'medium', 'high', 'critical'))
  `);

  await knex.schema.createTable('deliveries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('channel_id')
      .notNullable()
      .references('id')
      .inTable('delivery_channels')
      .onDelete('CASCADE');
    table.string('event_type', 80).notNullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.string('dedupe_key', 200).notNullable();
    table.string('status', 20).notNullable().defaultTo('pending');
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('next_attempt_at', { useTz: true }).nullable();
    table.text('last_error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('sent_at', { useTz: true }).nullable();

    // The same event can never notify the same channel twice.
    table.unique(['channel_id', 'dedupe_key'], {
      indexName: 'deliveries_channel_dedupe_unique',
    });
    table.index('channel_id', 'idx_deliveries_channel');
  });

  await knex.raw(`
    ALTER TABLE deliveries
    ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
  `);

  await knex.raw(`
    CREATE INDEX idx_deliveries_retryable
    ON deliveries(next_attempt_at)
    WHERE status = 'pending'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('deliveries');
  await knex.schema.dropTableIfExists('channel_routes');
  await knex.schema.dropTableIfExists('delivery_channels');
}
