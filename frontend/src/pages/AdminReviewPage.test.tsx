import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminReviewPage } from "./AdminReviewPage";
import { server } from "@/mocks/server";
import type {
  MatchPolicy,
  NameMatchBand,
  ReviewQueueItem,
  ReviewQueueResponse,
  VoteDonorEvidence,
} from "@/types";

/**
 * The statement is served by the backend and rendered verbatim, so the fixture
 * carries a real one rather than a placeholder — a test against "some text"
 * would pass if the page rendered the wrong field.
 */
const MATCH_POLICY: MatchPolicy = {
  minimumBand: "moderate",
  bands: [
    { band: "weak", label: "Weak name match" },
    { band: "moderate", label: "Possible name match" },
    { band: "strong", label: "Close name match" },
  ],
  statement:
    "A finding here rests on a name match between a filed donor name and text in an " +
    "agenda item. A name match is not a verified identity, and no band means it is.",
};

function evidence(band: NameMatchBand): VoteDonorEvidence {
  return {
    memberId: "44444444-4444-4444-8444-444444444444",
    memberName: "Dana Whitcomb",
    voteId: "55555555-5555-4555-8555-555555555555",
    votePosition: "yes",
    agendaItemId: "66666666-6666-4666-8666-666666666666",
    agendaItemNumber: 7,
    agendaItemTitle: "Ridgeline Aggregate gravel supply contract award",
    donorName: "Ridgeline Aggregate LLC",
    contributionCount: 1,
    totalAmount: 2500,
    earliestContributionDate: "2026-03-04",
    latestContributionDate: "2026-03-04",
    donorMatch: {
      method: "distinctive_term_overlap",
      band,
      score: 0.5,
      matchedTerms: ["ridgeline"],
      unmatchedTerms: ["aggregate"],
      discardedTerms: ["llc"],
    },
    recipientMatch: {
      method: "distinctive_term_overlap",
      band: "strong",
      score: 1,
      matchedTerms: ["whitcomb", "dana"],
      unmatchedTerms: [],
      discardedTerms: [],
    },
    contributions: [
      {
        contributionId: "77777777-7777-4777-8777-777777777777",
        sourceSystem: "openfec",
        donorName: "Ridgeline Aggregate LLC",
        recipientName: "Dana Whitcomb",
        committeeName: "Whitcomb for Montana",
        amount: 2500,
        contributionDate: "2026-03-04",
        externalId: "4062020241234567890",
        imageNumber: "202604159876543210",
        sourceUrl: "https://api.open.fec.gov/v1/schedules/schedule_a/",
        documentUrl: "https://docquery.fec.gov/cgi-bin/fecimg/?202604159876543210",
      },
    ],
    coverageNote: "Federal filings only.",
    operatorEntityDecision: null,
  };
}

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/review"]}>
      <AdminReviewPage />
    </MemoryRouter>,
  );
}

const CITED: ReviewQueueItem = {
  request: {
    id: "req-1",
    status: "pending_review",
    severity: "high",
    reviewer_operator_id: null,
    reviewer_email: null,
    review_comment: null,
    reviewed_at: null,
    expires_at: "2026-08-13T00:00:00.000Z",
    created_at: "2026-08-10T00:00:00.000Z",
    overdue: false,
  },
  finding: {
    id: "11111111-1111-4111-8111-111111111111",
    flag_type: "quorum_issue",
    severity: "high",
    description: "Two of five seated members were recorded present; quorum is three.",
    review_state: "held",
    source: "auto",
    meeting_id: "22222222-2222-4222-8222-222222222222",
    agenda_item_id: null,
    artifact_id: null,
    metadata: null,
    created_at: "2026-08-10T00:00:00.000Z",
  },
  context: {
    meeting_date: "2026-08-04T00:00:00.000Z",
    meeting_published_at: "2026-08-09T00:00:00.000Z",
    commission_name: "City Commission",
    jurisdiction_name: "City of Bozeman",
  },
  citations: [
    {
      kind: "meeting_document",
      artifact_id: "a-1",
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      storage_key: "artifacts/ab/abc",
      content_type: "application/pdf",
      source_url: "https://example.invalid/agenda.pdf",
      byte_size: 41234,
      fetched_at: "2026-08-09T00:00:00.000Z",
      document_title: "Agenda",
      document_type: "agenda",
      version_no: 1,
    },
  ],
  evidence: null,
  entity_decision: null,
};

/** A name-match finding, which is what the match panel exists to render. */
const NAME_MATCH: ReviewQueueItem = {
  ...CITED,
  request: { ...CITED.request, id: "req-3" },
  finding: {
    ...CITED.finding,
    id: "44444444-4444-4444-8444-444444444444",
    flag_type: "vote_donor_conflict",
    description:
      'Dana Whitcomb voted yes on agenda item 7. The federal campaign finance record lists ' +
      '1 contribution totalling $2,500.00 on 2026-03-04 from a donor filed as ' +
      '"Ridgeline Aggregate LLC"; this is a name match, not a verified identity.',
  },
  evidence: evidence("moderate"),
  entity_decision: null,
};

const UNSOURCED: ReviewQueueItem = {
  ...CITED,
  request: { ...CITED.request, id: "req-2", overdue: true },
  finding: {
    ...CITED.finding,
    id: "33333333-3333-4333-8333-333333333333",
    description: "Minutes not published 40 days after meeting",
    flag_type: "missing_minutes",
  },
  citations: [],
};

function listing(items: ReviewQueueItem[]): ReviewQueueResponse {
  return {
    data: items,
    total: items.length,
    policy: {
      id: "p-1",
      hold_at_or_above: "high",
      review_window_hours: 72,
      updated_by: null,
      updated_by_email: null,
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    counts: {
      pending: items.length,
      overdue: items.filter((item) => item.request.overdue).length,
      approved: 0,
      rejected: 0,
    },
    match_policy: MATCH_POLICY,
    band_counts: { weak: 0, moderate: 1, strong: 2, unbanded: 3 },
  };
}

function queueHandler(body: ReviewQueueResponse) {
  return http.get("/api/admin/review/queue", () => HttpResponse.json(body));
}

describe("AdminReviewPage", () => {
  it("shows the claim, and the artifacts it rests on, before the decision", async () => {
    server.use(queueHandler(listing([CITED])));
    renderPage();

    // Two matches, and both are correct: the claim as it would publish, and the
    // same text loaded into the edit field.
    const rendered = await screen.findAllByText(
      "Two of five seated members were recorded present; quorum is three.",
    );
    expect(rendered.length).toBe(2);
    expect(screen.getByText("What this rests on")).toBeInTheDocument();
    // The hash is on the screen, not behind a disclosure.
    expect(screen.getByText(/sha256 abcdef012345/)).toBeInTheDocument();
    expect(screen.getByText(/Stored document for this meeting/)).toBeInTheDocument();
  });

  it("states the threshold in force and what an expired request does", async () => {
    server.use(queueHandler(listing([CITED])));
    renderPage();

    const policy = await screen.findByText(/severity or above wait for an operator/);
    expect(policy).toHaveTextContent("72 hours");
    expect(policy).toHaveTextContent("An expired request publishes nothing.");
  });

  it("disables approval for a finding that cites nothing, and says why", async () => {
    // The API refuses it either way. Saying so here means the operator learns
    // the reason from the screen rather than from a 409.
    server.use(queueHandler(listing([UNSOURCED])));
    renderPage();

    expect(await screen.findByTestId(`unsourced-${UNSOURCED.finding.id}`)).toHaveTextContent(
      "No unsourced claim reaches the public site.",
    );
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
    // Rejecting an unsourced finding is still available: it is a decision.
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("marks an overdue request as still held", async () => {
    server.use(queueHandler(listing([UNSOURCED])));
    renderPage();

    expect(await screen.findByTestId(`overdue-${UNSOURCED.finding.id}`)).toHaveTextContent(
      "Overdue · still held",
    );
    expect(screen.getByTestId("overdue-count")).toHaveTextContent("1");
  });

  it("refuses to send a decision with no stated reason", async () => {
    let posted = 0;
    server.use(
      queueHandler(listing([CITED])),
      http.post("/api/admin/review/queue/:id/approve", () => {
        posted += 1;
        return HttpResponse.json(CITED);
      }),
    );
    renderPage();
    await screen.findByRole("button", { name: "Approve and publish" });

    await userEvent.click(screen.getByRole("button", { name: "Approve and publish" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "A decision needs a stated reason.",
    );
    expect(posted).toBe(0);
  });

  it("approves with a reason and reports that it published", async () => {
    let sent: { reason?: string } | null = null;
    server.use(
      queueHandler(listing([CITED])),
      http.post("/api/admin/review/queue/:id/approve", async ({ request }) => {
        sent = (await request.json()) as { reason?: string };
        return HttpResponse.json(CITED);
      }),
    );
    renderPage();

    const reason = await screen.findByLabelText(`Reason for ${CITED.finding.id}`);
    await userEvent.type(reason, "Checked against the stored agenda.");
    await userEvent.click(screen.getByRole("button", { name: "Approve and publish" }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ reason: "Checked against the stored agenda." });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Approved and published. The decision is in the correction log.",
    );
  });

  it("reproduces the API's refusal verbatim rather than paraphrasing it", async () => {
    server.use(
      queueHandler(listing([CITED])),
      http.post("/api/admin/review/queue/:id/edit", () =>
        HttpResponse.json(
          {
            error: "A finding describes the record, never the motive. Remove: deliberately",
            statusCode: 400,
          },
          { status: 400 },
        ),
      ),
    );
    renderPage();

    const reason = await screen.findByLabelText(`Reason for ${CITED.finding.id}`);
    await userEvent.type(reason, "Sharper.");
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "A finding describes the record, never the motive. Remove: deliberately",
    );
  });

  it("shows who decided a finding that is no longer pending", async () => {
    const decided: ReviewQueueItem = {
      ...CITED,
      request: {
        ...CITED.request,
        status: "rejected",
        reviewer_email: "operator@example.invalid",
        review_comment: "The roster used the wrong term dates.",
        reviewed_at: "2026-08-10T09:00:00.000Z",
      },
    };
    server.use(queueHandler(listing([decided])));
    renderPage();

    expect(await screen.findByText("operator@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("The roster used the wrong term dates.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and publish" })).toBeNull();
  });

  it("renders an empty queue as a sentence, not a broken table", async () => {
    server.use(queueHandler(listing([])));
    renderPage();

    expect(await screen.findByText("No finding is waiting for review.")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Match quality — the inversion this page existed with until now
  // -------------------------------------------------------------------------

  it("shows the operator the band, the score and the terms, above the buttons", async () => {
    server.use(queueHandler(listing([NAME_MATCH])));
    renderPage();

    const panel = await screen.findByTestId(`match-quality-${NAME_MATCH.finding.id}`);
    // The band, as a label and not only as a colour.
    expect(panel).toHaveTextContent("Possible name match");
    // The caveat the public reads, on the operator's surface too.
    expect(panel).toHaveTextContent("not a verified identity");
    expect(panel).toHaveTextContent("score 0.50");
    expect(screen.getByTestId(`match-quality-${NAME_MATCH.finding.id}-matched`)).toHaveTextContent(
      "ridgeline",
    );
    expect(
      screen.getByTestId(`match-quality-${NAME_MATCH.finding.id}-unmatched`),
    ).toHaveTextContent("aggregate");
    expect(
      screen.getByTestId(`match-quality-${NAME_MATCH.finding.id}-discarded`),
    ).toHaveTextContent("llc");
  });

  it("puts the match quality where it cannot be missed, not behind a disclosure", async () => {
    server.use(queueHandler(listing([NAME_MATCH])));
    renderPage();

    const panel = await screen.findByTestId(`match-quality-${NAME_MATCH.finding.id}`);
    // A `<details>` here would be the defect: the single most useful fact about
    // a finding may be that it rests on one common word.
    expect(panel.querySelector("details")).toBeNull();
  });

  it("never lets the operator's band label read as certainty", async () => {
    server.use(queueHandler(listing([NAME_MATCH])));
    renderPage();

    const chip = await screen.findByTestId(`match-quality-${NAME_MATCH.finding.id}-chip`);
    const text = (chip.textContent ?? "").toLowerCase();
    for (const forbidden of ["confirmed", "certain", "identified", "proven", "exact"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("name match");
  });

  it("renders no match panel for a finding that is not a name match", async () => {
    server.use(queueHandler(listing([CITED])));
    renderPage();

    await screen.findByText("What this rests on");
    expect(screen.queryByTestId(`match-quality-${CITED.finding.id}`)).toBeNull();
  });

  it("states the weak-match policy in the project's own words", async () => {
    server.use(queueHandler(listing([CITED])));
    renderPage();

    // Verbatim from the API, so the screen and the detector cannot drift.
    expect(await screen.findByTestId("match-policy")).toHaveTextContent(
      MATCH_POLICY.statement,
    );
  });

  it("says what is waiting, by band", async () => {
    server.use(queueHandler(listing([NAME_MATCH])));
    renderPage();

    const counts = await screen.findByTestId("band-counts");
    expect(counts).toHaveTextContent("0 weak");
    expect(counts).toHaveTextContent("1 possible");
    expect(counts).toHaveTextContent("3 not a name match");
  });

  it("asks the API for one band when the operator filters by it", async () => {
    const seen: string[] = [];
    server.use(
      http.get("/api/admin/review/queue", ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(listing([NAME_MATCH]));
      }),
    );
    renderPage();
    await screen.findByTestId("segmented-band");

    await userEvent.click(screen.getByRole("radio", { name: "Weak" }));
    await waitFor(() => expect(seen.some((search) => search.includes("band=weak"))).toBe(true));
  });

  it("asks the API to order by the weakest match", async () => {
    const seen: string[] = [];
    server.use(
      http.get("/api/admin/review/queue", ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(listing([NAME_MATCH]));
      }),
    );
    renderPage();
    await screen.findByTestId("segmented-sort");

    await userEvent.click(screen.getByRole("radio", { name: "Weakest match first" }));
    await waitFor(() =>
      expect(seen.some((search) => search.includes("sort=weakest_first"))).toBe(true),
    );
  });

  // -------------------------------------------------------------------------
  // Entity resolution
  // -------------------------------------------------------------------------

  it("records an entity-resolution judgement with its reason", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      queueHandler(listing([NAME_MATCH])),
      http.post("/api/admin/review/queue/:id/entity-resolution", async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(NAME_MATCH);
      }),
    );
    renderPage();

    const reason = await screen.findByLabelText(`Reason for ${NAME_MATCH.finding.id}`);
    await userEvent.type(reason, "The staff report gives the same registration number.");
    await userEvent.click(screen.getByRole("button", { name: "Same entity" }));

    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0].decision).toBe("same_entity");
    expect(bodies[0].reason).toBe("The staff report gives the same registration number.");
  });

  it("says plainly that judging is not approving", async () => {
    server.use(
      queueHandler(listing([NAME_MATCH])),
      http.post("/api/admin/review/queue/:id/entity-resolution", () =>
        HttpResponse.json(NAME_MATCH),
      ),
    );
    renderPage();

    const reason = await screen.findByLabelText(`Reason for ${NAME_MATCH.finding.id}`);
    await userEvent.type(reason, "Same company.");
    await userEvent.click(screen.getByRole("button", { name: "Same entity" }));

    expect(await screen.findByRole("status")).toHaveTextContent("still held");
  });

  it("refuses to record a judgement with no stated reason", async () => {
    let called = false;
    server.use(
      queueHandler(listing([NAME_MATCH])),
      http.post("/api/admin/review/queue/:id/entity-resolution", () => {
        called = true;
        return HttpResponse.json(NAME_MATCH);
      }),
    );
    renderPage();

    await screen.findByTestId(`entity-resolution-${NAME_MATCH.finding.id}`);
    await userEvent.click(screen.getByRole("button", { name: "Different entities" }));

    expect(await screen.findByRole("status")).toHaveTextContent("needs a stated reason");
    expect(called).toBe(false);
  });

  it("shows a judgement that has already been recorded against the pair", async () => {
    const judged: ReviewQueueItem = {
      ...NAME_MATCH,
      entity_decision: {
        decision: "same_entity",
        donorNameFiled: "Ridgeline Aggregate LLC",
        subjectTerms: "ridgeline",
        reason: "The staff report names the same registration number.",
        operatorEmail: "operator@example.invalid",
        decidedAt: "2026-08-10T09:00:00.000Z",
      },
    };
    server.use(queueHandler(listing([judged])));
    renderPage();

    const note = await screen.findByTestId(
      `match-quality-${NAME_MATCH.finding.id}-entity-decision`,
    );
    expect(note).toHaveTextContent("the same entity");
    expect(note).toHaveTextContent("operator@example.invalid");
    // Even a recorded judgement does not upgrade the claim: the note says so
    // itself, and the band chip beside it still carries the standing caveat.
    expect(note).toHaveTextContent("neither publishes this finding nor makes the match a verified identity");
    expect(screen.getByTestId(`match-quality-${NAME_MATCH.finding.id}`)).toHaveTextContent(
      "not a verified identity",
    );
  });

  it("offers no judgement control on a finding with no name match", async () => {
    server.use(queueHandler(listing([CITED])));
    renderPage();

    await screen.findByText("What this rests on");
    expect(screen.queryByRole("button", { name: "Same entity" })).toBeNull();
  });

  it("reports a queue that could not be loaded", async () => {
    server.use(
      http.get("/api/admin/review/queue", () => new HttpResponse(null, { status: 500 })),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The review queue could not be loaded.",
    );
  });
});
