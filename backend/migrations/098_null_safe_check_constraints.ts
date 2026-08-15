import type { Knex } from 'knex';

/**
 * Two more constraints that enforced nothing, found by auditing for a class.
 *
 * **A CHECK whose expression evaluates to NULL is satisfied.** So any constraint
 * shaped `A OR (B AND C)`, where A can be FALSE and B or C touch a nullable
 * column, is decoration: the row that violates it hardest — the one with the
 * columns simply absent — is the one that passes.
 *
 * This is the third and fourth instance in a day. `vote_events.counts` accepted
 * exactly the malformed tally it existed to refuse, because
 * `jsonb_typeof(counts -> 'absent')` is NULL for a missing key.
 * `place_links_citation_check` let a `stated` link insert with no citation at
 * all, and that one was invisible for hours because nothing had ever written to
 * the table — the first writer found it on its first run. Both were fixed where
 * they were found; this migration is the sweep the pattern earned.
 *
 * The audit that found these is one query, and it is worth keeping:
 *
 *   select conrelid::regclass, conname, pg_get_constraintdef(oid)
 *     from pg_constraint
 *    where contype = 'c' and connamespace = 'public'::regnamespace
 *      and pg_get_constraintdef(oid) ilike '%or %'
 *      and pg_get_constraintdef(oid) not ilike '%coalesce%';
 *
 * Most of what it returns is safe, and the distinction matters: `X IS NULL OR …`
 * cannot fail this way, because `IS NULL` returns true or false and never NULL.
 * The dangerous shape is a comparison that can be FALSE on the left and a
 * nullable operand on the right.
 *
 * ## What each of these was letting through
 *
 * `minute_claims_approved_pin_check` is the worse one. It exists so an approved
 * claim carries the rendered sentence, the sha of *those exact bytes*, a version
 * and an approver — the pin that stops a later template edit republishing words
 * nobody read. With `render_sha256` NULL, `render_sha256 ~ '^[0-9a-f]{64}$'` is
 * NULL, the conjunction is NULL, `FALSE OR NULL` is NULL, and an approved claim
 * with no pin at all inserts cleanly. Verified against the deployed schema:
 *
 *   select ('approved' <> 'approved'
 *           or ('x' is not null and null::varchar ~ '^[0-9a-f]{64}$'
 *               and 'v1' is not null and gen_random_uuid() is not null)) is null;  -- t
 *
 * `transcript_status_sha_check` is the same shape: a `published` transcript with
 * no `observed_sha256` passes, so the bytes we claim to have read cannot be
 * checked against the bytes we stored.
 *
 * Neither has bitten, because both writers happen to set the columns. That is
 * exactly why they were worth finding — a constraint you are relying on to be
 * true, that is in fact only true by the good manners of one caller, is a
 * constraint that fails the day a second caller appears.
 *
 * The earlier migrations are left as written. They are applied, and rewriting an
 * applied migration is how two databases stop agreeing about their own history.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE minute_claims DROP CONSTRAINT IF EXISTS minute_claims_approved_pin_check',
  );
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_approved_pin_check
    CHECK (
      status <> 'approved'
      OR coalesce(
           rendered_text IS NOT NULL
           AND render_sha256 ~ '^[0-9a-f]{64}$'
           AND render_version IS NOT NULL
           AND approved_by IS NOT NULL,
           false
         )
    )
  `);

  await knex.raw(
    'ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_sha_check',
  );
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_sha_check
    CHECK (
      state = 'unavailable'
      OR coalesce(observed_sha256 ~ '^[0-9a-f]{64}$', false)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Restores the exact text each constraint had before, holes and all. A `down`
  // that "improved" on what it is reverting to would make the rollback a
  // different schema from the one the previous migration produced.
  await knex.raw(
    'ALTER TABLE minute_claims DROP CONSTRAINT IF EXISTS minute_claims_approved_pin_check',
  );
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_approved_pin_check
    CHECK (
      status <> 'approved'
      OR (rendered_text IS NOT NULL
          AND render_sha256 ~ '^[0-9a-f]{64}$'
          AND render_version IS NOT NULL
          AND approved_by IS NOT NULL)
    )
  `);

  await knex.raw(
    'ALTER TABLE transcript_status DROP CONSTRAINT IF EXISTS transcript_status_sha_check',
  );
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_sha_check
    CHECK (state = 'unavailable' OR observed_sha256 ~ '^[0-9a-f]{64}$')
  `);
}
