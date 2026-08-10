import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { OfficialPage } from "./OfficialPage";
import { server } from "@/mocks/server";
import type {
  FinanceCoverage,
  OfficialFinding,
  OfficialProfile,
  VoteDonorEvidence,
} from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/officials/:id`.
 *
 * What this suite guards is the set of sentences the page must never stop
 * saying, each of which is one tidy-up away from disappearing:
 *
 *  - the federal-only caveat, **including when there is nothing under it**;
 *  - "not measured" rather than 0% for a rate computed from nothing;
 *  - the name-match label on every donor finding, and never the word
 *    "verified", "confirmed" or "identified" applied to a match.
 */

const OFFICIAL_ID = "11111111-1111-1111-1111-111111111111";

const COVERAGE: FinanceCoverage = {
  federalOnly: true,
  caveat:
    "Contribution records here come from the Federal Election Commission only. " +
    "City and county officials generally do not file federally, so an empty result " +
    "means no federal filing was found — it is not a statement that an official " +
    "received nothing. Montana state and local filings are held by CERS, which this " +
    "site does not yet read.",
  systems: [
    {
      key: "openfec",
      name: "OpenFEC",
      scope: "Federal candidate and committee filings.",
      state: "active",
      url: "https://api.open.fec.gov/developers/",
    },
    {
      key: "mt_cers",
      name: "Montana CERS",
      scope: "Montana state and local campaign filings.",
      state: "planned",
      url: "https://cers-ext.mt.gov/CampaignTracker",
    },
  ],
};

const EVIDENCE: VoteDonorEvidence = {
  operatorEntityDecision: null,
  memberId: OFFICIAL_ID,
  memberName: "Dana Whitcomb",
  voteId: "22222222-2222-2222-2222-222222222222",
  votePosition: "yes",
  agendaItemId: "33333333-3333-3333-3333-333333333333",
  agendaItemNumber: 7,
  agendaItemTitle: "Ridgeline Aggregate gravel supply contract award",
  donorName: "Ridgeline Aggregate LLC",
  contributionCount: 2,
  totalAmount: 3400,
  earliestContributionDate: "2026-01-05",
  latestContributionDate: "2026-03-04",
  donorMatch: {
    method: "distinctive_term_overlap",
    band: "strong",
    score: 1,
    matchedTerms: ["ridgeline", "aggregate"],
    unmatchedTerms: [],
    discardedTerms: ["llc"],
  },
  recipientMatch: {
    method: "distinctive_term_overlap",
    band: "strong",
    score: 1,
    matchedTerms: ["dana", "whitcomb"],
    unmatchedTerms: [],
    discardedTerms: [],
  },
  contributions: [
    {
      contributionId: "44444444-4444-4444-4444-444444444444",
      sourceSystem: "openfec",
      donorName: "Ridgeline Aggregate LLC",
      recipientName: "Dana Whitcomb",
      committeeName: "Whitcomb for Montana",
      amount: 3400,
      contributionDate: "2026-03-04",
      externalId: "4062020241234567890",
      imageNumber: "202604159876543210",
      sourceUrl: "https://api.open.fec.gov/v1/schedules/schedule_a/?per_page=25",
      documentUrl: "https://docquery.fec.gov/cgi-bin/fecimg/?202604159876543210",
    },
  ],
  coverageNote: COVERAGE.caveat,
};

const FINDING: OfficialFinding = {
  id: "55555555-5555-5555-5555-555555555555",
  meeting_id: "66666666-6666-6666-6666-666666666666",
  flag_type: "vote_donor_conflict",
  severity: "high",
  description:
    'Dana Whitcomb voted yes on agenda item 7, "Ridgeline Aggregate gravel supply contract ' +
    'award". The federal campaign finance record lists 2 contributions totalling $3,400.00. ' +
    "The donor name and the agenda item share the terms; this is a name match, not a verified " +
    "identity, and no relationship between the donor and this item is established by it.",
  created_at: "2026-08-09T12:00:00.000Z",
  evidence: EVIDENCE,
};

function profile(over: Partial<OfficialProfile> = {}): OfficialProfile {
  return {
    official: {
      id: OFFICIAL_ID,
      jurisdiction_id: "77777777-7777-7777-7777-777777777777",
      name: "Dana Whitcomb",
      title: "Commissioner",
      email: null,
      term_start: "2024-01-01T00:00:00.000Z",
      term_end: null,
      party: null,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      jurisdiction: {
        id: "77777777-7777-7777-7777-777777777777",
        name: "Gallatin County",
        state: "MT",
      },
    },
    record: { yes: 12, no: 3, abstain: 1, absent: 2, total: 18 },
    attendance: { meetingsWithRollCall: 8, present: 7, absent: 1, rate: 0.875 },
    alignment: { comparableVotes: 14, withMajority: 11, rate: 0.786 },
    activity: [
      { month: "2025-09", votes: 0 },
      { month: "2025-10", votes: 3 },
      { month: "2025-11", votes: 0 },
      { month: "2025-12", votes: 5 },
    ],
    timeline: [
      {
        meeting_id: "66666666-6666-6666-6666-666666666666",
        date: "2026-03-10",
        commission_name: "County Commission",
        location: "Courthouse Room 204",
        record: { yes: 1, no: 1, abstain: 0, absent: 0, total: 2 },
        dissents: 1,
      },
    ],
    findings: [FINDING],
    finance: COVERAGE,
    ...over,
  };
}

function serve(body: OfficialProfile | null, status = 200) {
  server.use(
    http.get("/api/officials/:id", () =>
      body === null
        ? new HttpResponse(null, { status })
        : HttpResponse.json(body as unknown as Record<string, unknown>),
    ),
  );
}

/**
 * The page reads its id off the route, so it has to be mounted under one.
 * `renderWithProviders` mounts a bare MemoryRouter with no path, which would
 * leave `useParams` empty and the query disabled.
 */
function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/officials/${OFFICIAL_ID}`]}>
        <Routes>
          <Route path="/officials/:id" element={<OfficialPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OfficialPage", () => {
  it("leads with the official as the subject", async () => {
    serve(profile());
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Dana Whitcomb" })).toBeInTheDocument();
    expect(screen.getByText(/Commissioner · Gallatin County, MT/)).toBeInTheDocument();
  });

  it("reports the standing figures as figures", async () => {
    serve(profile());
    renderPage();
    expect(await screen.findByTestId("tile-votes")).toHaveTextContent("18");
    expect(screen.getByTestId("tile-attendance")).toHaveTextContent("88%");
    expect(screen.getByTestId("tile-alignment")).toHaveTextContent("79%");
    expect(screen.getByTestId("tile-findings")).toHaveTextContent("1");
  });

  /**
   * "Voted with the majority 0% of the time" and "there was nothing comparable
   * to measure" are different claims about a person, and only the second is
   * true of an official with no roll calls yet.
   */
  it("says a rate is not measured rather than rendering it as zero", async () => {
    serve(
      profile({
        record: { yes: 0, no: 0, abstain: 0, absent: 0, total: 0 },
        attendance: { meetingsWithRollCall: 0, present: 0, absent: 0, rate: null },
        alignment: { comparableVotes: 0, withMajority: 0, rate: null },
        timeline: [],
        findings: [],
      }),
    );
    renderPage();
    expect(await screen.findByTestId("tile-attendance")).toHaveTextContent("Not measured");
    expect(screen.getByTestId("tile-alignment")).toHaveTextContent("Not measured");
    expect(screen.getByTestId("tile-attendance")).not.toHaveTextContent("0%");
  });

  it("draws the vote record as a bar and states it in words for a screen reader", async () => {
    serve(profile());
    renderPage();
    const bar = await screen.findByTestId("record-vote-bar");
    expect(bar).toHaveTextContent("18 recorded votes: 12 yes, 3 no, 1 abstain, 2 absent.");
  });

  it("draws every month in the activity window, including the empty ones", async () => {
    serve(profile());
    renderPage();
    const strip = await screen.findByTestId("activity-strip");
    expect(strip.querySelectorAll("rect")).toHaveLength(4);
    expect(strip.querySelector('rect[data-month="2025-09"]')).toHaveAttribute("data-votes", "0");
    expect(strip).toHaveTextContent(/of which 2 recorded none/);
  });

  it("renders the timeline as sittings, marking a dissent", async () => {
    serve(profile());
    renderPage();
    const entry = await screen.findByTestId("timeline-entry");
    expect(within(entry).getByRole("link", { name: "County Commission" })).toHaveAttribute(
      "href",
      "/meetings/66666666-6666-6666-6666-666666666666",
    );
    expect(entry).toHaveTextContent("1 against the majority");
  });

  it("says so when the published record holds no roll call", async () => {
    serve(profile({ timeline: [] }));
    renderPage();
    expect(
      await screen.findByText(/statement about the published record, not about attendance/),
    ).toBeInTheDocument();
  });
});

describe("the campaign finance panel", () => {
  /** The single most important assertion on this page. */
  it("states the federal-only limitation when there is nothing to show", async () => {
    serve(profile({ findings: [] }));
    renderPage();
    const caveat = await screen.findByTestId("finance-coverage-caveat");
    expect(caveat).toHaveTextContent(/Federal Election Commission only/);
    expect(caveat).toHaveTextContent(/it is not a statement that an official received nothing/);
    expect(screen.getByText(/Nothing has been published linking/)).toBeInTheDocument();
  });

  it("states it again when there is something to show", async () => {
    serve(profile());
    renderPage();
    expect(await screen.findByTestId("finance-coverage-caveat")).toHaveTextContent(
      /Federal Election Commission only/,
    );
  });

  it("names the filing system it has not read", async () => {
    serve(profile({ findings: [] }));
    renderPage();
    expect(await screen.findByText(/Not yet read:/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Montana CERS" })).toBeInTheDocument();
  });

  it("labels the link as a name match and never as an identity", async () => {
    serve(profile());
    renderPage();
    const chip = await screen.findByTestId("match-confidence");
    expect(chip).toHaveTextContent("Close name match");
    expect(chip).toHaveTextContent("not a verified identity");
    expect(chip).toHaveAttribute("data-band", "strong");
  });

  it("never claims a match is confirmed, verified or identified", async () => {
    serve(profile());
    renderPage();
    const overlay = await screen.findByTestId("donor-overlay");
    const text = overlay.textContent ?? "";
    for (const forbidden of ["confirmed match", "verified match", "identified as", "proven"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("shows what the match was made of, so a reader can judge it", async () => {
    serve(profile());
    renderPage();
    expect(await screen.findByText("How this link was made")).toBeInTheDocument();
    expect(screen.getByText("ridgeline, aggregate")).toBeInTheDocument();
    expect(screen.getByText("llc")).toBeInTheDocument();
  });

  it("cites the filing, not just the amount", async () => {
    serve(profile());
    renderPage();
    const citations = await screen.findByTestId("finding-citations");
    const link = within(citations).getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://docquery.fec.gov/cgi-bin/fecimg/?202604159876543210",
    );
    expect(link).toHaveTextContent("2026-03-04");
    expect(link).toHaveTextContent("$3,400.00");
  });
});

describe("when the official cannot be loaded", () => {
  it("says so rather than rendering an empty profile", async () => {
    serve(null, 404);
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: /could not be loaded/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the roster" })).toBeInTheDocument();
  });
});
