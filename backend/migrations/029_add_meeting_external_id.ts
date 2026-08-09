import type { Knex } from 'knex';

/**
 * Identity for an ingested meeting, and for an ingested document.
 *
 * A nightly sweep re-reads the same listing every night. Without an identity,
 * night two inserts a second copy of every meeting night one found, and the
 * public site starts asserting that the county met twice. `meetings` had no
 * natural key to upsert on: `(commission_id, date)` is not unique, because a
 * body can meet twice in one day, and using it would silently merge two real
 * meetings into one — a worse failure than duplication.
 *
 * So the source's own identifier is stored, and uniqueness is enforced on it.
 * The index is deliberately NOT partial: Postgres treats NULLs as distinct in a
 * unique index, so meetings entered by hand or seeded — which carry NULL — are
 * unconstrained anyway, and a partial index cannot be used for `ON CONFLICT`
 * inference without repeating its predicate at every call site. Same
 * uniqueness, one fewer trap.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('meetings', (table) => {
    // e.g. Gallatin AgendaCenter's '06042026-107'. Text, not a fixed width:
    // the next source's identifier scheme is not ours to predict.
    table.text('external_id').nullable();
  });

  await knex.raw(`
    CREATE UNIQUE INDEX meetings_commission_external_id_unique
    ON meetings (commission_id, external_id)
  `);

  // The same argument for documents: a re-swept meeting must not grow a second
  // copy of the same agenda link every night.
  await knex.raw(`
    CREATE UNIQUE INDEX meeting_documents_meeting_url_unique
    ON meeting_documents (meeting_id, url)
  `);

  // ...and for agenda items, whose identity within a meeting is their ordinal.
  // Re-parsing a corrected agenda must revise item 4, not add a second one.
  await knex.raw(`
    CREATE UNIQUE INDEX agenda_items_meeting_item_number_unique
    ON agenda_items (meeting_id, item_number)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS agenda_items_meeting_item_number_unique');
  await knex.raw('DROP INDEX IF EXISTS meeting_documents_meeting_url_unique');
  await knex.raw('DROP INDEX IF EXISTS meetings_commission_external_id_unique');
  await knex.schema.alterTable('meetings', (table) => {
    table.dropColumn('external_id');
  });
}
