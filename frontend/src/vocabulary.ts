/**
 * The words this site uses for the things it publishes, in one place.
 *
 * On 2026-08-14 a single page called one object four different things, and one
 * of the four denied being it: the masthead said **Findings**, the URL said
 * `/anomalies`, the heading said **Flagged for review**, and the body copy said
 * "nothing here is a finding". A reader who noticed had learned something true
 * and unfortunate — that nobody had decided.
 *
 * In a project whose product is precision about a public record, that is a
 * credibility defect rather than a polish one. It also makes the distinctions
 * the claim pipeline depends on impossible for a reader to hold: a claim is not
 * a finding, and a source is not a document, and neither statement survives a
 * site that uses whichever word came to hand.
 *
 * ## The boundary, stated once
 *
 * **Database names and reader-facing names are allowed to differ, and this file
 * is the only place the mapping lives.** The tables are not renamed. Renaming
 * `anomaly_flags` and `members` would touch every migration comment, query, seed
 * and test to fix a problem readers have and code does not — and migration 072
 * already had to explain in prose that "the officials *page* is a view over the
 * `members` table, and there is no table by that name". That explanation belongs
 * here instead.
 *
 * So `AnomalyFlag` stays the type name, `members` stays the table, `useMembers`
 * stays the hook — and a reader never sees any of those words.
 *
 * ## Retired from reader-facing text
 *
 * **Anomaly.** It asserts that something is abnormal, which is a conclusion and
 * was never what the page meant. Replaced by *finding*.
 *
 * **Member.** The people are officials. "Member" is the schema's word for a row.
 */

export interface Term {
  /** Singular, lowercase. Capitalise at the call site. */
  readonly one: string;
  readonly many: string;
  /** The canonical route, or null for a thing that is never its own page. */
  readonly path: string | null;
}

export const VOCABULARY = {
  meeting: { one: "meeting", many: "meetings", path: "/meetings" },
  matter: { one: "matter", many: "matters", path: "/matters" },
  official: { one: "official", many: "officials", path: "/officials" },
  vote: { one: "vote", many: "votes", path: "/votes" },
  /**
   * A quotation: what the record says a named person did, with the line that
   * says it. Never its own page — a page whose entire content is one sentence
   * about one named person is an accusation, not a record. Rendered at
   * `#claim-{id}` inside a meeting or an official's page.
   */
  claim: { one: "claim", many: "claims", path: null },
  /**
   * An inference: a pattern detected across records, held for review, approved
   * by a person. Distinct from a claim, and the distinction is what makes the
   * claim pipeline safe — a claim can be checked against bytes, a finding
   * cannot.
   */
  finding: { one: "finding", many: "findings", path: "/findings" },
  /** The bytes a claim or finding rests on, at a content address. */
  source: { one: "source", many: "sources", path: "/source" },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof VOCABULARY;

/**
 * Addresses this site published before the vocabulary was settled.
 *
 * They are 301s, not 404s. Both are in `sitemap.xml` and being crawled, and a
 * transparency project does not break a URL it asked people to cite. The same
 * reasoning already keeps `/data-license` alive alongside `/data`.
 */
export const RENAMED_PATHS: Readonly<Record<string, string>> = {
  "/anomalies": "/findings",
  "/members": "/officials",
};

/**
 * Words that must not appear in text a reader sees.
 *
 * The test that enforces this scans `.tsx` string literals and JSX text. It
 * cannot tell a reader-facing string from an identifier, so it checks only what
 * is rendered and carries an explicit allow-list for the deliberate exceptions —
 * an exception being a decision somebody wrote down rather than a match nobody
 * looked at.
 */
export const RETIRED_READER_WORDS = ["anomaly", "anomalies", "member", "members"] as const;
