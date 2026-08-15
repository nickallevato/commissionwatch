import type { Knex } from 'knex';

/**
 * Where a decision happened — stage 1, points only.
 *
 * Local government is *about* places. A rezone is a rezone of a parcel, a
 * capital project is a street, a variance is a lot line. Almost every decision
 * this project records has a location and the database held none of them, so
 * the question a resident actually asks — "what is happening near me" — could
 * not be asked at all.
 *
 * ## Why this is `float8` and not `geometry`
 *
 * The design assumed PostGIS. Probed on 2026-08-15 against the deployed image
 * (`pgvector/pgvector:pg16`): `pg_available_extensions` returns **zero** rows
 * matching `postgis%`. Not un-installed — unavailable. `CREATE EXTENSION postgis`
 * therefore fails at *migrate* time, and migrations run automatically on deploy,
 * so a migration written to the original design would have taken production down
 * on the push that introduced it.
 *
 * `cube` and `earthdistance` are present, and they answer the query this feature
 * exists for. Measured against two points a known distance apart:
 *
 *   earth_distance(ll_to_earth(45.6796,-111.0386), ll_to_earth(45.6841,-111.0386))  ->  501 m
 *   earth_distance(ll_to_earth(45.6796,-111.0386), ll_to_earth(45.7246,-111.0386))  -> 5009 m
 *
 * and a GiST index on `ll_to_earth(lat, lon)` builds, so radius search is
 * *indexed* rather than a sequential scan wearing a function call.
 *
 * What that buys is the whole point-and-radius half of the design, including the
 * subscription the geography spec calls the most compelling in the roadmap:
 * "anything within 500 metres of this address", with no account and nothing
 * stored about the subscriber. What it does not buy is polygons — parcel
 * boundaries and district containment need PostGIS, and stage 2 is sequenced
 * *after* the image changes, never with it.
 *
 * ## `precision` is not decoration
 *
 * A geocoded street address and a surveyed parcel centroid are different
 * epistemic objects, and a map that draws them identically is lying at a
 * resolution the reader cannot see. `precision` drives rendering: `exact` is a
 * pin, `block` and `centroid` are deliberately fuzzy, `jurisdiction` renders as
 * a whole-city badge rather than a pin anywhere. **Never draw a point more
 * precisely than the source supports** — the most common way civic maps mislead.
 *
 * `parcel` is absent from the allowed values on purpose. It becomes available in
 * stage 2, when there is a polygon behind it. A reader is never shown a
 * precision we cannot honour.
 *
 * ## This maps decisions, not people
 *
 * Migration 043 dropped `entity_address` from campaign finance on privacy
 * grounds, and 051 did the same federally. That precedent governs here. There is
 * **no foreign key from `places` or `place_links` to `members` or
 * `minute_claims`**, and there is a test that enumerates foreign keys and fails
 * if one appears. A location attaches to an agenda item, a document or a
 * meeting — objects that are already public — never to a person.
 */

export const PLACE_KINDS = [
  'address',
  'street_segment',
  'facility',
  'project_area',
] as const;

/** No `parcel`: that needs a polygon, and polygons are stage 2. */
export const PLACE_PRECISIONS = ['exact', 'block', 'centroid', 'jurisdiction'] as const;

export const PLACE_RELATIONS = ['subject_of', 'located_at', 'affects'] as const;

/**
 * `stated` means the record names the location and the quote proves it.
 * `matched` means an address string resolved against an authoritative dataset.
 * `inferred` means neither — and an inferred link is **never public**. The CHECK
 * below is what makes that a mechanism: anything not inferred must carry a
 * citation.
 */
export const PLACE_CONFIDENCE = ['stated', 'matched', 'inferred'] as const;

export async function up(knex: Knex): Promise<void> {
  // Both are present in the deployed image; IF NOT EXISTS so a re-run and a
  // database that already has them behave identically.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS cube');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS earthdistance');

  await knex.schema.createTable('places', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('jurisdiction_id')
      .notNullable()
      .references('id')
      .inTable('jurisdictions')
      .onDelete('CASCADE');

    table.text('kind').notNullable();
    /** As printed in the record. Never normalised into something nobody wrote. */
    table.text('label').notNullable();

    table.specificType('lat', 'double precision').notNullable();
    table.specificType('lon', 'double precision').notNullable();
    table.text('precision').notNullable();

    /** A county parcel id or city project number, and which dataset it came from. */
    table.text('external_ref').nullable();
    table.text('external_source').nullable();

    /**
     * Which geocoder, and when. A coordinate with no account of where it came
     * from is a claim about a place that cannot be re-checked, and every other
     * assertion in this database carries its provenance.
     */
    table.text('geocoder').nullable();
    table.timestamp('geocoded_at', { useTz: true }).nullable();

    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE places
    ADD CONSTRAINT places_kind_check
    CHECK (kind IN (${PLACE_KINDS.map((k) => `'${k}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE places
    ADD CONSTRAINT places_precision_check
    CHECK (precision IN (${PLACE_PRECISIONS.map((p) => `'${p}'`).join(', ')}))
  `);

  // Real coordinates or no row. A swapped lat/lon is the classic geodata bug and
  // it puts Bozeman in the Indian Ocean; the ranges catch it at write time
  // rather than on a map nobody double-checked.
  await knex.raw(`
    ALTER TABLE places
    ADD CONSTRAINT places_coords_check
    CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180)
  `);

  // The index the whole feature turns on. Without it "within 500 metres" is a
  // sequential scan over every place with a function call per row.
  await knex.raw('CREATE INDEX places_earth ON places USING gist (ll_to_earth(lat, lon))');

  // Re-importing an authoritative dataset must update, not duplicate — the same
  // instinct as `artifacts.sha256`.
  await knex.raw(`
    CREATE UNIQUE INDEX places_external
    ON places (external_source, external_ref)
    WHERE external_ref IS NOT NULL
  `);

  await knex.schema.createTable('place_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');

    /**
     * Polymorphic and deliberately not a foreign key: there is no single table
     * to point at, and the link records that a *document said* something, which
     * must survive the subject's deletion. Same reasoning as
     * `minute_claims.artifact_sha256` and `events.subject_id`.
     *
     * The permitted kinds are the objects that are already public. `member` and
     * `minute_claim` are absent, and their absence is the rule in §"maps
     * decisions, not people" made enforceable.
     */
    table.text('subject_kind').notNullable();
    table.uuid('subject_id').notNullable();

    table.text('relation').notNullable();
    table.text('confidence').notNullable();

    // The citation, on the same terms as every other claim here.
    table.string('artifact_sha256', 64).nullable();
    table.text('quote').nullable();
    table.integer('quote_offset').nullable();

    table.text('status').notNullable().defaultTo('held');
    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_subject_kind_check
    CHECK (subject_kind IN ('agenda_item', 'meeting', 'document', 'finding'))
  `);

  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_relation_check
    CHECK (relation IN (${PLACE_RELATIONS.map((r) => `'${r}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_confidence_check
    CHECK (confidence IN (${PLACE_CONFIDENCE.map((c) => `'${c}'`).join(', ')}))
  `);

  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_status_check
    CHECK (status IN ('held', 'approved', 'rejected'))
  `);

  // Anything that is not an inference must be able to point at the bytes that
  // support it. This is "no unsourced claim reaches the public site" expressed
  // as a constraint rather than as a convention.
  await knex.raw(`
    ALTER TABLE place_links
    ADD CONSTRAINT place_links_citation_check
    CHECK (
      confidence = 'inferred'
      OR (artifact_sha256 ~ '^[0-9a-f]{64}$' AND quote_offset >= 0 AND length(btrim(quote)) > 0)
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX place_links_dedupe
    ON place_links (place_id, subject_kind, subject_id, relation)
  `);

  await knex.raw('CREATE INDEX place_links_subject ON place_links (subject_kind, subject_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('place_links');
  await knex.schema.dropTableIfExists('places');
  // The extensions are deliberately left in place. Dropping them would break any
  // other feature that adopted them, and an unused extension costs nothing.
}
