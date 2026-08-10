import type { Knex } from 'knex';

/**
 * `ingested` and `published` are different states.
 *
 * Until now a meeting was public the instant a scraper inserted it. That makes
 * publication a side effect of a cron tick, which is the wrong shape for a
 * project whose whole claim is that a human stands behind what it asserts.
 * `published_at` makes it a decision, and one with a time on it.
 *
 * Existing rows are backfilled to `created_at`. They are already public — the
 * live site is serving them — and a migration that silently unpublished the
 * site would be a data-loss event dressed as a schema change. Rows created
 * after this point default to NULL: ingestion produces a candidate, an
 * operator produces a publication.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('meetings', (table) => {
    table.timestamp('published_at', { useTz: true }).nullable();
  });

  // Everything already ingested was already public. Do not change that here.
  await knex.raw(`UPDATE meetings SET published_at = created_at WHERE published_at IS NULL`);

  // Every public read filters on this, and the public read is the hot one, so
  // the index covers exactly the rows those queries can return.
  await knex.raw(`
    CREATE INDEX idx_meetings_published
    ON meetings (published_at)
    WHERE published_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_meetings_published');
  await knex.schema.alterTable('meetings', (table) => {
    table.dropColumn('published_at');
  });
}
