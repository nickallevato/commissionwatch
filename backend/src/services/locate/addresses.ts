import { parseDesignator } from "../matters";
import type { PlaceRelation } from "../places";

/**
 * Reading a location out of an agenda item title, deterministically.
 *
 * An address is a formatted string and a model is the wrong tool for a
 * well-formed pattern — the geography spec says so, and `verify.ts` shows what
 * the alternative costs: every model output has to be located in the bytes
 * before it can be stored, and a regex that matched the bytes in the first place
 * skips a step that can only lose.
 *
 * ## Tuned against the record, not against imagination
 *
 * Written against Bozeman's real City Commission agenda for 2026-08-04, held at
 * `test/fixtures/bozeman-granicus/agendaviewer-clip2784.html`. The titles it has
 * to survive:
 *
 *   "Resolution, Adoption of the 133 Maus Lane Annexation, Annexing 5.13 acres
 *    Including Adjacent Right-of-Way, Application 25213"
 *   "Resolution, Adoption of the 1071 Story Mill Road Annexation, Annexing 1.173
 *    acres, Application 25525"
 *   "Ordinance, Provisional Adoption, Establishing Zoning Designations of R-5
 *    (RD) ... the 5211 Baxter Lane Annexation, Generally Located at the
 *    Northwest Corner of Baxter Lane and Harper Pucket Road, Application 24570"
 *   "Authorize the City Manager to Sign Task Order 5 with Cushing Terrell for
 *    Analysis of a Housing Site in the Turnrow Subdivision"
 *   "Resolution Authorizing Change Order No. 5 with CK May Excavating, Inc. For
 *    the 2024 Street and Utility Improvements Project"
 *   "Authorize the Mayor to Approve the CDBG Program Year 3 Annual Action Plan"
 *
 * Four rules fall out of that list and each of them is there because a real
 * title would otherwise produce a pin on a map:
 *
 * 1. **A street suffix is required.** "Annexing 5.13 acres" and "Program Year 3
 *    Annual Action Plan" are a number followed by capitalised words, and without
 *    a closed suffix list both are addresses. The cost is stated rather than
 *    hidden: "Commission Room, City Hall, 121 North Rouse" — the meeting's own
 *    address, printed with no suffix at all — is **not** matched. That is the
 *    right trade for a public map, where a wrong pin is worse than a missing one.
 * 2. **The suffix ends the address.** "133 Maus Lane Annexation" is an address
 *    followed by a noun, and the greedy reading swallows the noun into the
 *    street name. The pattern therefore backtracks to the first token that is a
 *    suffix and stops.
 * 3. **A number may not be part of a decimal.** "Annexing 1.173 acres" contains
 *    "173" and "5.13 Acres" contains "13"; a lookbehind for a dot or a word
 *    character keeps both out.
 * 4. **`2024 Street and Utility Improvements Project` is not an address**, and it
 *    survives rule 2: "Street" is a suffix, but a suffix needs a street *name*
 *    before it, and "2024" is the number. Nothing matches, which is correct.
 *
 * The extractor describes what the document contains. It draws no conclusion
 * about any of it, and it geocodes nothing — that is a separate stage with a
 * separate provenance record.
 */

/**
 * Street suffixes, as printed and as abbreviated.
 *
 * Closed, and short on purpose. Every entry here is a word that turns a number
 * and a capitalised noun into an address, so a loose entry is a false pin.
 * `Project`, `Park`, `Plan`, `District` and `Acres` are all deliberately absent:
 * each of them appears in the real agenda above, after a number, in a title that
 * is about no place at all.
 */
export const STREET_SUFFIXES = [
  "Street", "St",
  "Avenue", "Ave",
  "Road", "Rd",
  "Lane", "Ln",
  "Drive", "Dr",
  "Boulevard", "Blvd",
  "Court", "Ct",
  "Place", "Pl",
  "Trail", "Trl",
  "Circle", "Cir",
  "Parkway", "Pkwy",
  "Highway", "Hwy",
  "Terrace", "Ter",
  "Alley", "Aly",
  "Loop",
  "Way",
] as const;

/** Spelled out and abbreviated, before or after the street name. */
const DIRECTIONS = [
  "North", "South", "East", "West",
  "Northeast", "Northwest", "Southeast", "Southwest",
  "NE", "NW", "SE", "SW",
  "N", "S", "E", "W",
] as const;

/**
 * A capitalised word usable as part of a street name.
 *
 * Capitalisation is load-bearing: it is what separates "133 Maus Lane" from
 * "1 to the ... Lane", and agenda titles are title-cased throughout both
 * jurisdictions' documents.
 */
const NAME_WORD = "[A-Z][A-Za-z'’-]*";

/**
 * How many words a street name may run to before the suffix.
 *
 * Four. "Story Mill", "Harper Pucket" and "Martin Luther King Jr" are the shapes
 * that occur; letting it run further starts absorbing the sentence around the
 * address.
 */
const MAX_NAME_WORDS = 4;

/** Longer than this and the match has run away from the address. */
const MAX_ADDRESS_LENGTH = 80;

function alternation(words: readonly string[]): string {
  // Longest first, so "Northwest" is preferred over "North" and "Street" over
  // "St". Without it the alternation stops at the shorter prefix and the rest of
  // the word is left dangling outside the match.
  return [...words].sort((a, b) => b.length - a.length).join("|");
}

const ADDRESS_PATTERN = new RegExp(
  // Not preceded by a word character or a dot: the dot is what keeps "1.173"
  // from yielding "173".
  `(?<![\\w.])` +
    `\\d{1,6}` +
    `\\s+(?:(?:${alternation(DIRECTIONS)})\\s+)?` +
    `(?:${NAME_WORD}\\s+){0,${MAX_NAME_WORDS - 1}}${NAME_WORD}` +
    `\\s+(?:${alternation(STREET_SUFFIXES)})\\b\\.?` +
    `(?:\\s+(?:${alternation(DIRECTIONS)})\\b)?`,
  "g",
);

export interface AddressMention {
  /** The address exactly as the record prints it. Never normalised. */
  text: string;
  /** Character index of `text` within the title it was read from. */
  index: number;
}

/**
 * Every distinct street address a title names, in the order it names them.
 *
 * Duplicates within one title collapse to their first appearance — a title that
 * says "the 133 Maus Lane Annexation ... zoning for 133 Maus Lane" names one
 * place, and two links to it would be one claim recorded twice.
 *
 * A title with no address yields `[]`. That is the common case, it is not an
 * error, and nothing is logged about it.
 */
export function extractAddresses(title: string): AddressMention[] {
  const found: AddressMention[] = [];
  const seen = new Set<string>();

  for (const match of title.matchAll(ADDRESS_PATTERN)) {
    if (match.index === undefined) continue;
    const text = match[0].trim();
    if (text.length > MAX_ADDRESS_LENGTH) continue;
    const key = text.toLowerCase().replace(/[.,]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ text, index: match.index });
  }

  return found;
}

/**
 * How firmly the record ties this item to this address.
 *
 * `subject_of` is reserved for a title that also carries a **designator** — a
 * numbered ordinance, resolution, application or project — because that is the
 * record naming an instrument that acts on the place. Everything else gets
 * `affects`: the title names the address, which is a fact, but nothing in it
 * says the address is what the item is *for*, and asserting that it is would be
 * an inference dressed as a reading.
 *
 * The designator comes from `parseDesignator` in `services/matters.ts`, not from
 * a second regex here. Two parsers for "Ordinance 2145" would be two definitions
 * of what a matter is, and the one that disagreed would be believed at random.
 *
 * Measured against the real corpus, and worth stating because it decides what
 * most links look like: **`parseDesignator` matches none of the 2026-08-04
 * Bozeman annexation titles.** They print "Application 25213", and that parser's
 * application pattern requires a hyphenated form; they print "Resolution,
 * Adoption of ..." with no number after the word. So those items land on
 * `affects`, which is the conservative answer and the honest one until somebody
 * decides whether `parseDesignator` should learn Bozeman's forms — a change to
 * matter identity across the whole corpus, and not this feature's to make.
 */
export function relationFor(title: string): PlaceRelation {
  return parseDesignator(title) === null ? "affects" : "subject_of";
}
