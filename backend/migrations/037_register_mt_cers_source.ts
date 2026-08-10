import type { Knex } from 'knex';

/**
 * MT CERS, registered as a source that has never run.
 *
 * The public status page shows what `ingestion_sources` holds and nothing else,
 * because a status page maintained by hand is a status page that lies
 * eventually. That rule has a cost: a source we have committed to and have not
 * built cannot appear on the page unless it exists in the table. Campaign
 * finance — `cers-ext.mt.gov/CampaignTracker` — has been in the roadmap since
 * the production design and has never been written. Left out of the table it is
 * an absence nobody can see; put in it, it is a commitment with a date attached.
 *
 * So this row exists, `enabled = false`, with a `disabled_reason` that says
 * plainly that no adapter has been written rather than implying an outage. It
 * renders as **Never run**, in the accent colour, next to Bozeman.
 *
 * Nothing sweeps because of this row. `SourceScheduler` arms enabled sources
 * only, and `AdapterRegistry` has no `mt-cers` entry — a manual sweep of it
 * fails to resolve an adapter and says so, which is the correct outcome for a
 * source whose adapter does not exist.
 *
 * ## Two things worth knowing before editing this
 *
 * **`jurisdiction_type` gains `'state'`.** A statewide filing system is neither
 * a city nor a county, and typing it as one of those to avoid an enum change
 * would put a false claim in the column that the whole page is derived from.
 * PostgreSQL refuses to *use* an enum value added in the same transaction, so
 * this migration runs with `transaction: false`. It is written to be safe if it
 * is re-run after a partial application: every step is guarded.
 *
 * **`seeds/001_pilot_data.ts` deletes every `jurisdictions` row**, and
 * `ingestion_sources.jurisdiction_id` cascades from it — so on a seeded
 * development or test database these rows are gone. That is pre-existing seed
 * behaviour, not something introduced here, and it is why
 * `test/public-status.test.ts` builds its own fixtures instead of asserting on
 * this row. Production is never seeded (`docker-entrypoint.sh` refuses under
 * `NODE_ENV=production`), so the row survives where it matters.
 */

export const config = { transaction: false };

const JURISDICTION_NAME = 'State of Montana';
const ADAPTER_KEY = 'mt-cers';

const DISABLED_REASON =
  'No adapter has been written for this source yet. Montana campaign-finance filings are ' +
  'published through CERS (cers-ext.mt.gov/CampaignTracker), a structured system rather than a ' +
  'document archive, and reading it is a separate piece of work that has not been done. This row ' +
  'exists so that the absence is visible on the public status page rather than being invisible: ' +
  'nothing has ever been ingested from Montana campaign finance, and no figure on this site ' +
  'draws on it.';

export async function up(knex: Knex): Promise<void> {
  // `ADD VALUE IF NOT EXISTS` so a re-run after a mid-migration failure is a
  // no-op rather than an error. Without a transaction there is no rollback to
  // rely on, so every statement here has to be safe twice.
  await knex.raw(`ALTER TYPE jurisdiction_type ADD VALUE IF NOT EXISTS 'state'`);

  const existing = await knex('jurisdictions')
    .where({ name: JURISDICTION_NAME, state: 'MT' })
    .first('id');

  const jurisdictionId: string = existing
    ? (existing as { id: string }).id
    : (
        (await knex('jurisdictions')
          .insert({
            name: JURISDICTION_NAME,
            state: 'MT',
            // The value added above. Separate statement, hence the need for
            // `transaction: false`.
            type: 'state',
            website_url: 'https://cers-ext.mt.gov/CampaignTracker',
          })
          .returning('id')) as { id: string }[]
      )[0].id;

  const source = await knex('ingestion_sources')
    .where({ jurisdiction_id: jurisdictionId, adapter_key: ADAPTER_KEY })
    .first('id');
  if (source) return;

  await knex('ingestion_sources').insert({
    jurisdiction_id: jurisdictionId,
    adapter_key: ADAPTER_KEY,
    config: JSON.stringify({ baseUrls: ['https://cers-ext.mt.gov/CampaignTracker'] }),
    enabled: false,
    // Not `blocked`: nothing has blocked us. CERS has never been asked for
    // anything. `healthy` here means "no failure has been observed", which is
    // true, and `verdict` reports `disabled` regardless — the state a reader
    // sees is the honest one either way.
    health_status: 'healthy',
    cron_expression: '41 7 * * *',
    // No expectation is stated, because none has been decided. An absent
    // expectation is not an expectation of zero, and the silence watch renders
    // it as `unknown` rather than inventing a cadence for a source that has
    // never run.
    expected_interval_hours: null,
    disabled_reason: DISABLED_REASON,
  });
}

export async function down(knex: Knex): Promise<void> {
  const jurisdiction = await knex('jurisdictions')
    .where({ name: JURISDICTION_NAME, state: 'MT' })
    .first('id');
  if (!jurisdiction) return;
  const jurisdictionId = (jurisdiction as { id: string }).id;

  await knex('ingestion_sources')
    .where({ jurisdiction_id: jurisdictionId, adapter_key: ADAPTER_KEY })
    .del();

  // Only if nothing else was attached to it in the meantime. Dropping a
  // jurisdiction cascades to commissions and meetings, and a `down` that
  // destroys ingested records is worse than one that leaves a row behind.
  const remaining = await knex('ingestion_sources')
    .where({ jurisdiction_id: jurisdictionId })
    .first('id');
  const commissions = await knex('commissions')
    .where({ jurisdiction_id: jurisdictionId })
    .first('id');
  if (!remaining && !commissions) {
    await knex('jurisdictions').where({ id: jurisdictionId }).del();
  }

  // `jurisdiction_type` keeps `'state'`. PostgreSQL cannot drop an enum value,
  // and recreating the type would rewrite every dependent column.
}
