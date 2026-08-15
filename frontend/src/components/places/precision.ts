import { PLACE_PRECISIONS, type PlacePrecision } from "@/types";

/**
 * What `precision` means, and what it forbids.
 *
 * `exact`, `block`, `centroid` and `jurisdiction` are four different epistemic
 * objects. A geocoded street address and the centre of a subdivision are not
 * the same claim, and drawing them identically is lying at a resolution the
 * reader cannot see — the geography spec calls this the single most common way
 * civic maps mislead, and it is the reason the column exists at all.
 *
 * So the grade is not decoration on a pin. It sets three things:
 *
 *  - **the radius drawn**, in metres of real ground, so a block-level location
 *    physically covers a block and cannot be read as a building;
 *  - **the rounding of the distance**, because "437 m" from a centroid claims a
 *    metre the source never had. The near feed already rounds to 10 m for this
 *    reason (`services/feeds/query.ts`); this carries the same rule further out
 *    for the coarser grades;
 *  - **whether the place is placed at all.** A `jurisdiction` fallback has no
 *    position on the ground. It is not a fuzzy point, it is the absence of one,
 *    and it is listed rather than plotted.
 */

export interface PrecisionGrade {
  /** How the grade is named to a reader, not to the schema. */
  label: string;
  /** What the record actually supports, in a sentence. */
  sentence: string;
  /**
   * Metres of uncertainty the position carries, or `null` when the record
   * supports no position at all. Every number here is deliberately generous:
   * overstating our doubt costs a reader nothing, understating it is the
   * failure this file exists to prevent.
   */
  uncertainty_metres: number | null;
}

export const PRECISION_GRADES: Readonly<Record<PlacePrecision, PrecisionGrade>> = Object.freeze({
  exact: {
    label: "Exact",
    sentence: "Geocoded to the address printed in the record.",
    uncertainty_metres: 10,
  },
  block: {
    label: "Block",
    sentence: "Located to a block. Not a building, and not a doorway.",
    uncertainty_metres: 100,
  },
  centroid: {
    label: "Area centre",
    sentence:
      "The centre of an area, not a point on the ground. The decision is somewhere in that area.",
    uncertainty_metres: 250,
  },
  jurisdiction: {
    label: "Jurisdiction only",
    sentence:
      "The record names no address. All that is known is which jurisdiction this belongs to, so it is listed rather than placed.",
    uncertainty_metres: null,
  },
});

/**
 * Narrows the API's `precision: string` to a grade, or `null`.
 *
 * The route sends the column as text and the CHECK constraint is in the
 * database, where this code cannot see it. A cast would compile and would draw
 * a fifth value — say a stage-2 `parcel` — as whatever branch happened to fall
 * through. `null` instead, and the caller states that it does not know rather
 * than guessing a resolution.
 *
 * Written as a loop rather than `includes(...) ? (raw as PlacePrecision)`
 * because the loop returns the element itself, which is already narrow. The
 * ternary needs a cast to compile, and a cast is how a runtime check turns back
 * into an assertion the next time somebody edits around it.
 */
export function precisionOf(raw: string): PlacePrecision | null {
  for (const value of PLACE_PRECISIONS) {
    if (value === raw) return value;
  }
  return null;
}

/**
 * A distance stated no more finely than the position it describes.
 *
 * `null` when the grade carries no position, and when the precision is one this
 * build does not recognise: a distance from an unknown-precision point is a
 * number with no error bar, which is the thing being refused here.
 */
export function distanceText(metres: number, precision: PlacePrecision | null): string | null {
  if (precision === null) return null;
  const step = PRECISION_GRADES[precision].uncertainty_metres;
  if (step === null) return null;
  const rounded = Math.round(metres / step) * step;
  return `${rounded.toLocaleString("en-US")} m`;
}
