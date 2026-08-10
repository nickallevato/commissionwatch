import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { CorrectionsPage } from "./CorrectionsPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { PublicCorrection } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/corrections` — the policy, and the log that shows it is kept.
 *
 * Two things this suite pins, and both are functional rather than cosmetic.
 *
 * **The absence of a response-time promise.** The Methodology page carried four
 * of them and nothing enforced any. If one reappears here it is an unenforced
 * claim on the page whose whole subject is unenforced claims.
 *
 * **The statement of the log's limit.** A correction to a withheld record does
 * not appear, and a reader has to be told that rather than left to assume the
 * log is a complete history of every edit ever made.
 */

function correction(over: Partial<PublicCorrection> = {}): PublicCorrection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-10T12:00:00.000Z",
    record_kind: "meeting",
    record_label: "Meeting",
    meeting_id: "22222222-2222-4222-8222-222222222222",
    field: "location",
    field_label: "location",
    old_value: "Main chamber",
    new_value: "Annexe",
    reason: "The agenda for that date names the annexe.",
    dispute_reference: null,
    summary: "Meeting location corrected from “Main chamber” to “Annexe”.",
    ...over,
  };
}

function serve(data: PublicCorrection[]) {
  server.use(
    http.get("/api/corrections", () =>
      HttpResponse.json({ data, total: data.length }),
    ),
  );
}

describe("CorrectionsPage", () => {
  it("states how to contest a record and what happens next", async () => {
    serve([]);
    renderWithProviders(<CorrectionsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Corrections and disputes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "How to contest a record" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What happens next" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Contest a record" }),
    ).toHaveAttribute("href", "/corrections/dispute");

    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
  });

  it("promises no response time that nothing enforces", async () => {
    serve([]);
    const { container } = renderWithProviders(<CorrectionsPage />);
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
    expect(container.textContent).not.toMatch(/business days/i);
    expect(container.textContent).toMatch(/Promise a response time/);
  });

  it("says plainly what it will not do, including publishing the dispute", async () => {
    serve([]);
    const { container } = renderWithProviders(<CorrectionsPage />);
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
    expect(container.textContent).toMatch(/Publish your dispute/);
    expect(container.textContent).toMatch(/Ask for identity documents/);
    expect(container.textContent).toMatch(/Email you/);
  });

  it("renders a correction in plain words, with its stated reason", async () => {
    serve([correction()]);
    renderWithProviders(<CorrectionsPage />);

    expect(
      await screen.findByText(
        "Meeting location corrected from “Main chamber” to “Annexe”.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The agenda for that date names the annexe."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "The record this changed" }),
    ).toHaveAttribute("href", "/meetings/22222222-2222-4222-8222-222222222222");
  });

  it("names the dispute that prompted a correction", async () => {
    serve([correction({ dispute_reference: "CW-4KQ7M2XP" })]);
    renderWithProviders(<CorrectionsPage />);
    expect(
      await screen.findByText("Prompted by dispute CW-4KQ7M2XP"),
    ).toBeInTheDocument();
  });

  it("states that corrections to withheld records do not appear", async () => {
    serve([]);
    const { container } = renderWithProviders(<CorrectionsPage />);
    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
    expect(container.textContent).toMatch(
      /Corrections to records that are not published do not appear here/,
    );
  });

  it("says an empty log is a statement about the log, not about being right", async () => {
    serve([]);
    renderWithProviders(<CorrectionsPage />);
    expect(
      await screen.findByText(/No correction has been made to a published record/),
    ).toBeInTheDocument();
  });

  it("shows a failure rather than an empty log when the request fails", async () => {
    server.use(
      http.get("/api/corrections", () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<CorrectionsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The corrections log could not be loaded.",
    );
  });
});
