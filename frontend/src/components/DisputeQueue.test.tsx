import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DisputeQueue } from "./DisputeQueue";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { DisputeItem } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The disputes half of `/admin/review`.
 *
 * What this suite guards is the *distinction*. A finding and a dispute look
 * similar on a screen and are not the same act: approving a finding publishes
 * a claim this project makes, and upholding a dispute publishes nothing and
 * changes nothing. So there must be no approve button here, the card must say
 * in words that upholding changes no record, and the contester's words must be
 * rendered as their words rather than summarised into ours.
 */

function item(over: Partial<DisputeItem["dispute"]> = {}): DisputeItem {
  return {
    dispute: {
      id: "33333333-3333-4333-8333-333333333333",
      reference: "CW-4KQ7M2XP",
      target_table: "meetings",
      target_id: "22222222-2222-4222-8222-222222222222",
      contested: "The location recorded is not where it was held.",
      account: "I attended. It was in the annexe.",
      contact: "a@example.invalid",
      status: "received",
      review_state: "held",
      reviewer_operator_id: null,
      reviewer_email: null,
      review_reason: null,
      reviewed_at: null,
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:00:00.000Z",
      ...over,
    },
    context: {
      meeting_id: "22222222-2222-4222-8222-222222222222",
      meeting_date: "2026-08-04",
      commission_name: "City Commission",
      jurisdiction_name: "City of Bozeman",
      record_summary: "Meeting · 2026-08-04",
    },
  };
}

function serve(data: DisputeItem[]) {
  server.use(
    http.get("/api/admin/review/disputes", () =>
      HttpResponse.json({
        data,
        total: data.length,
        counts: { received: data.length, upheld: 0, declined: 0 },
      }),
    ),
  );
}

describe("DisputeQueue", () => {
  it("shows the contester's own words, and the contact", async () => {
    serve([item()]);
    renderWithProviders(<DisputeQueue />);

    expect(await screen.findByText("CW-4KQ7M2XP")).toBeInTheDocument();
    expect(
      screen.getByText("The location recorded is not where it was held."),
    ).toBeInTheDocument();
    expect(screen.getByText("I attended. It was in the annexe.")).toBeInTheDocument();
    expect(screen.getByText("a@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("Meeting · 2026-08-04")).toBeInTheDocument();
  });

  it("offers uphold and decline, and never approve", async () => {
    serve([item()]);
    renderWithProviders(<DisputeQueue />);

    expect(await screen.findByRole("button", { name: "Uphold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    // A dispute is not a finding, and the two must never read as the same act.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
  });

  it("says that upholding changes nothing on the record", async () => {
    serve([item()]);
    const { container } = renderWithProviders(<DisputeQueue />);
    await screen.findByText("CW-4KQ7M2XP");
    expect(container.textContent).toMatch(/Upholding one changes nothing on the record/);
    expect(container.textContent).toMatch(/never the motive/);
  });

  it("refuses a decision with no reason, without calling the API", async () => {
    serve([item()]);
    let called = false;
    server.use(
      http.post("/api/admin/review/disputes/:id/uphold", () => {
        called = true;
        return HttpResponse.json({});
      }),
    );

    renderWithProviders(<DisputeQueue />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Uphold" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "A decision needs a stated reason.",
    );
    expect(called).toBe(false);
  });

  it("upholds with a reason and says the record has not changed", async () => {
    serve([item()]);
    let sent: Record<string, unknown> = {};
    server.use(
      http.post("/api/admin/review/disputes/:id/uphold", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(item({ status: "upheld" }));
      }),
    );

    renderWithProviders(<DisputeQueue />);
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Your reason"),
      "The agenda names the annexe.",
    );
    await user.click(screen.getByRole("button", { name: "Uphold" }));

    await waitFor(() => expect(sent.reason).toBe("The agenda names the annexe."));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Nothing has changed on the record/,
    );
  });

  it("reproduces the API's refusal verbatim", async () => {
    serve([item()]);
    server.use(
      http.post("/api/admin/review/disputes/:id/decline", () =>
        HttpResponse.json(
          {
            error:
              "A correction describes the record, never the motive. Remove: bad faith",
            statusCode: 400,
          },
          { status: 400 },
        ),
      ),
    );

    renderWithProviders(<DisputeQueue />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your reason"), "Acting in bad faith.");
    await user.click(screen.getByRole("button", { name: "Decline" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/Remove: bad faith/);
  });

  it("shows a decided dispute's reason and offers no buttons for it", async () => {
    serve([
      item({
        status: "declined",
        reviewer_email: "editor@example.invalid",
        review_reason: "The minutes and the agenda both name the main chamber.",
        reviewed_at: "2026-08-10T13:00:00.000Z",
      }),
    ]);
    renderWithProviders(<DisputeQueue />);

    expect(
      await screen.findByText(
        "The minutes and the agenda both name the main chamber.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uphold" })).toBeNull();
  });

  it("reports a failure rather than an empty queue", async () => {
    server.use(
      http.get(
        "/api/admin/review/disputes",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderWithProviders(<DisputeQueue />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The disputes could not be loaded.",
    );
  });
});
