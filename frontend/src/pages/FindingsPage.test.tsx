import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { FindingsPage } from "./FindingsPage";
import { server } from "@/mocks/server";

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
   * The heading changed on 2026-08-15; what it was guarding did not.
   *
   * "Flagged for review" was one of four names this page used for one object —
   * the nav said Findings, the URL said /anomalies, the body copy said "nothing
   * here is a finding". The heading is now the vocabulary's word, and the thing
   * worth protecting moves into the sentence under it: this page must say the
   * entries were reviewed by a person and must not read as an accusation.
   */
  it("leads with the review framing, not an accusation", () => {
    renderWithProviders(<FindingsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Findings" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/a person\s+reviewed and published/i)).toBeInTheDocument();
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
