import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminReviewPage } from "./AdminReviewPage";
import { server } from "@/mocks/server";
import type { ReviewQueueItem, ReviewQueueResponse } from "@/types";

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
