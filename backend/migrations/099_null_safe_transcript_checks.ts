import type { Knex } from 'knex';

/**
 * The last two constraints whose safety depended on another constraint.
 *
 * `transcript_status_absent_check` is `state <> 'absent' OR cue_count = 0`, and
 * `transcript_status_published_check` is `state <> 'published' OR cue_count > 0`.
 * `cue_count` is nullable, so with it NULL both evaluate to NULL and a CHECK
 * that evaluates to NULL is satisfied.
 *
 * In practice neither can be reached today, because
 * `transcript_status_cue_count_present_check` — `state = 'unavailable' OR
 * cue_count IS NOT NULL` — is itself null-safe and forbids the NULL. So these
 * two are correct *by virtue of a third constraint*.
 *
 * That is exactly the dependency worth removing. A constraint that holds only
 * because a different constraint happens to exist fails the day somebody drops
 * or relaxes that other one, and the failure is silent: the rows stop being
 * checked and nothing says so. Migration 098's header records three earlier
 * instances of the same class, two of which were also "safe in practice" right
 * up until the first writer that was not careful.
 *
 * The audit that finds these is a test now — see
 * `test/migrations-selfcontained.test.ts`, "CHECK constraints cannot pass by
 * evaluating to NULL". It exempts by name with a stated reason rather than by
 * pattern, because any pattern loose enough to exempt the genuinely safe ones
 * would exempt these too.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_absent_check');
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_absent_check
    CHECK (state <> 'absent' OR coalesce(cue_count = 0, false))
  `);

  await knex.raw('ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_published_check');
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_published_check
    CHECK (state <> 'published' OR coalesce(cue_count > 0, false))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_absent_check');
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_absent_check
    CHECK (state <> 'absent' OR cue_count = 0)
  `);
  await knex.raw('ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_published_check');
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_published_check
    CHECK (state <> 'published' OR cue_count > 0)
  `);
}
