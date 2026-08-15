import type { Knex } from 'knex';

/**
 * Where each caption cue sits in the indexed text, and when it was said.
 *
 * `artifact_texts.text` holds the cue payloads joined with newlines and nothing
 * else — no timestamps, no cue numbers, no synthesised speaker labels. That
 * projection is not a stylistic choice: `services/extraction/run.ts` builds its
 * document text as `lines.join("\n")` and `verify.ts`'s `locateQuote` returns a
 * character offset into that string, which is what `minute_claims.quote_offset`
 * stores. One projection idiom means one offset space and one verifier. A
 * timecode inside the text would also land in every `ts_headline` snippet a
 * reader sees, and would be quotable as if the custodian had written it.
 *
 * This table is how the timestamps survive that projection. Given a character
 * offset into `artifact_texts.text` — the same offset a claim already stores —
 * the cue it falls in is one indexed lookup, and a quote spanning three cues
 * cites the interval `[first.start_ms, last.end_ms]`. An interval is what is
 * true; a point would be a rounding of the record.
 *
 * The invariant, written in the same transaction as the text so the two can never
 * be different projections, and asserted in `test/transcripts.test.ts`:
 *
 *     substr(artifact_texts.text, text_offset + 1, text_length) = the cue payload
 *
 * **These clocks are media time, not wall-clock time.** Clip 2775's first cue
 * starts at 00:29:38.500 and clip 2786's at 00:01:44.459: the recording begins
 * before the meeting does, by an amount that varies per clip and is published
 * nowhere. The rendered form is "29:38 into the recording". Converting `start_ms`
 * to a time of day would invent a fact, and a test forbids it.
 *
 * **There is no `speaker` column and there must never be one.** `>>` in these
 * files is the CEA-608 speaker-*change* marker: it carries no identity by
 * construction, it appears mid-sentence in real payloads ("a color change isn't
 * enough to designate whether or not it's >>"), and in a three-hour meeting there
 * are 84 of them against thousands of real turns. One of five sampled files
 * carries `Name:` prefixes instead, and that file spells a single person three
 * ways — `Greg Sullivan`, `Gregg Sullivan`, `Gregg Sulivan` — alongside bare
 * surnames of undocumented provenance. Resolving any of that against `members`
 * would produce a confident-looking attribution built on a guess. Attribution
 * comes from the minutes, through `minute_claims`, or it does not exist. A column
 * named `speaker` would be read as an identity by every consumer that touched it
 * no matter what this comment says, which is why the rule is enforced by the
 * column's absence and by a schema test rather than by convention.
 *
 * `ON DELETE CASCADE`, matching `artifact_texts` and deliberately unlike
 * `document_versions.artifact_id`: this is derived data, reproducible from bytes
 * we still hold, and an orphaned cue index would be a timeline with nothing
 * behind it. A version row is evidence and must fail loudly instead.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transcript_cues', (table) => {
    table.uuid('artifact_id').notNullable().references('id').inTable('artifacts').onDelete('CASCADE');

    /** 0-based, file order. */
    table.integer('cue_index').notNullable();

    /** Milliseconds into the recording. Never a time of day. */
    table.integer('start_ms').notNullable();
    table.integer('end_ms').notNullable();

    /** Character offset and length into `artifact_texts.text`. */
    table.integer('text_offset').notNullable();
    table.integer('text_length').notNullable();

    table.timestamps(true, true);

    table.primary(['artifact_id', 'cue_index']);
  });

  await knex.raw(`
    ALTER TABLE transcript_cues
    ADD CONSTRAINT transcript_cues_time_check
    CHECK (start_ms >= 0 AND end_ms >= start_ms)
  `);

  // A zero-length cue would address no text at all, so the citation lookup would
  // return a row that quotes nothing.
  await knex.raw(`
    ALTER TABLE transcript_cues
    ADD CONSTRAINT transcript_cues_span_check
    CHECK (text_offset >= 0 AND text_length > 0)
  `);

  // Two cues cannot start at the same character: the offset is the key a citation
  // is resolved by, and a duplicate would make that resolution a coin toss.
  await knex.raw(`
    CREATE UNIQUE INDEX transcript_cues_offset
    ON transcript_cues (artifact_id, text_offset)
  `);

  await knex.raw(`
    CREATE INDEX transcript_cues_lookup
    ON transcript_cues (artifact_id, text_offset, cue_index)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS transcript_cues_lookup');
  await knex.raw('DROP INDEX IF EXISTS transcript_cues_offset');
  await knex.schema.dropTableIfExists('transcript_cues');
}
