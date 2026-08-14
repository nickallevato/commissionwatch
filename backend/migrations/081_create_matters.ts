import type { Knex } from 'knex';

/**
 * A durable identity for a subject of decision.
 *
 * This database records events. `agenda_items` is a per-meeting row, so the
 * question a resident actually asks — *an item appeared on an agenda, what
 * happened to it?* — has no row to answer it. Items get tabled, continued,
 * re-noticed under a different number, and sometimes quietly never return. The
 * last case is invisible precisely because nothing happened, and a project that
 * only stores events cannot report a non-event.
 *
 * Two tables. `matters` is the subject; `matter_appearances` is the link from
 * that subject to each agenda item that concerns it.
 *
 * **The identity is deterministic and the key enforces it.** `identity_key` is
 * either a parsed designator (`d:ordinance 2145`) or a normalised title
 * (`t:zoning map amendment for north seventh`), and the unique index on
 * `(commission_id, identity_key)` is what makes a rebuild idempotent rather
 * than merely careful. Nothing here is fuzzy: no similarity operator, no
 * trigram index, no embedding. A near-match is an inference, and merging two
 * neighbours' rezones because their titles read alike is exactly the kind of
 * claim this project may not publish. Two rows that are really one matter but
 * were titled differently stay two rows — the correct failure.
 *
 * **`commission_id`, not jurisdiction.** "Ordinance 2145" is a number a body
 * issues, and two bodies both have one. Scoping the key to the commission is
 * what stops a Bozeman ordinance and a Gallatin ordinance colliding into a
 * single matter with an impossible timeline.
 *
 * **`match_rule` on the link, not just the matter.** Every join between an
 * agenda item and a matter carries the rule that produced it, so the basis of
 * every link is inspectable from the row itself rather than by re-running the
 * parser and hoping it still behaves the same way.
 *
 * **No `state` column, deliberately** — migration 038's reason, applied to a
 * second table. A matter is `decided`, `withdrawn`, `dormant` or `pending`, and
 * three of those four would have to be written by a clock or a sweeper. A
 * terminal status set by a background job is indistinguishable, in the log,
 * from a decision a person made, and it drifts the moment the job stops
 * running. State is computed at read time in `services/matters.ts` from the
 * published record, so it cannot be stale and cannot be wrong in a way nobody
 * can see.
 *
 * **Everything here is derived and disposable.** These rows are a projection of
 * `agenda_items`; `rebuildMatters` reconstructs them in full. Both foreign keys
 * cascade, so a deleted meeting takes its appearances with it and the rebuild
 * prunes whatever matter is left with nothing to point at.
 */

/** The rules that may produce a link. Extended by migration, never by a caller. */
const MATCH_RULES = ['designator', 'normalized_title'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('matters', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('commission_id')
      .notNullable()
      .references('id')
      .inTable('commissions')
      .onDelete('CASCADE');

    // The identity. Rule-prefixed so a designator key and a title key can never
    // occupy the same string by coincidence.
    table.text('identity_key').notNullable();

    // The designator as it should be printed, or NULL when the identity came
    // from the title. This is display, not the key — the key is normalised.
    table.text('designator').nullable();

    // As first seen in the record, verbatim. Not a canonical title and not a
    // rewrite: the earliest published wording is a fact about the record, and
    // each appearance keeps whatever wording that meeting printed.
    table.text('title').notNullable();

    table.timestamps(true, true);

    table.unique(['commission_id', 'identity_key'], { indexName: 'uq_matters_identity' });
  });

  await knex.schema.createTable('matter_appearances', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('matter_id').notNullable().references('id').inTable('matters').onDelete('CASCADE');
    table
      .uuid('agenda_item_id')
      .notNullable()
      .references('id')
      .inTable('agenda_items')
      .onDelete('CASCADE');
    table.text('match_rule').notNullable();
    table.timestamps(true, true);

    // One item belongs to at most one matter. Without this a rebuild that
    // changed its mind about an item would leave both answers in the table and
    // the timeline would show it twice.
    table.unique(['agenda_item_id'], { indexName: 'uq_matter_appearances_item' });
    table.index('matter_id', 'idx_matter_appearances_matter');
  });

  await knex.raw(`
    ALTER TABLE matter_appearances
    ADD CONSTRAINT matter_appearances_match_rule_check
    CHECK (match_rule IN (${MATCH_RULES.map((rule) => `'${rule}'`).join(', ')}))
  `);

  // An empty key would satisfy NOT NULL and identify nothing, so every untitled
  // item in the table would become the same matter.
  await knex.raw(`
    ALTER TABLE matters
    ADD CONSTRAINT matters_identity_key_check
    CHECK (length(btrim(identity_key)) > 2)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('matter_appearances');
  await knex.schema.dropTableIfExists('matters');
}
