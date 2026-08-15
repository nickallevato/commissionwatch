import type { PlacePrecision } from "@/types";
import { PRECISION_GRADES } from "./precision";

/**
 * Distance and direction from the reader's own point. **Not a street map.**
 *
 * There is no basemap here and there is not going to be one. `frontend/nginx.conf`
 * serves `default-src 'self'` with no host allowed beyond the origin — no
 * `img-src` for a tile CDN, no `connect-src` for an SDK — so a commercial map
 * library would be blocked by the browser and render grey, visibly, and that is
 * the mechanism working as designed. The geography spec gives the reason: a
 * transparency site that tells a commercial mapping company exactly which
 * parcels each reader looked at has quietly built the surveillance layer it was
 * designed to avoid.
 *
 * So this draws the part of the data that is actually true — how far away each
 * located decision is, and in which direction — and draws nothing it does not
 * have. No streets, no buildings, no boundaries, no imagery. A reader is never
 * shown a shape this project cannot source.
 *
 * Two things make it honest rather than merely tile-free:
 *
 *  - **Every mark is drawn at its own uncertainty**, in metres of real ground,
 *    scaled by the same factor as the rings. A `block` place is a hundred-metre
 *    circle because that is what a block-level geocode knows; it cannot be
 *    mistaken for a pin on a building because it is not one.
 *  - **A `jurisdiction`-precision place is not here at all.** It has no
 *    position, and a mark in the middle of the circle would invent one. The
 *    caller lists those separately.
 *
 * The numbers correspond to the list beneath it. The plot is an index into the
 * record; the list is the record.
 */

export interface PlottedPlace {
  id: string;
  label: string;
  lat: number;
  lon: number;
  /** Already narrowed, and already known to carry an uncertainty in metres. */
  precision: PlacePrecision;
  distance_metres: number;
}

export interface ProximityPlotProps {
  centre: { lat: number; lon: number };
  /** The radius that was asked for, in metres. The outer ring. */
  radius: number;
  places: PlottedPlace[];
}

/** Half the viewBox, in user units. The outer ring sits at `RING`. */
const HALF = 100;
const RING = 88;

/**
 * Metres per degree, near enough at this scale.
 *
 * A flat projection is wrong over a continent and irrelevantly wrong over five
 * kilometres, which is the ceiling the API enforces (`MAX_RADIUS_METRES`).
 * 111,320 m per degree of longitude at the equator, narrowed by the cosine of
 * the centre's latitude; 110,540 m per degree of latitude. The alternative is a
 * projection library shipped to draw a circle 5 km across.
 */
const METRES_PER_DEGREE_LAT = 110_540;
const METRES_PER_DEGREE_LON = 111_320;

interface Offset {
  east: number;
  north: number;
}

function offsetMetres(centre: { lat: number; lon: number }, place: PlottedPlace): Offset {
  const cosLat = Math.cos((centre.lat * Math.PI) / 180);
  return {
    east: (place.lon - centre.lon) * METRES_PER_DEGREE_LON * cosLat,
    north: (place.lat - centre.lat) * METRES_PER_DEGREE_LAT,
  };
}

export function ProximityPlot({ centre, radius, places }: ProximityPlotProps) {
  const scale = RING / radius;

  return (
    <figure className="mt-6 border-y border-rule py-5">
      <svg
        viewBox="0 0 200 200"
        role="img"
        aria-label={`Distance and direction of ${places.length} located ${
          places.length === 1 ? "decision" : "decisions"
        } from the point you gave, within ${radius.toLocaleString("en-US")} metres. Each is listed below with its source.`}
        className="mx-auto block h-64 w-64 max-w-full sm:h-80 sm:w-80"
      >
        {/* The rings are the only measure on the figure, so they are labelled.
          An unlabelled circle is a decoration a reader has to guess at. */}
        <circle
          cx={HALF}
          cy={HALF}
          r={RING}
          fill="none"
          stroke="var(--cw-rule)"
          strokeWidth={1}
        />
        <circle
          cx={HALF}
          cy={HALF}
          r={RING / 2}
          fill="none"
          stroke="var(--cw-rule)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <text x={HALF + 2} y={HALF - RING + 9} fill="var(--cw-muted)" fontSize={7}>
          {radius.toLocaleString("en-US")} m
        </text>
        <text x={HALF + 2} y={HALF - RING / 2 + 9} fill="var(--cw-muted)" fontSize={7}>
          {Math.round(radius / 2).toLocaleString("en-US")} m
        </text>
        <text
          x={HALF}
          y={10}
          fill="var(--cw-muted)"
          fontSize={8}
          textAnchor="middle"
          fontWeight={600}
        >
          N
        </text>

        {/* The reader's own point. A cross rather than a dot, so it cannot be
          read as one of the results. */}
        <path
          d={`M${HALF - 4} ${HALF}H${HALF + 4}M${HALF} ${HALF - 4}V${HALF + 4}`}
          stroke="var(--cw-accent)"
          strokeWidth={1.2}
        />

        {places.map((place, index) => {
          const { east, north } = offsetMetres(centre, place);
          const x = HALF + east * scale;
          // SVG y grows downward and north does not, so this subtracts.
          const y = HALF - north * scale;
          const grade = PRECISION_GRADES[place.precision];
          // Non-null by the caller's contract; the `?? 0` is what keeps that
          // contract from needing an assertion here, and a zero-metre mark
          // still renders at the 2.5-unit floor below rather than vanishing.
          const uncertainty = grade.uncertainty_metres ?? 0;
          const drawn = Math.max(2.5, uncertainty * scale);
          const exact = place.precision === "exact";

          return (
            <g key={place.id}>
              <circle
                cx={x}
                cy={y}
                r={drawn}
                // An exact geocode is a point and is drawn solid. Anything
                // coarser is drawn as the area it actually knows about —
                // unfilled and dashed, so it reads as an extent rather than as
                // a bigger, more important pin.
                fill={exact ? "var(--cw-ink)" : "none"}
                stroke="var(--cw-ink)"
                strokeWidth={exact ? 0 : 1}
                strokeDasharray={exact ? undefined : "2 2"}
              />
              <text
                x={x + drawn + 2}
                y={y + 3}
                fill="var(--cw-ink-soft)"
                fontSize={8}
                fontWeight={600}
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="mx-auto mt-3 max-w-prose text-xs leading-relaxed text-muted">
        Distance and direction from the point you gave — north is up. This is not
        a street map: no basemap, no imagery and no tiles are loaded, from this
        site or from anywhere else, so nothing about what you looked at leaves
        your browser except the coordinate you typed. Each circle is drawn at the
        size of its own uncertainty, so a block-level location covers a block.
      </figcaption>
    </figure>
  );
}
