import type { Knex } from "knex";

/**
 * Campaign finance — the record a `vote_donor_conflict` finding is built from.
 *
 * `vote_donor_conflict` has been a legal value of `anomaly_flag_type` since
 * migration 020 and nothing has ever raised it, because there was nowhere to
 * put a contribution. These two tables are that place.
 *
 * ## Two systems, one shape
 *
 * `source_system` is the whole of the multi-source design, and it is a CHECK
 * rather than an enum on purpose: adding a value to a CHECK is one statement in
 * one transaction, where `ALTER TYPE ... ADD VALUE` cannot run in one at all
 * (see migration 020's header for what that costs).
 *
 * **`openfec` is the only system with an adapter today, and it is federal
 * only.** OpenFEC holds filings made to the Federal Election Commission. A city
 * commissioner or a county commissioner ordinarily files nothing there, so for
 * most of the officials this project follows the honest answer is *no federal
 * filings were found*, which is a statement about the FEC's records and not
 * about the official. That limitation is not left to be inferred: it is carried
 * to the reader by `services/finance/coverage.ts`, which is the single place the
 * sentence is written and the only place the UI gets it from.
 *
 * `mt_cers` is admitted by the CHECK and has **no adapter here** — Montana's
 * CERS holds the state and local filings that would answer for the officials
 * OpenFEC cannot, and it is being probed separately. The column exists now so
 * that landing it later is an insert path and a coverage row, not a migration
 * against tables that had assumed one source.
 *
 * ## Sourcing
 *
 * `source_url` is NOT NULL on both tables, and it is the API request that
 * returned the row, **with the API key stripped**. `external_id` is the filing
 * system's own identifier (`sub_id` on OpenFEC) and `image_number` is the FEC's
 * scanned-document number, which resolves to a public page on `docquery.fec.gov`
 * that anybody can open without an account. A finding is refused unless the
 * contribution behind it carries at least one of those two, because "no
 * unsourced claim reaches the public site" means a locator someone else can
 * follow, not a number we are asserting.
 *
 * `raw` keeps the record as filed. A normalisation defect must be visible as a
 * disagreement between the columns and the filing, rather than being the only
 * copy that survived.
 *
 * ## What is deliberately not modelled
 *
 * There is no `member_id` on a contribution. Matching a filing's recipient
 * name to an official on our roster is a *name* match and is uncertain, and a
 * foreign key is not an uncertain thing — writing one would turn a guess into
 * a fact the moment it was stored. The match, its method, its score and its
 * evidence live on the finding, where they can be labelled as what they are.
 */

const SOURCE_SYSTEMS = ["openfec", "mt_cers"] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("campaign_contributions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));

    table.string("source_system", 20).notNullable();

    /**
     * Which jurisdiction's roster this filing was retrieved *for*. Nullable and
     * advisory: it records why we fetched the row, never who it is about.
     */
    table
      .uuid("jurisdiction_id")
      .nullable()
      .references("id")
      .inTable("jurisdictions")
      .onDelete("SET NULL");

    /** Names exactly as filed. Never cleaned up — the filing is the record. */
    table.text("recipient_name").notNullable();
    table.text("committee_name").nullable();
    table.text("donor_name").notNullable();
    table.text("donor_employer").nullable();
    table.text("donor_occupation").nullable();
    table.text("donor_city").nullable();
    table.string("donor_state", 8).nullable();

    table.decimal("amount", 14, 2).notNullable();
    table.date("contribution_date").notNullable();
    /** The filing period, where the system publishes one. */
    table.integer("cycle").nullable();

    table.text("external_id").nullable();
    table.text("image_number").nullable();
    table.text("source_url").notNullable();
    table.timestamp("retrieved_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.jsonb("raw").notNullable();

    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["source_system", "recipient_name"], "idx_contributions_system_recipient");
    table.index("donor_name", "idx_contributions_donor");
    table.index("contribution_date", "idx_contributions_date");
  });

  await knex.raw(`
    ALTER TABLE campaign_contributions
    ADD CONSTRAINT campaign_contributions_source_system_check
    CHECK (source_system IN (${SOURCE_SYSTEMS.map((value) => `'${value}'`).join(", ")}))
  `);

  // A contribution of zero or less is not a contribution; it is a parse
  // failure wearing one's clothes, and it would render as "$0" beside an
  // official's name.
  await knex.raw(`
    ALTER TABLE campaign_contributions
    ADD CONSTRAINT campaign_contributions_amount_check CHECK (amount > 0)
  `);

  // Re-ingesting the same filing must not double the total anyone reads. The
  // partial index is the honest form: rows that carry no identifier cannot be
  // deduplicated by one, and pretending otherwise would silently drop
  // legitimate distinct filings that happen to share a name and a date.
  await knex.raw(`
    CREATE UNIQUE INDEX uq_contributions_external_id
    ON campaign_contributions (source_system, external_id)
    WHERE external_id IS NOT NULL
  `);

  await knex.schema.createTable("campaign_expenditures", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));

    table.string("source_system", 20).notNullable();
    table
      .uuid("jurisdiction_id")
      .nullable()
      .references("id")
      .inTable("jurisdictions")
      .onDelete("SET NULL");

    table.text("committee_name").nullable();
    table.text("recipient_name").notNullable();
    table.text("purpose").nullable();

    table.decimal("amount", 14, 2).notNullable();
    table.date("disbursement_date").notNullable();
    table.integer("cycle").nullable();

    table.text("external_id").nullable();
    table.text("image_number").nullable();
    table.text("source_url").notNullable();
    table.timestamp("retrieved_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.jsonb("raw").notNullable();

    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["source_system", "recipient_name"], "idx_expenditures_system_recipient");
    table.index("disbursement_date", "idx_expenditures_date");
  });

  await knex.raw(`
    ALTER TABLE campaign_expenditures
    ADD CONSTRAINT campaign_expenditures_source_system_check
    CHECK (source_system IN (${SOURCE_SYSTEMS.map((value) => `'${value}'`).join(", ")}))
  `);
  await knex.raw(`
    ALTER TABLE campaign_expenditures
    ADD CONSTRAINT campaign_expenditures_amount_check CHECK (amount > 0)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX uq_expenditures_external_id
    ON campaign_expenditures (source_system, external_id)
    WHERE external_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("campaign_expenditures");
  await knex.schema.dropTableIfExists("campaign_contributions");
}
