/**
 * Name matching, and the confidence model that keeps it honest.
 *
 * ## The problem this module refuses to pretend it has solved
 *
 * A campaign filing names a donor. An agenda item names a company. Nothing in
 * either record is an identifier — there is no shared key between the Federal
 * Election Commission's contributor field and the text a clerk typed into an
 * agenda. So every link this project can draw between the two is a **name**
 * match, and a name match is uncertain in a way that does not go away with a
 * better algorithm: two different companies really can be called the same
 * thing, and one company really can be filed under three spellings.
 *
 * Therefore this module never returns a boolean. It returns a `NameMatch` or
 * `null`, and a `NameMatch` always carries:
 *
 *  - a **band** — `weak`, `moderate` or `strong`. There is deliberately no
 *    `certain`, `exact` or `confirmed` band, and adding one would be a defect
 *    rather than an improvement: the strongest thing this method can conclude
 *    is that every distinctive word in the filed name appears in the record,
 *    which is strong evidence and is not identity;
 *  - a **score**, so the band is derived rather than asserted;
 *  - the **terms that matched**, so a reader can see the match rather than
 *    take it on trust, and can see immediately when it is a coincidence;
 *  - the **method**, so that when an identifier-based match becomes possible
 *    (a state filing system that publishes a business registration number, say)
 *    it can be a different method with its own banding rather than this one
 *    quietly getting more confident.
 *
 * ## Uniform treatment across entity classes, by construction
 *
 * The project's non-partisanship invariant says detection logic must apply
 * identically to every entity class — nonprofits, unions, PACs, trade
 * associations, developers, corporations. Here that is not a rule anybody has
 * to remember: **the words that name the class are removed before any decision
 * is taken.** `llc`, `union`, `pac`, `foundation`, `association`, `local`,
 * `developers` and the rest are all in `GENERIC_TERMS`, so
 * "Ridgeline Partners LLC", "Ridgeline Workers Union" and
 * "Ridgeline Foundation" all reduce to the same distinctive set —
 * `{ridgeline}` — and the matcher cannot tell them apart even in principle.
 *
 * The test that asserts this substitutes the class word and requires byte-equal
 * output. It passes because there is no branch it could fail on.
 */

/** How a match reads. There is no band above `strong`, on purpose. */
export const MATCH_BANDS = ["weak", "moderate", "strong"] as const;

export type MatchBand = (typeof MATCH_BANDS)[number];

/**
 * How the match was arrived at. A new method gets a new value rather than
 * changing what an existing one means — a stored finding says how it was
 * matched, and that must keep meaning what it meant when it was written.
 */
export type MatchMethod = "distinctive_term_overlap";

export interface NameMatch {
  method: MatchMethod;
  band: MatchBand;
  /** Share of the filed name's distinctive terms found. 0 < score <= 1. */
  score: number;
  /** The terms that matched, in the order they appear in the filed name. */
  matchedTerms: string[];
  /** Distinctive terms in the filed name that were **not** found. */
  unmatchedTerms: string[];
  /**
   * Terms discarded as non-distinctive before matching — entity-class words,
   * jurisdiction names, and procedural vocabulary. Published with the finding
   * so a reader can see what the matcher was blind to.
   */
  discardedTerms: string[];
}

/**
 * Words that carry no distinguishing information about *who* a filer is.
 *
 * Three groups, and the first is load-bearing for non-partisanship:
 *
 *  1. **Entity class.** Corporate forms, union vocabulary, PAC vocabulary,
 *     nonprofit vocabulary, trade-association vocabulary and the words a
 *     developer's name tends to carry. All removed, all equally.
 *  2. **Government and procedure**, which appear in nearly every agenda item
 *     and so match everything if left in.
 *  3. **Person-name furniture** — honorifics and generational suffixes.
 */
const GENERIC_TERMS = new Set<string>([
  // 1 — entity class. Every category the invariant names, and no category is
  // treated differently from any other.
  "llc",
  "llp",
  "lp",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "company",
  "co",
  "holdings",
  "holding",
  "group",
  "partners",
  "partnership",
  "enterprises",
  "ventures",
  "capital",
  "properties",
  "development",
  "developments",
  "developers",
  "builders",
  "construction",
  "realty",
  "union",
  "unions",
  "local",
  "labor",
  "workers",
  "brotherhood",
  "sisterhood",
  "guild",
  "chapter",
  "lodge",
  "pac",
  "political",
  "committee",
  "committees",
  "action",
  "fund",
  "funds",
  "campaign",
  "friends",
  "electing",
  "elect",
  "victory",
  "foundation",
  "trust",
  "charitable",
  "charity",
  "nonprofit",
  "society",
  "institute",
  "alliance",
  "coalition",
  "association",
  "associates",
  "assn",
  "trade",
  "cooperative",
  "coop",
  "advocacy",
  "citizens",
  "taxpayers",
  "voters",
  "members",
  "membership",
  "chamber",
  "commerce",
  // Party and affiliation words. A detector that could see them could be
  // pointed at one side, which is the failure the non-partisanship invariant
  // names. Removing them costs nothing: they identify nobody.
  "party",
  "democratic",
  "democrat",
  "democrats",
  "republican",
  "republicans",
  "libertarian",
  "libertarians",
  "conservative",
  "conservatives",
  "progressive",
  "progressives",
  "liberal",
  "liberals",
  "nonpartisan",
  "bipartisan",
  "federation",
  "league",
  "network",
  "council",
  "organization",
  "organisation",
  "services",
  "service",
  "solutions",
  "systems",
  "industries",
  "international",
  "national",
  "american",
  "america",
  "usa",
  "united",
  "states",

  // 2 — government and procedure. These are in every agenda ever written.
  "city",
  "county",
  "town",
  "board",
  "commission",
  "commissioners",
  "district",
  "department",
  "agency",
  "authority",
  "office",
  "public",
  "meeting",
  "agenda",
  "item",
  "motion",
  "vote",
  "resolution",
  "ordinance",
  "hearing",
  "approval",
  "approve",
  "consider",
  "consideration",
  "request",
  "application",
  "project",
  "contract",
  "agreement",
  "amendment",
  "plan",
  "review",
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",

  // 3 — person-name furniture.
  "mr",
  "mrs",
  "ms",
  "dr",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

/** Below this a term is too short to distinguish anybody. */
const MIN_TERM_LENGTH = 4;

/**
 * A single term this long, fully matched, is allowed to reach `moderate` on its
 * own. "Ridgeline" can; "Smith" cannot, and that asymmetry is the point.
 */
const DISTINCTIVE_SOLO_LENGTH = 8;

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Split a name into the terms that could identify it, and the ones that could
 * not. Both halves are returned, because the discarded half is published: a
 * reader is entitled to know the matcher never looked at the word "Union".
 */
export function splitTerms(
  value: string,
  extraGenericTerms: readonly string[] = [],
): { distinctive: string[]; discarded: string[] } {
  const extra = new Set(extraGenericTerms.map((term) => normalizeName(term)).filter(Boolean));
  const distinctive: string[] = [];
  const discarded: string[] = [];
  const seen = new Set<string>();

  for (const term of normalizeName(value).split(" ")) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    if (term.length < MIN_TERM_LENGTH || GENERIC_TERMS.has(term) || extra.has(term)) {
      discarded.push(term);
      continue;
    }
    distinctive.push(term);
  }

  return { distinctive, discarded };
}

function band(matched: string[], total: number): MatchBand {
  const coverage = matched.length / total;
  if (coverage === 1 && matched.length >= 2) return "strong";
  if (coverage === 1 && matched.length === 1 && matched[0].length >= DISTINCTIVE_SOLO_LENGTH) {
    return "moderate";
  }
  if (coverage >= 0.5 && matched.length >= 2) return "moderate";
  return "weak";
}

export interface MatchOptions {
  /**
   * Terms to treat as non-distinctive for this comparison on top of the
   * standing list — in practice the jurisdiction's own name. "Bozeman" appears
   * in most Bozeman agenda items, so a donor called "Bozeman Ridgeline" must
   * not be credited with matching it.
   */
  extraGenericTerms?: readonly string[];
}

/**
 * Does a filed name appear in a body of record text?
 *
 * Used for donor → agenda item. Directional: it asks how much of the *filed
 * name* the record contains, never the reverse, because an agenda item is a
 * sentence and a name is a name.
 */
export function matchNameInText(
  name: string,
  text: string,
  options: MatchOptions = {},
): NameMatch | null {
  const { distinctive, discarded } = splitTerms(name, options.extraGenericTerms);
  if (distinctive.length === 0) return null;

  const haystack = ` ${normalizeName(text)} `;
  const matchedTerms = distinctive.filter((term) => haystack.includes(` ${term} `));
  if (matchedTerms.length === 0) return null;

  return {
    method: "distinctive_term_overlap",
    band: band(matchedTerms, distinctive.length),
    score: round3(matchedTerms.length / distinctive.length),
    matchedTerms,
    unmatchedTerms: distinctive.filter((term) => !matchedTerms.includes(term)),
    discardedTerms: discarded,
  };
}

/**
 * Are two filed names the same name?
 *
 * Used for official → filing recipient. Symmetric, so neither side is treated
 * as the authority: the score is the overlap over the union, which means
 * "Sarah Jane Whitcomb" against "Sarah Whitcomb" scores 0.5 and lands
 * `moderate` rather than being asserted as the same person.
 */
export function matchNames(
  left: string,
  right: string,
  options: MatchOptions = {},
): NameMatch | null {
  const a = splitTerms(left, options.extraGenericTerms);
  const b = splitTerms(right, options.extraGenericTerms);
  if (a.distinctive.length === 0 || b.distinctive.length === 0) return null;

  const rightSet = new Set(b.distinctive);
  const matchedTerms = a.distinctive.filter((term) => rightSet.has(term));
  if (matchedTerms.length === 0) return null;

  const union = new Set([...a.distinctive, ...b.distinctive]).size;

  return {
    method: "distinctive_term_overlap",
    band: band(matchedTerms, union),
    score: round3(matchedTerms.length / union),
    matchedTerms,
    unmatchedTerms: [...a.distinctive, ...b.distinctive].filter(
      (term) => !matchedTerms.includes(term),
    ),
    discardedTerms: Array.from(new Set([...a.discarded, ...b.discarded])),
  };
}

/** Band ordering, for "is this at least X?" comparisons. */
export function bandRank(value: MatchBand): number {
  return MATCH_BANDS.indexOf(value);
}

export function bandAtLeast(value: MatchBand, floor: MatchBand): boolean {
  return bandRank(value) >= bandRank(floor);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
