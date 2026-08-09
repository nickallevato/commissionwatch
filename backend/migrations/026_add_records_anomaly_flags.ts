import type { Knex } from 'knex';

// ALTER TYPE ... ADD VALUE cannot run inside a transaction block, and Knex
// wraps migrations in one by default.
export const config = { transaction: false };

/**
 * The three flag types a public-records document can raise, ported from the
 * archive's document-digger.
 *
 * Each keys on procurement language, a budget delta, or an approval timeline.
 * None takes an entity class as input, so none can be pointed at one category
 * of counterparty — the project's non-partisanship requirement is satisfied by
 * construction here rather than by care.
 */
export async function up(knex: Knex): Promise<void> {
  for (const value of ['no_bid_contract', 'budget_spike', 'fast_tracked_permit']) {
    await knex.raw(`ALTER TYPE anomaly_flag_type ADD VALUE IF NOT EXISTS '${value}'`);
  }
}

export async function down(): Promise<void> {
  // Deliberately a no-op. PostgreSQL cannot remove a value from an enum type.
  // Recorded so a future reader knows this is a decision, not an omission.
}
