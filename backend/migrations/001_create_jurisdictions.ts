import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.createTable('jurisdictions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('state', 2).notNullable();
    table.enum('type', ['city', 'county'], { useNative: true, enumName: 'jurisdiction_type' }).notNullable();
    table.string('website_url');
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('jurisdictions');
  await knex.raw('DROP TYPE IF EXISTS "jurisdiction_type"');
}
