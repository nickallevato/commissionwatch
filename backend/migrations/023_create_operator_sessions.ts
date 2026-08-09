import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Named operator_sessions rather than sessions because B-e introduces
  // subscriber-scoped tokens governed by a different permission model, and a
  // bare `sessions` invites conflating the two at exactly the point where
  // conflating them is a security defect.
  await knex.schema.createTable('operator_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('operator_id')
      .notNullable()
      .references('id')
      .inTable('operators')
      .onDelete('CASCADE');

    // The SHA-256 of the cookie value, never the value itself. A read of this
    // table therefore yields nothing anyone can present as a session.
    table.text('token_hash').notNullable().unique();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Sliding: pushed forward on each validated request.
    table.timestamp('idle_expires_at', { useTz: true }).notNullable();
    // Hard ceiling: never extended, so a session cannot live forever by use.
    table.timestamp('absolute_expires_at', { useTz: true }).notNullable();
    // Server-side revocation is the whole reason this is not a JWT.
    table.timestamp('revoked_at', { useTz: true }).nullable();

    table.text('ip').nullable();
    table.text('user_agent').nullable();

    table.index('operator_id', 'idx_operator_sessions_operator');
    table.index('absolute_expires_at', 'idx_operator_sessions_absolute_expiry');
  });

  await knex.raw(`
    ALTER TABLE operator_sessions
    ADD CONSTRAINT operator_sessions_idle_within_absolute_check
    CHECK (idle_expires_at <= absolute_expires_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operator_sessions');
}
