import type { Knex } from 'knex';

/**
 * Whether the custodian published a transcript for one meeting document, and
 * what we saw when we asked.
 *
 * **This table exists because the content address collapses absences.** Every
 * empty Granicus caption file is the same eight bytes — `WEBVTT\n\n`, sha256
 * `8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c`, which
 * anyone can reproduce with `printf 'WEBVTT\n\n' | sha256sum`. `artifacts.sha256`
 * is uniquely indexed, so one `artifacts` row would otherwise represent every
 * absence Bozeman ever publishes, and `artifacts.source_url` would name whichever
 * clip happened to be fetched first. Worse, the fetch handler enqueues `parse`
 * only when the artifact is new, so from the second absence onward there is no
 * downstream job at all. An absence recorded on the artifact would be a false
 * statement about provenance attached to a row nobody re-derives.
 *
 * So the state is recorded per **meeting document**, by the fetch handler,
 * outside its `isNew` branch. `meeting_document_id` rather than `meeting_id`
 * because Bozeman's archive files one sitting as two rows ("City Commission
 * Meeting pt 1"), each with its own clip.
 *
 * The three states answer different questions, and the site must be able to tell
 * them apart:
 *
 *   published    a text/vtt body with at least one parseable cue  — the record
 *   absent       a well-formed WebVTT file with zero cues         — the record
 *   unavailable  a non-200, or a 200 whose bytes are not WebVTT   — **us**
 *
 * `absent` is the custodian saying, in a file they chose to serve, that there is
 * nothing here. It is not a failure and must never be counted as one: probed
 * 2026-08-14, 8 of 8 sampled clips from 2013-2020 were empty and 21 of 22 from
 * 2021-2026 carried a transcript. The absence is a fact about an era, not about
 * our fetcher. `unavailable` is us failing to get an answer, and the site may
 * never render it as a fact about Bozeman.
 *
 * `absent` is also not permanent — Granicus generates captions asynchronously, so
 * a meeting held on Tuesday can be empty on Wednesday and present on Friday.
 * `first_checked_at` / `last_checked_at` / `checks` are what let the coverage page
 * say "we re-checked on Friday and it is still empty" instead of restating a
 * single stale observation.
 *
 * `observed_sha256` is deliberately **not** a foreign key to `artifacts`, for the
 * same reason migration 072 gives for `minute_claims.artifact_sha256`: the row
 * records which bytes were served on a date, and it must survive the artifact
 * being deleted or never having been stored. Its practical value is that an
 * absence claim becomes checkable by a stranger with one command.
 */

export const TRANSCRIPT_STATES = ['published', 'absent', 'unavailable'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transcript_status', (table) => {
    table
      .uuid('meeting_document_id')
      .primary()
      .references('id')
      .inTable('meeting_documents')
      .onDelete('CASCADE');

    table.text('state').notNullable();

    // The custodian's own identifier for the recording. Text, not integer:
    // Granicus clip ids are not chronological and are not arithmetic — clip 32 is
    // December 2020 and clip 1301 is September 2013 — so nothing may order or
    // compare them, and storing them as a number invites exactly that.
    table.text('clip_id').notNullable();

    table.string('observed_sha256', 64).nullable();
    table.integer('cue_count').nullable();

    table.timestamp('first_checked_at', { useTz: true }).notNullable();
    table.timestamp('last_checked_at', { useTz: true }).notNullable();
    table.integer('checks').notNullable().defaultTo(1);

    // Non-null exactly when the state describes our failure. Carries a URL and an
    // HTTP status today; it is still held to the same leak rule as every other
    // operator-facing error string, because "today it is safe" is not a
    // constraint.
    table.text('last_error').nullable();

    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_state_check
    CHECK (state IN (${TRANSCRIPT_STATES.map((name) => `'${name}'`).join(', ')}))
  `);

  // A statement about the custodian's record has to name the bytes it read.
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_sha_check
    CHECK (state = 'unavailable' OR observed_sha256 ~ '^[0-9a-f]{64}$')
  `);

  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_cue_count_present_check
    CHECK (state = 'unavailable' OR cue_count IS NOT NULL)
  `);

  // The two record states are distinguished by the cue count and nothing else, so
  // the database refuses a row that says 'published' about an empty file.
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_published_check
    CHECK (state <> 'published' OR cue_count > 0)
  `);

  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_absent_check
    CHECK (state <> 'absent' OR cue_count = 0)
  `);

  // An 'unavailable' with no error text is a failure nobody disclosed.
  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_unavailable_check
    CHECK (state <> 'unavailable' OR (last_error IS NOT NULL AND cue_count IS NULL))
  `);

  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_checked_order_check
    CHECK (last_checked_at >= first_checked_at)
  `);

  await knex.raw(`
    ALTER TABLE transcript_status
    ADD CONSTRAINT transcript_status_checks_check
    CHECK (checks >= 1)
  `);

  await knex.raw('CREATE INDEX transcript_status_state ON transcript_status (state)');
  await knex.raw(
    'CREATE INDEX transcript_status_recheck ON transcript_status (last_checked_at)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS transcript_status_recheck');
  await knex.raw('DROP INDEX IF EXISTS transcript_status_state');
  await knex.schema.dropTableIfExists('transcript_status');
}
