import type { Knex } from "knex";

/**
 * P6 · Full-text search over the record.
 *
 * The honest replacement for the withdrawn embedding work (archive-salvage
 * spec § A3): the want was *find me everything about this*, and PostgreSQL
 * answers it with no vendor, no API key, no per-call cost and no dimension
 * decision. Nothing here touches `document_embeddings`.
 *
 * Four vectors, four GIN indexes, one new table.
 *
 * **Every `to_tsvector` call names `'english'` explicitly.** The one-argument
 * form reads `default_text_search_config`, which makes it STABLE rather than
 * IMMUTABLE, and Postgres refuses it in a generated column. The failure is at
 * migration time, but the reason is worth stating: the index would otherwise
 * depend on a session setting.
 *
 * **Weighting is A title, B description, C body**, so a title match outranks a
 * passing mention under `ts_rank_cd`'s default {0.1, 0.2, 0.4, 1.0}.
 */
export async function up(knex: Knex): Promise<void> {
  /**
   * Agenda items — the substance of the record, and the only place most terms
   * appear at all.
   */
  await knex.raw(`
    ALTER TABLE agenda_items
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED
  `);
  await knex.raw(
    "CREATE INDEX idx_agenda_items_search_vector ON agenda_items USING GIN (search_vector)",
  );

  /**
   * Meetings carry no title.
   *
   * Migration 003 gives this table a `DATE`, a nullable `TIME`, a `location`
   * and two URLs. `location` is its only free text, and a venue is not a
   * title — so it takes `B` and nothing in `meetings` earns `A`.
   *
   * The name a reader would call the sitting is `commissions.name`, one table
   * away, and a `GENERATED ALWAYS` column may not reference another table.
   * Copying that name onto every meeting to make one index possible would put
   * a second copy of a fact in the database for the convenience of a query,
   * and it would go stale the first time a body is renamed. A meeting is
   * already reachable through its agenda items, which are indexed here, and
   * through the venue it was held at.
   */
  await knex.raw(`
    ALTER TABLE meetings
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(location, '')), 'B')
    ) STORED
  `);
  await knex.raw("CREATE INDEX idx_meetings_search_vector ON meetings USING GIN (search_vector)");

  /**
   * Members. `name` is the title here in every sense that matters, and
   * `members.title` — "Commissioner", "Chair" — is the qualifier.
   *
   * Deliberately outside the publication wall, because `GET /api/members`
   * already lists every member to anyone. Search must not be more permissive
   * than the rest of the API; making it *less* permissive than a route that
   * already exists would be a different, invented rule.
   */
  await knex.raw(`
    ALTER TABLE members
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(title, '')), 'B')
    ) STORED
  `);
  await knex.raw("CREATE INDEX idx_members_search_vector ON members USING GIN (search_vector)");

  /**
   * The extracted text of an artifact, which nothing held until now.
   *
   * `extractDocumentText` has run in the parse stage since P1 and its output
   * was discarded the moment agenda items were read out of it. There was
   * therefore no column to index and no way to search the body of a document
   * for a term its agenda item's title never mentions — which is most terms.
   *
   * The text and its vector live in the same row on purpose: a vector on
   * `artifacts` fed from a text column in another table could not be
   * `GENERATED ALWAYS`. One row per artifact, so a re-parse replaces rather
   * than accumulates.
   *
   * `ON DELETE CASCADE`, unlike `document_versions.artifact_id`, which
   * deliberately has none. A version row is evidence behind a citation and
   * must fail loudly if its artifact goes. Extracted text is derived — it can
   * be produced again from the stored bytes — and an orphan would be a
   * searchable body with nothing behind it.
   */
  await knex.schema.createTable("artifact_texts", (table) => {
    table.uuid("artifact_id").primary().references("id").inTable("artifacts").onDelete("CASCADE");
    table.text("text").notNullable();
    // What was extracted, in characters. A document that yields 40 characters
    // parsed badly even though nothing threw, and that is visible here.
    table.integer("char_count").notNullable();
    table.timestamp("extracted_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamps(true, true);
  });

  await knex.raw(`
    ALTER TABLE artifact_texts
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(text, '')), 'C')
    ) STORED
  `);
  await knex.raw(
    "CREATE INDEX idx_artifact_texts_search_vector ON artifact_texts USING GIN (search_vector)",
  );

  await knex.raw(`
    ALTER TABLE artifact_texts
    ADD CONSTRAINT artifact_texts_char_count_check
    CHECK (char_count >= 0)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("artifact_texts");
  await knex.raw("DROP INDEX IF EXISTS idx_members_search_vector");
  await knex.raw("DROP INDEX IF EXISTS idx_meetings_search_vector");
  await knex.raw("DROP INDEX IF EXISTS idx_agenda_items_search_vector");
  await knex.schema.alterTable("members", (table) => table.dropColumn("search_vector"));
  await knex.schema.alterTable("meetings", (table) => table.dropColumn("search_vector"));
  await knex.schema.alterTable("agenda_items", (table) => table.dropColumn("search_vector"));
}
