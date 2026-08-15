import type { Knex } from "knex";
import { appendCorrectionRow } from "../pressroom/corrections";
import {
  PLACE_LINK_STATUSES,
  PLACE_PRECISIONS,
  placeLinkSubjectIsPublic,
  type PlaceLinkStatus,
  type PlacePrecision,
  type PlaceSubjectKind,
} from "../places";
import { sliceContext, viewerPath, type QuoteContext } from "./claims";
import { ReviewError, type ReviewActor } from "./queue";

/**
 * The place-link review path — the thing that makes a pin publishable.
 *
 * Migration 094 shipped `place_links.status` defaulting to `held`, and the
 * extraction stage writes every link `held`, correctly: a pin is a claim about
 * where a decision happened and it names a location on a public map. But
 * `wherePlaceLinkPublic` requires `status = 'approved'` and **nothing set it**,
 * so the map could only ever be empty. That is the exact shape `minute_claims`
 * was in between migration 072 and 087, and this module is the same fix applied
 * to the same defect — deliberately shaped after `review/claims.ts`, because an
 * operator should not have to learn two review concepts.
 *
 * Five rules the code enforces rather than assumes:
 *
 *  1. **The operator sees the quote in the line that carries it.** Every link
 *     that is not `inferred` carries `artifact_sha256`, `quote` and
 *     `quote_offset` — `place_links_citation_check` guarantees it — so the
 *     surrounding text is resolved and shipped with the item. Approving a pin
 *     you cannot see in situ is rubber-stamping, and an address is the easiest
 *     thing in a document to attach to the wrong item.
 *  2. **The precision is stated in words, not in a column value.** Every US
 *     Census match is a TIGER address-range interpolation, so `block` is the
 *     honest grade and `exact` is unreachable from that geocoder — see
 *     `locate/census.ts`. An operator approving a `block` pin is approving a
 *     block, and `PRECISION_MEANING` is where the screen gets that sentence
 *     from rather than inventing its own.
 *  3. **An `inferred` link can never be approved.** `wherePlaceLinkPublic`
 *     excludes it whatever its status, so writing `approved` on one would put a
 *     row in the database that says published and is invisible. The refusal is
 *     explicit and it is here, not in the console, so it holds for any caller.
 *  4. **Rejection is the same mechanism as holding.** `status = 'rejected'`
 *     fails the wall's `status = 'approved'` clause — one rule, one failure
 *     mode. There is no second flag and there must not be one.
 *  5. **Every decision appends to `record_corrections`**, in the same
 *     transaction as the write it describes, through the writer publication,
 *     corrections and the two other review paths already use. Migration 097
 *     widened that table's CHECK to admit `place_links`; two audit logs can
 *     disagree about what happened, and the one that disagreed would be
 *     believed at random.
 *
 * **There is no bulk approve.** A screen that approves forty pins in one click
 * publishes forty unread locations, each of them a street a reader will be told
 * a decision lands on. If throughput becomes binding, the answer is a better
 * single-link screen.
 *
 * ## Why approval emits no event
 *
 * `events.subject_kind` is `('meeting', 'finding', 'claim', 'document', 'ops')`
 * by migration 083's CHECK, widened to include `dispute` since; `place_link` is
 * not among them and `emitEvent` refuses an unknown kind before it reaches the
 * insert. Forcing a link through as one of the existing kinds would announce a
 * subject the payload is not about, and the delivery channels read `events` and
 * nothing else. So nothing is emitted here. A link's subject is announced when
 * *it* is published — the meeting publish path — which is the same reason
 * `approveClaim` stays silent for a claim on a withheld meeting.
 */

/* ---------------------------------------------------------------------------
   What a precision means, in words
   --------------------------------------------------------------------------- */

/**
 * The four sentences an operator may be shown about a coordinate, and the only
 * ones. Frozen and exhaustive over `PLACE_PRECISIONS`, asserted by a test that
 * iterates that constant — so a fifth precision added to migration 094 fails the
 * suite until somebody says what it means. An unexplained grade renders as a raw
 * column value, and "block" means nothing to a reader deciding whether a pin is
 * safe to publish.
 */
export const PRECISION_MEANING: Readonly<Record<PlacePrecision, string>> = Object.freeze({
  exact: "A surveyed or rooftop point: the building itself. No geocoder this project uses produces one.",
  block:
    "Interpolated along the street segment from its address range. The block is right; the building may be a few doors out. Every US Census match grades here.",
  centroid:
    "The centre of a larger shape — a segment or an area — not a point anyone surveyed. Draw it fuzzy.",
  jurisdiction:
    "The whole jurisdiction, and not a pin at all. Approving this says only that the decision is somewhere in this city or county.",
});

/* ---------------------------------------------------------------------------
   Reading
   --------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function isPlaceSubjectKind(value: unknown): value is PlaceSubjectKind {
  return (
    value === "agenda_item" || value === "meeting" || value === "document" || value === "finding"
  );
}

function precisionMeaning(precision: string): string | null {
  return (PLACE_PRECISIONS as readonly string[]).includes(precision)
    ? PRECISION_MEANING[precision as PlacePrecision]
    : null;
}

export interface PlaceLinkCitation {
  artifact_sha256: string;
  quote: string;
  quote_offset: number;
  /** Where we got the bytes. Null when no `artifacts` row holds this address. */
  source_url: string | null;
  /** Whether the cited bytes are actually stored. False blocks approval. */
  artifact_stored: boolean;
  /** The content-addressed viewer path, built by the claims path's own writer. */
  viewer_path: string;
  /** The quote in the line that carries it. Null when the text is not held. */
  context: QuoteContext | null;
}

export interface PlaceLinkSubject {
  kind: string;
  id: string;
  /** How the record names it: an item title, a document title, a meeting date. */
  label: string | null;
  /** The meeting this subject belongs to, where it has one. */
  meeting_id: string | null;
  /**
   * Whether a reader can already see the subject.
   *
   * `false` does **not** block approval. A link on a meeting an operator has
   * withheld is legitimately approvable — the wall keeps the pin off the map
   * until the meeting goes out — but an operator who is not told would read the
   * pin's later absence as a bug.
   */
  is_public: boolean;
}

export interface PlaceLinkReviewItem {
  link: {
    id: string;
    place_id: string;
    subject_kind: string;
    subject_id: string;
    relation: string;
    confidence: string;
    status: string;
    created_at: string;
    updated_at: string;
  };
  place: {
    id: string;
    jurisdiction_id: string;
    jurisdiction_name: string | null;
    kind: string;
    /** As printed in the record. Never normalised into something nobody wrote. */
    label: string;
    lat: number;
    lon: number;
    precision: string;
    /** What that precision means, in the project's own words. */
    precision_meaning: string | null;
    geocoder: string | null;
    geocoded_at: string | null;
    external_source: string | null;
    external_ref: string | null;
  };
  /** Null for an `inferred` link, which is permitted to carry no citation. */
  citation: PlaceLinkCitation | null;
  subject: PlaceLinkSubject;
  decision: {
    /** Whether `approvePlaceLink` would succeed right now. */
    approvable: boolean;
    /** Why not, in the operator's words. Null when approvable. */
    blocked_reason: string | null;
  };
}

const LINK_COLUMNS = [
  "place_links.id as id",
  "place_links.place_id as place_id",
  "place_links.subject_kind as subject_kind",
  "place_links.subject_id as subject_id",
  "place_links.relation as relation",
  "place_links.confidence as confidence",
  "place_links.status as status",
  "place_links.artifact_sha256 as artifact_sha256",
  "place_links.quote as quote",
  "place_links.quote_offset as quote_offset",
  "place_links.created_at as created_at",
  "place_links.updated_at as updated_at",
  "places.jurisdiction_id as jurisdiction_id",
  "places.kind as place_kind",
  "places.label as place_label",
  "places.lat as lat",
  "places.lon as lon",
  "places.precision as precision",
  "places.geocoder as geocoder",
  "places.geocoded_at as geocoded_at",
  "places.external_source as external_source",
  "places.external_ref as external_ref",
  "jurisdictions.name as jurisdiction_name",
];

function linkQuery(db: Knex): Knex.QueryBuilder {
  return db("place_links")
    .join("places", "places.id", "place_links.place_id")
    .leftJoin("jurisdictions", "jurisdictions.id", "places.jurisdiction_id");
}

/**
 * The bytes behind the citation, and the window an operator reads it in.
 *
 * The same two questions the claims path asks, in the same order: is there an
 * `artifacts` row at this content address, and do we hold text for it. A link
 * whose bytes are not stored cites nothing a reader could check, which is what
 * makes it unapprovable rather than merely awkward to review.
 *
 * `sliceContext` is imported rather than reimplemented. It locates the quote
 * whitespace-insensitively and reports when the stored offset disagrees with
 * where the quote actually is — and an operator told "here is the quote in
 * context" deserves that report on a pin exactly as much as on a sentence.
 */
async function loadCitation(
  db: Knex,
  row: Record<string, unknown>,
): Promise<PlaceLinkCitation | null> {
  const sha = textOrNull(row.artifact_sha256);
  const quote = textOrNull(row.quote);
  const offset = numberOrNull(row.quote_offset);
  // Only an `inferred` link may lack these; the CHECK enforces the rest.
  if (sha === null || quote === null || offset === null) return null;

  const base: PlaceLinkCitation = {
    artifact_sha256: sha,
    quote,
    quote_offset: offset,
    source_url: null,
    artifact_stored: false,
    viewer_path: viewerPath(sha, offset, quote.length),
    context: null,
  };

  const artifact: unknown = await db("artifacts").where({ sha256: sha }).first("id", "source_url");
  if (!isRecord(artifact)) return base;

  const stored: PlaceLinkCitation = {
    ...base,
    source_url: textOrNull(artifact.source_url),
    artifact_stored: true,
  };

  const textRow: unknown = await db("artifact_texts").where({ artifact_id: artifact.id }).first("text");
  if (!isRecord(textRow) || typeof textRow.text !== "string") return stored;

  return { ...stored, context: sliceContext(textRow.text, quote, offset) };
}

/**
 * What the link attaches to, named the way the record names it.
 *
 * One query per kind rather than a four-way join: `place_links.subject_id` is
 * polymorphic and deliberately not a foreign key, so there is no single table to
 * join to, and a `LEFT JOIN` per kind would produce a row of nulls for every
 * kind the link is not. A subject that no longer exists comes back with a null
 * label, which is a fact worth showing — the link records that a document said
 * something, and it survives the subject's deletion on purpose.
 */
async function loadSubject(
  db: Knex,
  linkId: string,
  kind: string,
  subjectId: string,
): Promise<PlaceLinkSubject> {
  const base: PlaceLinkSubject = {
    kind,
    id: subjectId,
    label: null,
    meeting_id: null,
    is_public: false,
  };
  if (!isPlaceSubjectKind(kind)) return base;

  const is_public = await placeLinkSubjectIsPublic(db, linkId);

  if (kind === "agenda_item") {
    const row: unknown = await db("agenda_items")
      .where({ id: subjectId })
      .first("title", "meeting_id");
    if (!isRecord(row)) return { ...base, is_public };
    return { ...base, is_public, label: textOrNull(row.title), meeting_id: textOrNull(row.meeting_id) };
  }

  if (kind === "meeting") {
    const row: unknown = await db("meetings").where({ id: subjectId }).first("date");
    if (!isRecord(row)) return { ...base, is_public };
    // Meetings have no title column — the date is how the record names one.
    return { ...base, is_public, label: asIsoOrNull(row.date), meeting_id: subjectId };
  }

  if (kind === "document") {
    const row: unknown = await db("meeting_documents")
      .where({ id: subjectId })
      .first("title", "meeting_id");
    if (!isRecord(row)) return { ...base, is_public };
    return { ...base, is_public, label: textOrNull(row.title), meeting_id: textOrNull(row.meeting_id) };
  }

  const row: unknown = await db("anomaly_flags")
    .where({ id: subjectId })
    .first("description", "meeting_id");
  if (!isRecord(row)) return { ...base, is_public };
  return {
    ...base,
    is_public,
    label: textOrNull(row.description),
    meeting_id: textOrNull(row.meeting_id),
  };
}

/** The refusals `approvePlaceLink` will make, computed for display. */
function approvalBlock(
  row: Record<string, unknown>,
  citation: PlaceLinkCitation | null,
): string | null {
  if (row.status !== "held") return `this link is ${text(row.status)}, not held`;
  if (row.confidence === "inferred") {
    return (
      "this link is inferred, and an inferred link is never public whatever its status. " +
      "Approving it would write a row that says published and shows nothing."
    );
  }
  if (citation === null) return "this link cites nothing";
  if (!citation.artifact_stored) {
    return "the bytes this link cites are not stored, so a reader could not check it";
  }
  return null;
}

async function toReviewItem(db: Knex, row: Record<string, unknown>): Promise<PlaceLinkReviewItem> {
  const citation = await loadCitation(db, row);
  const linkId = text(row.id);
  const subject = await loadSubject(db, linkId, text(row.subject_kind), text(row.subject_id));
  const blocked = approvalBlock(row, citation);

  return {
    link: {
      id: linkId,
      place_id: text(row.place_id),
      subject_kind: text(row.subject_kind),
      subject_id: text(row.subject_id),
      relation: text(row.relation),
      confidence: text(row.confidence),
      status: text(row.status),
      created_at: asIso(row.created_at),
      updated_at: asIso(row.updated_at),
    },
    place: {
      id: text(row.place_id),
      jurisdiction_id: text(row.jurisdiction_id),
      jurisdiction_name: textOrNull(row.jurisdiction_name),
      kind: text(row.place_kind),
      label: text(row.place_label),
      // float8 through `pg`; coerced so a driver handing back text cannot make a
      // coordinate a string in a JSON response. `places.ts` does the same.
      lat: Number(row.lat),
      lon: Number(row.lon),
      precision: text(row.precision),
      precision_meaning: precisionMeaning(text(row.precision)),
      geocoder: textOrNull(row.geocoder),
      geocoded_at: asIsoOrNull(row.geocoded_at),
      external_source: textOrNull(row.external_source),
      external_ref: textOrNull(row.external_ref),
    },
    citation,
    subject,
    decision: { approvable: blocked === null, blocked_reason: blocked },
  };
}

export function isPlaceLinkStatus(value: unknown): value is PlaceLinkStatus {
  return typeof value === "string" && (PLACE_LINK_STATUSES as readonly string[]).includes(value);
}

export interface PlaceLinkQueueFilters {
  status?: PlaceLinkStatus;
  subject_kind?: PlaceSubjectKind;
  place_id?: string;
  limit?: number;
  offset?: number;
}

export interface PlaceLinkQueueListing {
  data: PlaceLinkReviewItem[];
  total: number;
  counts: { held: number; approved: number; rejected: number };
}

/**
 * The queue. Oldest first, and no ranking.
 *
 * A pin has no severity and should not acquire one: every row is one address on
 * one record, and a ranking would invite an operator to work the top of the list
 * and leave the rest — the same reasoning the claims queue gives. Ties break on
 * `id` so two links written in the same transaction cannot swap places between
 * two reads of the same page.
 */
export async function listPlaceLinkQueue(
  db: Knex,
  filters: PlaceLinkQueueFilters = {},
): Promise<PlaceLinkQueueListing> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const base = linkQuery(db);
  if (filters.status !== undefined) base.where("place_links.status", filters.status);
  if (filters.subject_kind !== undefined) {
    base.where("place_links.subject_kind", filters.subject_kind);
  }
  if (filters.place_id !== undefined) base.where("place_links.place_id", filters.place_id);

  const countRow = await base.clone().count("* as total").first<{ total?: string } | undefined>();
  const total = Number(countRow?.total ?? 0);

  const rows = await base
    .clone()
    .select<Array<Record<string, unknown>>>(LINK_COLUMNS)
    .orderBy([
      { column: "place_links.created_at", order: "asc" },
      { column: "place_links.id", order: "asc" },
    ])
    .limit(limit)
    .offset(offset);

  const data: PlaceLinkReviewItem[] = [];
  for (const row of rows) data.push(await toReviewItem(db, row));

  // Counted over the whole table, not the filtered page: the row of counts says
  // what is waiting, and a number that changed when you filtered would answer a
  // question nobody asked.
  const tallies = await db("place_links")
    .select<Array<{ status: string; count: string }>>(["status", db.raw("count(*) as count")])
    .groupBy("status");

  const counts = { held: 0, approved: 0, rejected: 0 };
  for (const row of tallies) {
    const n = Number(row.count);
    if (row.status === "held") counts.held += n;
    else if (row.status === "approved") counts.approved += n;
    else if (row.status === "rejected") counts.rejected += n;
  }

  return { data, total, counts };
}

/** One link as the review screen sees it, or `null`. */
export async function getPlaceLinkReview(
  db: Knex,
  linkId: string,
): Promise<PlaceLinkReviewItem | null> {
  const row = await linkQuery(db)
    .where("place_links.id", linkId)
    .select<Array<Record<string, unknown>>>(LINK_COLUMNS)
    .first();
  if (row === undefined) return null;
  return toReviewItem(db, row);
}

/* ---------------------------------------------------------------------------
   Deciding
   --------------------------------------------------------------------------- */

export interface PlaceLinkDecisionInput {
  linkId: string;
  reason: string;
  actor: ReviewActor;
}

function requireReason(reason: string): void {
  if (reason.trim() === "") {
    throw new ReviewError(
      "reason is required: a decision without one is not a decision anyone can review",
      400,
    );
  }
}

async function loadForDecision(
  trx: Knex.Transaction,
  linkId: string,
): Promise<Record<string, unknown>> {
  const row: unknown = await trx("place_links").where({ id: linkId }).forUpdate().first();
  if (!isRecord(row)) throw new ReviewError("No place link with that id", 404);
  return row;
}

/**
 * Approval — the one thing that puts a pin on the map.
 *
 * Three refusals, each of them here rather than in the console so it holds for
 * any caller:
 *
 *  - **a link that is not held.** Re-approving an approved link or reviving a
 *    rejected one are both decisions somebody already made, and the log is where
 *    they are recorded.
 *  - **an `inferred` link.** `wherePlaceLinkPublic` excludes it whatever its
 *    status, so `approved` on such a row would be a status that means nothing —
 *    a row that says published and is invisible is a lie in the database, and
 *    the next person to read it would go looking for a bug in the wall. An
 *    inferred link is an operator-only lead; a lead is not a location.
 *  - **a citation whose bytes we do not hold.** No unsourced claim reaches the
 *    public site, and a content address with no artifact behind it is a citation
 *    a reader cannot follow. `place_links_citation_check` guarantees the address
 *    exists; only this can ask whether it resolves.
 *
 * An unpublished subject is **not** refused. See `PlaceLinkSubject.is_public`:
 * the wall already hides the pin, and refusing here would mean a link could only
 * ever be reviewed after its meeting was published — which is backwards.
 *
 * No event is emitted. See the module header: `place_link` is not an
 * `events.subject_kind`, and announcing it as one of the kinds it is not would
 * be worse than announcing nothing.
 */
export async function approvePlaceLink(
  db: Knex,
  input: PlaceLinkDecisionInput,
): Promise<PlaceLinkReviewItem> {
  requireReason(input.reason);

  await db.transaction(async (trx) => {
    const link = await loadForDecision(trx, input.linkId);
    if (link.status !== "held") {
      throw new ReviewError(
        `That link is ${text(link.status)}, so there is nothing to approve`,
        409,
      );
    }
    if (link.confidence === "inferred") {
      throw new ReviewError(
        "An inferred link is never public, whatever its status, so approving it would " +
          "record a decision with no effect. Keep it as a lead, or reject it.",
        409,
      );
    }

    const sha = textOrNull(link.artifact_sha256);
    if (sha === null || text(link.quote).trim() === "" || (numberOrNull(link.quote_offset) ?? -1) < 0) {
      throw new ReviewError(
        "That link cites nothing, so it cannot be approved. " +
          "No unsourced claim reaches the public site.",
        409,
      );
    }
    const artifact: unknown = await trx("artifacts").where({ sha256: sha }).first("id");
    if (!isRecord(artifact)) {
      throw new ReviewError(
        "The bytes that link cites are not stored, so a reader could not check it. " +
          "No unsourced claim reaches the public site.",
        409,
      );
    }

    await appendCorrectionRow(trx, {
      targetTable: "place_links",
      targetId: input.linkId,
      field: "status",
      oldValue: "held",
      newValue: "approved",
      reason: input.reason,
      actor: input.actor,
    });

    await trx("place_links")
      .where({ id: input.linkId })
      .update({ status: "approved", updated_at: trx.fn.now() });
  });

  const item = await getPlaceLinkReview(db, input.linkId);
  if (item === null) throw new ReviewError("No place link with that id", 404);
  return item;
}

/**
 * Rejection. The link becomes `rejected` and the wall never lets it through.
 *
 * It is unpublishable by exactly the rule that keeps a held link unpublishable —
 * `wherePlaceLinkPublic` asks for `status = 'approved'` and neither value is
 * that. There is no second mechanism, because a second mechanism is a second
 * thing that can be forgotten. What the distinct value buys is the console: an
 * operator can see what they have already refused instead of being offered it
 * back next week.
 *
 * An `inferred` link *may* be rejected, and that is deliberate. Approving one is
 * meaningless; refusing one is not — it says this lead is not worth carrying.
 */
export async function rejectPlaceLink(
  db: Knex,
  input: PlaceLinkDecisionInput,
): Promise<PlaceLinkReviewItem> {
  requireReason(input.reason);

  await db.transaction(async (trx) => {
    const link = await loadForDecision(trx, input.linkId);
    if (link.status !== "held") {
      throw new ReviewError(`That link is ${text(link.status)}, so there is nothing to reject`, 409);
    }

    await appendCorrectionRow(trx, {
      targetTable: "place_links",
      targetId: input.linkId,
      field: "status",
      oldValue: "held",
      newValue: "rejected",
      reason: input.reason,
      actor: input.actor,
    });

    await trx("place_links")
      .where({ id: input.linkId })
      .update({ status: "rejected", updated_at: trx.fn.now() });
  });

  const item = await getPlaceLinkReview(db, input.linkId);
  if (item === null) throw new ReviewError("No place link with that id", 404);
  return item;
}
