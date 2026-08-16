/**
 * What campaign finance data this project actually holds, and — more
 * importantly — what it does not.
 *
 * ## Why this is a module and not a paragraph in a component
 *
 * OpenFEC holds filings made to the **Federal** Election Commission. The
 * officials this project follows are city commissioners and county
 * commissioners, and most of them have never filed anything federal in their
 * lives. So for most officials the correct answer to "what did their donors
 * give?" is *the federal record shows nothing*, and the distance between that
 * sentence and "their donors gave nothing" is the whole of this project's
 * credibility.
 *
 * A reader who sees an empty donor panel and is not told why will supply their
 * own reason, and both available reasons are wrong: either the official is
 * unusually clean, or this site is broken. The true reason is that we have
 * consulted one filing system and it is the wrong one for local office.
 *
 * Putting that sentence in a component means it appears wherever somebody
 * remembered to put it. It lives here instead, one copy, returned by the API
 * alongside every finance figure, so an absence is never rendered without it.
 *
 * ## Montana CERS
 *
 * Montana's Commissioner of Political Practices runs CERS, which holds the
 * state and local filings that would answer for these officials. A coverage
 * table that claimed CERS was consulted when it was not would be the exact
 * failure this module exists to prevent.
 *
 * ### Corrected 2026-08-16: the adapter landed, and this comment did not
 *
 * This docblock used to say CERS was planned **with no adapter in this
 * codebase**. That stopped being true on 2026-08-10, when
 * `ingestion/adapters/mt-cers.ts` landed, was registered **disabled**, and a
 * real rate-limited sweep took 384 filers, 35 filed reports and 127 itemised
 * transactions. The sentence stayed for six days.
 *
 * It also said that when the adapter lands, "its entry moves to `active` … and
 * every panel starts telling the truth about it without a single component
 * changing." **Nothing moves it.** `state` below is a hardcoded literal, and so
 * is the last sentence of `FEDERAL_ONLY_CAVEAT`. Both have to be edited by
 * hand.
 *
 * That is a live trap rather than a tidy-up. The instant an operator enables
 * the CERS source in production, this site will render CERS-derived
 * contribution figures **and**, on the same page, tell the reader that Montana
 * filings are held by a system "which this site does not yet read". A false
 * statement about our own sourcing, published on the one surface built to keep
 * our sourcing honest, with nothing failing anywhere.
 *
 * `coverage-drift.test.ts` now fails the moment records exist from a system
 * this table still calls `planned`. It does not attempt to fix the wording
 * automatically: deriving `state` from stored rows is a real design question
 * with a genuinely hard case — a system that swept and found nothing is not the
 * same as a system never consulted, and the two want different sentences. That
 * is specced in `docs/superpowers/specs/2026-08-16-finance-coverage-drift-design.md`
 * and left to the operator. Until then the failure is loud instead of silent,
 * which is the part that could not wait.
 */

export type CoverageState = "active" | "planned";

export interface FinanceSystem {
  /** Matches `campaign_contributions.source_system`. */
  key: string;
  name: string;
  /** What the system's records cover. Plain, checkable, no hedging. */
  scope: string;
  state: CoverageState;
  url: string;
}

export const FINANCE_SYSTEMS: readonly FinanceSystem[] = [
  {
    key: "openfec",
    name: "OpenFEC",
    scope: "Federal candidate and committee filings made to the Federal Election Commission.",
    state: "active",
    url: "https://api.open.fec.gov/developers/",
  },
  {
    key: "mt_cers",
    name: "Montana CERS",
    scope:
      "Montana state and local campaign filings held by the Commissioner of Political Practices.",
    state: "planned",
    url: "https://cers-ext.mt.gov/CampaignTracker",
  },
] as const;

/**
 * The sentence itself. One string, asserted by tests on both the API and the
 * page, so it cannot be softened on one surface and not the other.
 *
 * Note what it does not say. It does not say an official has no donors, and it
 * does not imply anything about an official from whom nothing was found. It
 * describes which filing cabinet was opened.
 */
export const FEDERAL_ONLY_CAVEAT =
  "Contribution records here come from the Federal Election Commission only. " +
  "City and county officials generally do not file federally, so an empty result " +
  "means no federal filing was found — it is not a statement that an official " +
  "received nothing. Montana state and local filings are held by CERS, which this " +
  "site does not yet read.";

export interface FinanceCoverage {
  systems: readonly FinanceSystem[];
  /** True while every `active` system is a federal one. */
  federalOnly: boolean;
  caveat: string;
}

export function financeCoverage(): FinanceCoverage {
  const active = FINANCE_SYSTEMS.filter((system) => system.state === "active");
  return {
    systems: FINANCE_SYSTEMS,
    federalOnly: active.length > 0 && active.every((system) => system.key === "openfec"),
    caveat: FEDERAL_ONLY_CAVEAT,
  };
}
