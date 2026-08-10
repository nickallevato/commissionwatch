import type { NameMatchBand } from "@/types";

/**
 * How a name-match band reads, in words.
 *
 * Kept apart from `MatchQuality.tsx` so that file exports components and
 * nothing else — a module mixing the two costs fast refresh, and the lint rule
 * that says so is not one to silence.
 *
 * **None of these words is "confirmed", "verified", "identified", "proven" or
 * "exact", and none may become one.** `strong` is the ceiling of the matcher's
 * method and the ceiling of that method is still a name: two different companies
 * really can be called the same thing. Tests on the public officials page, on
 * the operator review queue and in the backend all hold this lexicon, because it
 * is the difference between reporting a record and accusing a person.
 */
export const BAND_LABEL: Record<NameMatchBand, string> = {
  weak: "Weak name match",
  moderate: "Possible name match",
  strong: "Close name match",
};

/**
 * Short forms, for a filter control where the full label will not fit.
 *
 * Still words rather than colours, and still none of them a claim of identity.
 */
export const BAND_SHORT_LABEL: Record<NameMatchBand, string> = {
  weak: "Weak",
  moderate: "Possible",
  strong: "Close",
};

/** Border and text colour per band. The second signal, never the only one. */
export const BAND_CLASS: Record<NameMatchBand, string> = {
  weak: "border-rule text-muted",
  moderate: "border-sev3 text-sev3",
  strong: "border-ink text-ink",
};
