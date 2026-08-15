import { setTimeout as delay } from "node:timers/promises";
import type { PlacePrecision } from "../places";

/**
 * Coordinates for an address, from the US Census geocoder.
 *
 * ## Why this service and no other
 *
 * The geography spec sets three constraints and this is the only free option
 * that meets all of them. The terms must permit **storing** the result, because
 * geocoding at render time tells a third party which parcels each reader looked
 * at and turns a transparency site into the surveillance layer it exists to
 * avoid — and it breaks the map when a quota runs out. **No API key may ship to
 * the browser**, and nothing here needs a key at all. And the result must be
 * re-checkable, which is why `places.geocoder` and `places.geocoded_at` are
 * written with every coordinate: a point with no account of where it came from
 * is a claim nobody can audit.
 *
 * The Census geocoder is a US federal government service, public domain, and
 * keyless. Nominatim's usage policy forbids heavy automated use, which rules it
 * out for a corpus sweep.
 *
 * ## Probed 2026-08-15, not read about
 *
 * ```
 * GET https://geocoding.geo.census.gov/geocoder/locations/onelineaddress
 *     ?address=133+Maus+Lane%2C+Bozeman%2C+MT&benchmark=Public_AR_Current&format=json
 * -> 200, 630 bytes
 * {"result":{"input":{...},"addressMatches":[{
 *    "tigerLine":{"side":"L","tigerLineId":"640478172"},
 *    "coordinates":{"x":-111.043593591292,"y":45.701959309284},
 *    "addressComponents":{"zip":"59715","streetName":"MAUS","suffixType":"LN",
 *                         "city":"BOZEMAN","state":"MT",
 *                         "fromAddress":"101","toAddress":"199", ...},
 *    "matchedAddress":"133 MAUS LN, BOZEMAN, MT, 59715"}]}}
 * ```
 *
 * Four real Bozeman addresses off the 2026-08-04 agenda resolved: 133 Maus Lane,
 * 1071 Story Mill Road, 5211 Baxter Lane and 121 North Rouse. A deliberately
 * fake one — "99999 Nowhere Boulevard, Bozeman, MT" — answered **200 with an
 * empty `addressMatches`**, which is why "no match" is a shape to read and not
 * an HTTP status to catch.
 *
 * Two things that probe settled, which reading the documentation would not have:
 *
 * **`x` is longitude and `y` is latitude.** Storing them in the order they
 * appear puts Bozeman in the Indian Ocean, and `places_coords_check` would
 * reject it — loudly, which is the point of that constraint.
 *
 * **A county jurisdiction must not send its name as the city.** "133 Maus Lane,
 * Gallatin County, MT" returned **zero** matches; "5211 Baxter Lane, MT" — state
 * only — returned the same match as the city-qualified query. `geocodeQuery`
 * below encodes that, and it is the difference between a county's agenda
 * producing pins and producing nothing at all.
 *
 * ## Precision is never `exact`
 *
 * Every match above carries a `tigerLine`. That is address-range interpolation:
 * the geocoder knows the block runs 101–199 and places number 133 proportionally
 * along the segment. It is not a rooftop and it is not a parcel. So this client
 * returns `block`, never `exact`, and `censusPrecision` is the one place that
 * decides it. **Never draw a point more precisely than the source supports** —
 * migration 094 says why, and drawing a TIGER interpolation as a rooftop pin is
 * the most common way a civic map misleads.
 */

export const CENSUS_GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** The current public address-range benchmark, as returned by the probe. */
export const CENSUS_BENCHMARK = "Public_AR_Current";

/** Recorded on `places.geocoder`. Names the service *and* the benchmark. */
export const CENSUS_GEOCODER_NAME = `us-census/${CENSUS_BENCHMARK}`;

/** Recorded on `places.external_source`, beside the matched address. */
export const CENSUS_EXTERNAL_SOURCE = "us-census-geocoder";

/**
 * Honest, and it names the project. The scraping-conduct rule applies to a
 * geocoder as much as to a county web server: we are a guest on a public
 * service, and a spoofed browser identity is not politeness with an asterisk.
 */
export const GEOCODER_USER_AGENT =
  "CommissionWatch/1.0 (civic transparency; https://commissionwatch.bmux.sh)";

/**
 * Seconds between requests, because this is a public service we do not pay for.
 *
 * One per second, serial. The corpus is hundreds of agenda items, not millions,
 * so the sweep finishes in minutes either way and the difference is entirely in
 * what we cost somebody else. Paired with `LOCATE_CONCURRENCY = 1`: a knob that
 * spaces requests is worthless beside a loop that runs eight of them at once.
 */
export const GEOCODER_MIN_INTERVAL_MS = 1_000;

/** Long enough for a slow federal endpoint, short enough to fail a stage. */
export const GEOCODER_TIMEOUT_MS = 15_000;

export interface GeocodeResult {
  lat: number;
  lon: number;
  precision: PlacePrecision;
  /** The address as the authoritative dataset spells it. The dedupe key. */
  matchedAddress: string;
  /** Which service and benchmark. Written to `places.geocoder`. */
  geocoder: string;
}

/**
 * The narrow port the locate stage depends on.
 *
 * An interface rather than the class, so the suite can supply coordinates
 * without a network call — the same injection `OpenRouterClient.fetchImpl`
 * exists for. A test that reaches the internet is a test that fails when the
 * internet does, and this one would also be rude.
 */
export interface Geocoder {
  /** Coordinates, or `null` when the service has no single confident answer. */
  locate(query: string): Promise<GeocodeResult | null>;
}

/**
 * The one-line query string for an address in a jurisdiction.
 *
 * A county name is omitted, not passed as the city — see the probe above. A
 * "City of Bozeman" / "Town of X" prefix is stripped because the geocoder wants
 * the place name, not the corporate one.
 */
export function geocodeQuery(
  address: string,
  jurisdiction: { name: string; state: string },
): string {
  const bare = jurisdiction.name.replace(/^(?:the\s+)?(?:city|town|village)\s+of\s+/i, "").trim();
  const isCounty = /\bcounty\b/i.test(bare);
  const parts = isCounty ? [address, jurisdiction.state] : [address, bare, jurisdiction.state];
  return parts.filter((part) => part.length > 0).join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The precision a Census match actually supports.
 *
 * `tigerLine` present means the point was interpolated along a street segment
 * from an address range: `block`. Absent, the service gave a coordinate without
 * saying which segment produced it, and the weakest honest reading is
 * `centroid`. **`exact` is unreachable from here**, and a test asserts it —
 * this geocoder does not do rooftop matching, and a column that said otherwise
 * would be a lie the renderer would faithfully draw.
 */
export function censusPrecision(match: Record<string, unknown>): PlacePrecision {
  return isRecord(match.tigerLine) ? "block" : "centroid";
}

/**
 * One confident match, or `null`.
 *
 * `null` covers three different facts and they are deliberately collapsed here,
 * because the caller does the same thing with all of them — write no place:
 *
 *  - the response has no matches (the probed shape for an address that is not
 *    real: HTTP 200, `addressMatches: []`);
 *  - it has several that disagree, which means the record's address is ambiguous
 *    and picking the first would be a coin toss rendered as a pin;
 *  - a match arrived without usable coordinates.
 *
 * Repeated identical `matchedAddress` values are *not* ambiguity — the service
 * returns the same address twice for a street with two sides — so they collapse
 * to one answer.
 */
export function readCensusResponse(body: unknown): GeocodeResult | null {
  if (!isRecord(body)) return null;
  const result = body.result;
  if (!isRecord(result)) return null;
  const matches = result.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const distinct = new Set<string>();
  for (const match of matches) {
    if (!isRecord(match)) continue;
    if (typeof match.matchedAddress === "string") distinct.add(match.matchedAddress);
  }
  if (distinct.size > 1) return null;

  const first = matches.find((match): match is Record<string, unknown> => isRecord(match));
  if (first === undefined) return null;

  const coordinates = first.coordinates;
  if (!isRecord(coordinates)) return null;
  // `x` is longitude and `y` is latitude. Reversing them is the classic geodata
  // bug and `places_coords_check` is what catches it if this ever drifts.
  const lon = numberOf(coordinates.x);
  const lat = numberOf(coordinates.y);
  if (lat === null || lon === null) return null;

  const matchedAddress =
    typeof first.matchedAddress === "string" && first.matchedAddress.trim().length > 0
      ? first.matchedAddress.trim()
      : null;
  if (matchedAddress === null) return null;

  return {
    lat,
    lon,
    precision: censusPrecision(first),
    matchedAddress,
    geocoder: CENSUS_GEOCODER_NAME,
  };
}

export interface CensusGeocoderOptions {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
}

/** Raised when the service itself failed. Distinct from "no match". */
export class GeocoderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GeocoderError";
  }
}

export class CensusGeocoder implements Geocoder {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;

  constructor(options: CensusGeocoderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? CENSUS_GEOCODER_URL;
    this.minIntervalMs = options.minIntervalMs ?? GEOCODER_MIN_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? GEOCODER_TIMEOUT_MS;
  }

  async locate(query: string): Promise<GeocodeResult | null> {
    await this.pace();

    const url = new URL(this.baseUrl);
    url.searchParams.set("address", query);
    url.searchParams.set("benchmark", CENSUS_BENCHMARK);
    url.searchParams.set("format", "json");

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { accept: "application/json", "user-agent": GEOCODER_USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A network failure is retryable and the queue's backoff is what should
      // handle it, so it is raised rather than turned into "no match" — a
      // silently unlocatable corpus is the failure this project keeps writing
      // ledgers to avoid.
      throw new GeocoderError(
        `the Census geocoder could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }

    if (!response.ok) {
      throw new GeocoderError(
        `the Census geocoder answered ${response.status} for ${query}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GeocoderError("the Census geocoder returned a body that is not JSON", null);
    }

    return readCensusResponse(body);
  }

  /** Holds the request rate down to one every `minIntervalMs`. */
  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const waitMs = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (waitMs > 0) await delay(waitMs);
    this.lastRequestAt = Date.now();
  }
}
