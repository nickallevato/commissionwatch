import type { Knex } from "knex";

/**
 * Removes the four campaign-finance columns that describe a person rather than
 * a transaction.
 *
 *   cf_transactions.entity_address   a donor's street address
 *   cf_transactions.occupation       a donor's occupation
 *   cf_transactions.employer         a donor's employer
 *   cf_filers.residence_city         a candidate's residence city
 *
 * Montana publishes all four as part of the filing, and migration 041 stored
 * them for that reason: provenance is the product, and a schema that disagrees
 * with the source it is loaded from produces rows that are neither what was
 * filed nor what we meant. That argument holds for the *filing* and does not
 * hold for *us*. Being entitled to read a donor's home address is not the same
 * as being right to keep a copy of it in a database this project operates, and
 * the operator's instruction is that we do not: we must not ingest PII.
 *
 * ## Why the columns go rather than the writes
 *
 * Leaving them nullable and simply not writing them would look identical on
 * the day it landed and would decay from there. A nullable column is an
 * invitation with a schema comment attached — the next person to add a field
 * to the CERS line-item parser finds somewhere obvious to put an address, and
 * nothing in the codebase says no. Dropping is the only form of the decision
 * that a future writer has to argue with rather than merely overlook.
 *
 * ## What deliberately stays
 *
 * `entity_name`, `transaction_date`, `cash_amount`, `in_kind_amount` and
 * `total_amount`. They are the disclosure. `vote_donor_conflict` exists to say
 * "this donor gave this much on this date, and their filed name matches text in
 * an item this official voted on", and it cannot say anything at all without
 * the name, the amount and the date. Removing those would not be a privacy
 * measure, it would be the end of the feature. `residence_county` also stays:
 * a county is the jurisdiction a candidacy is filed in, not a location of a
 * person, and it is on the filer rather than on a donor.
 *
 * ## Reversibility
 *
 * `down` restores the four columns with their original types and nullability,
 * so the schema is reversible in shape. It cannot restore the values, and that
 * is the correct inverse: the data is what we are removing. Re-running the
 * adapter after a `down` would not repopulate them either — the parser no
 * longer reads them from the CERS response at all.
 *
 * No index or constraint referenced any of the four, so nothing else has to be
 * rebuilt. `idx_cf_transactions_entity_name` covers the donor *name*, which is
 * staying.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("cf_transactions", (table) => {
    table.dropColumn("entity_address");
    table.dropColumn("occupation");
    table.dropColumn("employer");
  });

  await knex.schema.alterTable("cf_filers", (table) => {
    table.dropColumn("residence_city");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("cf_transactions", (table) => {
    table.text("entity_address").nullable();
    table.string("occupation", 200).nullable();
    table.string("employer", 300).nullable();
  });

  await knex.schema.alterTable("cf_filers", (table) => {
    table.string("residence_city", 120).nullable();
  });
}
