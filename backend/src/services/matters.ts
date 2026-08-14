import type { Knex } from "knex";
import { whereMeetingPublished } from "./publication";

/**
 * Matters — what happened to the thing that was on the agenda.
 *
 * A matter is a durable identity for a subject of decision: a rezone, an
 * ordinance, a capital project. `agenda_items` records appearances; this file
 * records the subject those appearances are about, so "it was tabled in March
 * and never came back" is a question the database can answer.
 *
 * Three rules govern this file.
 *
 * **Identity is deterministic, never fuzzy.** Two ways to identify a matter and
 * no third: a designator parsed out of the title by an explicit regex, or the
 * title normalised and matched exactly. There is no Levenshtein, no trigram
 * similarity and no embedding here, and none may be added. A near-match is an
 * *inference*, and an inference that silently merges two neighbours' rezones is
 * a published claim nobody can source. Two rows that are really one matter but
 * were titled differently stay two rows; that is the correct failure, and it is
 * visible, which the alternative is not.
 *
 * **State is derived at read time.** Migration 038's reasoning, applied again: a
 * terminal status written by a clock reads, in the log, exactly like a decision
 * a person made. So there is no `state` column. `stateExpression` computes it in
 * SQL from the published record on every read, which cannot go stale and cannot
 * disagree with the rows it was computed from.
 *
 * **Only the published record is visible, and only through the shared helper.**
 * Every query below reaches the wall through `whereMeetingPublished`, never a
 * re-typed `published_at IS NOT NULL`. A matter is a *rollup*, which makes it
 * the most dangerous surface in the product for that wall: an unpublished
 * meeting leaks through a count, a `last_seen` date or an appearance row just as
 * completely as through a document. So the aggregates are computed over
 * published appearances only, and a matter whose every appearance is unpublished
 * does not exist as far as this module is concerned.
 */

/* ---------------------------------------------------------------------------
   Identity
   --------------------------------------------------------------------------- */

export type MatchRule = "designator" | "normalized_title";

export interface Designator {
  /** The identity, normalised: kind and number, lowercased. */
  key: string;
  /** The same thing as it should be printed. */
  label: string;
}

/**
 * The designator kinds this project will parse, and nothing else.
 *
 * Each pattern is anchored on the word a clerk actually writes, requires a
 * number to follow it, and captures only that number. The kind is part of the
 * identity because "Ordinance 24-11" and "Resolution 24-11" are two different
 * things that share a number — dropping the kind would merge them.
 *
 * The abbreviations are the ones that appear in these agendas ("Ord.", "Res.").
 * They are safe because a number is required immediately after: "Residential
 * rezone" matches `res` and then fails, because no digits follow.
 */
const DESIGNATOR_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "ordinance", pattern: /\bord(?:inance)?s?\.?\s*(?:no\.?|number)?\s*(\d{2,5}(?:-\d{1,5})?)\b/i },
  { kind: "resolution", pattern: /\bres(?:olution)?s?\.?\s*(?:no\.?|number)?\s*(\d{2,5}(?:-\d{1,5})?)\b/i },
  {
    kind: "application",
    pattern: /\bapplication\s*(?:no\.?|number)?\s*([a-z]{1,3}-?\d{2,4}-\d{1,5}|\d{2,6}-[a-z]{1,4})\b/i,
  },
  {
    kind: "project",
    pattern: /\bproject\s*(?:no\.?|number)?\s*([a-z]{1,4}-\d{2,4}(?:-\d{1,5})?|\d{4,6})\b/i,
  },
];

/**
 * The designator in a title, or `null`.
 *
 * When a title carries more than one — "Ordinance 2145 amending Resolution
 * 24-11" — the leftmost wins, because the subject of an agenda item is what its
 * title leads with and the rest is context. Ties break on the order above, so
 * the answer is the same on every run; a rebuild that could reorder its own
 * matters is not idempotent in any useful sense.
 */
export function parseDesignator(title: string): Designator | null {
  let best: { index: number; kind: string; number: string } | null = null;

  for (const { kind, pattern } of DESIGNATOR_PATTERNS) {
    const match = pattern.exec(title);
    if (match === null) continue;
    if (best === null || match.index < best.index) {
      best = { index: match.index, kind, number: match[1] };
    }
  }

  if (best === null) return null;
  const number = best.number.toLowerCase();
  return {
    key: `${best.kind} ${number}`,
    label: `${best.kind.charAt(0).toUpperCase()}${best.kind.slice(1)} ${best.number.toUpperCase()}`,
  };
}

/** Leading agenda numbering: `4.`, `A.`, `3)`, `4.2 -`, `Item 7 —`. */
const LEADING_NUMBERING = /^\s*(?:item\s*)?(?:[a-z]|\d+(?:\.\d+)*)\s*[.):\-—–]\s*/i;

/**
 * A title reduced to the string that identifies it.
 *
 * Lowercased, leading item numbering removed, punctuation replaced by spaces
 * and whitespace collapsed. Nothing is stemmed, no words are dropped and no
 * synonyms are applied — every one of those would be a judgement about what two
 * titles mean rather than what they say. After this, matching is exact.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(LEADING_NUMBERING, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface Identity {
  key: string;
  rule: MatchRule;
  designator: string | null;
}

/**
 * The identity of an agenda item, or `null` when it has none.
 *
 * The key is rule-prefixed so a designator key and a title key cannot collide on
 * the same string by accident. `null` means the title normalised to nothing —
 * an item titled `"—"` identifies no subject, and giving every such item the
 * same empty key would collapse them all into one matter.
 */
export function identify(title: string): Identity | null {
  const designator = parseDesignator(title);
  if (designator !== null) {
    return { key: `d:${designator.key}`, rule: "designator", designator: designator.label };
  }
  const normalized = normalizeTitle(title);
  if (normalized.length === 0) return null;
  return { key: `t:${normalized}`, rule: "normalized_title", designator: null };
}

/* ---------------------------------------------------------------------------
   State, derived
   --------------------------------------------------------------------------- */

export type MatterState = "pending" | "decided" | "withdrawn" | "dormant";

export const MATTER_STATES: readonly MatterState[] = [
  "pending",
  "decided",
  "withdrawn",
  "dormant",
];

export function isMatterState(value: unknown): value is MatterState {
  return typeof value === "string" && (MATTER_STATES as readonly string[]).includes(value);
}

/**
 * How long a matter may go unmentioned before it is reported as dormant.
 *
 * Six months. This is a reporting threshold, not a legal one — nothing in
 * Montana law makes an agenda item lapse — and it is here rather than in the
 * query so that the number has one home and can be quoted on the page beside
 * the word it produces. These bodies re-notice a continued item within weeks, so
 * half a year of silence is the point at which "it will be back" stops being a
 * description of the record and starts being a hope.
 *
 * A dormant matter is *not* a finding about anyone. It says the record shows no
 * further appearance, which is exactly as far as the record goes.
 */
export const DORMANT_AFTER_DAYS = 180;

/**
 * `withdrawn` is in the type and is deliberately **not derived**.
 *
 * Nothing in the schema records a withdrawal: `agenda_items` has a title, a
 * description and a category, and `votes` records how each member voted with no
 * aggregate outcome column anywhere. The only support the data offers is the
 * clerk having written the word down.
 *
 * Matching that word was implemented and then removed, because it produces a
 * reader-facing label that can be flatly wrong on ordinary titles:
 *
 *     "Appeal of withdrawn permit for 1234 Main St"
 *     "Ordinance 2145, replacing withdrawn Ordinance 2101"
 *
 * Both contain the past participle on a word boundary and neither describes a
 * withdrawn matter. Narrowing the pattern does not fix the class — the word is
 * doing different grammatical work in each case, and deciding which is which is
 * exactly the near-match this project refuses to publish. A keyword hit on free
 * text presented as a state is an inference wearing a fact's clothes.
 *
 * So a matter the clerk described as withdrawn reads `pending`, which is what
 * we actually know. The sourced home for this is `vote_events.result` in the
 * corpus-throughput design, where a withdrawal is extracted with a quote, an
 * offset and an operator's approval behind it. When that lands, this becomes a
 * lookup rather than a regex, and the union member is already here waiting.
 */

/**
 * The state, as SQL, over a `latest` row and the `votes` table.
 *
 * Three branches, not four. `withdrawn` is a member of the type and is never
 * produced here — see the note above it for why a regex over free text was
 * built and then taken out.
 *
 * "A recorded vote with a result" is, in this schema, the existence of `votes`
 * rows against that agenda item. Migration 010 stores one row per member with a
 * `vote_value`; there is no motion-level outcome column, so the recorded votes
 * *are* the result and their presence is the whole of the evidence.
 *
 * Takes one binding: the dormancy threshold in days.
 */
export const STATE_EXPRESSION = `
  case
    when exists (
      select 1 from votes v where v.agenda_item_id = latest.agenda_item_id
    ) then 'decided'
    when latest.meeting_date < current_date - make_interval(days => ?::int)
      then 'dormant'
    else 'pending'
  end
`;

/* ---------------------------------------------------------------------------
   Reading
   --------------------------------------------------------------------------- */

export interface Matter {
  id: string;
  title: string;
  designator: string | null;
  state: MatterState;
  first_seen: string;
  last_seen: string;
  appearance_count: number;
  jurisdiction_name: string;
  commission_name: string;
}

export interface Appearance {
  agenda_item_id: string;
  meeting_id: string;
  meeting_date: string;
  item_number: number;
  title: string;
  match_rule: MatchRule;
}

export interface MatterDetail extends Matter {
  appearances: Appearance[];
}

export interface MatterListResponse {
  data: Matter[];
  total: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Every appearance on a published meeting, and nothing else.
 *
 * The single point at which this module touches the publication wall. Both the
 * aggregate and the timeline are built on top of it, so there is one predicate
 * to get right rather than four — and it is the shared helper, given the
 * qualified column the joined query needs, not a retyped `whereNotNull`.
 */
function publishedAppearances(db: Knex): Knex.QueryBuilder {
  return whereMeetingPublished(
    db("matter_appearances as ma")
      .join("agenda_items as ai", "ai.id", "ma.agenda_item_id")
      .join("meetings as m", "m.id", "ai.meeting_id"),
    "m.published_at",
  );
}

/** First seen, last seen and the count — published appearances only. */
function aggregateSubquery(db: Knex): Knex.QueryBuilder {
  return publishedAppearances(db)
    .select("ma.matter_id as matter_id")
    .min({ first_seen: "m.date" })
    .max({ last_seen: "m.date" })
    .count({ appearance_count: "ma.id" })
    .groupBy("ma.matter_id");
}

/**
 * The most recent published appearance of each matter, which is what every
 * state derivation reads. `distinct on` with a total ordering: without the id
 * tiebreak, two items on one meeting's agenda would make the answer depend on
 * the planner.
 */
function latestSubquery(db: Knex): Knex.QueryBuilder {
  return publishedAppearances(db)
    .distinctOn("ma.matter_id")
    .select(
      "ma.matter_id as matter_id",
      "ai.id as agenda_item_id",
      "ai.title as title",
      "ai.description as description",
      "m.date as meeting_date",
    )
    .orderBy([
      { column: "ma.matter_id" },
      { column: "m.date", order: "desc" },
      { column: "ai.id" },
    ]);
}

/**
 * Matters with at least one published appearance, joined to everything a row
 * needs.
 *
 * The join to `agg` is inner, which is what enforces the wall for the list: a
 * matter every one of whose appearances is unpublished contributes no aggregate
 * row and therefore no result — including no contribution to `total`, because a
 * count that includes rows the caller cannot reach is a leak dressed as a
 * number.
 */
function baseQuery(db: Knex): Knex.QueryBuilder {
  return db("matters as mt")
    .join("commissions as c", "c.id", "mt.commission_id")
    .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
    .join(aggregateSubquery(db).as("agg"), "agg.matter_id", "mt.id")
    .join(latestSubquery(db).as("latest"), "latest.matter_id", "mt.id");
}

function selectMatter(db: Knex, query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query.select(
    "mt.id as id",
    "mt.title as title",
    "mt.designator as designator",
    "j.name as jurisdiction_name",
    "c.name as commission_name",
    // `to_char`, not the driver's date handling: `date` comes back as a
    // JavaScript Date, and serialising that to JSON applies UTC, which moves a
    // Montana evening meeting to the next day for anyone reading it.
    db.raw("to_char(agg.first_seen, 'YYYY-MM-DD') as first_seen"),
    db.raw("to_char(agg.last_seen, 'YYYY-MM-DD') as last_seen"),
    db.raw("agg.appearance_count::int as appearance_count"),
    db.raw(`(${STATE_EXPRESSION}) as state`, [DORMANT_AFTER_DAYS]),
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMatter(row: Record<string, unknown>): Matter {
  const state = row.state;
  return {
    id: text(row.id),
    title: text(row.title),
    designator: typeof row.designator === "string" ? row.designator : null,
    // Narrowed rather than asserted. The CASE can only produce these four, and
    // saying so in code is what makes the type honest.
    state: isMatterState(state) ? state : "pending",
    first_seen: text(row.first_seen),
    last_seen: text(row.last_seen),
    appearance_count: num(row.appearance_count),
    jurisdiction_name: text(row.jurisdiction_name),
    commission_name: text(row.commission_name),
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

export interface ListOptions {
  jurisdictionId?: string;
  state?: MatterState;
  limit?: number;
  offset?: number;
}

/**
 * The list.
 *
 * `state` is filtered by repeating the same expression in the WHERE clause —
 * SQL cannot see a select alias there — which is why the expression is one
 * exported constant. Two copies of that CASE would be two definitions of what
 * "dormant" means, and the one that disagreed would be believed at random.
 */
export async function listMatters(db: Knex, options: ListOptions = {}): Promise<MatterListResponse> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const filtered = (query: Knex.QueryBuilder): Knex.QueryBuilder => {
    if (options.jurisdictionId) query.where("j.id", options.jurisdictionId);
    if (options.state) {
      query.whereRaw(`(${STATE_EXPRESSION}) = ?`, [DORMANT_AFTER_DAYS, options.state]);
    }
    return query;
  };

  const countRow: unknown = await filtered(baseQuery(db)).count({ total: "mt.id" }).first();
  const total =
    typeof countRow === "object" && countRow !== null
      ? num((countRow as { total?: unknown }).total)
      : 0;

  // Newest activity first — a reader scanning this list is looking for what is
  // live. The id tiebreak gives a total order, without which two matters last
  // seen on the same date can swap between pages and a reader sees one twice
  // and the other never.
  const rows: unknown = await selectMatter(db, filtered(baseQuery(db)))
    .orderBy([
      { column: "agg.last_seen", order: "desc" },
      { column: "mt.id", order: "asc" },
    ])
    .limit(limit)
    .offset(offset);

  return { data: rowsOf(rows).map(toMatter), total };
}

/** The timeline, ascending: a timeline reads forwards. */
export async function loadAppearances(db: Knex, matterId: string): Promise<Appearance[]> {
  const rows: unknown = await publishedAppearances(db)
    .where("ma.matter_id", matterId)
    .select(
      "ma.agenda_item_id as agenda_item_id",
      "ma.match_rule as match_rule",
      "m.id as meeting_id",
      "ai.item_number as item_number",
      // The title as printed at *that* meeting. It may differ from the matter's,
      // and where it differs that difference is the record — an item re-noticed
      // under different wording is precisely what a reader came here to see.
      "ai.title as title",
      db.raw("to_char(m.date, 'YYYY-MM-DD') as meeting_date"),
    )
    .orderBy([
      { column: "m.date", order: "asc" },
      { column: "ai.item_number", order: "asc" },
      { column: "ai.id", order: "asc" },
    ]);

  return rowsOf(rows).map((row) => ({
    agenda_item_id: text(row.agenda_item_id),
    meeting_id: text(row.meeting_id),
    meeting_date: text(row.meeting_date),
    item_number: num(row.item_number),
    title: text(row.title),
    match_rule: row.match_rule === "designator" ? "designator" : "normalized_title",
  }));
}

/**
 * One matter, or `undefined`.
 *
 * `undefined` covers both "no such matter" and "every appearance it has is on
 * an unpublished meeting", and the route turns both into the same 404 — the
 * reason `findPublishedMeeting` gives. Distinguishing them would let an
 * anonymous caller enumerate what has been ingested and withheld, and a matter
 * is a *subject*, so confirming one exists discloses that this body is
 * considering it before the operator has published anything that says so.
 */
export async function findMatter(db: Knex, id: string): Promise<MatterDetail | undefined> {
  const row: unknown = await selectMatter(db, baseQuery(db).where("mt.id", id)).first();
  if (typeof row !== "object" || row === null) return undefined;

  const matter = toMatter(row as Record<string, unknown>);
  const appearances = await loadAppearances(db, id);
  return { ...matter, appearances };
}

/* ---------------------------------------------------------------------------
   Rebuilding
   --------------------------------------------------------------------------- */

export interface RebuildSummary {
  matters: number;
  appearances: number;
}

interface ItemRow {
  id: string;
  title: string;
  commission_id: string;
}

interface Group {
  commissionId: string;
  key: string;
  rule: MatchRule;
  designator: string | null;
  title: string;
  itemIds: string[];
}

/** Postgres caps a statement's bind parameters; these go in at a few per row. */
const CHUNK = 500;

function chunk<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Rebuilds every matter and every link from `agenda_items`.
 *
 * Matters are a projection, not a record. Nothing else writes these two tables,
 * so this function is the whole of their provenance and running it twice must
 * leave the database identical — which is what the unique keys buy: identity is
 * the content, so an insert either creates the row or finds the one that already
 * says the same thing.
 *
 * The scan is ordered oldest first so `matters.title` is the *earliest*
 * published wording, deterministically, however many times this runs and in
 * whatever order the items were ingested.
 *
 * It reads unpublished meetings on purpose. The wall is a rule about what a
 * reader may see, not about what may be computed: an operator publishing a
 * meeting must make its matters correct immediately, not after the next
 * rebuild. Every read path filters, so nothing unpublished escapes.
 *
 * Deliberately not wired to the ingestion queue or a scheduler. A caller decides
 * when this runs.
 */
export async function rebuildMatters(db: Knex): Promise<RebuildSummary> {
  const items: unknown = await db("agenda_items as ai")
    .join("meetings as m", "m.id", "ai.meeting_id")
    .select("ai.id as id", "ai.title as title", "m.commission_id as commission_id")
    .orderBy([
      { column: "m.date", order: "asc" },
      { column: "ai.item_number", order: "asc" },
      { column: "ai.id", order: "asc" },
    ]);

  const groups = new Map<string, Group>();
  for (const raw of rowsOf(items)) {
    const row: ItemRow = {
      id: text(raw.id),
      title: text(raw.title),
      commission_id: text(raw.commission_id),
    };
    const identity = identify(row.title);
    // An item whose title normalises to nothing identifies no subject. It is
    // left unlinked rather than filed under an empty key that would swallow
    // every other such item in the jurisdiction.
    if (identity === null) continue;

    const groupKey = `${row.commission_id} ${identity.key}`;
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, {
        commissionId: row.commission_id,
        key: identity.key,
        rule: identity.rule,
        designator: identity.designator,
        // First in the ordered scan, so: as first seen in the record.
        title: row.title,
        itemIds: [row.id],
      });
    } else {
      existing.itemIds.push(row.id);
    }
  }

  return db.transaction(async (trx) => {
    const matterRows = [...groups.values()].map((group) => ({
      commission_id: group.commissionId,
      identity_key: group.key,
      designator: group.designator,
      title: group.title,
      updated_at: trx.fn.now(),
    }));

    for (const batch of chunk(matterRows)) {
      // `merge`, not `ignore`: an earlier meeting ingested after a later one
      // changes what "first seen" is, and the projection must follow the record
      // rather than keep whichever wording it happened to see first.
      await trx("matters")
        .insert(batch)
        .onConflict(["commission_id", "identity_key"])
        .merge(["designator", "title", "updated_at"]);
    }

    const keys = [...groups.values()].map((group) => [group.commissionId, group.key]);
    const idByKey = new Map<string, string>();
    for (const batch of chunk(keys)) {
      const rows: unknown = await trx("matters")
        .whereIn(["commission_id", "identity_key"], batch)
        .select("id", "commission_id", "identity_key");
      for (const row of rowsOf(rows)) {
        idByKey.set(`${text(row.commission_id)} ${text(row.identity_key)}`, text(row.id));
      }
    }

    const appearanceRows: Array<{
      matter_id: string;
      agenda_item_id: string;
      match_rule: MatchRule;
      updated_at: Knex.Raw;
    }> = [];
    for (const group of groups.values()) {
      const matterId = idByKey.get(`${group.commissionId} ${group.key}`);
      if (matterId === undefined) continue;
      for (const itemId of group.itemIds) {
        appearanceRows.push({
          matter_id: matterId,
          agenda_item_id: itemId,
          match_rule: group.rule,
          updated_at: trx.fn.now(),
        });
      }
    }

    for (const batch of chunk(appearanceRows)) {
      // An item that moved — because a correction changed its title, or because
      // a designator now parses out of it — is *re*linked, not linked twice.
      await trx("matter_appearances")
        .insert(batch)
        .onConflict("agenda_item_id")
        .merge(["matter_id", "match_rule", "updated_at"]);
    }

    // Two prunes, because a rebuild that only ever adds is not a rebuild. An
    // item that stopped having an identity keeps a stale link otherwise, and the
    // matter it was the last appearance of would linger with an empty timeline.
    const linkedIds = appearanceRows.map((row) => row.agenda_item_id);
    const stale = trx("matter_appearances");
    if (linkedIds.length > 0) {
      for (const batch of chunk(linkedIds)) stale.whereNotIn("agenda_item_id", batch);
    }
    await stale.del();

    await trx("matters")
      .whereNotExists(trx("matter_appearances").whereRaw("matter_appearances.matter_id = matters.id"))
      .del();

    const matterCount: unknown = await trx("matters").count({ total: "id" }).first();
    const appearanceCount: unknown = await trx("matter_appearances").count({ total: "id" }).first();
    return {
      matters:
        typeof matterCount === "object" && matterCount !== null
          ? num((matterCount as { total?: unknown }).total)
          : 0,
      appearances:
        typeof appearanceCount === "object" && appearanceCount !== null
          ? num((appearanceCount as { total?: unknown }).total)
          : 0,
    };
  });
}
