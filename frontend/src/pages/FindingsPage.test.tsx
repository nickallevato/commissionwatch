import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { FindingsPage } from "./FindingsPage";
import { server } from "@/mocks/server";
import type { AnomalyFlag } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Entry sub-headlines are h3s; the filter menus repeat the same words. */
function entry(name: string) {
  return screen.queryByRole("heading", { name });
}

/** The whole ledger row a given sub-headline belongs to. */
function articleFor(name: string): HTMLElement {
  const article = screen
    .getByRole("heading", { name })
    .closest("article");
  if (!article) throw new Error(`no ledger entry rendered for "${name}"`);
  return article;
}

describe("FindingsPage", () => {
  /**
   * This test asserted a guarantee the system does not make, and held it in
   * place for half a day.
   *
   * The copy said "a person reviewed and published", and the assertion below
   * required those words — so the page and its test agreed with each other and
   * both disagreed with `resolveReviewState`, which publishes a low or medium
   * flag naming nobody with no human in the loop. A test that pins a false
   * claim is worse than no test: it makes the claim look checked.
   *
   * What it now asserts is the guarantee that is actually true, and it is the
   * narrower one — person-naming findings are held — plus the scope that makes
   * it honest.
   */
  it("states the review guarantee it can keep, and scopes it honestly", () => {
    renderWithProviders(<FindingsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Findings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/anything\s+naming a person is held until an operator approves it/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/published by rule[\s\S]*without a human in the\s+loop/i),
      "the page must not imply every finding was read by somebody",
    ).toBeInTheDocument();
    expect(screen.getByText(/a finding is not an allegation/i)).toBeInTheDocument();
  });

  it("renders a ledger entry per flag once loaded", async () => {
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });
    expect(entry("Last-minute agenda change")).toBeInTheDocument();
    expect(entry("Unanimous vote on a contested item")).toBeInTheDocument();
    expect(entry("Minutes not published")).toBeInTheDocument();
  });

  it("states severity as a numeral, not colour alone", async () => {
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    // Every entry carries its rank, so severity never rides on colour alone.
    for (const article of screen.getAllByRole("article")) {
      expect(
        within(article).getByTitle(/^Severity [1-5] of 5 — /),
      ).toHaveTextContent(/^[1-5]/);
    }

    const critical = articleFor("Quorum issue");
    expect(
      within(critical).getByTitle("Severity 5 of 5 — Critical"),
    ).toBeInTheDocument();
    expect(critical).toHaveTextContent("Severity 5 of 5, critical");
  });

  it("datelines each entry with its jurisdiction and meeting date", async () => {
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    const article = articleFor("Quorum issue");
    expect(article).toHaveTextContent("Boulder County, CO");
    expect(article).toHaveTextContent("Meeting Dec 10, 2024");
  });

  it("cites a source document and the meeting record for each entry", async () => {
    renderWithProviders(<FindingsPage />);

    const records = await screen.findAllByRole("link", {
      name: "Meeting record",
    });
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.getAttribute("href")).toMatch(
        /^\/meetings\/[0-9a-f-]{36}$/,
      );
    }

    const sources = screen.getAllByRole("link", {
      name: /^Source: (minutes|agenda)$/,
    });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]).toHaveAttribute("target", "_blank");
    expect(sources[0].getAttribute("href")).toMatch(/^https?:\/\//);
  });

  /**
   * The ledger and the meeting page resolve a finding's source with one rule as
   * of 2026-08-15, and this is the case that proved they did not.
   *
   * `AnomalyCard` used to ignore `metadata.source_document` and always link the
   * minutes, so a finding an operator had pinned to a named staff report was
   * cited here as the minutes and on the meeting page as the report. A reader
   * who followed the ledger's chip opened a document that does not contain what
   * the entry describes — worse than an uncited entry, because the check
   * appears to have been done.
   */
  it("cites the document a finding names, not the minutes it would default to", async () => {
    const pinned: AnomalyFlag = {
      id: "60000000-0000-4000-8000-00000000000f",
      meeting_id: "30000000-0000-4000-8000-000000000001",
      agenda_item_id: null,
      flag_type: "quorum_issue",
      description: "Only 2 of 5 members were recorded present.",
      severity: "critical",
      metadata: {
        source_document: "Staff report on the culvert bid",
        source_url: "https://records.example.invalid/staff-report-culvert.pdf",
      },
      source: "manual",
      created_at: "2024-12-10T10:00:00Z",
    };
    server.use(
      http.get("/api/anomalies", () =>
        HttpResponse.json({ data: [pinned], total: 1 }),
      ),
    );
    renderWithProviders(<FindingsPage />);

    const chip = await screen.findByRole("link", {
      name: "Source: Staff report on the culvert bid",
    });
    expect(chip).toHaveAttribute(
      "href",
      "https://records.example.invalid/staff-report-culvert.pdf",
    );
    expect(
      screen.queryByRole("link", { name: "Source: minutes" }),
    ).toBeNull();
  });

  /**
   * A finding carries no quotation and no artifact hash — `anomaly_flags` has
   * neither column, and the stored artifacts behind a finding are resolved only
   * for the operator console at `/api/admin/review`. So the ledger cites a
   * document and says so, and must never grow the furniture of `<Citation>`,
   * which promises a verbatim span of stored bytes.
   */
  it("cites a document, and never dresses one up as a quotation", async () => {
    const { container } = renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });
    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("figcaption")).toBeNull();
  });

  it("says a failed ledger request is ours, not an empty record", async () => {
    server.use(
      http.get("/api/anomalies", () =>
        HttpResponse.json({ error: "boom", statusCode: 500 }, { status: 500 }),
      ),
    );
    renderWithProviders(<FindingsPage />);

    expect(
      await screen.findByText(/The findings ledger could not be loaded/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /collection status/i }),
    ).toHaveAttribute("href", "/status");
    expect(screen.queryByText("Nothing is flagged for review.")).toBeNull();
  });

  it("counts the entries on show", async () => {
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(screen.getByText("entries")).toBeInTheDocument();
    });
    expect(screen.getByText("entries").closest("p")).toHaveTextContent("4");
  });

  it("filters the ledger by severity", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText("Severity"), "critical");

    await waitFor(() => {
      expect(entry("Last-minute agenda change")).not.toBeInTheDocument();
    });
    expect(entry("Quorum issue")).toBeInTheDocument();
    expect(screen.getByText("entry").closest("p")).toHaveTextContent("1");
  });

  it("filters the ledger by flag type and can be cleared", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    await user.selectOptions(
      screen.getByLabelText("Flag type"),
      "missing_minutes",
    );

    await waitFor(() => {
      expect(entry("Quorum issue")).not.toBeInTheDocument();
    });
    expect(entry("Minutes not published")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });
  });

  it("says so plainly when nothing matches the view", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    await user.selectOptions(
      screen.getByLabelText("Flag type"),
      "emergency_session",
    );

    await waitFor(() => {
      expect(screen.getByText("No flags match this view.")).toBeInTheDocument();
    });
  });

  it("never asserts wrongdoing in its own copy", async () => {
    const { container } = renderWithProviders(<FindingsPage />);

    await waitFor(() => {
      expect(entry("Quorum issue")).toBeInTheDocument();
    });

    const accusations =
      /corrupt|illegal|unlawful|fraud|wrongdoing|misconduct|crime|criminal|scandal|cover-?up|conspir/i;
    expect(container.textContent ?? "").not.toMatch(accusations);
  });
});
