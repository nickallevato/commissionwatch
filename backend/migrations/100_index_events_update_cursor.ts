import type { Knex } from 'knex';

/**
 * The index the prerender cursor reads on.
 *
 * `PrerenderConsumer` walks `events` ordered by `(updated_at, id)` — not by
 * `occurred_at`, because revoking a publication bumps `updated_at` on a row
 * written days earlier and never touches when it occurred. Migration 083 gave
 * the table three indexes and none of them serve that order: `(occurred_at)
 * WHERE dispatched_at IS NULL` is the drain's, `(subject_kind, subject_id,
 * occurred_at)` is the per-subject history, and the primary key is on `id`.
 *
 * So today every tick sorts the whole table, and at the table's present size
 * that is free — with the index in place the planner still picks the sequential
 * scan, which is the correct choice and will stay correct for a while. This is
 * not a fix for a measured problem — it is the index being added while the
 * table is small enough that building it costs nothing, rather than the day the
 * consumer starts timing out and somebody has to work out why.
 *
 * There is no partial predicate. Unlike the drain, which only ever reads
 * undispatched rows, the cursor can be reset to any point in the past — a
 * rebuild deletes the cursor file and walks from the beginning — so a
 * `WHERE` clause here would exclude exactly the rows a rebuild needs.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_update_cursor
      ON events (updated_at, id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_events_update_cursor');
}
