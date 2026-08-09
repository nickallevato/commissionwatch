import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // A TTL store for outbound HTTP responses. Deliberately generic: the cache
  // key is an opaque hash chosen by the caller, so a second API can share this
  // table without a schema change.
  await knex.schema.createTable('http_cache', (table) => {
    table.text('cache_key').primary();
    table.jsonb('payload').notNullable();
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at', { useTz: true }).notNullable();

    // Sweep query: delete where expires_at <= now.
    table.index('expires_at', 'idx_http_cache_expires_at');
  });

  await knex.raw(`
    ALTER TABLE http_cache
    ADD CONSTRAINT http_cache_expires_after_fetched_check
    CHECK (expires_at > fetched_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('http_cache');
}
