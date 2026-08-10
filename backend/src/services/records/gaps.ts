import type { Knex } from "knex";
import { whereMeetingPublished } from "../publication";

/**
 * P7 — the gaps in the record, derived from the record.
 *
 * A "gap" is something this system already knows is absent: a meeting that
 * concluded and has no minutes, an agenda item that names an exhibit nobody
 * published, a source we cannot collect from, a fetch that failed. Each one is
 * an opportunity for a public-records request, which is what this module feeds.
 *
 * **Nothing here is a list.** There is no array of jurisdictions, no array of
 * meetings, no hand-maintained catalogue of known problems. Every gap is the
 * result of a query, so a new commission, a new source or a new failure shows up
 * without a deploy — and, just as importantly, a gap that gets filled disappears
 * on its own rather than sitting in a list somebody has to remember to prune.
 *
 * ## Scope, and why two of these are operator-only
 *
 * `missing_minutes` and `unpublished_exhibit` are anchored to a meeting. In
 * `public` scope they pass through {@link whereMeetingPublished}, so an
 * unpublished meeting cannot be named — the same wall every other public path
 * stands behind, reached through the same helper rather than a retyped
 * `whereNotNull`.
 *
 * `disabled_source` and `failed_fetch` are statements about **our ingestion**,
 * not about the public record. A public gap list naming a source we cannot fetch
 * or a job that errored would be publishing our operational state as though it
 * were the county's. They are operator scope only.
 */

export const GAP_KINDS = [
  "missing_minutes",
  "unpublished_exhibit",
  "disabled_source",
  "failed_fetch",
] as const;

export type GapKind = (typeof GAP_KINDS)[number];

/** Which gaps a caller may see. See the module comment. */
export type GapScope = "public" | "operator";

/** The gap kinds a given scope is allowed to produce. */
export const SCOPED_GAP_KINDS: Readonly<Record<GapScope, readonly GapKind[]>> = Object.freeze({
  public: Object.freeze(["missing_minutes", "unpublished_exhibit"] as const),
  operator: GAP_KINDS,
});

export interface RecordGap {
  /** `<kind>:<uuid>` — derived and stable, so a client hands back an id. */
  id: string;
  kind: GapKind;
  jurisdiction_id: string;
  jurisdiction_name: string;
  /**
   * One neutral line describing what is absent. It states the absence and
   * nothing about why — no delay, no failure to do anything, no motive.
   */
  summary: string;
  /** The noun phrase the letter asks for, used verbatim in the request body. */
  requested_record: string;
  meeting_id: string | null;
  /** `YYYY-MM-DD`, formatted in SQL so no timezone can shift the calendar day. */
  meeting_date: string | null;
  commission_name: string | null;
  document_title: string | null;
  /** A URL a reader can check, when one exists. Never invented. */
  reference_url: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits `<kind>:<uuid>`, or returns null. Never throws on user input. */
export function parseGapId(value: string): { kind: GapKind; subjectId: string } | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const subjectId = value.slice(separator + 1);
  const matched = GAP_KINDS.filter((candidate) => candidate === kind);
  if (matched.length === 0 || !UUID_RE.test(subjectId)) return null;
  return { kind: matched[0], subjectId };
}

export function isGapKindInScope(kind: GapKind, scope: GapScope): boolean {
  return SCOPED_GAP_KINDS[scope].includes(kind);
}

export interface ListGapsOptions {
  /** Cap per kind. The default keeps a console page finite on a full archive. */
  limit?: number;
  /** Restrict to one meeting — what the "Request this record" button on a meeting uses. */
  meetingId?: string;
  /** Resolve exactly one gap. Used by {@link findGap}. */
  subjectId?: string;
  kinds?: readonly GapKind[];
}

const DEFAULT_LIMIT = 50;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

// ---- the four queries -------------------------------------------------------

interface MissingMinutesRow {
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_id: string;
  jurisdiction_name: string;
  agenda_url: string | null;
}

/**
 * A meeting that has been held and whose minutes are not in the record.
 *
 * Both halves matter: `minutes_url IS NULL` covers the source never linking
 * them, and the `NOT EXISTS` covers our never storing a `minutes` document. A
 * meeting with either one is not a gap.
 *
 * `status = 'completed'` **and** a past date. The status alone would include a
 * row an adapter mislabelled; the date alone would include a scheduled meeting
 * whose date has passed without anyone recording that it happened. Minutes of a
 * meeting that has not been held are not a gap, they are a category error.
 */
async function missingMinutes(
  db: Knex,
  scope: GapScope,
  options: ListGapsOptions,
): Promise<RecordGap[]> {
  const query = db("meetings as m")
    .join("commissions as c", "c.id", "m.commission_id")
    .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
    .whereRaw("m.status = 'completed'")
    .whereRaw("m.date < CURRENT_DATE")
    .whereNull("m.minutes_url")
    .whereNotExists((sub) =>
      sub
        .select(db.raw("1"))
        .from("meeting_documents as d")
        .whereRaw("d.meeting_id = m.id")
        .where("d.document_type", "minutes"),
    )
    .orderBy("m.date", "desc")
    .limit(clampLimit(options.limit))
    .select<MissingMinutesRow[]>(
      "m.id as meeting_id",
      db.raw("to_char(m.date, 'YYYY-MM-DD') as meeting_date"),
      "c.name as commission_name",
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      "m.agenda_url as agenda_url",
    );

  if (scope === "public") whereMeetingPublished(query, "m.published_at");
  if (options.meetingId) query.where("m.id", options.meetingId);
  if (options.subjectId) query.where("m.id", options.subjectId);

  const rows = await query;
  return rows.map((row) => ({
    id: `missing_minutes:${row.meeting_id}`,
    kind: "missing_minutes" as const,
    jurisdiction_id: row.jurisdiction_id,
    jurisdiction_name: row.jurisdiction_name,
    summary: `No minutes are in the record for the ${row.commission_name} meeting of ${row.meeting_date}.`,
    requested_record: `the minutes of the ${row.commission_name} meeting held on ${row.meeting_date}`,
    meeting_id: row.meeting_id,
    meeting_date: row.meeting_date,
    commission_name: row.commission_name,
    document_title: null,
    reference_url: row.agenda_url,
  }));
}

interface ExhibitRow {
  item_id: string;
  item_number: number;
  item_title: string;
  exhibit_label: string | null;
  meeting_id: string;
  meeting_date: string;
  commission_name: string;
  jurisdiction_id: string;
  jurisdiction_name: string;
  agenda_url: string | null;
}

/**
 * An agenda item that names an exhibit, where no supporting document exists.
 *
 * The reference is found in the extracted text rather than in a column, because
 * there is no column: `agenda_items` has nothing pointing at an attachment, and
 * document linkage lives only at the meeting level. So the query looks for the
 * words an agenda uses — exhibit, attachment, appendix, enclosure — followed by
 * a designator, and requires the meeting to hold no `attachment`, `packet`,
 * `resolution` or `ordinance` document at all.
 *
 * That last condition is deliberately coarse. Matching a specific exhibit to a
 * specific stored file is guesswork, and a request for a document we already
 * have is worse than no request: it wastes a custodian's time and makes the tool
 * untrustworthy. Requiring *nothing* supporting to exist means every gap this
 * produces is real, at the cost of missing the meeting that published Exhibit A
 * and not Exhibit B. Under-reporting here is the safe direction.
 */
async function unpublishedExhibits(
  db: Knex,
  scope: GapScope,
  options: ListGapsOptions,
): Promise<RecordGap[]> {
  const EXHIBIT_PATTERN = "(exhibit|attachment|appendix|enclosure)[[:space:]]+[A-Za-z0-9][-A-Za-z0-9.]*";

  const query = db("agenda_items as ai")
    .join("meetings as m", "m.id", "ai.meeting_id")
    .join("commissions as c", "c.id", "m.commission_id")
    .join("jurisdictions as j", "j.id", "c.jurisdiction_id")
    .whereRaw(`(ai.title || ' ' || coalesce(ai.description, '')) ~* ?`, [EXHIBIT_PATTERN])
    .whereNotExists((sub) =>
      sub
        .select(db.raw("1"))
        .from("meeting_documents as d")
        .whereRaw("d.meeting_id = m.id")
        .whereIn("d.document_type", ["attachment", "packet", "resolution", "ordinance"]),
    )
    .orderBy("m.date", "desc")
    .orderBy("ai.item_number", "asc")
    .limit(clampLimit(options.limit))
    .select<ExhibitRow[]>(
      "ai.id as item_id",
      "ai.item_number as item_number",
      "ai.title as item_title",
      db.raw(
        `substring(ai.title || ' ' || coalesce(ai.description, '') from ?) as exhibit_label`,
        [`(?i)(${EXHIBIT_PATTERN})`],
      ),
      "m.id as meeting_id",
      db.raw("to_char(m.date, 'YYYY-MM-DD') as meeting_date"),
      "c.name as commission_name",
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      "m.agenda_url as agenda_url",
    );

  if (scope === "public") whereMeetingPublished(query, "m.published_at");
  if (options.meetingId) query.where("m.id", options.meetingId);
  if (options.subjectId) query.where("ai.id", options.subjectId);

  const rows = await query;
  return rows.map((row) => {
    // The label as the agenda itself wrote it, or a description of where the
    // reference sits when the pattern matched across a boundary we cannot quote.
    const label = row.exhibit_label?.trim() ?? "";
    const named = label === "" ? "the material referenced" : label;
    return {
      id: `unpublished_exhibit:${row.item_id}`,
      kind: "unpublished_exhibit" as const,
      jurisdiction_id: row.jurisdiction_id,
      jurisdiction_name: row.jurisdiction_name,
      summary: `Agenda item ${row.item_number} of the ${row.commission_name} meeting of ${row.meeting_date} refers to ${named}; no supporting document for that meeting is in the record.`,
      requested_record: `${named}, referred to by agenda item ${row.item_number} ("${row.item_title}") of the ${row.commission_name} meeting held on ${row.meeting_date}, together with any other exhibits or attachments to that item`,
      meeting_id: row.meeting_id,
      meeting_date: row.meeting_date,
      commission_name: row.commission_name,
      document_title: row.item_title,
      reference_url: row.agenda_url,
    };
  });
}

interface DisabledSourceRow {
  source_id: string;
  adapter_key: string;
  disabled_reason: string | null;
  since: string;
  jurisdiction_id: string;
  jurisdiction_name: string;
}

/**
 * A source that is not collecting, and the period it is therefore silent about.
 *
 * The start date is the last time collection from that source succeeded, or the
 * day the source was registered when it never has. That is a fact about our own
 * records rather than an invention, and it is what makes the letter able to name
 * a period at all instead of leaving a blank for someone to fill in.
 */
async function disabledSources(db: Knex, options: ListGapsOptions): Promise<RecordGap[]> {
  const query = db("ingestion_sources as s")
    .join("jurisdictions as j", "j.id", "s.jurisdiction_id")
    .where("s.enabled", false)
    .orderBy("s.adapter_key", "asc")
    .limit(clampLimit(options.limit))
    .select<DisabledSourceRow[]>(
      "s.id as source_id",
      "s.adapter_key as adapter_key",
      "s.disabled_reason as disabled_reason",
      db.raw("to_char(coalesce(s.last_success_at, s.created_at), 'YYYY-MM-DD') as since"),
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
    );

  if (options.subjectId) query.where("s.id", options.subjectId);
  // A source is not a meeting, so a meeting filter excludes this kind entirely
  // rather than matching everything.
  if (options.meetingId) return [];

  const rows = await query;
  return rows.map((row) => ({
    id: `disabled_source:${row.source_id}`,
    kind: "disabled_source" as const,
    jurisdiction_id: row.jurisdiction_id,
    jurisdiction_name: row.jurisdiction_name,
    summary: `No documents have been collected from ${row.jurisdiction_name} through ${row.adapter_key} since ${row.since}.`,
    requested_record: `the agendas, minutes and supporting materials for all public meetings of ${row.jurisdiction_name} held on or after ${row.since}`,
    meeting_id: null,
    meeting_date: null,
    commission_name: null,
    document_title: null,
    reference_url: null,
  }));
}

interface FailedFetchRow {
  job_id: string;
  target_url: string | null;
  target_title: string | null;
  jurisdiction_id: string;
  jurisdiction_name: string;
}

/**
 * A document the pipeline holds a reference to and does not hold the bytes of.
 *
 * `ingestion_jobs.last_error` is deliberately **not** carried into the gap. The
 * letter must say what record is sought; a transport error is our problem and
 * saying it to a custodian invites them to read the request as a complaint.
 */
async function failedFetches(db: Knex, options: ListGapsOptions): Promise<RecordGap[]> {
  const query = db("ingestion_jobs as job")
    .join("ingestion_runs as run", "run.id", "job.run_id")
    .join("ingestion_sources as s", "s.id", "run.source_id")
    .join("jurisdictions as j", "j.id", "s.jurisdiction_id")
    .where("job.stage", "fetch")
    .whereIn("job.status", ["failed", "blocked"])
    .whereRaw("job.target ->> 'url' IS NOT NULL")
    .orderBy("job.created_at", "desc")
    .limit(clampLimit(options.limit))
    .select<FailedFetchRow[]>(
      "job.id as job_id",
      db.raw("job.target ->> 'url' as target_url"),
      db.raw("job.target ->> 'title' as target_title"),
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
    );

  if (options.subjectId) query.where("job.id", options.subjectId);
  if (options.meetingId) return [];

  const rows = await query;
  return rows.map((row) => {
    const title = row.target_title?.trim() ?? "";
    const url = row.target_url ?? "";
    const described = title === "" ? `the document published at ${url}` : `the document titled "${title}", published at ${url}`;
    return {
      id: `failed_fetch:${row.job_id}`,
      kind: "failed_fetch" as const,
      jurisdiction_id: row.jurisdiction_id,
      jurisdiction_name: row.jurisdiction_name,
      summary: `${described} is referenced in the record and its contents are not held.`,
      requested_record: `a copy of ${described}`,
      meeting_id: null,
      meeting_date: null,
      commission_name: null,
      document_title: title === "" ? null : title,
      reference_url: url === "" ? null : url,
    };
  });
}

// ---- the public surface -----------------------------------------------------

/** Every gap visible in `scope`, newest first within each kind. */
export async function listGaps(
  db: Knex,
  scope: GapScope,
  options: ListGapsOptions = {},
): Promise<RecordGap[]> {
  const wanted = (options.kinds ?? SCOPED_GAP_KINDS[scope]).filter((kind) =>
    isGapKindInScope(kind, scope),
  );

  const batches = await Promise.all(
    wanted.map((kind) => {
      switch (kind) {
        case "missing_minutes":
          return missingMinutes(db, scope, options);
        case "unpublished_exhibit":
          return unpublishedExhibits(db, scope, options);
        case "disabled_source":
          return disabledSources(db, options);
        case "failed_fetch":
          return failedFetches(db, options);
      }
    }),
  );

  return batches.flat();
}

/**
 * Resolve one gap id back to a gap, in `scope`, or `null`.
 *
 * A caller hands back an id and the gap is rebuilt from the database. Nothing a
 * client sends about the record itself is trusted: a letter that quoted a
 * client-supplied meeting date would let anyone put words in the project's
 * mouth, and would route around the publication wall by simply not asking it.
 */
export async function findGap(
  db: Knex,
  scope: GapScope,
  gapId: string,
): Promise<RecordGap | null> {
  const parsed = parseGapId(gapId);
  if (!parsed) return null;
  if (!isGapKindInScope(parsed.kind, scope)) return null;

  const found = await listGaps(db, scope, {
    kinds: [parsed.kind],
    subjectId: parsed.subjectId,
    limit: 1,
  });
  return found[0] ?? null;
}
