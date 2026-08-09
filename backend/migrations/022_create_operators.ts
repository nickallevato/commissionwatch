import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // citext: email uniqueness is enforced case-insensitively by the database
  // rather than by whichever route last remembered to call toLowerCase(). The
  // archive lowercased on register and login but declared UNIQUE on a
  // case-sensitive varchar, so Op@x.com and op@x.com were two accounts.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');

  // One value on purpose. The column exists so that a second role is an
  // ALTER TYPE ... ADD VALUE rather than a migration that rewrites every row.
  await knex.raw(`CREATE TYPE operator_role AS ENUM ('operator')`);

  await knex.schema.createTable('operators', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.specificType('email', 'citext').notNullable().unique();
    table.text('password_hash').notNullable();
    table.text('name').notNullable();
    table.specificType('role', 'operator_role').notNullable().defaultTo('operator');
    table.timestamp('last_login_at', { useTz: true }).nullable();

    // Lockout state lives on the row, not in memory: a restart must not clear
    // it, and the backend is not guaranteed to be a single process forever.
    table.integer('failed_attempts').notNullable().defaultTo(0);
    table.timestamp('locked_until', { useTz: true }).nullable();

    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operators');
  await knex.raw('DROP TYPE IF EXISTS operator_role');
  // citext is deliberately left installed. Dropping an extension a later
  // migration may depend on is a worse outcome than leaving it in place.
}
