import type { Knex } from 'knex';

/**
 * The event spine — one durable row per thing this project has announced.
 *
 * The problem it solves is a counting problem. `services/publication.ts` is the
 * wall between ingested and published, and its own header records the cost of
 * re-typing it: seven routes on the meetings router, three on the anomalies
 * router. Every consumer added after this — a feed, a webhook, a receipt, a
 * digest — would have to re-derive the same two-part condition ("the finding is
 * `published` AND its meeting is published") in a query shape none of the
 * existing helpers fit. The first one to get it slightly wrong publishes a
 * generated claim about a named person that an operator withheld.
 *
 * So: an event row is written only for an object that is already public, and a
 * consumer reads events instead of reading tables. The wall moves from *n*
 * consumers to one emitter (`services/events/emit.ts`), which re-reads the
 * subject through the publication helpers immediately before inserting.
 *
 * Three column choices that could plausibly have gone the other way.
 *
 * **`dedupe_key` is globally unique, not unique per channel.** `deliveries`
 * already carries a `(channel_id, dedupe_key)` unique index and it stays — that
 * one stops a repeat *delivery*. This one is a level up: it stops a repeat
 * *event*. A publish that runs twice because an operator double-clicked, or
 * because a retry re-entered the transaction, must produce one event rather
 * than two that then fan out to every channel twice.
 *
 * **`subject_id` is not a foreign key.** There is no one table to point at; the
 * subject is a meeting, a flag, a claim or a document. A polymorphic FK would
 * need five nullable columns and five constraints to say exactly one is set.
 * More to the point, the row records that something *was announced*, and it has
 * to survive the subject being deleted — a deleted meeting does not
 * retroactively un-announce itself. Same reasoning as
 * `minute_claims.artifact_sha256`, which deliberately is not an FK to
 * `artifacts`.
 *
 * **The undispatched index carries `revoked_at IS NULL`.** The drain's hot
 * query is "what have I not sent that I am still allowed to send". Putting both
 * predicates in the index means a revocation removes the row from the drain's
 * working set rather than merely being filtered out of it.
 *
 * `dispatched_at` means *handed to the dispatcher*, not *delivered*. Delivery
 * outcome lives in `deliveries.status`, where it already lives. Two columns,
 * two questions, no overlap.
 *
 * Retention: never delete. These rows are the announcement history, and a
 * cleanup job that quietly erased them would erase the only record of what this
 * project told the public and when.
 */

/** Extended by migration, never by a caller. Mirrored in `services/events/emit.ts`. */
const SUBJECT_KINDS = ['meeting', 'finding', 'claim', 'document', 'ops'] as const;

/** The same ladder `delivery_channels` routes on. */
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    /** `{subject}.{past-tense verb}`, e.g. `finding.published`. */
    table.text('event_type').notNullable();
    table.text('subject_kind').notNullable();

    // Nullable only for `ops`, which is about the machinery rather than about a
    // record. The CHECK below is what makes that the only case.
    table.uuid('subject_id').nullable();

    // SET NULL, not CASCADE: the announcement outlives the jurisdiction row.
    table
      .uuid('jurisdiction_id')
      .nullable()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('SET NULL');

    table.text('severity').nullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.text('dedupe_key').notNullable();

    table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('dispatched_at', { useTz: true }).nullable();

    // Revocation is the honest half of unpublication: an undispatched event is
    // genuinely recalled, a dispatched one is only marked. See
    // `services/events/emit.ts` and the `.retracted` event it emits.
    table.timestamp('revoked_at', { useTz: true }).nullable();
    table.text('revoked_reason').nullable();

    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_subject_kind_check
    CHECK (subject_kind IN (${quoted(SUBJECT_KINDS)}))
  `);

  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_subject_id_check
    CHECK (subject_kind = 'ops' OR subject_id IS NOT NULL)
  `);

  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_severity_check
    CHECK (severity IS NULL OR severity IN (${quoted(SEVERITIES)}))
  `);

  // A reason with no revocation describes a write that never happened.
  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_revoked_reason_check
    CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL)
  `);

  await knex.raw('CREATE UNIQUE INDEX events_dedupe ON events (dedupe_key)');

  await knex.raw(`
    CREATE INDEX events_undispatched ON events (occurred_at)
    WHERE dispatched_at IS NULL AND revoked_at IS NULL
  `);

  await knex.raw('CREATE INDEX events_subject ON events (subject_kind, subject_id, occurred_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('events');
}
