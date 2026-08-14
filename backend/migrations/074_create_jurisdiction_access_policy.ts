import type { Knex } from 'knex';

/**
 * The regions module — how we are allowed to reach a jurisdiction's records,
 * and what we have promised in exchange.
 *
 * ── Why this is a table and not more constants ──
 *
 * Everything that varies by jurisdiction and carries a legal or reputational
 * consequence was, until now, scattered across five places that cannot be kept
 * in step with each other: a crawl delay in `ingestion/adapters/http.ts`, a
 * robots decision in a code comment, its disclosure in a React page, a reason a
 * source is switched off in `ingestion_sources.disabled_reason`, and the rest
 * in an operator's memory. Scattered facts drift, and these are the facts that
 * get a project like this blocked, sued, or caught asserting something it does
 * not do.
 *
 * ── The line this table draws, and it is the important part ──
 *
 * **Our conduct is ours to state. Their statute is theirs, and must be read.**
 *
 * So this table *is* seeded and `jurisdiction_records_law` is *not*. The rows
 * below record decisions this project made about its own behaviour — how often
 * we fetch, under what name, and whether we set a vendor's robots file aside.
 * We are the primary source for those, and writing them down is recording a
 * decision rather than guessing at someone else's obligation. A statute is the
 * opposite: nobody here has authority over it, so migration 036 ships empty and
 * the letter generator refuses rather than inventing a deadline.
 *
 * Do not blur that line by seeding a statute here later because it was
 * convenient.
 *
 * ── The disclosure is a constraint, not a note ──
 *
 * `robots_posture = 'vendor_exception'` is the operator decision of 2026-08-04:
 * where a *vendor's* blanket `Disallow: /` would block records a custodian is
 * legally obliged to publish, we fetch anyway — politely, under our own name,
 * and **disclosed publicly on the Methodology page**. SKILL.md states the
 * condition plainly: a transparency project must not carry a published policy
 * it knowingly breaks, and if the disclosure ever comes down the exception must
 * end with it.
 *
 * `disclosure_required` is therefore a stored, generated-by-rule column rather
 * than something a reader has to infer, and `services/regions/policy.ts`
 * refuses to report a region as compliant while an exception is undisclosed.
 * The frontend already has three tests asserting the Methodology wording is
 * present; this is the other half of that pair, on the side that does the
 * fetching.
 *
 * ── verified_on ──
 *
 * Same discipline as `jurisdiction_records_law`. A posture nobody has re-read
 * in a year is a claim we are still making, so it carries a date and the
 * console warns when it goes stale. `verified_by` is nullable only because the
 * seeded rows predate any operator account existing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jurisdiction_access_policy', (table) => {
    // Primary key, not a plain foreign key — one policy per jurisdiction, and
    // the absence of a row means "we have not decided how to treat this place",
    // which is a state the sweeper must be able to refuse on. Making it the
    // identity means that question cannot have two disagreeing answers.
    table
      .uuid('jurisdiction_id')
      .primary()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('CASCADE');

    // The platform the custodian publishes through. Free text with a CHECK
    // rather than an enum: a new vendor should be an INSERT, not a migration,
    // and PostgreSQL will not use an enum value added in the same transaction
    // anyway — a trap migration 037 already hit.
    table.text('vendor_platform').nullable();

    table.text('robots_posture').notNullable().defaultTo('respect');
    table.boolean('disclosure_required').notNullable().defaultTo(false);

    // Our own politeness, per region. The floor, not a target: the adapter may
    // wait longer, never less.
    table.integer('crawl_delay_seconds').notNullable().defaultTo(10);
    table.integer('max_concurrency').notNullable().defaultTo(1);

    // NULL means "use the project user agent". A region-specific string exists
    // for the case where a custodian asks us to identify differently so they
    // can allowlist us — which is the outcome we actually want, and
    // `bozeman.granicus.com/robots.txt` shows Granicus already does this for
    // another crawler.
    table.text('user_agent').nullable();

    table.text('tos_notes').nullable();
    table.text('notes').nullable();

    table.date('verified_on').notNullable();
    table
      .uuid('verified_by')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');

    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE jurisdiction_access_policy
      ADD CONSTRAINT jurisdiction_access_policy_robots_posture_check
      CHECK (robots_posture IN ('respect', 'vendor_exception', 'blocked'))
  `);

  // The disclosure rule, in the database rather than in a service everyone has
  // to remember to call. An exception that is not marked as requiring
  // disclosure is not a posture we have any way to honour, so the row simply
  // may not exist.
  await knex.raw(`
    ALTER TABLE jurisdiction_access_policy
      ADD CONSTRAINT jurisdiction_access_policy_exception_is_disclosed
      CHECK (robots_posture <> 'vendor_exception' OR disclosure_required = true)
  `);

  await knex.raw(`
    ALTER TABLE jurisdiction_access_policy
      ADD CONSTRAINT jurisdiction_access_policy_delay_is_polite
      CHECK (crawl_delay_seconds >= 1 AND max_concurrency >= 1)
  `);

  // ── Seed: our own decisions, already made and already in force ──
  //
  // Every figure below is currently live in code or in an operator decision,
  // so this records where they came from rather than introducing anything.
  // Matched on name because jurisdiction ids differ per environment and a
  // hardcoded uuid would silently insert nothing.
  const rows: Array<{
    name: string;
    vendor_platform: string;
    robots_posture: string;
    disclosure_required: boolean;
    crawl_delay_seconds: number;
    notes: string;
  }> = [
    {
      name: 'City of Bozeman',
      vendor_platform: 'granicus',
      robots_posture: 'vendor_exception',
      disclosure_required: true,
      // The Crawl-delay the vendor's own robots.txt publishes. We take the
      // number from the file we are setting aside, which is the whole of the
      // good faith on offer here.
      crawl_delay_seconds: 10,
      notes:
        'bozeman.granicus.com/robots.txt is Disallow: / for this agent. Operator decision of '
        + '2026-08-04: fetched anyway at the file\'s own published Crawl-delay, under the project '
        + 'user agent, disclosed on the Methodology page. bozemanmt.gov itself is a blanket Akamai '
        + '403 and is never fetched — that is a wall, not bot detection, and it stays closed.',
    },
    {
      name: 'Gallatin County',
      vendor_platform: 'civicplus',
      robots_posture: 'respect',
      disclosure_required: false,
      crawl_delay_seconds: 2,
      notes:
        'AgendaCenter is not disallowed, so no exception is needed or claimed. '
        + 'Note the same file does disallow /RSS.aspx and /Search; neither is fetched.',
    },
    {
      name: 'State of Montana',
      vendor_platform: 'mt_cers',
      robots_posture: 'respect',
      disclosure_required: false,
      crawl_delay_seconds: 2,
      notes: 'CERS campaign finance. Rate-limited sweep, no exception claimed.',
    },
  ];

  for (const row of rows) {
    const jurisdiction = await knex('jurisdictions').where({ name: row.name }).first();
    if (!jurisdiction) continue;

    const { name: _name, ...policy } = row;
    await knex('jurisdiction_access_policy')
      .insert({
        jurisdiction_id: jurisdiction.id,
        ...policy,
        // The date the posture was decided, not the date this migration ran.
        // Stamping "today" would restart the staleness clock on a decision
        // nobody has actually re-read.
        verified_on: '2026-08-04',
      })
      .onConflict('jurisdiction_id')
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('jurisdiction_access_policy');
}
