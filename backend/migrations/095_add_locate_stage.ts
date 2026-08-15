import type { Knex } from 'knex';

/**
 * `locate` becomes a queue stage.
 *
 * Migration 094 created `places` and `place_links` and nothing wrote to either
 * of them. The map, `/api/places/near` and `feed.xml?near=` were a working
 * feature over an empty table, which means the subscription the geography spec
 * calls the most compelling in the roadmap — "anything within 500 metres of this
 * address" — returned nothing, forever, and would have gone on doing so
 * silently.
 *
 * The work is a stage rather than a loop in a route for the reason migration 084
 * states about `extract`: an unawaited promise owns no row, so a deploy mid-run
 * loses the work and leaves nothing behind that says so. It also calls a public
 * geocoder we are a guest on, and a queue is where concurrency and backoff
 * against a rate-limited third party already live.
 *
 * It sits after `parse`, because it reads the agenda items `parse` wrote and
 * cites the artifact `parse` indexed. It obeys the post-`fetch` invariant the
 * queue's header states: its target carries a content address and no URL. Its
 * one outbound call is to the US Census geocoder, which is a *source for the
 * coordinate* and is recorded as such on `places.geocoder` and
 * `places.geocoded_at` — never an anonymous pin.
 *
 * `transaction: false` because Postgres refuses to use an enum value added in
 * the same transaction that added it. Nothing here uses it, but a migration that
 * only works because of statement ordering inside a transaction is a trap for
 * whoever edits it next. Same reasoning, verbatim, as 084.
 *
 * ## And a repair to `place_links_citation_check`
 *
 * Migration 094 wrote the rule "anything that is not an inference must be able
 * to point at the bytes that support it" as:
 *
 *     CHECK (confidence = 'inferred'
 *            OR (artifact_sha256 ~ '...' AND quote_offset >= 0
 *                AND length(btrim(quote)) > 0))
 *
 * **It does not enforce that.** With the three citation columns NULL — which is
 * how they arrive, since all three are nullable — the second disjunct evaluates
 * to NULL, `FALSE OR NULL` is NULL, and a CHECK constraint *passes* on NULL. So
 * a `stated` link with no artifact, no quote and no offset inserts cleanly.
 * Measured on the deployed schema, not reasoned about:
 *
 *     select ('stated' = 'inferred' OR (null::text ~ '^[0-9a-f]{64}$'
 *             AND null::int >= 0 AND length(btrim(null::text)) > 0));   -- NULL
 *
 * That is the project's "no unsourced claim reaches the public site" rule, and
 * it was the CHECK's whole job. The three-valued-logic hole is the classic way a
 * constraint looks right and holds nothing, and it was invisible because until
 * now nothing wrote to the table at all.
 *
 * Repaired forward rather than by editing 094: that migration has run on the
 * deployment, and a migration whose text no longer matches what it did is worse
 * than a second one that says what changed. `coalesce(..., false)` is the fix
 * and it is deliberately explicit — the intent is "unknown is not good enough",
 * and the constraint should read that way to whoever meets it next.
 */

export const config = { transaction: false };

/** The predicate as 094 meant it, with the NULL hole closed. */
const CITATION_CHECK = `
  confidence = 'inferred'
  OR coalesce(
       artifact_sha256 ~ '^[0-9a-f]{64}$'
       AND quote_offset >= 0
       AND length(btrim(quote)) > 0,
       false
     )
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TYPE ingestion_job_stage ADD VALUE IF NOT EXISTS 'locate'`);

  await knex.raw(`ALTER TABLE place_links DROP CONSTRAINT IF EXISTS place_links_citation_check`);
  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_citation_check
    CHECK (${CITATION_CHECK})
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Postgres cannot remove a value from an enum, and rewriting the type would
  // mean rewriting every ingestion_jobs row to drop a stage nobody used. The
  // rollback path that works is migration 018's, which drops the type outright.
  //
  // The constraint is restored to 094's text — including its NULL hole. A
  // rollback that left a *stricter* rule in place than the migration it rolled
  // back to would be a different schema wearing an old version number.
  await knex.raw(`ALTER TABLE place_links DROP CONSTRAINT IF EXISTS place_links_citation_check`);
  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_citation_check
    CHECK (
      confidence = 'inferred'
      OR (artifact_sha256 ~ '^[0-9a-f]{64}$' AND quote_offset >= 0 AND length(btrim(quote)) > 0)
    )
  `);
}
