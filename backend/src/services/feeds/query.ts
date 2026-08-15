import type { Knex } from "knex";
import { search, type SearchKind, type SearchResult } from "../search";
import { EVENT_SEVERITIES, type EventSeverity } from "../events/emit";
import {
  PlaceQueryError,
  parseNear,
  parseRadius,
  placesNear,
  wherePlaceLinkPublic,
  type Coordinate,
  type PlaceNearResult,
} from "../places";
import { meetingContexts, type MeetingContext } from "./entries";
import { searchUrn, type FeedCitation, type FeedEntry } from "./atom";

/**
 * The query feed — "the query is the subscription".
 *
 * The subscription **is** the URL. There is no account, no email address, no
 * token, no row in a subscribers table: nothing to leak and nothing to
 * unsubscribe from. That property only holds if this file keeps it, which is
 * what the two rules below are for.
 *
 * **No query logging beyond aggregate counts.** Nothing here writes the query
 * text, the client address, or the two together, anywhere — not to a table, not
 * to `console`, not into an error message that a log scraper would keep. A log
 * of who searched for which official's name would hand back exactly the
 * property this channel was designed not to have, and it would do it quietly.
 * If a future change needs to know how the feed is used, the answer is a
 * counter, not a line per request.
 *
 * **The query goes through `services/search.ts`, unchanged.** That module
 * already reaches the publication wall six different ways — `whereMeetingPublished`
 * with a qualified column for its four-table joins, `whereFindingPublic` for
 * the two-part finding rule, `publishedAppearances` for matters — and a second
 * query builder here would be a seventh, eighth and ninth phrasing of a rule
 * that is only correct if it is phrased once.
 *
 * Where the shapes did **not** compose is `jurisdiction_id`. `search()` takes
 * `{q, limit, offset}` and its rows carry `jurisdiction_name`, not the id, so a
 * jurisdiction filter is applied after the fact against the resolved name. The
 * consequence is stated rather than hidden: `finding` results carry no
 * jurisdiction at all, so a jurisdiction-filtered query feed omits findings. An
 * empty column is not a match, and attributing a finding to a jurisdiction we
 * did not check would be the confident wrong answer this endpoint is supposed
 * to refuse.
 *
 * ## `near` — and where it did *not* compose
 *
 * `?near=45.6796,-111.0386&radius=500` is the same idea over geography: the URL
 * is the subscription, no account, nothing stored about the subscriber, and the
 * thing the subscriber would most rather not hand over — their address — stays
 * in their own feed reader.
 *
 * It does **not** compose with the query path, and the honest thing is to say
 * so rather than force it. `collectQueryEntries` is a thin wrapper over
 * `services/search.ts`, which is full-text over six `search_vector` columns;
 * "within 500 metres" is not a term and there is no text to give it. The
 * corpora differ too: a query feed entry is a *record*, a near feed entry is a
 * *link between a record and a coordinate*, and the link is what carries the
 * citation and the precision a reader needs to judge the pin. So `near` is a
 * third branch, and `q` with `near` is a 400 rather than a guess at what an
 * intersection would mean.
 *
 * What is **not** duplicated is the wall. `wherePlaceLinkPublic` from
 * `services/places.ts` is the only predicate here, exactly as `search()` is the
 * only one on the query path.
 */

/**
 * Bounds. A public endpoint that accepts arbitrary query text is a public
 * endpoint somebody will use as a load generator, and `websearch_to_tsquery`
 * over six indexes is not free.
 */
export const MAX_QUERY_LENGTH = 200;
export const MAX_QUERY_TERMS = 12;
export const MAX_FEED_ENTRIES = 50;
export const DEFAULT_FEED_ENTRIES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{subject}.{verb}` — the vocabulary `services/events/emit.ts` documents. */
const EVENT_TYPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

const SEARCH_KINDS: readonly SearchKind[] = [
  "agenda_item",
  "meeting",
  "member",
  "document",
  "finding",
  "matter",
];

const SEVERITY_RANK: ReadonlyMap<string, number> = new Map(
  EVENT_SEVERITIES.map((name, index) => [name, index]),
);

/**
 * A rejected request, with the message a reader is shown.
 *
 * The message never echoes the query back. A 400 that quotes what you typed is
 * a 400 that puts the query in whatever caught the error, and the point of this
 * channel is that nothing keeps it.
 */
export class FeedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedQueryError";
  }
}

export interface RawFeedQuery {
  q?: unknown;
  jurisdiction_id?: unknown;
  type?: unknown;
  severity?: unknown;
  near?: unknown;
  radius?: unknown;
}

export interface ParsedFeedQuery {
  /** `null` means the plain event feed rather than a query feed. */
  q: string | null;
  jurisdiction_id: string | null;
  /** An `events.event_type` when `q` is null, a `SearchKind` when it is not. */
  event_type: string | null;
  search_kind: SearchKind | null;
  min_severity: EventSeverity | null;
  /** `?near=lat,lon` — the third feed. Mutually exclusive with `q`. */
  near: Coordinate | null;
  /** Metres. Only meaningful with `near`; defaulted to 500 when it is given. */
  radius: number | null;
}

function single(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  // Express parses `?q=a&q=b` into an array. Picking one of them would be a
  // guess about which the reader meant.
  throw new FeedQueryError(`${name} may be given at most once.`);
}

/**
 * Parse and bound, or throw.
 *
 * Every rejection is a 400 naming the parameter. An invalid `jurisdiction_id`
 * in particular must never fall through to an empty feed: a typo that returns
 * an empty page is a confident wrong answer, and a reader who saved that URL as
 * a subscription would watch nothing happen for months and conclude the record
 * was quiet.
 *
 * `type` carries two vocabularies because the two feeds are two corpora. With
 * `q` the entries are search results, which have a `kind`; without it they are
 * events, which have an `event_type`. A value that is not valid for the active
 * feed is rejected rather than ignored, so neither vocabulary silently
 * swallows the other's word.
 */
export function parseFeedQuery(raw: RawFeedQuery): ParsedFeedQuery {
  const rawQ = single(raw.q, "q");
  const q = rawQ === null ? null : rawQ.trim();

  if (q !== null) {
    if (q.length === 0) {
      throw new FeedQueryError("q was given but is empty. Omit it for the full feed.");
    }
    if (q.length > MAX_QUERY_LENGTH) {
      throw new FeedQueryError(`q must be ${MAX_QUERY_LENGTH} characters or fewer.`);
    }
    if (q.split(/\s+/).length > MAX_QUERY_TERMS) {
      throw new FeedQueryError(
        `q must be ${MAX_QUERY_TERMS} terms or fewer — a longer one scans more of the ` +
          `index than a subscription needs.`,
      );
    }
  }

  const jurisdiction = single(raw.jurisdiction_id, "jurisdiction_id");
  if (jurisdiction !== null && !UUID.test(jurisdiction)) {
    throw new FeedQueryError("jurisdiction_id must be a UUID.");
  }

  const type = single(raw.type, "type");
  let eventType: string | null = null;
  let searchKind: SearchKind | null = null;
  if (type !== null) {
    if (q === null) {
      if (!EVENT_TYPE.test(type)) {
        throw new FeedQueryError(
          "type must be an event type such as meeting.published on the unfiltered feed.",
        );
      }
      eventType = type;
    } else {
      const kind = SEARCH_KINDS.find((name) => name === type);
      if (kind === undefined) {
        throw new FeedQueryError(
          `type must be one of ${SEARCH_KINDS.join(", ")} when q is given.`,
        );
      }
      searchKind = kind;
    }
  }

  const rawNear = single(raw.near, "near");
  const rawRadius = single(raw.radius, "radius");
  let near: Coordinate | null = null;
  let radius: number | null = null;
  if (rawNear !== null) {
    if (q !== null) {
      // Stated rather than silently resolved. See the "near" section of the file
      // header: the two feeds are two corpora and there is no honest way to
      // intersect them here.
      throw new FeedQueryError("near and q are separate feeds. Give one or the other.");
    }
    if (type !== null) {
      // `type` on a `q`-less feed is an `events.event_type`, and the near feed
      // reads `place_links`, not `events`. Accepting it would apply nothing and
      // return a plausible page the reader believes was filtered.
      throw new FeedQueryError("type does not apply to the near feed.");
    }
    if (single(raw.severity, "severity") !== null) {
      throw new FeedQueryError("severity does not apply to the near feed.");
    }
    try {
      near = parseNear(rawNear);
      radius = parseRadius(rawRadius ?? undefined);
    } catch (err) {
      // One error type crosses the boundary, so the route has one catch. The
      // message is the parser's and never echoes the coordinate back.
      if (err instanceof PlaceQueryError) throw new FeedQueryError(err.message);
      throw err;
    }
  } else if (rawRadius !== null) {
    throw new FeedQueryError("radius means nothing without near.");
  }

  const severity = single(raw.severity, "severity");
  let minSeverity: EventSeverity | null = null;
  if (severity !== null) {
    const match = EVENT_SEVERITIES.find((name) => name === severity);
    if (match === undefined) {
      throw new FeedQueryError(`severity must be one of ${EVENT_SEVERITIES.join(", ")}.`);
    }
    minSeverity = match;
  }

  return {
    q,
    jurisdiction_id: jurisdiction,
    event_type: eventType,
    search_kind: searchKind,
    min_severity: minSeverity,
    near,
    radius,
  };
}

/**
 * The jurisdiction's name, or a 400.
 *
 * A well-formed UUID that names no jurisdiction is rejected for the same reason
 * a malformed one is: the reader is subscribing to something, and "nothing"
 * looks identical to "nothing has happened yet". Six months later that URL has
 * shown them an empty page every hour and they have concluded the record was
 * quiet, which is a wrong answer delivered confidently for six months.
 *
 * Called by the route for **both** feeds, not just the query feed. The event
 * feed filters on `events.jurisdiction_id` and would answer an unknown id with
 * a perfectly valid empty document — the same failure, on the path a reader is
 * more likely to be on.
 */
export async function requireJurisdictionName(db: Knex, id: string): Promise<string> {
  const row = await db("jurisdictions")
    .where({ id })
    .first<{ name: string } | undefined>("name");
  if (row === undefined) {
    throw new FeedQueryError("jurisdiction_id names no jurisdiction.");
  }
  return row.name;
}

/** The jurisdiction a search result belongs to, where the row carries one. */
function jurisdictionOf(result: SearchResult): string | null {
  switch (result.kind) {
    case "agenda_item":
    case "meeting":
    case "member":
    case "document":
    case "matter":
      return result.jurisdiction_name;
    case "finding":
      // `anomaly_flags` has no jurisdiction column and a records-derived flag
      // has no meeting to reach one through. See the file header.
      return null;
  }
}

function severityOf(result: SearchResult): string | null {
  return result.kind === "finding" ? result.severity : null;
}

/** Where a result renders on this site. Absolute. */
function resultUrl(homeUrl: string, result: SearchResult): string {
  switch (result.kind) {
    case "agenda_item":
      return `${homeUrl}/meetings/${result.meeting_id}`;
    case "meeting":
      return `${homeUrl}/meetings/${result.meeting_id}`;
    case "member":
      return `${homeUrl}/officials/${result.id}`;
    case "document":
      return `${homeUrl}/meetings/${result.meeting_id}`;
    case "finding":
      // No `/findings/:id` exists in `App.tsx`. See `entries.ts` — a per-finding
      // path would render the SPA's 404 in every reader's client.
      return result.meeting_id === null
        ? `${homeUrl}/findings`
        : `${homeUrl}/meetings/${result.meeting_id}`;
    case "matter":
      return `${homeUrl}/matters/${result.id}`;
  }
}

function resultCitation(homeUrl: string, result: SearchResult): FeedCitation {
  switch (result.kind) {
    case "agenda_item":
    case "meeting":
      return {
        label: `The meeting record — ${result.commission_name}, ${result.meeting_date}`,
        url: `${homeUrl}/meetings/${result.meeting_id}`,
        sha256: null,
      };
    case "document":
      return {
        label: `${result.title} (${result.document_type}) — ${result.commission_name}, ${result.meeting_date}`,
        url: `${homeUrl}/meetings/${result.meeting_id}`,
        sha256: result.sha256,
      };
    case "member":
      return {
        label: `The voting record — ${result.jurisdiction_name}`,
        url: `${homeUrl}/officials/${result.id}`,
        sha256: null,
      };
    case "finding":
      return {
        label: "The record this was detected in",
        url:
          result.meeting_id === null
            ? `${homeUrl}/findings`
            : `${homeUrl}/meetings/${result.meeting_id}`,
        sha256: null,
      };
    case "matter":
      return {
        label: `Every appearance on the published record — ${result.commission_name}`,
        url: `${homeUrl}/matters/${result.id}`,
        sha256: null,
      };
  }
}

/** A frozen label per kind. Not prose, and not a sentence about anybody. */
const KIND_LABEL: Readonly<Record<SearchKind, string>> = Object.freeze({
  agenda_item: "Agenda item",
  meeting: "Meeting",
  member: "Official",
  document: "Document",
  finding: "Finding",
  matter: "Matter",
});

function resultEntry(homeUrl: string, result: SearchResult, updated: Date): FeedEntry {
  return {
    // Stable across renders and not a URL: the kind and the row's primary key,
    // both of which outlive any path this site serves them at.
    urn: searchUrn(result.kind, result.id),
    title: `${KIND_LABEL[result.kind]}: ${result.title}`,
    summary: result.snippet,
    url: resultUrl(homeUrl, result),
    updated,
    retraction: false,
    citation: resultCitation(homeUrl, result),
  };
}

export interface QueryFeedOptions {
  q: string;
  /** Already resolved by the route, so an unknown id 400s before either feed runs. */
  jurisdiction_name: string | null;
  search_kind: SearchKind | null;
  min_severity: EventSeverity | null;
  limit: number;
  /**
   * Stamped on every entry.
   *
   * A search result has no publication timestamp of its own that survives the
   * six-way merge, and inventing one per row would make a reader's client
   * re-sort the feed on every poll. One timestamp for the render is honest
   * about what this feed is: the answer to a query as of now.
   */
  renderedAt: Date;
}

export async function collectQueryEntries(
  db: Knex,
  baseUrl: string,
  options: QueryFeedOptions,
): Promise<FeedEntry[]> {
  const homeUrl = baseUrl.replace(/\/+$/, "");
  const name = options.jurisdiction_name;

  const response = await search(db, { q: options.q, limit: options.limit, offset: 0 });

  const floor =
    options.min_severity === null ? null : (SEVERITY_RANK.get(options.min_severity) ?? 0);

  const results = response.data.filter((result) => {
    if (options.search_kind !== null && result.kind !== options.search_kind) return false;
    if (name !== null && jurisdictionOf(result) !== name) return false;
    if (floor !== null) {
      // A severity filter means "things at least this serious", and only a
      // finding claims a severity. Keeping the other kinds would answer a
      // narrower question with a wider set.
      const severity = severityOf(result);
      if (severity === null) return false;
      if ((SEVERITY_RANK.get(severity) ?? 0) < floor) return false;
    }
    return true;
  });

  return results.map((result) => resultEntry(homeUrl, result, options.renderedAt));
}

/* ---------------------------------------------------------------------------
   The near feed
   --------------------------------------------------------------------------- */

export interface NearFeedOptions {
  lat: number;
  lon: number;
  /** Already bounded by `parseRadius`; `MAX_RADIUS_METRES` is the ceiling. */
  metres: number;
  jurisdiction_id: string | null;
  limit: number;
}

interface NearLinkRow {
  id: string;
  place_id: string;
  subject_kind: string;
  subject_id: string;
  relation: string;
  artifact_sha256: string | null;
  quote: string | null;
  updated_at: Date;
  source_url: string | null;
}

/** What a reader is told they are looking at. Frozen labels, not prose. */
const SUBJECT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  agenda_item: "Agenda item",
  meeting: "Meeting",
  document: "Document",
  finding: "Finding",
});

/**
 * Distance, rounded to the nearest 10 metres.
 *
 * A pin whose source is a block-level geocode does not know where it is to the
 * metre, and printing "437 m" next to it claims a resolution the record does
 * not support — the same failure migration 094 built `precision` to prevent,
 * committed in the summary text instead of on the map.
 */
function metresText(distance: number): string {
  return `${Math.round(distance / 10) * 10} m`;
}

/**
 * The meeting each link's subject belongs to, by link id.
 *
 * One query per kind, never one per row. A `finding` may legitimately have no
 * meeting — `anomaly_flags.meeting_id` has been nullable since migration 027 —
 * so its absence from this map is a fact about the flag, not a failed lookup.
 */
async function subjectMeetings(db: Knex, rows: NearLinkRow[]): Promise<Map<string, string>> {
  const byLink = new Map<string, string>();
  const idsOf = (kind: string): string[] => [
    ...new Set(rows.filter((row) => row.subject_kind === kind).map((row) => row.subject_id)),
  ];

  const lookups: Array<{ kind: string; table: string; column: string }> = [
    { kind: "agenda_item", table: "agenda_items", column: "meeting_id" },
    { kind: "document", table: "meeting_documents", column: "meeting_id" },
    { kind: "finding", table: "anomaly_flags", column: "meeting_id" },
  ];

  const meetingBySubject = new Map<string, string>();
  for (const lookup of lookups) {
    const ids = idsOf(lookup.kind);
    if (ids.length === 0) continue;
    const found = await db(lookup.table)
      .whereIn("id", ids)
      .select<Array<Record<string, unknown>>>("id", `${lookup.column} as meeting_id`);
    for (const row of found) {
      const meetingId = row.meeting_id;
      if (typeof meetingId !== "string") continue;
      meetingBySubject.set(`${lookup.kind}:${String(row.id)}`, meetingId);
    }
  }

  for (const row of rows) {
    const meetingId =
      row.subject_kind === "meeting"
        ? row.subject_id
        : meetingBySubject.get(`${row.subject_kind}:${row.subject_id}`);
    if (meetingId !== undefined) byLink.set(row.id, meetingId);
  }
  return byLink;
}

function meetingLabel(context: MeetingContext | undefined): string {
  return context === undefined
    ? "the published record"
    : `${context.commission_name}, ${context.meeting_date}`;
}

/**
 * Public place links within a radius, newest first.
 *
 * Two walls and no third phrasing of either. `placesNear` already refuses a
 * place that has no public link, and `wherePlaceLinkPublic` is applied again
 * here on the links themselves — not belt-and-braces, but because the first
 * question is "may this coordinate be shown at all" and the second is "which of
 * its links may be shown", and a place with one public and one held link must
 * answer them differently.
 *
 * An entry whose subject cannot be resolved to a meeting is still emitted when
 * it is a finding, which has no meeting to resolve; every other kind is dropped
 * rather than rendered pointing at a page that does not exist. Same rule as
 * `collectEventEntries`.
 */
export async function collectNearEntries(
  db: Knex,
  baseUrl: string,
  options: NearFeedOptions,
): Promise<FeedEntry[]> {
  const homeUrl = baseUrl.replace(/\/+$/, "");

  const places = await placesNear(db, {
    lat: options.lat,
    lon: options.lon,
    metres: options.metres,
    jurisdictionId: options.jurisdiction_id ?? undefined,
    limit: options.limit,
  });
  if (places.length === 0) return [];

  const byPlace = new Map<string, PlaceNearResult>(places.map((place) => [place.id, place]));

  const linkQuery = db("place_links as pl")
    // On the content address, not an FK — `place_links.artifact_sha256` stores a
    // sha for the reason migration 072 does: a reissued document is different
    // bytes and the citation must keep pointing at what it was read from.
    .leftJoin("artifacts as a", "a.sha256", "pl.artifact_sha256")
    .whereIn("pl.place_id", [...byPlace.keys()])
    .orderBy([{ column: "pl.updated_at", order: "desc" }, { column: "pl.id", order: "desc" }])
    .limit(options.limit)
    .select<NearLinkRow[]>(
      "pl.id",
      "pl.place_id",
      "pl.subject_kind",
      "pl.subject_id",
      "pl.relation",
      "pl.artifact_sha256",
      "pl.quote",
      "pl.updated_at",
      "a.source_url as source_url",
    );

  const rows = await wherePlaceLinkPublic(db, linkQuery, "pl");
  if (rows.length === 0) return [];

  const meetingByLink = await subjectMeetings(db, rows);
  const meetings = await meetingContexts(db, [...new Set(meetingByLink.values())]);

  const entries: FeedEntry[] = [];
  for (const row of rows) {
    const place = byPlace.get(row.place_id);
    if (place === undefined) continue;

    const meetingId = meetingByLink.get(row.id);
    const context = meetingId === undefined ? undefined : meetings.get(meetingId);
    // A finding is the only kind that may legitimately have no meeting; for
    // anything else an unresolved subject means the row was deleted out from
    // under the link, and an entry with a title and no record behind it is the
    // one thing this feed must not emit. `/findings` is the list page — the
    // frontend has no `/findings/:id`, checked in `App.tsx` by `entries.ts`.
    if (row.subject_kind !== "finding" && context === undefined) continue;

    const url = meetingId === undefined ? `${homeUrl}/findings` : `${homeUrl}/meetings/${meetingId}`;

    // The quote is the claim; everything around it is scaffolding. A non-inferred
    // link is guaranteed to carry one by `place_links_citation_check`, and an
    // inferred link never reaches here.
    const quote = row.quote === null ? "" : `“${row.quote}”`;
    const provenance =
      `Recorded at ${place.label}, about ${metresText(place.distance_metres)} away. ` +
      `Location precision: ${place.precision}.`;

    const citation: FeedCitation = {
      label:
        row.source_url === null
          ? `The record this location was read from — ${meetingLabel(context)}`
          : `The document this location was read from — ${meetingLabel(context)}`,
      url: row.source_url ?? url,
      sha256: row.artifact_sha256,
    };

    entries.push({
      urn: searchUrn("place_link", row.id),
      title: `${SUBJECT_LABEL[row.subject_kind] ?? "Record"} near ${place.label} — ${meetingLabel(context)}`,
      summary: quote.length === 0 ? provenance : `${quote}\n\n${provenance}`,
      url,
      // The link's own timestamp, not the render time. Unlike a search result a
      // place link has a real one, so a reader's client can sort and de-duplicate
      // the way it does on the announcement feed.
      updated: row.updated_at,
      retraction: false,
      citation,
    });
  }

  return entries;
}
