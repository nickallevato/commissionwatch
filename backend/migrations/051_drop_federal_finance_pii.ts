import type { Knex } from "knex";

/**
 * Removes the three `campaign_contributions` columns that describe a donor as a
 * person rather than describing the contribution.
 *
 *   campaign_contributions.donor_employer     a donor's employer
 *   campaign_contributions.donor_occupation   a donor's occupation
 *   campaign_contributions.donor_city         a donor's city of residence
 *
 * This is migration 043 applied to the other half of the same problem. 043
 * dropped `entity_address`, `occupation`, `employer` and `residence_city` on the
 * MT CERS tables; these three are the federal path's equivalents, declared by
 * migration 050 in the 050–059 block and left standing at the time because
 * dropping them was called the operator's decision. It has been made: we must
 * not ingest PII, and that the FEC publishes employer and occupation because
 * federal law requires a donor to disclose them does not make them ours to keep.
 *
 * ## Why the columns go rather than the writes
 *
 * `donor_employer` and `donor_occupation` were already unwritten — the fields
 * were removed from `ContributionRow` so the compiler would block a writer. That
 * is a good guard and it is not enough. A nullable column with an obvious name
 * is a place to put something, and the next person mapping a new OpenFEC field
 * finds `donor_employer` sitting there and adds one line. Dropping is the only
 * form of the decision a future writer must argue with rather than merely
 * overlook, and after this migration that line does not compile *and* does not
 * have anywhere to land.
 *
 * `donor_city` is different and was worse: it had a live writer.
 * `normalizeContribution` was setting it from `record.contributor_city` on every
 * ingested row. The claim that all three were written NULL was true of two of
 * them. Its writer goes with the column.
 *
 * ## What deliberately stays
 *
 * `donor_name`, `contribution_date` and `amount`, for the reason 043 gives:
 * they are the disclosure, and `vote_donor_conflict` cannot state that a named
 * donor gave a named official money before a vote without all three.
 *
 * `donor_state` stays. A state is not a location of a person in any useful
 * sense — it is the coarse geography that makes "out-of-state money" a
 * sentence — and it is the granularity every campaign-finance summary in the
 * public interest is built on. The line drawn here is the same one 043 drew
 * between `residence_county` and `residence_city`.
 *
 * ## Nothing read them
 *
 * Verified before dropping. `correlation.ts` is the only production SELECT
 * against this table and names its columns explicitly; none of the three is
 * among them. There are no views or materialised views in this project at all.
 * No export, serializer, API route, detector, seed or frontend component
 * references them, and the camelCase spellings appear nowhere. The public path
 * out of this table is `checkVoteDonorConflict` → `anomaly_flags.metadata` →
 * `VoteDonorEvidence`, which carries donor name, recipient, amount, date and
 * source URL and has never carried an employer, an occupation or a city.
 *
 * ## Reversibility
 *
 * `down` restores the three columns with their original types and nullability,
 * so the schema is reversible in shape. It cannot restore the values, which is
 * the correct inverse: the values are the thing being removed. Re-running the
 * ingest after a `down` would not repopulate them either — the normaliser no
 * longer reads any of the three from the OpenFEC response.
 *
 * No index or constraint referenced any of them. `idx_contributions_donor`
 * covers `donor_name`, which is staying.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaign_contributions", (table) => {
    table.dropColumn("donor_employer");
    table.dropColumn("donor_occupation");
    table.dropColumn("donor_city");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaign_contributions", (table) => {
    table.text("donor_employer").nullable();
    table.text("donor_occupation").nullable();
    table.text("donor_city").nullable();
  });
}
