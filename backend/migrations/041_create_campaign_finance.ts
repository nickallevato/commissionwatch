import type { Knex } from "knex";

/**
 * Campaign finance storage — the money behind local office.
 *
 * OpenFEC covers federal candidates. A Gallatin County Commissioner and a
 * Bozeman City Commissioner have no federal filings at all, so until now this
 * project held no donor record for any official it actually watches. Montana
 * publishes theirs through CERS. Access findings, with dates and status codes:
 * `docs/exploration/mt-cers-spike.md`.
 *
 * Three tables, and the shape follows CERS rather than an ideal model, because
 * a schema that disagrees with the source it is loaded from produces rows that
 * are neither what was filed nor what we meant.
 *
 *   cf_filers        a candidacy or a committee registration
 *   cf_reports       one filed report (a C-5, a C-7, an amendment)
 *   cf_transactions  one line item of one schedule of one report
 *
 * ## Every transaction cites a stored artifact, and the column is NOT NULL
 *
 * "No unsourced claim reaches the public site" is an invariant of this project
 * with legal consequences. Here it is a foreign key: `cf_transactions.artifact_id`
 * cannot be null and has no `ON DELETE CASCADE`, so a contribution row without
 * the bytes it was read out of cannot be inserted, and deleting the bytes under
 * a stored contribution fails loudly rather than silently orphaning a citation.
 * The same rule as `document_versions` in migration 034, for the same reason.
 *
 * ## Idempotency is keyed on the content address, not on the data
 *
 * `unique (artifact_id, row_index)` is the whole deduplication mechanism.
 * Re-parsing an artifact yields the same rows in the same order because an
 * artifact *is* its bytes; an amended filing is different bytes, therefore a
 * different artifact, therefore its own rows — which is correct, because an
 * amendment is a second thing the filer said and not a correction to the first.
 * Keying on `(report, name, date, amount)` instead would have silently merged
 * two genuine same-day contributions of the same size from the same donor,
 * which is a thing that happens.
 *
 * ## What is deliberately not modelled
 *
 * There is **no donor identity table**. CERS gives contributors a name and an
 * address and nothing else on this path — `entIdFrom`, the contributor's own
 * entity id, appears on the contributor-side search, which is the query that
 * timed out during the spike and which this adapter does not issue. Resolving
 * "Aas, Barbara" across filings is an inference, and inventing an identity
 * table now would make that inference look like a record. Names and addresses
 * are stored as filed; joining them is later work with its own evidence.
 *
 * There is **no jurisdiction foreign key on `cf_filers`**. CERS has no city or
 * municipality field — the office select contains no city names — so "this is a
 * Bozeman candidate" can only be inferred from a residence address.
 * `residence_city` records what was filed and `derived_jurisdiction` records
 * what we concluded, in two different columns, so the inference can never be
 * read back as the filing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("cf_filers", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("source_id")
      .notNullable()
      .references("id")
      .inTable("ingestion_sources")
      .onDelete("CASCADE");

    // 'candidate' or 'committee'. A check rather than an enum: two values that
    // may grow, and an enum here would need a migration to add 'ballot_issue'.
    table.string("filer_type", 20).notNullable();

    /**
     * CERS's own identifiers.
     *
     * `cers_ent_id` is the entity — the person or organisation — and is the key
     * that would one day join a filer to a donor, because a contribution's
     * contributor id lives in the same namespace. `cers_filer_id` is the
     * candidacy or committee registration: one person who ran twice has two.
     * bigint because they are integers in a state system we do not control, and
     * `.bigInteger` returns a string in JS, so callers must not do arithmetic
     * on it.
     */
    table.bigInteger("cers_filer_id").notNullable();
    table.bigInteger("cers_ent_id").nullable();

    table.string("name", 300).notNullable();
    table.string("office_title", 200).nullable();
    // CERS `candidateTypeCode`: CN county, CT city, SC school, SD state
    // district, SW statewide. Stored as filed.
    table.string("campaign_type_code", 10).nullable();
    table.string("election_year", 8).nullable();
    table.string("party", 100).nullable();
    table.string("residence_city", 120).nullable();
    table.string("residence_county", 120).nullable();

    /**
     * What we concluded, never what CERS said.
     *
     * NULL means we did not conclude anything, which is the honest answer for
     * most rows. See the header: this is an inference from a residence address
     * and must never be presented as part of the filing.
     */
    table.string("derived_jurisdiction", 120).nullable();

    table.timestamps(true, true);

    table.unique(["source_id", "filer_type", "cers_filer_id"], {
      indexName: "cf_filers_source_filer_unique",
    });
    table.index("cers_ent_id", "idx_cf_filers_ent");
    table.index("election_year", "idx_cf_filers_election_year");
  });

  await knex.raw(`
    ALTER TABLE cf_filers
    ADD CONSTRAINT cf_filers_type_check
    CHECK (filer_type IN ('candidate', 'committee'))
  `);

  await knex.schema.createTable("cf_reports", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("filer_id")
      .notNullable()
      .references("id")
      .inTable("cf_filers")
      .onDelete("CASCADE");

    table.bigInteger("cers_report_id").notNullable();
    // C5, C7, C7E … stored as filed rather than mapped to our own vocabulary.
    table.string("form_type", 20).nullable();
    table.string("report_type", 100).nullable();
    table.string("filing_type", 100).nullable();
    // Filed, Amended, Pending-Amended, Incorporated. A filing's status is a
    // fact about the filing and is published with it, never inferred from it.
    table.string("status", 60).nullable();
    table.date("period_start").nullable();
    table.date("period_end").nullable();

    table.timestamps(true, true);

    table.unique(["filer_id", "cers_report_id"], {
      indexName: "cf_reports_filer_report_unique",
    });
  });

  await knex.schema.createTable("cf_transactions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("report_id")
      .notNullable()
      .references("id")
      .inTable("cf_reports")
      .onDelete("CASCADE");

    /**
     * The bytes this row was read out of. The citation, and it is required.
     *
     * No cascade, on purpose and by precedent (`document_versions`, 034):
     * deleting the evidence under a published figure must fail rather than
     * quietly leave the figure standing with nothing behind it.
     */
    table.uuid("artifact_id").notNullable().references("id").inTable("artifacts");

    // 'contribution' or 'expenditure'. Taken from which schedule was requested,
    // never from the row — a row's own label is display text CERS chose.
    table.string("direction", 20).notNullable();
    // The CERS `listName`: individual, committee, expendOther, expendIndependent.
    table.string("schedule", 40).notNullable();
    /**
     * Position within the schedule as returned.
     *
     * Half of the deduplication key. It is meaningful only together with the
     * artifact, and that is the point: it identifies a line of a specific
     * document, not a fact about the world.
     */
    table.integer("row_index").notNullable();

    table.string("entity_name", 300).nullable();
    table.text("entity_address").nullable();
    table.string("occupation", 200).nullable();
    table.string("employer", 300).nullable();
    // Primary / General. Montana reports the two elections separately.
    table.string("election_type", 40).nullable();

    table.date("transaction_date").nullable();
    // numeric, never float. These are money and they are published.
    table.decimal("cash_amount", 14, 2).nullable();
    table.decimal("in_kind_amount", 14, 2).nullable();
    table.decimal("total_amount", 14, 2).nullable();

    table.text("purpose").nullable();
    table.string("line_item_label", 200).nullable();

    table.timestamps(true, true);

    table.unique(["artifact_id", "row_index"], {
      indexName: "cf_transactions_artifact_row_unique",
    });
    table.index("report_id", "idx_cf_transactions_report");
    table.index("transaction_date", "idx_cf_transactions_date");
    table.index("entity_name", "idx_cf_transactions_entity_name");
  });

  await knex.raw(`
    ALTER TABLE cf_transactions
    ADD CONSTRAINT cf_transactions_direction_check
    CHECK (direction IN ('contribution', 'expenditure'))
  `);

  await knex.raw(`
    ALTER TABLE cf_transactions
    ADD CONSTRAINT cf_transactions_row_index_check
    CHECK (row_index >= 0)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("cf_transactions");
  await knex.schema.dropTableIfExists("cf_reports");
  await knex.schema.dropTableIfExists("cf_filers");
}
