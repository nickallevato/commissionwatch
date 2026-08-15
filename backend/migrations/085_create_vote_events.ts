import type { Knex } from 'knex';

/**
 * The tally, as a fact.
 *
 * *"The motion failed 2–3"* was not storable. `minute_claims` records what one
 * named person did on one matter, so five rows **imply** a tally — but nothing
 * held it, nothing checked it, and no page could state it. The site could say
 * "Sample voted no" and could not say the sentence a reader actually wants, the
 * one that makes the individual votes mean anything.
 *
 * The shape follows Open Civic Data's `VoteEvent` rather than being invented
 * here: a motion, a result, counts per option, and the individual votes that
 * compose it. The project already targets an OCD-shaped export, and a schema
 * that diverges from it only has to be translated later.
 *
 * **Citation columns exactly as migration 072 has them, for 072's reason.**
 * `quote` is the sentence the model emitted, `quote_offset` is where the
 * application *found* that sentence in the stored artifact, and both are NOT
 * NULL — the database refusing to store a citation nobody checked. A vote event
 * asserting a 2–3 outcome is a stronger statement than any single claim, so it
 * gets the stronger evidence rule, not a weaker one. `artifact_sha256` rather
 * than a document id: the tally is about a specific set of bytes, and if the
 * county reissues its minutes that is a different artifact.
 *
 * **Held by default, like a claim.** A vote event names people by composition.
 * Same wall, same queue.
 *
 * **`counts` must carry all four options.** A tally missing a column is not a
 * tally — "3 yes, 2 no" and "3 yes, 2 no, 0 abstain, 0 absent" say different
 * things about who was in the room, and the sum-check against the linked claims
 * is only total if every option is stated. The CHECK below enforces the shape
 * so no writer can leave one out and have it read as zero.
 *
 * The check this buys is in `services/vote-events.ts`: the linked claims per
 * option must sum to `counts`. A mismatch is never reconciled silently — it
 * means the extractor missed a member or invented one, and a tally that
 * disagrees with its own votes is the loudest available signal that a document
 * was read badly.
 */

/** How the motion ended. Extended by migration, never by a caller. */
export const VOTE_RESULTS = ['pass', 'fail', 'tabled', 'withdrawn', 'unrecorded'] as const;

/** The options a tally counts, and the keys `counts` must carry. */
export const VOTE_OPTIONS = ['yes', 'no', 'abstain', 'absent'] as const;

export const VOTE_EVENT_STATUSES = ['held', 'approved', 'rejected'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('vote_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('meeting_id')
      .notNullable()
      .references('id')
      .inTable('meetings')
      .onDelete('CASCADE');
    // Nullable and SET NULL: minutes routinely record a vote whose agenda item
    // was never parsed into a row, and losing the item must not lose the tally.
    table
      .uuid('agenda_item_id')
      .nullable()
      .references('id')
      .inTable('agenda_items')
      .onDelete('SET NULL');

    // The motion as the minutes print it. Not a summary of it.
    table.text('motion_text').notNullable();
    table.text('result').notNullable();
    table.jsonb('counts').notNullable();

    // The citation. Both columns or no row.
    table.string('artifact_sha256', 64).notNullable();
    table.text('quote').notNullable();
    table.integer('quote_offset').notNullable();

    // Provenance of the generation, as on minute_claims. A tally whose model
    // nobody recorded is a tally nobody can re-examine when that model turns
    // out to be bad.
    table.text('model').notNullable();
    table.text('prompt_version').notNullable();

    table.text('status').notNullable().defaultTo('held');
    table.uuid('reviewed_by').nullable();
    table.text('review_reason').nullable();
    table.timestamp('reviewed_at', { useTz: true }).nullable();

    table.timestamps(true, true);

    table.index(['meeting_id', 'status'], 'idx_vote_events_meeting');
    table.index('agenda_item_id', 'idx_vote_events_agenda_item');
  });

  await knex.raw(`
    ALTER TABLE vote_events
    ADD CONSTRAINT vote_events_result_check
    CHECK (result IN (${VOTE_RESULTS.map((name) => `'${name}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE vote_events
    ADD CONSTRAINT vote_events_status_check
    CHECK (status IN (${VOTE_EVENT_STATUSES.map((name) => `'${name}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE vote_events
    ADD CONSTRAINT vote_events_quote_check
    CHECK (length(btrim(quote)) > 0 AND quote_offset >= 0 AND length(btrim(motion_text)) > 0)
  `);

  await knex.raw(`
    ALTER TABLE vote_events
    ADD CONSTRAINT vote_events_sha_check
    CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$')
  `);

  // Every option present, numeric and not negative.
  //
  // `coalesce(jsonb_typeof(...), '')` and not the bare call: a missing key makes
  // `jsonb_typeof` return NULL, an unknown CHECK result counts as satisfied, and
  // the constraint would have accepted exactly the tally it exists to refuse —
  // one with an option left out. Caught by the test that omits `absent`.
  await knex.raw(`
    ALTER TABLE vote_events
    ADD CONSTRAINT vote_events_counts_check
    CHECK (
      jsonb_typeof(counts) = 'object'
      AND ${VOTE_OPTIONS.map(
        (option) =>
          `coalesce(jsonb_typeof(counts -> '${option}'), '') = 'number' AND (counts ->> '${option}')::numeric >= 0`,
      ).join('\n      AND ')}
    )
  `);

  // One vote event per (meeting, artifact, offset), for migration 072's reason:
  // a re-run of the extractor over the same bytes must revise rather than
  // accumulate, or every retry doubles the review queue.
  await knex.raw(`
    CREATE UNIQUE INDEX vote_events_dedupe
    ON vote_events (meeting_id, artifact_sha256, quote_offset)
  `);

  // The link from a personal claim to the tally it belongs to. Nullable: a
  // claim about a motion nobody tallied is still a claim, and SET NULL because
  // deleting a badly-read tally must not delete the votes it was read from.
  await knex.schema.alterTable('minute_claims', (table) => {
    table
      .uuid('vote_event_id')
      .nullable()
      .references('id')
      .inTable('vote_events')
      .onDelete('SET NULL');
    table.index('vote_event_id', 'idx_minute_claims_vote_event');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('minute_claims', (table) => {
    table.dropIndex('vote_event_id', 'idx_minute_claims_vote_event');
    table.dropColumn('vote_event_id');
  });
  await knex.raw('DROP INDEX IF EXISTS vote_events_dedupe');
  await knex.schema.dropTableIfExists('vote_events');
}
