import type { Knex } from 'knex';

/**
 * P6 · The two kinds full-text search missed.
 *
 * Migration 035 indexed agenda items, meetings, members and document text.
 * Findings and matters were not searchable at all, which meant the Findings
 * page had no search box and the only way to reach a matter was to scroll the
 * list — for the object a reader is most likely to arrive already knowing the
 * name of. "What is happening with Ordinance 2145" is the whole use case.
 *
 * Same shape as 035, deliberately: a `GENERATED ALWAYS ... STORED` tsvector
 * beside the row it describes, one GIN index each, and every `to_tsvector`
 * call naming `'english'` explicitly. The one-argument form reads
 * `default_text_search_config`, which makes it STABLE rather than IMMUTABLE and
 * Postgres refuses it in a generated column — the index would otherwise depend
 * on a session setting.
 *
 * Neither vector encodes anything about publication. The wall is a rule about
 * what a reader may see, not about what may be indexed, and it is enforced in
 * `services/search.ts` through the same helpers the rest of the API uses —
 * `whereFindingPublic` for findings, `publishedAppearances` for matters.
 * Baking it into the index instead would put a third copy of a predicate that
 * already has two correct ones.
 */
export async function up(knex: Knex): Promise<void> {
  /**
   * Findings. `description` is the whole of the index because it is the whole
   * of the free text: migration 011 gives this table a `flag_type` enum, a
   * `severity` enum, a JSONB blob and that one sentence.
   *
   * The enums are not indexed, for two reasons that both had to be checked
   * rather than assumed. `flag_type::text` in a generated column is rejected
   * outright — an enum's output function is not IMMUTABLE, so the cast is not
   * either, and Postgres answers `generation expression is not immutable`.
   * And `severity` would be actively harmful if it were possible: its values
   * are `low`, `medium`, `high` and `critical`, ordinary English words that
   * would make every finding a hit for a reader who typed "high water". A
   * caller who wants a flag type or a severity has `GET /api/anomalies`, which
   * filters on both as the enums they are.
   *
   * So `description` takes `A` rather than 035's `B`. There is nothing here for
   * it to outrank, and it is what heads the result: the API returns the flag
   * row and the page prints that sentence as the finding's headline.
   */
  await knex.raw(`
    ALTER TABLE anomaly_flags
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(description, '')), 'A')
    ) STORED
  `);
  await knex.raw(
    'CREATE INDEX idx_anomaly_flags_search_vector ON anomaly_flags USING GIN (search_vector)',
  );

  /**
   * Matters. The designator takes `A` and the title `B`, which inverts nothing
   * — a designator *is* the title of a matter in the only sense a reader uses.
   * Someone searching for a subject of decision types "Ordinance 2145", not a
   * phrase from its wording, and `ts_rank_cd`'s default {0.1, 0.2, 0.4, 1.0}
   * puts that above a matter that merely mentions it.
   *
   * The designator is usually also inside `title` — migration 081 stores the
   * earliest published wording verbatim, and that wording generally leads with
   * the number. Indexing both is what makes the designator match count twice,
   * which is the intent, not a duplication to be optimised away.
   *
   * `identity_key` is deliberately absent. It is `d:ordinance 2145` or
   * `t:zoning map amendment for north seventh` — a normalised key, not display
   * text, and its rule prefix would put lexemes in the index that appear in no
   * document a reader has ever seen.
   */
  await knex.raw(`
    ALTER TABLE matters
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(designator, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(title, '')), 'B')
    ) STORED
  `);
  await knex.raw('CREATE INDEX idx_matters_search_vector ON matters USING GIN (search_vector)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_matters_search_vector');
  await knex.raw('DROP INDEX IF EXISTS idx_anomaly_flags_search_vector');
  await knex.schema.alterTable('matters', (table) => table.dropColumn('search_vector'));
  await knex.schema.alterTable('anomaly_flags', (table) => table.dropColumn('search_vector'));
}
