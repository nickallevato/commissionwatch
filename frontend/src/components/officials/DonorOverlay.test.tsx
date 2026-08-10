import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders as render } from "@/lib/test-utils";
import { DonorOverlay, MatchConfidenceChip } from "./DonorOverlay";
import { VoteBar } from "./VoteBar";
import type { FinanceCoverage, NameMatchBand, StoredNameMatch } from "@/types";

/**
 * The two properties of this panel that no amount of tidying may remove: the
 * caveat is unconditional, and no band label claims an identity.
 */

const COVERAGE: FinanceCoverage = {
  federalOnly: true,
  caveat: "Contribution records here come from the Federal Election Commission only.",
  systems: [
    {
      key: "openfec",
      name: "OpenFEC",
      scope: "Federal filings.",
      state: "active",
      url: "https://api.open.fec.gov/developers/",
    },
  ],
};

function match(band: NameMatchBand): StoredNameMatch {
  return {
    method: "distinctive_term_overlap",
    band,
    score: 1,
    matchedTerms: ["ridgeline"],
    unmatchedTerms: [],
    discardedTerms: ["llc"],
  };
}

describe("MatchConfidenceChip", () => {
  const BANDS: NameMatchBand[] = ["weak", "moderate", "strong"];

  it.each(BANDS)("says %s is not a verified identity", (band) => {
    render(<MatchConfidenceChip match={match(band)} testId="chip" />);
    expect(screen.getByTestId("chip")).toHaveTextContent("not a verified identity");
  });

  it.each(BANDS)("never uses the vocabulary of certainty for %s", (band) => {
    render(<MatchConfidenceChip match={match(band)} testId="chip" />);
    const text = (screen.getByTestId("chip").textContent ?? "").toLowerCase();
    for (const forbidden of ["confirmed", "certain", "identified", "proven", "exact"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("name match");
  });
});

describe("DonorOverlay", () => {
  it("carries the caveat with no findings under it", () => {
    render(<DonorOverlay findings={[]} coverage={COVERAGE} />);
    expect(screen.getByTestId("finance-coverage-caveat")).toHaveTextContent(
      "Federal Election Commission only",
    );
  });

  it("does not present an empty panel as a fact about the official", () => {
    render(<DonorOverlay findings={[]} coverage={COVERAGE} />);
    const text = (screen.getByTestId("donor-overlay").textContent ?? "").toLowerCase();
    for (const forbidden of ["no donors", "received nothing", "clean", "no contributions received"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("shows a finding that carries no donor evidence without inventing any", () => {
    render(
      <DonorOverlay
        coverage={COVERAGE}
        findings={[
          {
            id: "f1",
            meeting_id: "m1",
            flag_type: "quorum_issue",
            severity: "high",
            description: "Only 2 of 5 members present.",
            created_at: "2026-08-01T00:00:00.000Z",
            evidence: null,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("official-finding")).toHaveTextContent("Only 2 of 5 members present.");
    expect(screen.queryByTestId("match-confidence")).toBeNull();
    expect(screen.queryByTestId("finding-citations")).toBeNull();
  });
});

describe("VoteBar", () => {
  it("says there is no record rather than drawing an empty bar", () => {
    render(<VoteBar record={{ yes: 0, no: 0, abstain: 0, absent: 0, total: 0 }} testId="bar" />);
    expect(screen.getByTestId("bar")).toHaveTextContent("No votes recorded");
  });

  it("draws only the segments that have a count", () => {
    render(<VoteBar record={{ yes: 3, no: 0, abstain: 0, absent: 1, total: 4 }} testId="bar" />);
    const bar = screen.getByTestId("bar");
    expect(bar.querySelector('[data-segment="yes"]')).not.toBeNull();
    expect(bar.querySelector('[data-segment="no"]')).toBeNull();
    expect(bar.querySelector('[data-segment="absent"]')).not.toBeNull();
  });
});
