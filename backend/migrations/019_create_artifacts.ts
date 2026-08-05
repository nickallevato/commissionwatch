import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('artifacts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Content address. Unique, so re-fetching an unchanged document collides
    // here and is never reprocessed. Lowercase hex SHA-256.
    table.string('sha256', 64).notNullable();
    // MinIO object key the bytes live under.
    table.string('storage_key', 500).notNullable();
    table.string('content_type', 150).nullable();
    // NULL for documents obtained by hand or public-records request: those
    // flow through the identical pipeline as automatically fetched ones.
    table.text('source_url').nullable();
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // integer, not bigint: pg returns bigint as a string in JS, and no
    // meeting document approaches 2GB. byte_size is a number downstream.
    table.integer('byte_size').notNullable();
    table.timestamps(true, true);

    table.unique(['sha256'], { indexName: 'artifacts_sha256_unique' });
    table.index('fetched_at', 'idx_artifacts_fetched_at');
  });

  await knex.raw(`
    ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_sha256_format_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$')
  `);

  await knex.raw(`
    ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_byte_size_check
    CHECK (byte_size >= 0)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('artifacts');
}
