import type { Knex } from 'knex';

/**
 * P7 — the statute a public-records request cites, per jurisdiction.
 *
 * This table exists because of one fact, and the fact is worth writing down in
 * full because getting it wrong produces a legal document that is confidently
 * incorrect in someone else's hands.
 *
 * Montana Code Annotated 2025, Title 2, Chapter 6, Part 10 — verified against
 * `mca.legmt.gov` on 2026-08-09:
 *
 *   §2-6-1003  Access to public information — safety and security exceptions
 *   §2-6-1006  Public information requests — fees
 *   §2-6-1009  Written notice of denial — failure to meet response deadline
 *
 * §2-6-1006 states an acknowledgement deadline, a response deadline, and a
 * window in which the *requester* must answer a clarification. Every one of
 * those figures is stated for **"an executive branch agency"** and **"a public
 * agency that is not a local government."**
 *
 * The City of Bozeman and Gallatin County **are local governments.** They fall
 * under a different subsection of the same section, and nobody on this project
 * has read it. A generated letter quoting the executive-branch deadlines to a
 * county would assert a legal obligation that does not apply. Both sections are
 * additionally marked **(Temporary)** in the 2025 edition: they carry effective
 * and termination dates and will be superseded.
 *
 * Therefore no citation, deadline or fee provision is hardcoded anywhere in
 * this codebase. They are rows here, each carrying its own provenance, and the
 * generator **refuses to draft a letter** for a jurisdiction with no row rather
 * than falling back to a plausible default. A confidently wrong statute is
 * worse than no letter.
 *
 * ── This migration inserts nothing, on purpose. ──
 *
 * Populating it is a blocking operator task and cannot be done by a program: it
 * requires a person to read the local-government subsection of §2-6-1006, and
 * to put their name in `verified_by` next to the date they read it. Seeding it
 * with the executive-branch figures above — which are *right there in this
 * comment* and would make the feature appear to work — is the single most
 * damaging thing anyone could do to this table. Do not.
 *
 * `docs/STATUS.md` records the task.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jurisdiction_records_law', (table) => {
    // The primary key, not merely a foreign key: exactly one law row per
    // jurisdiction, and the *absence* of a row is the condition the generator
    // refuses on. Making this the identity means "is there a law row?" is a
    // primary-key lookup and cannot accidentally find two disagreeing answers.
    table
      .uuid('jurisdiction_id')
      .primary()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('CASCADE');

    // e.g. 'Mont. Code Ann. § 2-6-1006'. Free text: a citation format is a
    // publisher's convention, and constraining it here would only mean the
    // right citation could not be entered.
    table.text('statute_citation').notNullable();
    // The exact page the text was read from, so a later reader can check the
    // same words the verifier checked rather than a search result for them.
    table.text('statute_url').notNullable();

    // NULL means "not established for this class of agency" — which is a
    // different statement from zero, and a different statement from unknown-
    // but-probably-five. The letter omits the deadline sentence entirely when
    // these are NULL rather than guessing one.
    table.integer('acknowledge_days').nullable().comment('Business days to acknowledge receipt.');
    table.integer('respond_days').nullable().comment('Calendar days to respond.');

    table.text('custodian_name').nullable();
    table.text('custodian_email').nullable();
    table.text('custodian_address').nullable();

    // The load-bearing column. A statute that moved under us is exactly the
    // failure this table exists to prevent, so the console warns when this is
    // older than a year and the generated letter carries the warning too.
    table.date('verified_on').notNullable();
    table
      .uuid('verified_by')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');

    table.text('notes').nullable();
    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE jurisdiction_records_law
    ADD CONSTRAINT jurisdiction_records_law_citation_check
    CHECK (length(btrim(statute_citation)) > 0 AND length(btrim(statute_url)) > 0)
  `);

  await knex.raw(`
    ALTER TABLE jurisdiction_records_law
    ADD CONSTRAINT jurisdiction_records_law_days_check
    CHECK (
      (acknowledge_days IS NULL OR acknowledge_days > 0)
      AND (respond_days IS NULL OR respond_days > 0)
    )
  `);

  // A verification dated in the future is a typo, and this is the one table in
  // the schema where a typo becomes an assertion about the law in a letter
  // somebody sends.
  await knex.raw(`
    ALTER TABLE jurisdiction_records_law
    ADD CONSTRAINT jurisdiction_records_law_verified_on_check
    CHECK (verified_on <= CURRENT_DATE)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('jurisdiction_records_law');
}
