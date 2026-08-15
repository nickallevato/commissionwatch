import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { useMetrics } from "@/hooks/useMetrics";
import { Citation, type CitationRef } from "@/components/ui/Citation";
import { PRECISION_GRADES, distanceText, precisionOf } from "@/components/places/precision";
import { ProximityPlot, type PlottedPlace } from "@/components/places/ProximityPlot";
import { usePlaceDetails, usePlacesNear, type NearQuery } from "@/hooks/usePlaces";
import type { PlaceDetail, PlaceLinkView, PlaceNearResult, PlacePrecision } from "@/types";

/**
 * `/map` — what is happening near a point, and how we know.
 *
 * **There is no slippy map here, and that is a decision rather than a gap.**
 * `frontend/nginx.conf` serves `default-src 'self'` with no host allowed past
 * the origin: no `img-src` for a tile CDN, no `script-src` for an SDK, no
 * `connect-src` for a geocoder. Leaflet-with-OpenStreetMap, Mapbox and Google
 * would each be blocked by the browser and render a grey rectangle, and the
 * only way to get a real basemap under that policy is to self-host a tile
 * pyramid — a build-and-storage problem, not a frontend one, and not something
 * to fake in the meantime. The geography spec states the reason the policy
 * exists: a transparency site that tells a commercial mapping company exactly
 * which parcels each reader looked at has quietly built the surveillance layer
 * it was designed to avoid.
 *
 * So this page shows what the data actually contains — distance, direction,
 * precision and a citation — and shows it as a list with a figure beside it.
 * An honest list beats a map that is blocked and renders grey.
 *
 * Three rules run through everything below.
 *
 * **A position is never shown more precisely than the source supports.**
 * `precision` drives the mark, the wording and the rounding of the distance;
 * see `components/places/precision.ts`.
 *
 * **Nothing is drawn without its citation.** `/api/places/near` carries the
 * coordinate but not the links, so the page fetches each place's links and
 * draws only the places that come back with a quote, an artifact and an offset.
 * A pin is a claim about where a decision happened.
 *
 * **The browser is never asked where the reader is until the reader asks.**
 * `navigator.geolocation` is reached from a click handler and from nowhere
 * else. A coordinate typed into a box is the reader's choice; one taken on page
 * load is not, and `MapPage.test.tsx` asserts the negative rather than trusting
 * this comment.
 */

/** The API's own ceiling — `MAX_RADIUS_METRES` — and the steps below it. */
const RADIUS_OPTIONS = [250, 500, 1000, 2500, 5000] as const;

/** The geography spec's headline subscription: "anything within 500 metres". */
const DEFAULT_RADIUS = 500;

/**
 * `?near=lat,lon`, parsed the way `parseNear` in `backend/src/services/places.ts`
 * parses it, so a coordinate this page accepts is one the API accepts.
 *
 * `null` rather than a default on anything malformed. `Number("")` is 0, and a
 * silently defaulted coordinate puts the reader off the coast of Africa and
 * answers with an empty list that reads exactly like "nothing is happening near
 * you" — the confident wrong answer this feature must never give.
 */
function parseNear(raw: string): { lat: number; lon: number } | null {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (parts[0].trim() === "" || parts[1].trim() === "") return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  // A Bozeman longitude of -111 is not a latitude. The range check is the same
  // one `places_coords_check` enforces at write time and it is what catches the
  // classic swapped pair.
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function parseRadius(raw: string | null): number {
  const value = Number(raw);
  return RADIUS_OPTIONS.find((option) => option === value) ?? DEFAULT_RADIUS;
}

/** What a link's subject is, in the reader's words. Frozen labels, not prose. */
const SUBJECT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  agenda_item: "Agenda item",
  meeting: "Meeting",
  document: "Document",
  finding: "Finding",
});

/** What the link asserts about the place. */
const RELATION_PHRASE: Readonly<Record<string, string>> = Object.freeze({
  subject_of: "which names this place as its subject",
  located_at: "which places this record here",
  affects: "which says this place is affected",
});

/**
 * `confidence` is the honesty column, so it reaches the reader.
 *
 * `inferred` has no entry and needs none: `wherePlaceLinkPublic` excludes it
 * from every public path whatever its review status, because a lead an operator
 * thought worth following is not a sourced statement about where a decision
 * applies. If one ever appears here, the fallback says we do not know how it
 * was arrived at — which is the truth, and is not a sentence anybody would
 * publish on purpose.
 */
const CONFIDENCE_PHRASE: Readonly<Record<string, string>> = Object.freeze({
  stated: "The record names this location.",
  matched: "An address in the record was matched against an authoritative dataset.",
});

interface SourcedLink {
  ref: CitationRef;
  basis: string;
}

/**
 * The links of one place that may actually be shown, as citations.
 *
 * The three citation columns are nullable in the type because they are nullable
 * in the table — `place_links_citation_check` only requires them of a link that
 * is not `inferred`. A public link therefore carries all three in practice, and
 * this checks anyway: the alternative is a non-null assertion, and an assertion
 * is how "every place shows its citation" quietly becomes "every place shows a
 * citation unless the row was odd".
 */
function sourcedLinks(links: PlaceLinkView[]): SourcedLink[] {
  const out: SourcedLink[] = [];
  for (const link of links) {
    if (link.artifact_sha256 === null || link.quote === null || link.quote_offset === null) {
      continue;
    }
    const subject = SUBJECT_LABEL[link.subject_kind] ?? "Record";
    const relation = RELATION_PHRASE[link.relation] ?? "linked to this place";
    out.push({
      ref: {
        artifact_sha256: link.artifact_sha256,
        quote_offset: link.quote_offset,
        quote: link.quote,
        source_label: `${subject} — ${relation}`,
      },
      basis: CONFIDENCE_PHRASE[link.confidence] ?? "How this location was arrived at is not recorded.",
    });
  }
  return out;
}

interface ResolvedPlace {
  place: PlaceNearResult;
  /** `null` when the API sent a precision this build does not recognise. */
  precision: PlacePrecision | null;
  links: SourcedLink[];
}


/**
 * Why the radius came back empty, in the reader's terms.
 *
 * `undefined` counts mean the metrics request has not answered — which is a
 * fourth thing, and it must not borrow the wording of any of the other three.
 * Falling back to the most flattering reading of an unknown is exactly the
 * failure this component exists to prevent.
 */
function PlacesAbsence({
  totalPlaces,
  publicPlaces,
}: {
  totalPlaces: number | undefined;
  publicPlaces: number | undefined;
}) {
  if (totalPlaces === undefined || publicPlaces === undefined) {
    // `request-failed`, not `not-yet-ingested`. The two read almost the same in
    // a component tree and are opposite claims: "No sweep has collected located
    // decisions yet" is a definite statement about our collection, and we are
    // in this branch precisely because we could not ask. The first version of
    // this component used the wrong one and wrote the correction underneath it
    // as body copy, so a reader met both sentences and had to pick.
    // `request-failed` also carries `ours: true`, which is what makes the
    // component say this is our failure rather than a fact about the record.
    return (
      <Absence reason="request-failed" subject="Located decisions">
        Until that request answers we cannot tell an empty neighbourhood from a
        gap in our own collection, and we will not guess which.
      </Absence>
    );
  }

  if (totalPlaces === 0) {
    return (
      <Absence reason="not-yet-ingested" subject="located decisions">
        Nothing anywhere has been tied to a location yet. That is a statement
        about this project, not about your neighbourhood.
      </Absence>
    );
  }

  if (publicPlaces === 0) {
    // Held, not missing. Nothing naming a location is published before a person
    // reads it, exactly as nothing naming a person is.
    return (
      <Absence reason="not-reviewed" subject="located decisions">
        We have tied{" "}
        <span className="figure">{totalPlaces.toLocaleString("en-US")}</span>{" "}
        decisions to a place and none has been through review yet. A pin is a
        claim about where something happened, so a person checks it first.
      </Absence>
    );
  }

  // Now, and only now, is silence about the neighbourhood rather than about us.
  return (
    <Absence reason="none-exist" subject="located decisions near this point">
      <span className="figure">{publicPlaces.toLocaleString("en-US")}</span>{" "}
      located decisions are published elsewhere — try a wider radius.
    </Absence>
  );
}


/** Whether a resolved place has a position on the ground at all. */
function isPlaceable(resolved: ResolvedPlace): boolean {
  return (
    resolved.precision !== null &&
    PRECISION_GRADES[resolved.precision].uncertainty_metres !== null
  );
}

function PrecisionNote({ precision }: { precision: PlacePrecision | null }) {
  if (precision === null) {
    // Not silence, and not a guess at which grade was meant. A precision this
    // build does not know is a position it cannot honestly draw.
    return (
      <p className="mt-1 text-xs leading-relaxed text-muted">
        The record carries a location precision this page does not recognise, so
        the position is not drawn.
      </p>
    );
  }
  const grade = PRECISION_GRADES[precision];
  return (
    <p className="mt-1 text-xs leading-relaxed text-muted">
      <span className="label-sm text-ink">{grade.label}</span> — {grade.sentence}
    </p>
  );
}

function PlaceCard({
  resolved,
  index,
}: {
  resolved: ResolvedPlace;
  /** The number on the figure, or `null` for a place with no position. */
  index: number | null;
}) {
  const { place, precision, links } = resolved;
  const distance = distanceText(place.distance_metres, precision);

  return (
    <li className="border-b border-rule py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-medium leading-snug">
          {index === null ? null : (
            <span className="figure mr-2 text-muted">{index}</span>
          )}
          {place.label}
        </h2>
        {/* No distance at all where the precision does not support one. "About
          437 m" from an area centroid claims a metre the record never had. */}
        <span className="label-sm whitespace-nowrap text-muted">
          {distance === null ? "Distance not stated" : `About ${distance} away`}
        </span>
      </div>
      <PrecisionNote precision={precision} />
      {links.map((link) => (
        <Citation key={link.ref.artifact_sha256 + link.ref.quote_offset} citation={link.ref}>
          {link.basis}
        </Citation>
      ))}
    </li>
  );
}

export function MapPage() {
  // Only for the empty branch: a reader who gets results never needs it, and it
  // is a cheap cached read either way.
  const { data: metrics } = useMetrics();
  const [params, setParams] = useSearchParams();
  const near = params.get("near");
  const radius = parseRadius(params.get("radius"));
  const coordinate = near === null ? null : parseNear(near);

  const [draft, setDraft] = useState(near ?? "");
  const [draftError, setDraftError] = useState<string | null>(null);

  const query: NearQuery | null =
    coordinate === null ? null : { lat: coordinate.lat, lon: coordinate.lon, radius };
  const { data, isLoading, isError } = usePlacesNear(query);

  const places = data?.data ?? [];
  const details = usePlaceDetails(places.map((place) => place.id));
  const detailsPending = details.some((detail) => detail.isPending);

  /**
   * Only the places whose links came back with a citation.
   *
   * A place whose detail 404s, errors, or carries no citable link is dropped
   * rather than drawn without a source — and dropped silently is wrong too, so
   * the count of what was dropped is stated below the list.
   */
  const resolved: ResolvedPlace[] = [];
  places.forEach((place, position) => {
    const detail: PlaceDetail | undefined = details[position]?.data;
    if (detail === undefined) return;
    const links = sourcedLinks(detail.links);
    if (links.length === 0) return;
    resolved.push({ place, precision: precisionOf(place.precision), links });
  });

  const placed = resolved.filter(isPlaceable);
  const unplaced = resolved.filter((entry) => !isPlaceable(entry));
  // Only once every detail has answered. Mid-flight the difference is not
  // "held back for want of a source", it is "not asked yet", and a count that
  // ticks down as requests land would report the second as the first.
  const withheldForNoSource =
    isLoading || detailsPending ? 0 : places.length - resolved.length;

  const plotted: PlottedPlace[] = placed.map((entry) => ({
    id: entry.place.id,
    label: entry.place.label,
    lat: entry.place.lat,
    lon: entry.place.lon,
    // Narrowed by `isPlaceable`, which the type system cannot carry across a
    // filter. Recomputed rather than asserted: `precisionOf` is cheap and a
    // second `precisionOf` cannot disagree with the first, whereas a `!` can be
    // left behind when the filter changes.
    precision: precisionOf(entry.place.precision) ?? "jurisdiction",
    distance_metres: entry.place.distance_metres,
  }));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseNear(draft);
    if (parsed === null) {
      setDraftError(
        "That is not a coordinate. Give a latitude and a longitude separated by a comma — for example 45.6796, -111.0386.",
      );
      return;
    }
    setDraftError(null);
    setParams({ near: `${parsed.lat},${parsed.lon}`, radius: String(radius) }, { replace: true });
  }

  function onRadiusChange(value: number) {
    if (near === null) return;
    setParams({ near, radius: String(value) }, { replace: true });
  }

  /**
   * The only path to `navigator.geolocation` in this application.
   *
   * It is a click handler, it is never called on mount, and there is no effect
   * anywhere on this page that touches it.
   *
   * The coordinate is rounded to **three** decimals — about 110 m. Four was the
   * first answer and it was the wrong one: eleven metres is a doorstep, and the
   * argument written down for it, that eleven metres is far finer than the
   * smallest radius offered, is an argument for coarsening further rather than
   * for stopping there. The smallest search this page offers is a 250 m radius,
   * so a centre good to 110 m returns materially the same decisions while not
   * writing a reader's house into their browser history and into a URL they may
   * later share. A reader who wants an exact centre can type one; nobody is
   * prevented from being precise about themselves on purpose.
   */
  function requestMyLocation() {
    if (!("geolocation" in navigator)) {
      setDraftError(
        "This browser will not share a location. Type a coordinate instead — it does the same thing.",
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude.toFixed(3));
        const lon = Number(position.coords.longitude.toFixed(3));
        setDraft(`${lat}, ${lon}`);
        setDraftError(null);
        setParams({ near: `${lat},${lon}`, radius: String(radius) }, { replace: true });
      },
      () => {
        setDraftError(
          "The browser did not share a location. Type a coordinate instead — it does the same thing.",
        );
      },
    );
  }

  return (
    <div>
      <header>
        <p className="kicker">The record</p>
        <h1 className="headline mt-1">Nearby</h1>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Decisions that name a place, listed by how far they are from a point
          you choose. Every one carries the quotation it was read from and the
          precision of its location, because a location on a public record is a
          claim like any other.
        </p>
      </header>

      <div className="rule-hi mt-6" />

      <form
        onSubmit={onSubmit}
        aria-label="Find located decisions near a point"
        className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-rule py-4"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="near-coordinate" className="label-sm">
            Latitude, longitude
          </label>
          <input
            id="near-coordinate"
            type="text"
            inputMode="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="45.6796, -111.0386"
            className="min-w-0 rounded-none border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted hover:border-ink focus:border-ink"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="near-radius" className="label-sm">
            Within
          </label>
          <select
            id="near-radius"
            value={radius}
            onChange={(event) => onRadiusChange(Number(event.target.value))}
            className="rounded-none border border-rule bg-paper px-2 py-2 text-sm text-ink focus:border-ink"
          >
            {RADIUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option.toLocaleString("en-US")} m
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="border border-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-ink hover:bg-ink hover:text-paper"
        >
          Show what is near
        </button>
        {/* A button, never an effect. The browser is asked where the reader is
          only because the reader pressed the thing that asks. */}
        <button
          type="button"
          onClick={requestMyLocation}
          className="border border-rule px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink"
        >
          Use my location
        </button>
      </form>

      {draftError === null ? null : (
        <p role="alert" className="mt-3 max-w-prose text-sm text-accent">
          {draftError}
        </p>
      )}

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
        The coordinate goes to this site&apos;s own API and to no one else. No
        map tiles, imagery or fonts are fetched from a third party anywhere on
        this page — the site&apos;s content policy does not permit it — so no
        mapping company learns which streets you looked at.
      </p>

      {coordinate === null ? (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          Give a coordinate to see which decisions on the record name a place
          near it.
        </p>
      ) : isError ? (
        /* A failure of ours, not an empty neighbourhood. */
        <Absence reason="request-failed" subject="Located decisions" />
      ) : isLoading || detailsPending ? (
        <p className="border-b border-rule py-12 text-center text-sm text-muted">
          Looking for located decisions…
        </p>
      ) : resolved.length === 0 ? (
        /* Three states, not two — and the distinction is the whole point.
        
          "Nothing near you" is a statement about a neighbourhood. "We have
          located nothing anywhere" and "we have located things and nobody has
          approved them yet" are statements about us. Rendering all three as the
          same empty result tells a reader their area is quiet when the truth is
          that we have not looked, which is the strongest available claim on the
          weakest possible evidence.
        
          This branch was `not-yet-ingested` unconditionally until
          `/api/metrics` grew `places_total` and `places_public`; the comment
          that stood here said the honest distinction needed a signal that did
          not exist, and named the one it needed. It exists now. */
        <PlacesAbsence
          totalPlaces={metrics?.quality.places_total}
          publicPlaces={metrics?.quality.places_public}
        />
      ) : (
        <>
          {placed.length > 0 ? (
            <ProximityPlot centre={coordinate} radius={radius} places={plotted} />
          ) : null}

          <ul className="mt-2">
            {placed.map((entry, index) => (
              <PlaceCard key={entry.place.id} resolved={entry} index={index + 1} />
            ))}
            {unplaced.map((entry) => (
              <PlaceCard key={entry.place.id} resolved={entry} index={null} />
            ))}
          </ul>
        </>
      )}

      {/* Stated rather than swallowed. A place we hold but cannot source is not
        drawn, and a reader comparing this list against the agendas deserves to
        know the difference between "there are none" and "we have one we cannot
        stand behind". */}
      {withheldForNoSource > 0 ? (
        <p className="mt-6 max-w-prose text-xs leading-relaxed text-muted">
          <span className="figure">{withheldForNoSource}</span>{" "}
          {withheldForNoSource === 1 ? "location is" : "locations are"} held back
          here because no quotation from a published record could be shown for{" "}
          {withheldForNoSource === 1 ? "it" : "them"}. Nothing on this site is
          drawn on a map without its source.
        </p>
      ) : null}

      {/* The subscription this whole feature exists for.

        A plain <a>, not a Link: /feed.xml is served by the backend and is not a
        route in this app, so client-side navigation would 404 inside the SPA.
        Offered whenever the reader has given a coordinate, including when the
        answer is empty — an empty neighbourhood today is precisely the one
        worth watching, and a subscription that only appears once something has
        already happened is a subscription for people who were watching anyway. */}
      {coordinate === null ? null : (
        <p className="mt-6 max-w-prose text-xs leading-relaxed text-muted">
          <a
            href={`/feed.xml?near=${encodeURIComponent(`${coordinate.lat},${coordinate.lon}`)}&radius=${radius}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            Subscribe to this area
          </a>{" "}
          — a feed of anything new on the record within{" "}
          {radius.toLocaleString("en-US")} metres of that point. No account, no
          email address, and we keep no record of who is subscribed: the URL is
          the subscription, and it lives in your reader rather than in our
          database.
        </p>
      )}
    </div>
  );
}
