import type { Knex } from 'knex';

/**
 * `place_links` joins the one audit log.
 *
 * Migration 094 shipped `place_links.status` defaulting to `held`, and nothing
 * wrote it — the same shape `minute_claims` was in between 072 and 087. The
 * review path that fixes it (`services/review/place-links.ts`) appends every
 * decision to `record_corrections` like every other decision in this product,
 * and 031's CHECK on `target_table` would refuse the insert. So the widening is
 * this migration, and it is the whole of it.
 *
 * A second log for pins was the alternative and it is not one: two audit logs
 * can disagree about what happened, and the one that disagreed would be believed
 * at random.
 */

/**
 * Mirrors 031, 038, 039, 070 and 087, plus the subject this migration adds.
 * Retyped rather than imported because `backend/Dockerfile` copies `migrations/`
 * without `src/`, and `migrations-selfcontained.test.ts` enforces it.
 */
const CORRECTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
  'review_policy',
  'record_disputes',
  'entity_resolution_decisions',
  'minute_claims',
  'place_links',
] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES)}))
  `);

  // The queue's own read: held links, oldest first. A partial index because the
  // held rows are the ones an operator asks for repeatedly, and the approved and
  // rejected ones accumulate forever without ever being the working set.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_place_links_held
    ON place_links (created_at, id)
    WHERE status = 'held'
  `);
}

/**
 * Rolling back narrows the CHECK again, which fails loudly once any place-link
 * decision has been logged — `record_corrections` forbids DELETE, so those rows
 * cannot be removed to make room. 038, 039, 070 and 087 record the same honest
 * failure: the log cannot be un-widened once it holds a decision.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_place_links_held');
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES.slice(0, -1))}))
  `);
}
