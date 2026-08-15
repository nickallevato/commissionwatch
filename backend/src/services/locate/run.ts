import type { Knex } from "knex";
import { locateQuote } from "../extraction/verify";
import { linkPlace, recordPlace } from "../places";
import { CENSUS_EXTERNAL_SOURCE, geocodeQuery, type Geocoder } from "./census";
import { extractAddresses, relationFor } from "./addresses";

/**
 * Turning an agenda into pins, with a citation on every one.
 *
 * Nothing written here is published. Every `place_link` is `held`, which is the
 * migration's default and is the same rule generated narrative lives under:
 * a link naming a specific street is an assertion about where a body's decision
 * lands, and it goes to the operator review queue before a reader sees it.
 *
 * Three properties this module exists to hold:
 *
 * **Every link carries a citation located in the bytes.** `place_links_citation_check`
 * refuses anything not `inferred` without a 64-hex artifact address, a non-empty
 * quote and a non-negative offset — "no unsourced claim reaches the public site"
 * written as a CHECK rather than as a convention. So the offset is *found*, the
 * way `verify.ts` finds a quotation, and a mention whose text cannot be located
 * in the artifact produces no link at all. It is not a smaller claim, it is one
 * this project does not make.
 *
 * **The offsets index into the same text as everything else.** `artifact-text.ts`
 * states the rule: there is one projection of a document and there must stay
 * one, because `minute_claims.quote_offset` and `transcript_cues.text_offset`
 * address it. The caller derives `documentText` from the artifact bytes with
 * `extractDocumentText(...).lines.join("\n")` — the same two calls
 * `handlers.ts` makes before writing `artifact_texts`, and the same ones
 * `governor/stage.ts` makes for its windows.
 *
 * **Re-running writes nothing new.** A place is keyed on the geocoder's own
 * spelling of the address (`external_source`/`external_ref`) so `recordPlace`
 * updates rather than duplicating, and the link is keyed on
 * `(place_id, subject_kind, subject_id, relation)` so `linkPlace` relinks. That
 * is not an optimisation: without a stable `external_ref` every sweep would mint
 * a new place row and a new held link, and the review queue would fill with the
 * same address over and over.
 */

/**
 * Characters of context kept on each side of the address in a citation.
 *
 * A quote that is only the address — "133 Maus Lane" — locates fine and proves
 * nothing about *which* item names it, which is the `MIN_QUOTE_LENGTH` failure
 * `verify.ts` describes: a check that passes and means nothing. The enclosing
 * line of the agenda is the item's own text, so that is what is quoted, trimmed
 * to these bounds when a line runs long.
 */
export const QUOTE_LEAD = 80;
export const QUOTE_TRAIL = 240;

export interface Citation {
  quote: string;
  /** Byte-exact: `documentText.slice(offset, offset + quote.length) === quote`. */
  offset: number;
}

/**
 * Where this address appears in the artifact, with the line around it.
 *
 * `null` when the phrase is not in the document. That happens legitimately —
 * `agenda_items.title` is clamped to 255 characters at parse time, and an HTML
 * agenda's line reconstruction can differ from the title stored beside it — and
 * it is the correct outcome, because a citation that cannot be resolved is not a
 * citation.
 */
export function citeInArtifact(documentText: string, phrase: string): Citation | null {
  const at = locateQuote(documentText, phrase);
  if (at === null) return null;

  const lineStart = documentText.lastIndexOf("\n", at) + 1;
  const rawEnd = documentText.indexOf("\n", at);
  const lineEnd = rawEnd === -1 ? documentText.length : rawEnd;

  const start = Math.max(lineStart, at - QUOTE_LEAD);
  const end = Math.min(lineEnd, at + phrase.length + QUOTE_TRAIL);

  const quote = documentText.slice(start, end);
  // The CHECK requires a non-blank quote, and a blank one would also be useless
  // to a reader. It cannot happen — the slice contains the phrase — but the
  // constraint is the authority and this keeps the failure here rather than at
  // the insert.
  if (quote.trim().length === 0) return null;

  return { quote, offset: start };
}

export interface AgendaArtifact {
  sha256: string;
  contentType: string | null;
  /** The source whose sweep captured these bytes. `ingestion_runs` needs it. */
  sourceId: string;
}

/**
 * The agenda for a meeting, or null.
 *
 * Chosen by the parse job's `documentType`, exactly as `findMinutesArtifact`
 * chooses minutes and for its reason: an agenda and a set of minutes for the
 * same meeting are both documents from the same host, and `agenda_items` were
 * read out of the agenda. Citing a title to the minutes would produce an offset
 * that resolves, in the wrong document.
 */
export async function findAgendaArtifact(
  db: Knex,
  meetingId: string,
): Promise<AgendaArtifact | null> {
  const row: unknown = await db("ingestion_jobs as j")
    .join("artifacts as a", db.raw("a.sha256 = j.target ->> 'sha256'"))
    .join("ingestion_runs as r", "j.run_id", "r.id")
    .where("j.stage", "parse")
    .whereRaw("j.target ->> 'meetingId' = ?", [meetingId])
    .whereRaw("lower(coalesce(j.target ->> 'documentType', '')) = 'agenda'")
    .orderBy("j.created_at", "desc")
    .first("a.sha256 as sha256", "a.content_type as content_type", "r.source_id as source_id");

  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.sha256 !== "string" || typeof value.source_id !== "string") return null;
  return {
    sha256: value.sha256,
    contentType: typeof value.content_type === "string" ? value.content_type : null,
    sourceId: value.source_id,
  };
}

export interface LocateInput {
  meetingId: string;
  /** The artifact the citations point at. */
  artifactSha256: string;
  /** Its text, in the one projection every other offset in this database uses. */
  documentText: string;
}

/**
 * What one run did, and what it declined to do and why.
 *
 * Every counter that is not `links` is a *refusal*, and they are separated
 * because they mean different things to an operator: an address the geocoder has
 * never heard of is a question about the record, a title that will not locate in
 * its own artifact is a question about the parser, and an ambiguous match is a
 * question for a human. "0 links" collapses all three into silence.
 */
export interface LocateTally {
  items: number;
  mentions: number;
  /** Mentions that could not be located in the artifact text. */
  uncited: number;
  /** Mentions the geocoder returned no single confident answer for. */
  unresolved: number;
  places: number;
  links: number;
}

interface ItemRow {
  id: string;
  title: string;
}

interface JurisdictionRow {
  id: string;
  name: string;
  state: string;
}

async function findJurisdiction(db: Knex, meetingId: string): Promise<JurisdictionRow | null> {
  const row: unknown = await db("meetings as m")
    .join("commissions as c", "c.id", "m.commission_id")
    .join("jurisdictions as jd", "jd.id", "c.jurisdiction_id")
    .where("m.id", meetingId)
    .first("jd.id as id", "jd.name as name", "jd.state as state");
  if (typeof row !== "object" || row === null) return null;
  const value = row as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.state !== "string"
  ) {
    return null;
  }
  return { id: value.id, name: value.name, state: value.state };
}

/**
 * Read every address out of a meeting's agenda items and record what resolves.
 *
 * The geocoder is called once per distinct query per run, not once per mention:
 * the same address appears in an annexation resolution and again in the zoning
 * ordinance that follows it, and asking a public service the same question twice
 * in one sweep is rude for no gain.
 */
export async function locateAgendaPlaces(
  db: Knex,
  geocoder: Geocoder,
  input: LocateInput,
): Promise<LocateTally> {
  const tally: LocateTally = {
    items: 0,
    mentions: 0,
    uncited: 0,
    unresolved: 0,
    places: 0,
    links: 0,
  };

  const jurisdiction = await findJurisdiction(db, input.meetingId);
  if (jurisdiction === null) return tally;

  const items = await db("agenda_items")
    .where({ meeting_id: input.meetingId })
    .orderBy([{ column: "item_number", order: "asc" }, { column: "id", order: "asc" }])
    .select<ItemRow[]>("id", "title");

  const geocoded = new Map<string, Awaited<ReturnType<Geocoder["locate"]>>>();
  const placeIds = new Set<string>();

  for (const item of items) {
    tally.items += 1;
    const relation = relationFor(item.title);

    for (const mention of extractAddresses(item.title)) {
      tally.mentions += 1;

      // The citation first. A mention that cannot be pointed at in the bytes is
      // not worth a request to somebody else's server, and it could not be
      // stored if it were.
      const citation = citeInArtifact(input.documentText, mention.text);
      if (citation === null) {
        tally.uncited += 1;
        continue;
      }

      const query = geocodeQuery(mention.text, jurisdiction);
      if (!geocoded.has(query)) {
        geocoded.set(query, await geocoder.locate(query));
      }
      const match = geocoded.get(query) ?? null;
      if (match === null) {
        tally.unresolved += 1;
        continue;
      }

      const place = await recordPlace(db, {
        jurisdiction_id: jurisdiction.id,
        kind: "address",
        // As printed in the record, never the geocoder's upper-cased rewrite.
        // The reader is shown what the agenda said.
        label: mention.text,
        lat: match.lat,
        lon: match.lon,
        precision: match.precision,
        // The authoritative dataset's own spelling is the identity, which is
        // what makes a second sweep an update instead of a duplicate.
        external_source: CENSUS_EXTERNAL_SOURCE,
        external_ref: match.matchedAddress,
        geocoder: match.geocoder,
        geocoded_at: new Date(),
      });
      if (!placeIds.has(place.id)) {
        placeIds.add(place.id);
        tally.places += 1;
      }

      await linkPlace(db, {
        place_id: place.id,
        subject_kind: "agenda_item",
        subject_id: item.id,
        relation,
        // The record names the location and the quote proves it. `matched` is
        // for a resolution against an authoritative *parcel* dataset, which is
        // stage 2; the geocoding provenance lives on the place, where
        // `geocoder`, `geocoded_at` and `precision` already carry it.
        confidence: "stated",
        artifact_sha256: input.artifactSha256,
        quote: citation.quote,
        quote_offset: citation.offset,
        // Explicit, though it is also the column default. Nothing naming a
        // location auto-publishes any more than a claim does.
        status: "held",
      });
      tally.links += 1;
    }
  }

  return tally;
}
