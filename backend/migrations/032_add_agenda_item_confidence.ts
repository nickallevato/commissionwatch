import type { Knex } from 'knex';

/**
 * Confidence is per field, not per record.
 *
 * Seven good agenda items and one mangled one is not a low-confidence meeting,
 * and a record-level score would say it was. Worse, it would say it about the
 * seven items that are fine. So the mark goes on the field that is actually
 * doubtful, and the reason goes with it:
 *
 *   { "title":       { "level": "low",  "reason": "truncated to fit agenda_items.title" },
 *     "category":    { "level": "low",  "reason": "no section heading preceded this item" },
 *     "description": { "level": "high", "reason": "captured whole" } }
 *
 * `level` is one of high | medium | low. It is not a probability: nothing here
 * computes one, and a number would imply an accuracy the extractor does not
 * have. The shape is validated in TypeScript at the write boundary rather than
 * by a jsonb constraint, so a future field needs no migration.
 *
 * Default '{}' rather than NULL: an item extracted before this migration has no
 * assessment, which is different from an assessment that found nothing to say.
 * Both read as "no marks", and neither claims the item is good.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agenda_items', (table) => {
    table.jsonb('field_confidence').notNullable().defaultTo('{}');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agenda_items', (table) => {
    table.dropColumn('field_confidence');
  });
}
