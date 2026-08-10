import type { Knex } from "knex";
import { whereMeetingPublished } from "./publication";

/**
 * P6 · Full-text search over the published record.
 *
 * Four kinds of record, searched with PostgreSQL and ranked together. No vendor,
 * no API key, no per-call cost, no dimension decision. The embedding work this
 * replaces was withdrawn (archive-salvage spec § A3) and nothing here reaches
 * for it.
 *
 * Three rules govern this file.
 *
 * **Only published records are searchable.** `meetings.published_at` is the wall
 * between ingested and published, and search is the one surface that could walk
 * straight through it: a caller who cannot guess a meeting id can still guess a
 * *word*. Every meeting-derived query below goes through
 * `whereMeetingPublished` — the same helper the ten other public paths use, not
 * a re-typed predicate — and `search.test.ts` asserts that an unpublished
 * meeting, its agenda items and its document text are all absent, *and* that
 * publishing it makes all three appear. The second half matters: a test that
 * only proves nothing comes back also passes when search is broken.
 *
 * **The database marks matches; the page renders them.** `ts_headline` is given
 * control characters as delimiters rather than `<b>`. The text being highlighted
 * was scraped out of third-party PDFs and HTML, so returning it as markup for
 * the frontend to inject would be an XSS hole opened for a typographic effect.
 *
 * **Four queries, merged here, rather than one SQL union.** A union would have
 * to align twelve columns by position across four branches and could not use the
 * publication helper at all. Ranking, deduplication and paging are ordinary code
 * instead, testable without a database, and each branch stays a plain indexed
 * lookup.
 */

/** Delimiters `ts_headline` wraps a match in. Not markup, deliberately. */
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_END = "";

/**
 * `ts_headline` options, as a SQL expression.
 *
 * Built with `chr()` because the delimiters are control characters, and a SQL
 * literal holding them would be invisible in every diff and editor that ever
 * touched this file.
 */
const HEADLINE_OPTIONS = `(
  'StartSel=' || chr(2) || ',StopSel=' || chr(3) ||
  ',MaxFragments=1,MinWords=8,MaxWords=32,FragmentDelimiter= … '
)`;

/** `websearch_to_tsquery`: quoted phrases and -exclusions, no `&` or `|` to learn. */
const TSQUERY = "websearch_to_tsquery('english', ?)";

export type SearchKind = "agenda_item" | "meeting" | "member" | "document";

/** Fields every kind carries, so a result list renders without narrowing first. */
interface SearchResultBase {
  kind: SearchKind;
  /** The row's own id — an agenda item, a meeting, a member, an artifact. */
  id: string;
  /** What heads the result. Never marked up. */
  title: string;
  /**
   * The matching passage, matches wrapped in {@link HIGHLIGHT_START} /
   * {@link HIGHLIGHT_END}. Empty when the record carries no body text to quote.
   */
  snippet: string;
  rank: number;
}

export interface AgendaItemResult extends SearchResultBase {
  kind: "agenda_item";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
  item_number: number;
}

export interface MeetingResult extends SearchResultBase {
  kind: "meeting";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
}

export interface MemberResult extends SearchResultBase {
  kind: "member";
  jurisdiction_name: string;
}

export interface DocumentResult extends SearchResultBase {
  kind: "document";
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_name: string;
  document_type: string;
  sha256: string;
}

export type SearchResult = AgendaItemResult | MeetingResult | MemberResult | DocumentResult;

export interface SearchResponse {
  data: SearchResult[];
  total: number;
  /** Echoed back, trimmed, so a client can say "results for …" honestly. */
  query: string;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** The clamping `/api/meetings` applies. Two pagination policies on one API is a defect. */
export function clampLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

export function clampOffset(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

/**
 * Rank descending, then kind, then id.
 *
 * The tiebreakers are not decoration. Without a total order two rows of equal
 * rank can swap between one page and the next, and a reader paging through
 * results sees one row twice and another never.
 */
export function compareResults(a: SearchResult, b: SearchResult): number {
  return b.rank - a.rank || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function countOf(row: unknown): number {
  if (typeof row !== "object" || row === null) return 0;
  return num((row as { total?: unknown }).total);
}

// ---------------------------------------------------------------------------
// The four branches
// ---------------------------------------------------------------------------

/**
 * Agenda items — the substance of the record, and where most terms appear at all.
 *
 * The wall is reached through `meetings`, which is why the helper is given the
 * qualified column: `published_at` unqualified in a four-table join is a
 * reference waiting to become ambiguous.
 */
function agendaItemsQuery(db: Knex, q: string): Knex.QueryBuilder {
  return whereMeetingPublished(
    db("agenda_items as ai")
      .join("meetings as m", "m.id", "ai.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id"),
    "m.published_at",
  ).whereRaw(`ai.search_vector @@ ${TSQUERY}`, [q]);
}

/**
 * Meetings match on their venue — `location` is the only free text the table
 * holds. The commission's name heads the result because that is what a reader
 * calls the sitting; it is display, not the index.
 */
function meetingsQuery(db: Knex, q: string): Knex.QueryBuilder {
  return whereMeetingPublished(
    db("meetings as m")
      .join("commissions as c", "c.id", "m.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id"),
    "m.published_at",
  ).whereRaw(`m.search_vector @@ ${TSQUERY}`, [q]);
}

/**
 * Members sit outside the publication wall because they are already outside it:
 * `GET /api/members` lists every one of them to anyone. Search must not be more
 * permissive than the rest of the API, and making it *less* permissive than a
 * route that already exists would be a different, invented rule.
 */
function membersQuery(db: Knex, q: string): Knex.QueryBuilder {
  return db("members as mem")
    .join("jurisdictions as j", "j.id", "mem.jurisdiction_id")
    .whereRaw(`mem.search_vector @@ ${TSQUERY}`, [q]);
}

/**
 * Document bodies — the extracted text of an artifact, which nothing held before
 * migration 035.
 *
 * The path to the wall is the P5 join: `artifact_texts → document_versions →
 * meeting_documents → meetings`. An artifact reached through two documents
 * appears twice here and is deduplicated on the way out, so the count uses
 * `countDistinct` and means the same thing as the list.
 */
function documentsQuery(db: Knex, q: string): Knex.QueryBuilder {
  return whereMeetingPublished(
    db("artifact_texts as at")
      .join("artifacts as a", "a.id", "at.artifact_id")
      .join("document_versions as dv", "dv.artifact_id", "at.artifact_id")
      .join("meeting_documents as md", "md.id", "dv.meeting_document_id")
      .join("meetings as m", "m.id", "md.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .join("jurisdictions as j", "j.id", "c.jurisdiction_id"),
    "m.published_at",
  ).whereRaw(`at.search_vector @@ ${TSQUERY}`, [q]);
}

function headline(db: Knex, expression: string, q: string): Knex.Raw {
  return db.raw(`ts_headline('english', ${expression}, ${TSQUERY}, ${HEADLINE_OPTIONS}) as snippet`, [
    q,
  ]);
}

function rank(db: Knex, column: string, q: string): Knex.Raw {
  return db.raw(`ts_rank_cd(${column}, ${TSQUERY}) as rank`, [q]);
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  q: string;
  limit?: number;
  offset?: number;
}

/**
 * Search the published record.
 *
 * A blank query short-circuits to an empty result set with no database round
 * trip. A query of nothing but stopwords does not: it goes through
 * `websearch_to_tsquery`, produces an empty `tsquery`, matches nothing, and
 * returns the same empty set — which is worth exercising against the real parser
 * rather than guessing at in JavaScript.
 *
 * An empty database takes the identical path and gives the identical answer.
 * Production has zero rows today, so that is the ordinary case here, not an edge
 * one.
 *
 * Each branch is asked for `offset + limit` rows, which is exactly the most any
 * one of them can contribute to the page being assembled.
 */
export async function search(db: Knex, options: SearchOptions): Promise<SearchResponse> {
  const query = options.q.trim();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  if (query.length === 0) return { data: [], total: 0, query };

  const take = offset + limit;

  const [agendaRows, meetingRows, memberRows, documentRows, counts] = await Promise.all([
    agendaItemsQuery(db, query)
      .select(
        "ai.id as id",
        "ai.title as title",
        "ai.item_number as item_number",
        "m.id as meeting_id",
        db.raw("m.date::text as meeting_date"),
        "c.name as commission_name",
        "j.name as jurisdiction_name",
        rank(db, "ai.search_vector", query),
        headline(db, "coalesce(nullif(ai.description, ''), ai.title)", query),
      )
      .orderByRaw("rank desc, ai.id asc")
      .limit(take),

    meetingsQuery(db, query)
      .select(
        "m.id as id",
        "c.name as title",
        "m.id as meeting_id",
        db.raw("m.date::text as meeting_date"),
        "c.name as commission_name",
        "j.name as jurisdiction_name",
        rank(db, "m.search_vector", query),
        headline(db, "coalesce(m.location, '')", query),
      )
      .orderByRaw("rank desc, m.id asc")
      .limit(take),

    membersQuery(db, query)
      .select(
        "mem.id as id",
        "mem.name as title",
        "j.name as jurisdiction_name",
        rank(db, "mem.search_vector", query),
        headline(db, "coalesce(mem.title, '')", query),
      )
      .orderByRaw("rank desc, mem.id asc")
      .limit(take),

    documentsQuery(db, query)
      .select(
        "at.artifact_id as id",
        "md.title as title",
        "md.document_type as document_type",
        "a.sha256 as sha256",
        "m.id as meeting_id",
        db.raw("m.date::text as meeting_date"),
        "c.name as commission_name",
        "j.name as jurisdiction_name",
        rank(db, "at.search_vector", query),
        headline(db, "at.text", query),
      )
      .orderByRaw("rank desc, at.artifact_id asc")
      .limit(take),

    Promise.all([
      agendaItemsQuery(db, query).count({ total: "ai.id" }).first(),
      meetingsQuery(db, query).count({ total: "m.id" }).first(),
      membersQuery(db, query).count({ total: "mem.id" }).first(),
      // Distinct, because the list deduplicates an artifact reached through two
      // documents and a total that counted both would describe a different set.
      documentsQuery(db, query).countDistinct({ total: "at.artifact_id" }).first(),
    ]),
  ]);

  const results: SearchResult[] = [];
  for (const row of rowsOf(agendaRows)) {
    results.push({
      kind: "agenda_item",
      id: text(row.id),
      title: text(row.title),
      snippet: text(row.snippet),
      rank: num(row.rank),
      meeting_id: text(row.meeting_id),
      meeting_date: text(row.meeting_date),
      commission_name: text(row.commission_name),
      jurisdiction_name: text(row.jurisdiction_name),
      item_number: num(row.item_number),
    });
  }
  for (const row of rowsOf(meetingRows)) {
    results.push({
      kind: "meeting",
      id: text(row.id),
      title: text(row.title),
      snippet: text(row.snippet),
      rank: num(row.rank),
      meeting_id: text(row.meeting_id),
      meeting_date: text(row.meeting_date),
      commission_name: text(row.commission_name),
      jurisdiction_name: text(row.jurisdiction_name),
    });
  }
  for (const row of rowsOf(memberRows)) {
    results.push({
      kind: "member",
      id: text(row.id),
      title: text(row.title),
      snippet: text(row.snippet),
      rank: num(row.rank),
      jurisdiction_name: text(row.jurisdiction_name),
    });
  }
  const seenArtifacts = new Set<string>();
  for (const row of rowsOf(documentRows)) {
    const id = text(row.id);
    if (seenArtifacts.has(id)) continue;
    seenArtifacts.add(id);
    results.push({
      kind: "document",
      id,
      title: text(row.title),
      snippet: text(row.snippet),
      rank: num(row.rank),
      meeting_id: text(row.meeting_id),
      meeting_date: text(row.meeting_date),
      commission_name: text(row.commission_name),
      jurisdiction_name: text(row.jurisdiction_name),
      document_type: text(row.document_type),
      sha256: text(row.sha256),
    });
  }

  results.sort(compareResults);

  const total = counts.reduce<number>((sum, row) => sum + countOf(row), 0);
  return { data: results.slice(offset, offset + limit), total, query };
}
