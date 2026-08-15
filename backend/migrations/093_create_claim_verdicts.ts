import type { Knex } from 'knex';

/**
 * What a second model said about one claim, and the exact bytes it said it about.
 *
 * Pass 1 (`services/extraction/`) is mechanical and strong: it locates the quote
 * in the artifact, checks the subject is named in it, and refuses motive
 * language. What it cannot decide is which of two names in one sentence the
 * action attaches to. *"Commissioner Sample moved to table the item; Commissioner
 * Fixture seconded"* supports a claim of `Fixture / seconded` and not one of
 * `Fixture / moved`, and both pass every check `verify.ts` can make. The governor
 * asks a different model that one question.
 *
 * **A separate table, not columns on `minute_claims`.** Three reasons, and each
 * is a thing that would go wrong otherwise:
 *
 *  - A claim is re-judged when the governor model or its prompt changes, and the
 *    old judgement is evidence about the old model. Columns overwrite; rows
 *    accumulate.
 *  - `raw_response` is bulky and belongs nowhere near the meeting page's read
 *    path. It is stored because the first time this project disagrees with a
 *    model's judgement the question will be "what did it actually say", and a
 *    parsed struct cannot answer that.
 *  - The unique index makes re-running the governor over unchanged bytes with an
 *    unchanged model a no-op — the same idempotence `artifacts.sha256` gives the
 *    fetcher.
 *
 * **`window_sha256` pins what was judged.** The verdict is about a ±2,000
 * character window of the document, not about the claim's id. If the county
 * reissues its minutes the window changes, the sha changes, and the old verdict
 * is visibly stale rather than quietly reused as though it had been made about
 * the new text.
 *
 * **Nothing here approves anything.** There is no status column and no foreign
 * key into any decision. A verdict changes the order and the annotation of an
 * operator's queue; a person still presses the button. `supported = false` is
 * not a delete: a judge with a 5% error rate that auto-discards silently loses
 * one true claim in twenty, and a transparency project cannot have a mechanism
 * that quietly drops records.
 *
 * `transaction: false` because `ALTER TYPE ... ADD VALUE` cannot run inside a
 * transaction block in Postgres, for migration 084's reason.
 */

export const VERDICT_CONFIDENCES = ['low', 'medium', 'high'] as const;

export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // The governor is a queue stage, like extraction, and for the same reasons:
  // free models are rate-limited per minute, an unawaited promise owns no row,
  // and a backlog nobody can count is indistinguishable from having nothing to
  // do. Post-`fetch`, so its target carries a content address and no URL.
  await knex.raw(`ALTER TYPE ingestion_job_stage ADD VALUE IF NOT EXISTS 'govern'`);

  await knex.schema.createTable('claim_verdicts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('claim_id')
      .notNullable()
      .references('id')
      .inTable('minute_claims')
      .onDelete('CASCADE');

    /** The model that judged. The requested pin, and what actually answered. */
    table.text('model').notNullable();
    table.text('prompt_version').notNullable();

    table.boolean('supported').notNullable();

    /** Spans of the claim the window does not support. Required when refusing. */
    table.jsonb('unsupported_fragments').notNullable().defaultTo('[]');
    /** Where in the window the judge looked, as offsets we located ourselves. */
    table.jsonb('relied_on').notNullable().defaultTo('[]');

    table.text('confidence').notNullable();

    /** sha256 of the exact window judged. See the header. */
    table.specificType('window_sha256', 'char(64)').notNullable();

    /** Verbatim. A summarised model reply is a reply nobody can re-examine. */
    table.text('raw_response').notNullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['claim_id', 'created_at'], 'idx_claim_verdicts_claim');
  });

  await knex.raw(`
    ALTER TABLE claim_verdicts
    ADD CONSTRAINT claim_verdicts_confidence_check
    CHECK (confidence IN (${VERDICT_CONFIDENCES.map((c) => `'${c}'`).join(', ')}))
  `);

  // A refusal that cannot say what is wrong has not judged. The application
  // treats that reply as void and stores no row at all; this is the database
  // refusing to hold one if the application ever stops.
  await knex.raw(`
    ALTER TABLE claim_verdicts
    ADD CONSTRAINT claim_verdicts_points_at_something_check
    CHECK (supported OR jsonb_array_length(unsupported_fragments) > 0)
  `);

  await knex.raw(`
    ALTER TABLE claim_verdicts
    ADD CONSTRAINT claim_verdicts_window_sha_check
    CHECK (window_sha256 ~ '^[0-9a-f]{64}$')
  `);

  // The idempotence. Same claim, same model, same prompt, same bytes — one row.
  await knex.raw(`
    CREATE UNIQUE INDEX claim_verdicts_current
    ON claim_verdicts (claim_id, model, prompt_version, window_sha256)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS claim_verdicts_current');
  await knex.schema.dropTableIfExists('claim_verdicts');
  // Postgres cannot remove an enum value, and rewriting `ingestion_job_stage`
  // would mean rewriting every `ingestion_jobs` row to drop a stage nobody used.
  // The rollback that works is migration 018's, which drops the type outright.
}
