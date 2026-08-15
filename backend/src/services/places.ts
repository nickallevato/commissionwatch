import type { Knex } from "knex";
import { whereFindingPublic, whereMeetingPublished } from "./publication";

/**
 * Where a decision happened — stage 1, points and radius.
 *
 * Schema of record: `backend/migrations/094_create_places.ts`, whose header
 * carries the probe that decided the shape. The short version: PostGIS is not
 * available in `pgvector/pgvector:pg16`, `cube` and `earthdistance` are, and
 * they answer the one question this feature exists for — what is happening
 * within N metres of here. Polygons are stage 2 and are sequenced after the
 * image changes, never with it.
 *
 * Three rules govern this file.
 *
 * **The radius query is two filters, in this order, always.**
 * `earth_box(...) @> ll_to_earth(lat, lon)` is the one the GiST index can
 * answer, and it is a *bounding box*: it admits points beyond the radius near
 * the corners. Probed against the real database — a point 1095 m from the
 * centre sits inside `earth_box(centre, 1000)`. So `earth_distance(...) <= r`
 * follows it, and the test in `places.test.ts` uses that measured point to
 * prove the second filter is doing work. Dropping either one gives a wrong
 * answer: without the box the query is a sequential scan, without the distance
 * it is a lie about how far away something is.
 *
 * **A place is public only through a public link.** A place row on its own is
 * not an assertion — it is a coordinate an extractor or an operator wrote down,
 * possibly about a meeting nobody has published. Returning it would leak the
 * existence and the location of a withheld record, which is the same hole
 * `whereFindingPublic` was written to close on `/api/anomalies`. So the public
 * read paths default to `visibility: "public"` and the operator console has to
 * ask for `"all"` explicitly.
 *
 * **The subject wall is composed, never retyped.** `place_links` is
 * polymorphic across four kinds and each kind reaches the wall by a different
 * path, so this file maps kind → predicate and every predicate is built out of
 * `publication.ts`'s helpers. See `wherePlaceLinkPublic`.
 */

/* ---------------------------------------------------------------------------
   Vocabulary
   --------------------------------------------------------------------------- */

/**
 * These repeat the CHECK constraint values in migration 094 rather than
 * importing them, and that is deliberate: `backend/Dockerfile`'s builder stage
 * copies `src/`, `knexfile.ts` and `tsconfig.json` and **not** `migrations/`,
 * so a `src/` module that imported a migration would fail `npx tsc` inside the
 * image while compiling perfectly here. That is the same class of defect as the
 * sweep script that did not exist in production.
 *
 * The duplication is held honest by `places.test.ts`, which reads
 * `pg_get_constraintdef` for each CHECK and asserts these lists are exactly what
 * the database enforces. A constant that drifts from the constraint fails there
 * rather than at an insert in production.
 */
export const PLACE_KINDS = ["address", "street_segment", "facility", "project_area"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** No `parcel` — that needs a polygon, and polygons are stage 2. */
export const PLACE_PRECISIONS = ["exact", "block", "centroid", "jurisdiction"] as const;
export type PlacePrecision = (typeof PLACE_PRECISIONS)[number];

export const PLACE_RELATIONS = ["subject_of", "located_at", "affects"] as const;
export type PlaceRelation = (typeof PLACE_RELATIONS)[number];

export const PLACE_CONFIDENCE = ["stated", "matched", "inferred"] as const;
export type PlaceConfidence = (typeof PLACE_CONFIDENCE)[number];

export const PLACE_SUBJECT_KINDS = ["agenda_item", "meeting", "document", "finding"] as const;
export type PlaceSubjectKind = (typeof PLACE_SUBJECT_KINDS)[number];

export const PLACE_LINK_STATUSES = ["held", "approved", "rejected"] as const;
export type PlaceLinkStatus = (typeof PLACE_LINK_STATUSES)[number];

/* ---------------------------------------------------------------------------
   Bounds
   --------------------------------------------------------------------------- */

/**
 * The largest radius a public caller may ask for.
 *
 * Five kilometres covers Bozeman end to end, which is the question this is for.
 * A caller asking for 40 000 000 metres is asking for the whole table with an
 * `earth_distance` call per row, and the honest answer to that is a 400 rather
 * than a scan — the same reasoning as `MAX_QUERY_TERMS` in the query feed.
 */
export const MAX_RADIUS_METRES = 5_000;

/** The subscription the geography spec leads with: "within 500 metres". */
export const DEFAULT_RADIUS_METRES = 500;

export const MAX_PLACE_RESULTS = 100;
export const DEFAULT_PLACE_RESULTS = 50;

/** Rejected input, with the message the caller is shown. */
export class PlaceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceQueryError";
  }
}

export interface Coordinate {
  lat: number;
  lon: number;
}

/**
 * A coordinate, or a rejection. Never a default.
 *
 * `parseFloat("north")` is `NaN` and `Number("")` is `0`, and either of those
 * quietly becoming a coordinate puts the caller at the equator off the coast of
 * Africa and returns an empty feed forever. A reader who saved that URL as a
 * subscription would watch nothing happen for months and conclude the record
 * was quiet. So both halves must parse as finite numbers in range, and anything
 * else throws.
 *
 * The range check is the same one `places_coords_check` enforces at write time,
 * which is what catches the classic swapped lat/lon: a Bozeman longitude of
 * -111 is not a latitude.
 */
export function parseCoordinate(rawLat: unknown, rawLon: unknown): Coordinate {
  const lat = numberOrNull(rawLat);
  const lon = numberOrNull(rawLon);
  if (lat === null || lat < -90 || lat > 90) {
    throw new PlaceQueryError("lat must be a number between -90 and 90.");
  }
  if (lon === null || lon < -180 || lon > 180) {
    throw new PlaceQueryError("lon must be a number between -180 and 180.");
  }
  return { lat, lon };
}

/** A radius in metres, or a rejection. Absent means the 500 m default. */
export function parseRadius(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RADIUS_METRES;
  const metres = numberOrNull(raw);
  if (metres === null || metres <= 0) {
    throw new PlaceQueryError("radius must be a positive number of metres.");
  }
  if (metres > MAX_RADIUS_METRES) {
    throw new PlaceQueryError(`radius must be ${MAX_RADIUS_METRES} metres or fewer.`);
  }
  return metres;
}

function numberOrNull(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // `Number("")` is 0 and `Number(" ")` is 0. Both would be a coordinate the
  // caller did not give.
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `?near=45.6796,-111.0386` — one parameter, because an address is one thing. */
export function parseNear(raw: unknown): Coordinate {
  if (typeof raw !== "string") {
    throw new PlaceQueryError("near must be given once, as lat,lon.");
  }
  const parts = raw.split(",");
  if (parts.length !== 2) {
    throw new PlaceQueryError("near must be two numbers separated by a comma: lat,lon.");
  }
  return parseCoordinate(parts[0], parts[1]);
}

/* ---------------------------------------------------------------------------
   Writing
   --------------------------------------------------------------------------- */

export interface PlaceInput {
  jurisdiction_id: string;
  kind: PlaceKind;
  label: string;
  lat: number;
  lon: number;
  precision: PlacePrecision;
  external_ref?: string | null;
  external_source?: string | null;
  geocoder?: string | null;
  geocoded_at?: Date | null;
}

export interface Place {
  id: string;
  jurisdiction_id: string;
  kind: string;
  label: string;
  lat: number;
  lon: number;
  precision: string;
  external_ref: string | null;
  external_source: string | null;
  geocoder: string | null;
  geocoded_at: Date | null;
}

export interface PlaceNearResult extends Place {
  /** Great-circle metres from the query point. Not the bounding-box distance. */
  distance_metres: number;
}

/**
 * Records a place, or updates the one that already stands for it.
 *
 * Idempotency is exactly what the migration's unique index says it is:
 * `(external_source, external_ref) WHERE external_ref IS NOT NULL`. Re-importing
 * an authoritative dataset must update rather than duplicate, the same instinct
 * as `artifacts.sha256`.
 *
 * A place with **no** external reference has no identity the database can key
 * on, so it is inserted. That is stated rather than papered over: matching such
 * a row on "same label, roughly same coordinates" would be the fuzzy identity
 * `services/matters.ts` refuses for the same reason — a near-match that silently
 * merges two neighbours' rezones is a published claim nobody can source. A
 * caller that needs idempotency supplies an `external_ref`.
 *
 * The conflict target names the index predicate because Postgres cannot infer a
 * *partial* unique index without it. Written as raw for that reason, not for
 * style.
 */
export async function recordPlace(db: Knex, input: PlaceInput): Promise<Place> {
  const row = {
    jurisdiction_id: input.jurisdiction_id,
    kind: input.kind,
    label: input.label,
    lat: input.lat,
    lon: input.lon,
    precision: input.precision,
    external_ref: input.external_ref ?? null,
    external_source: input.external_source ?? null,
    geocoder: input.geocoder ?? null,
    geocoded_at: input.geocoded_at ?? null,
  };

  const insert = db("places").insert({ ...row, updated_at: db.fn.now() });
  const query =
    row.external_ref === null
      ? insert
      : insert
          .onConflict(db.raw("(external_source, external_ref) where external_ref is not null"))
          .merge([
            "kind",
            "label",
            "lat",
            "lon",
            "precision",
            "geocoder",
            "geocoded_at",
            "updated_at",
          ]);

  const [created] = await query.returning<Place[]>("*");
  return created;
}

export interface PlaceLinkInput {
  place_id: string;
  subject_kind: PlaceSubjectKind;
  subject_id: string;
  relation: PlaceRelation;
  confidence: PlaceConfidence;
  artifact_sha256?: string | null;
  quote?: string | null;
  quote_offset?: number | null;
  status?: PlaceLinkStatus;
}

export interface PlaceLink {
  id: string;
  place_id: string;
  subject_kind: string;
  subject_id: string;
  relation: string;
  confidence: string;
  artifact_sha256: string | null;
  quote: string | null;
  quote_offset: number | null;
  status: string;
  updated_at: Date;
}

/**
 * Links a place to something on the record.
 *
 * Idempotent on `place_links_dedupe` — `(place_id, subject_kind, subject_id,
 * relation)` — so a re-run of an extractor over the same document relinks
 * rather than accumulating. `status` is deliberately **not** merged: an operator
 * who approved a link must not have that approval reset by the next sweep
 * finding the same sentence again. The citation is merged, because a re-extract
 * that resolves a better offset into the same bytes is an improvement to the
 * evidence for a decision already taken.
 *
 * The citation itself is not validated here. `place_links_citation_check` does
 * it in the database — anything not `inferred` must carry a 64-hex address, a
 * non-empty quote and a non-negative offset — and a second copy of that rule in
 * TypeScript is a second thing that can disagree with the constraint.
 */
export async function linkPlace(db: Knex, input: PlaceLinkInput): Promise<PlaceLink> {
  const [created] = await db("place_links")
    .insert({
      place_id: input.place_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      relation: input.relation,
      confidence: input.confidence,
      artifact_sha256: input.artifact_sha256 ?? null,
      quote: input.quote ?? null,
      quote_offset: input.quote_offset ?? null,
      status: input.status ?? "held",
      updated_at: db.fn.now(),
    })
    .onConflict(["place_id", "subject_kind", "subject_id", "relation"])
    .merge(["confidence", "artifact_sha256", "quote", "quote_offset", "updated_at"])
    .returning<PlaceLink[]>("*");
  return created;
}

/* ---------------------------------------------------------------------------
   The wall
   --------------------------------------------------------------------------- */

/**
 * One predicate per subject kind: *is the thing this link points at public?*
 *
 * Every branch is built from `publication.ts` rather than from a retyped
 * `published_at IS NOT NULL`, because `place_links` is polymorphic and four
 * hand-written copies of the wall is four chances to be nine-tenths right.
 *
 *  - **`meeting`** is the wall itself, `whereMeetingPublished`.
 *  - **`agenda_item`** reaches it through its meeting — the same join
 *    `services/search.ts` uses, with the qualified column the helper takes for
 *    exactly this case.
 *  - **`document`** reaches it through `meeting_documents.meeting_id`.
 *  - **`finding`** does **not** use `whereMeetingPublished`. `anomaly_flags`
 *    has been nullable on `meeting_id` since migration 027, and a join to
 *    `meetings` would look right and silently drop every records-derived flag.
 *    `whereFindingPublic` is the two-part rule — approved, and a published
 *    meeting only if it has one — and it is imported unchanged.
 *
 * `table` is a table name or alias chosen in this file, never caller input, so
 * interpolating it into the correlation clause is safe. It is a parameter for
 * the same reason `whereMeetingPublished` takes a column: the near query aliases
 * `place_links` and an unqualified `subject_id` in a join is a reference waiting
 * to become ambiguous.
 */
const SUBJECT_IS_PUBLIC: Readonly<
  Record<PlaceSubjectKind, (db: Knex, table: string) => Knex.QueryBuilder>
> = Object.freeze({
  meeting: (db, table) =>
    whereMeetingPublished(
      db("meetings").whereRaw(`meetings.id = ${table}.subject_id`),
      "meetings.published_at",
    ),
  agenda_item: (db, table) =>
    whereMeetingPublished(
      db("agenda_items")
        .join("meetings", "meetings.id", "agenda_items.meeting_id")
        .whereRaw(`agenda_items.id = ${table}.subject_id`),
      "meetings.published_at",
    ),
  document: (db, table) =>
    whereMeetingPublished(
      db("meeting_documents")
        .join("meetings", "meetings.id", "meeting_documents.meeting_id")
        .whereRaw(`meeting_documents.id = ${table}.subject_id`),
      "meetings.published_at",
    ),
  finding: (db, table) =>
    whereFindingPublic(
      db,
      db("anomaly_flags").whereRaw(`anomaly_flags.id = ${table}.subject_id`),
      "anomaly_flags",
    ),
});

/**
 * Constrains a `place_links` query to links a reader may see.
 *
 * Three conditions, and each fails differently:
 *
 *  - **`status = 'approved'`.** Migration 094 defaults to `held`. A `rejected`
 *    link is excluded by the same clause, one rule and one failure mode.
 *  - **`confidence <> 'inferred'`.** An inferred link is *never* public,
 *    whatever its status. The migration lets it exist without a citation
 *    precisely so it can be an operator-only lead, and a lead published as a
 *    location is an unsourced claim about where a decision applies — the exact
 *    thing "no unsourced claim reaches the public site" forbids. This is not
 *    redundant with the status check: an operator can approve an inferred link
 *    as a lead worth following, and that approval must not put it on a map.
 *  - **Its subject is public**, by the per-kind predicate above.
 *
 * A `subject_kind` this file does not know is matched by no branch and is
 * therefore invisible. That is the correct default for a later migration adding
 * a fifth kind: it stays out of public view until somebody writes its wall.
 */
export function wherePlaceLinkPublic<T extends Knex.QueryBuilder>(
  db: Knex,
  query: T,
  table = "place_links",
): T {
  query
    .where(`${table}.status`, "approved")
    .whereNot(`${table}.confidence`, "inferred")
    .where((outer) => {
      for (const kind of PLACE_SUBJECT_KINDS) {
        outer.orWhere((branch) => {
          branch
            .where(`${table}.subject_kind`, kind)
            .whereExists(SUBJECT_IS_PUBLIC[kind](db, table));
        });
      }
    });
  return query;
}

/**
 * Is the thing this link points at public — ignoring the link's own status?
 *
 * The review screen has to answer it separately from `wherePlaceLinkPublic`,
 * which folds three conditions into one predicate. An operator may legitimately
 * approve a link whose meeting is still withheld — the wall keeps the pin off
 * the map until the meeting goes out — but they must be told they are doing it,
 * and "approved and still invisible" is otherwise indistinguishable on the
 * screen from a bug in the wall.
 *
 * It reuses `SUBJECT_IS_PUBLIC`, correlated against `place_links` by id, rather
 * than reimplementing four per-kind joins. A second copy of the subject wall is
 * how the console and the reader start disagreeing about what is published.
 */
export async function placeLinkSubjectIsPublic(db: Knex, linkId: string): Promise<boolean> {
  const row = await db("place_links as pl")
    .where("pl.id", linkId)
    .where((outer) => {
      for (const kind of PLACE_SUBJECT_KINDS) {
        outer.orWhere((branch) => {
          branch
            .where("pl.subject_kind", kind)
            .whereExists(SUBJECT_IS_PUBLIC[kind](db, "pl"));
        });
      }
    })
    .first<{ id: string } | undefined>("pl.id");
  return row !== undefined;
}

/* ---------------------------------------------------------------------------
   Reading
   --------------------------------------------------------------------------- */

/**
 * `"public"` is the default everywhere. The operator console reads the same
 * tables and must see the held rows — the reason `publication.ts` gives for not
 * making the wall a view or an RLS policy — so it asks for `"all"` by name.
 */
export type PlaceVisibility = "public" | "all";

export interface NearOptions {
  lat: number;
  lon: number;
  metres: number;
  jurisdictionId?: string;
  limit?: number;
  visibility?: PlaceVisibility;
}

/**
 * Places within `metres` of a point, nearest first.
 *
 * **Both filters, in this order.** `earth_box(ll_to_earth(?,?), ?) @>
 * ll_to_earth(lat, lon)` is what the GiST index on `ll_to_earth(lat, lon)` can
 * answer, so it does the selection; `earth_distance(...) <= ?` is what makes the
 * answer true, because `earth_box` is a bounding box and admits points past the
 * radius near its corners. Measured, not assumed: 45.68680,-111.02900 is
 * 1095 m from 45.6796,-111.0386 and sits inside `earth_box(centre, 1000)`.
 * `places.test.ts` asserts on that point.
 *
 * The ties break on `id` so two places at the same distance cannot swap between
 * two calls — the same total-ordering rule the matters list follows.
 */
export async function placesNear(db: Knex, options: NearOptions): Promise<PlaceNearResult[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PLACE_RESULTS, 1), MAX_PLACE_RESULTS);
  const { lat, lon, metres } = options;

  const query = db("places as p")
    .select<PlaceNearResult[]>(
      "p.id",
      "p.jurisdiction_id",
      "p.kind",
      "p.label",
      "p.lat",
      "p.lon",
      "p.precision",
      "p.external_ref",
      "p.external_source",
      "p.geocoder",
      "p.geocoded_at",
      db.raw("earth_distance(ll_to_earth(?, ?), ll_to_earth(p.lat, p.lon)) as distance_metres", [
        lat,
        lon,
      ]),
    )
    .whereRaw("earth_box(ll_to_earth(?, ?), ?) @> ll_to_earth(p.lat, p.lon)", [lat, lon, metres])
    .whereRaw("earth_distance(ll_to_earth(?, ?), ll_to_earth(p.lat, p.lon)) <= ?", [
      lat,
      lon,
      metres,
    ])
    .orderByRaw("earth_distance(ll_to_earth(?, ?), ll_to_earth(p.lat, p.lon)) asc, p.id asc", [
      lat,
      lon,
    ])
    .limit(limit);

  if (options.jurisdictionId !== undefined) query.where("p.jurisdiction_id", options.jurisdictionId);

  if ((options.visibility ?? "public") === "public") {
    query.whereExists(
      wherePlaceLinkPublic(db, db("place_links as pl").whereRaw("pl.place_id = p.id"), "pl"),
    );
  }

  const rows = await query;
  // `earth_distance` comes back as float8, which `pg` parses to a number; the
  // coercion is here so a driver that ever hands it back as text cannot make
  // `distance_metres` a string in a JSON response.
  return rows.map((row) => ({ ...row, distance_metres: Number(row.distance_metres) }));
}

export interface PlaceLinkView {
  id: string;
  subject_kind: string;
  subject_id: string;
  relation: string;
  confidence: string;
  artifact_sha256: string | null;
  quote: string | null;
  quote_offset: number | null;
  updated_at: Date;
}

export interface PlaceDetail extends Place {
  links: PlaceLinkView[];
}


/**
 * Public links for many places at once.
 *
 * `/api/places/near` used to return coordinates and no citations, so a client
 * that honours "every place shows its citation" had to fetch each place's
 * detail separately — an N+1 the reader pays for, and one the map page worked
 * around by capping its own request at 25 results and holding back anything it
 * could not resolve.
 *
 * A pin is a claim about where a decision happened, and this project's oldest
 * invariant is that no unsourced claim reaches the public site. That guarantee
 * should not cost a round trip per pin, and it should not be something a client
 * can forget: shipping the links with the coordinates makes an uncited place
 * unrenderable rather than merely discouraged.
 *
 * Same predicate as `listPublicLinks` — `wherePlaceLinkPublic` — because a
 * second copy of the wall is how the two start disagreeing about which links a
 * reader may see.
 */
export async function listPublicLinksFor(
  db: Knex,
  placeIds: readonly string[],
): Promise<Map<string, PlaceLinkView[]>> {
  const byPlace = new Map<string, PlaceLinkView[]>();
  if (placeIds.length === 0) return byPlace;

  const query = db("place_links as pl")
    .whereIn("pl.place_id", [...placeIds])
    .select<Array<PlaceLinkView & { place_id: string }>>(
      "pl.place_id",
      "pl.id",
      "pl.subject_kind",
      "pl.subject_id",
      "pl.relation",
      "pl.confidence",
      "pl.artifact_sha256",
      "pl.quote",
      "pl.quote_offset",
      "pl.updated_at",
    )
    .orderBy([{ column: "pl.updated_at", order: "asc" }, { column: "pl.id", order: "asc" }]);

  for (const row of await wherePlaceLinkPublic(db, query, "pl")) {
    const list = byPlace.get(row.place_id);
    if (list) list.push(row);
    else byPlace.set(row.place_id, [row]);
  }
  return byPlace;
}


/** Every link on a place that a reader may see, oldest first. */
export async function listPublicLinks(db: Knex, placeId: string): Promise<PlaceLinkView[]> {
  const query = db("place_links as pl")
    .where("pl.place_id", placeId)
    .select<PlaceLinkView[]>(
      "pl.id",
      "pl.subject_kind",
      "pl.subject_id",
      "pl.relation",
      "pl.confidence",
      "pl.artifact_sha256",
      "pl.quote",
      "pl.quote_offset",
      "pl.updated_at",
    )
    .orderBy([{ column: "pl.updated_at", order: "asc" }, { column: "pl.id", order: "asc" }]);
  return wherePlaceLinkPublic(db, query, "pl");
}

/**
 * One place and its public links, or `undefined`.
 *
 * `undefined` covers "no such place" *and* "every link it has is held,
 * inferred, or points at something unpublished", and the route turns both into
 * the same 404 — the reason `findPublishedMeeting` gives. A place with no public
 * link is a coordinate an extractor wrote down about a record an operator has
 * not published; confirming it exists would disclose that a body is considering
 * something at that address before anything published says so, which on a map
 * is a disclosure about a specific street.
 */
export async function findPlace(db: Knex, id: string): Promise<PlaceDetail | undefined> {
  const place = await db("places").where({ id }).first<Place | undefined>();
  if (place === undefined) return undefined;

  const links = await listPublicLinks(db, id);
  if (links.length === 0) return undefined;

  return { ...place, links };
}
