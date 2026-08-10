import type { Knex } from 'knex';

/**
 * An operator's judgement about whether two names are the same entity.
 *
 * ## The gap this closes
 *
 * A `vote_donor_conflict` rests on a name match: a donor filed as "Anderson
 * Ridge LLC" and an agenda item containing the word "Anderson". The matcher
 * bands that as evidence of a possible link and says so. What it cannot do — in
 * principle, not for want of a better algorithm — is decide whether the two
 * names denote the same thing. Only a person can, by looking.
 *
 * Until this table, that person's answer was thrown away. The same ambiguous
 * pair came back on the next sweep, and could be decided differently on two days
 * with nothing recording that it had ever been decided at all.
 *
 * ## What a pair is
 *
 * Not the finding, and not the agenda item. A finding id changes every sweep and
 * an agenda item id changes every meeting, so keying on either would mean the
 * judgement expired the moment it was useful. The pair is:
 *
 *  - `donor_terms` — the donor's **distinctive** terms, sorted and space-joined
 *  - `subject_terms` — the distinctive terms the matcher found in the agenda
 *    item, sorted and space-joined
 *
 * Those two are byte-stable across sweeps and across meetings, which is exactly
 * the reuse being asked for: an operator who has decided that this donor is not
 * the "Anderson" that agenda items keep naming has decided it once.
 *
 * **The donor half is distinctive terms and not the whole normalised name**, for
 * the reason `entity-resolution.ts` sets out at length: the whole name would key
 * "Ridgeline Aggregate LLC" and "Ridgeline Aggregate Union" separately, which
 * would make a stored judgement depend on what class of organisation the donor
 * is. Detection applies identically to every entity class, and the class word is
 * discarded before this key is built, so there is nothing here to depend on.
 *
 * `donor_name_filed` is stored beside the key so the console can show a human
 * the string a human would recognise, rather than the term list the matcher
 * works in.
 *
 * ## The two decisions are not symmetric
 *
 *  - `different_entity` **suppresses**. The finding is not raised again. That is
 *    the operator saying the link is a coincidence, and asking them the same
 *    question next week would be the defect this table exists to fix.
 *  - `same_entity` **annotates**. The finding is still raised, still `held`, and
 *    still requires an explicit approval with a stated reason. Nothing here
 *    publishes anything as a side effect.
 *
 * ## Current state here, history in the log
 *
 * This table is the *current* answer, so it is updatable — an operator must be
 * able to change their mind. Every write also appends a row to
 * `record_corrections`, which migration 031 makes append-only with a trigger, so
 * the sequence of judgements is recoverable from the one audit log this project
 * has rather than from a second one that could disagree with it.
 *
 * That is why the CHECK on `record_corrections.target_table` is widened below.
 *
 * ## No PII, and no entity class
 *
 * A donor's **name** and the terms that matched. No address, occupation,
 * employer, telephone, email or residence city — `finance-pii-guard.test.ts`
 * scans this table's column names for all of them.
 *
 * There is also no column saying what kind of thing the donor is, and no branch
 * anywhere on one. Detection applies identically to every entity class, and here
 * that holds because there is nothing to branch on.
 */

/** Mirrors 031, 038 and 039, plus the subject this migration adds. */
const CORRECTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
  'review_policy',
  'record_disputes',
  'entity_resolution_decisions',
] as const;

/** The two answers. Written out rather than imported: no migration reads `../src/`. */
const DECISIONS = ['same_entity', 'different_entity'] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('entity_resolution_decisions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // The pair. See the header for why it is these two columns and not an id.
    table.text('donor_terms').notNullable();
    table.text('subject_terms').notNullable();

    // What a human would recognise, for the console. Never part of the key —
    // "Anderson Ridge LLC" and "ANDERSON RIDGE, L.L.C." are one pair.
    table.text('donor_name_filed').notNullable();

    table.text('decision').notNullable();
    // Not nullable. A judgement without a stated reason is a preference.
    table.text('reason').notNullable();

    // No foreign key to `operators`, matching every other audited table here:
    // an audit record snapshots its actor, so the row survives the operator's
    // deletion still naming who decided.
    table.uuid('operator_id').nullable();
    table.text('operator_email').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // One answer per pair. A second row would make "has this been decided?" a
    // question with two answers, and the one that answered would be whichever
    // the planner reached first.
    table.unique(['donor_terms', 'subject_terms'], {
      indexName: 'uq_entity_resolution_pair',
    });
  });

  await knex.raw(`
    ALTER TABLE entity_resolution_decisions
    ADD CONSTRAINT entity_resolution_decisions_decision_check
    CHECK (decision IN (${quoted(DECISIONS)}))
  `);

  await knex.raw(`
    ALTER TABLE entity_resolution_decisions
    ADD CONSTRAINT entity_resolution_decisions_reason_check
    CHECK (length(btrim(reason)) > 0)
  `);

  await knex.raw(`
    ALTER TABLE entity_resolution_decisions
    ADD CONSTRAINT entity_resolution_decisions_terms_check
    CHECK (length(btrim(donor_terms)) > 0 AND length(btrim(subject_terms)) > 0)
  `);

  // One audit log. Migration 038's reasoning, applied again.
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES)}))
  `);
}

/**
 * Rolling back narrows the CHECK again, which fails loudly once any entity
 * decision has been logged — `record_corrections` forbids DELETE, so those rows
 * cannot be removed to make room. Migrations 038 and 039 document the same
 * honest failure: the log cannot be un-widened once it holds a decision.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES.slice(0, -1))}))
  `);

  await knex.schema.dropTableIfExists('entity_resolution_decisions');
}
