import type { Knex } from 'knex';

// ALTER TYPE ... ADD VALUE cannot run inside a transaction block, and Knex
// wraps migrations in one by default. Without this the migration fails with
// "ALTER TYPE ... ADD cannot run inside a transaction block".
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // IF NOT EXISTS keeps the migration idempotent, which matters because a
  // non-transactional migration that fails partway cannot be rolled back.
  await knex.raw(
    `ALTER TYPE anomaly_flag_type ADD VALUE IF NOT EXISTS 'vote_donor_conflict'`,
  );
}

export async function down(): Promise<void> {
  // Deliberately a no-op. PostgreSQL cannot remove a value from an enum type;
  // the only route back is recreating the type and rewriting every column that
  // uses it, which would destroy rows for a rollback nobody needs. Recorded
  // here so a future reader knows this is a decision, not an omission.
}
