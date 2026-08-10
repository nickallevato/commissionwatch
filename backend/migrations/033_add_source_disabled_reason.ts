import type { Knex } from 'knex';

/**
 * Why a source is off.
 *
 * A disabled source disappearing from the console is how operational knowledge
 * turns into somebody's memory. `bozemanmt.gov` is a blanket Akamai deny; that
 * fact has cost this project two investigations already, and it currently lives
 * in a code comment and a status document. It belongs where an operator looks
 * when they wonder why nothing has swept.
 *
 * So the reason is a column, the console lists disabled sources rather than
 * filtering them out, and `registerSource` seeds this from the adapter's own
 * `describeSource().notes` — the adapter is the thing that knows.
 *
 * The backfill below writes the two reasons that are already known. It is
 * `WHERE disabled_reason IS NULL` so re-running it can never overwrite an
 * operator's own note.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ingestion_sources', (table) => {
    table.text('disabled_reason').nullable();
  });

  await knex('ingestion_sources')
    .where({ adapter_key: 'bozeman-granicus' })
    .whereNull('disabled_reason')
    .update({
      disabled_reason:
        'Registered disabled pending an operator decision. Records come from the Granicus ' +
        'portal, not bozemanmt.gov: the city site returns a blanket Akamai 403 to a real ' +
        'browser from a residential IP and is never fetched. The Granicus robots.txt is ' +
        'Disallow: / for this agent, so sweeping runs under the vendor-robots exception of ' +
        '2026-08-04 at the published 10s crawl delay, disclosed on the Methodology page. If ' +
        'that disclosure comes down, this source must stay disabled.',
    });

  await knex('ingestion_sources')
    .where({ adapter_key: 'gallatin-civicplus' })
    .whereNull('disabled_reason')
    .update({
      disabled_reason:
        'Registered disabled pending an operator decision. CivicPlus AgendaCenter with a ' +
        'permissive robots.txt; nothing blocks it. Enabling it starts a real crawl of a ' +
        'county web server, which is a choice a person makes, not one a deploy makes.',
    });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ingestion_sources', (table) => {
    table.dropColumn('disabled_reason');
  });
}
