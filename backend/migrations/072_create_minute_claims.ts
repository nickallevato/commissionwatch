import type { Knex } from 'knex';

/**
 * What the minutes say a named person did, with the line that says it.
 *
 * This is the first table in the project whose rows are written by a language
 * model, and every column here exists to make that safe rather than to make it
 * convenient.
 *
 * **A claim cannot exist without a verified quote.** `quote` is the text the
 * model emitted, `quote_offset` is where that text was *found* in the stored
 * artifact, and a row cannot be written unless the application located it —
 * `services/extraction/verify.ts` does the finding, and the NOT NULL on
 * `quote_offset` is the database refusing to store a citation nobody checked.
 * A model that invents a sentence produces no row at all. That is the whole
 * design: we do not trust the extraction, we test it against the bytes.
 *
 * **`artifact_sha256`, not a document id.** The claim is about a specific set
 * of bytes with a content address. If the county reissues its minutes, that is
 * a different artifact and the old claim still points at what it was actually
 * read from.
 *
 * **Held by default.** `status` starts `held` and nothing here is public until
 * an operator says so, because every row names a person. That is the project's
 * oldest invariant and this feature is the reason it exists.
 *
 * **No motive.** The extractor is constrained to what the record states —
 * moved, seconded, voted, abstained, was absent, asked — and the writer path
 * rejects any claim whose text carries motive language, reusing the same
 * `motiveTerms` list the corrections log has always used. Describing intent is
 * how a citation becomes an accusation.
 */

/** What a claim asserts happened. Extended by migration, never by a caller. */
export const CLAIM_ACTIONS = [
  'voted_yes',
  'voted_no',
  'abstained',
  'absent',
  'moved',
  'seconded',
  'spoke',
  'recused',
] as const;

export const CLAIM_STATUSES = ['held', 'approved', 'rejected'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('minute_claims', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('meeting_id')
      .notNullable()
      .references('id')
      .inTable('meetings')
      .onDelete('CASCADE');

    // The bytes this was read from. Not a foreign key to `artifacts`: the claim
    // is about a content address, and the address is the identity.
    table.string('artifact_sha256', 64).notNullable();

    // Who the minutes name. Free text as printed — resolving it to a `members`
    // row is a separate, fallible step and lives in its own column so that a
    // failed match never silently rewrites what the document said.
    table.text('subject_name').notNullable();
    // `members`, not `officials` — the officials *page* is a view over the
    // `members` table, and there is no table by that name. SET NULL rather than
    // CASCADE: if a member row goes, the minutes still said what they said, and
    // `subject_name` preserves it as printed.
    table.uuid('member_id').nullable().references('id').inTable('members').onDelete('SET NULL');

    table.text('action').notNullable();
    /** What the action was about, as the minutes describe it. */
    table.text('matter').nullable();

    // The citation. Both columns or no row.
    table.text('quote').notNullable();
    table.integer('quote_offset').notNullable();

    // Provenance of the generation itself. A claim whose model nobody recorded
    // is a claim nobody can re-examine when that model turns out to be bad.
    table.text('model').notNullable();
    table.text('prompt_version').notNullable();

    table.text('status').notNullable().defaultTo('held');
    table.uuid('reviewed_by').nullable();
    table.text('review_reason').nullable();
    table.timestamp('reviewed_at', { useTz: true }).nullable();

    table.timestamps(true, true);

    table.index(['meeting_id', 'status'], 'idx_minute_claims_meeting');
    table.index('member_id', 'idx_minute_claims_member');
  });

  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_action_check
    CHECK (action IN (${CLAIM_ACTIONS.map((name) => `'${name}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_status_check
    CHECK (status IN (${CLAIM_STATUSES.map((name) => `'${name}'`).join(', ')}))
  `);

  // A quote is a citation or it is nothing. An empty string would satisfy
  // NOT NULL and cite nothing at all.
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_quote_check
    CHECK (length(btrim(quote)) > 0 AND quote_offset >= 0)
  `);

  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_sha_check
    CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$')
  `);

  // One claim per (meeting, person, action, offset). A re-run of the extractor
  // over the same bytes must revise rather than accumulate — otherwise every
  // retry doubles the review queue.
  await knex.raw(`
    CREATE UNIQUE INDEX minute_claims_dedupe
    ON minute_claims (meeting_id, artifact_sha256, subject_name, action, quote_offset)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS minute_claims_dedupe');
  await knex.schema.dropTableIfExists('minute_claims');
}
