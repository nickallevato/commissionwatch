import type { Knex } from 'knex';

/**
 * `members` learns where a row came from.
 *
 * Until this migration a row reading "Emma Bode, Commissioner" was
 * indistinguishable from a row somebody typed. That is not a cosmetic gap:
 * `verify.ts` rejects an extracted claim as `not-an-official` unless `members`
 * holds the name, so an unsourced roster is simultaneously the thing that
 * throws away true claims and the thing nobody can audit. `rosterCoverage`
 * could only ever report `unsourced`, and `/api/metrics` publishes
 * `roster_sourced: false` because of this table.
 *
 * Three columns, all nullable, and **nothing is backfilled**. Every existing
 * row is genuinely unsourced; writing a plausible URL onto it would manufacture
 * exactly the provenance this project exists to refuse to manufacture. The
 * honest state of the table after this migration is: same rows, now able to
 * say they cannot prove anything.
 *
 *  - `source_url`      the address the roster was read from;
 *  - `fetched_at`      when those bytes were read;
 *  - `artifact_sha256` the sha256 of the exact bytes, so a reader can check
 *                      the row against the document rather than against us.
 *
 * **The CHECK is all-or-nothing.** A row carrying a URL and no hash is worse
 * than a row carrying nothing: it looks sourced in every listing and proves
 * nothing, and `seats_traceable` would count it. Partial provenance is not a
 * lesser form of provenance, it is the appearance of it.
 *
 * Both disjuncts are wrapped in `coalesce(..., false)`. A CHECK that evaluates
 * to NULL is satisfied, and this constraint is entirely about nullable columns
 * — `migrations-selfcontained.test.ts` holds the whole class.
 */

const PROVENANCE_CHECK = `
  coalesce(
    source_url IS NULL AND fetched_at IS NULL AND artifact_sha256 IS NULL,
    false
  )
  OR coalesce(
    length(btrim(source_url)) > 0
    AND fetched_at IS NOT NULL
    AND artifact_sha256 ~ '^[0-9a-f]{64}$',
    false
  )
`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('members', (table) => {
    table.text('source_url');
    table.timestamp('fetched_at', { useTz: true });
    table.text('artifact_sha256');
  });

  await knex.raw(`
    ALTER TABLE members
    ADD CONSTRAINT members_provenance_check
    CHECK (${PROVENANCE_CHECK})
  `);

  // The count `rosterCoverage` reports per body: sourced seats within a
  // jurisdiction that can prove where they came from. Partial because the rows
  // with no provenance are the majority today and are never the working set of
  // this query.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_members_traceable
    ON members (jurisdiction_id)
    WHERE artifact_sha256 IS NOT NULL
  `);
}

/**
 * Rolling back drops the provenance rather than hiding it. That is a real loss
 * of evidence — which is the honest consequence, and the reason nothing here
 * tries to stash the values somewhere first.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_members_traceable');
  await knex.raw('ALTER TABLE members DROP CONSTRAINT IF EXISTS members_provenance_check');
  await knex.schema.alterTable('members', (table) => {
    table.dropColumn('source_url');
    table.dropColumn('fetched_at');
    table.dropColumn('artifact_sha256');
  });
}
