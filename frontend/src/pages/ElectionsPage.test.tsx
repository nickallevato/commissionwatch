import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { ElectionsPage } from "./ElectionsPage";
import { renderWithProviders } from "@/lib/test-utils";

/**
 * `/elections` — the scaffolded module.
 *
 * The assertion this suite exists for is the negative one. A skeleton page is
 * the easiest place in the site for placeholder data to appear and then quietly
 * survive into production, and election figures are the worst candidates for
 * that: a contribution total is a number people repeat, and a plausible one is
 * indistinguishable from a real one once it leaves the page.
 *
 * So this suite fails if the page ever renders a candidate, a dollar amount, or
 * a vote count. When the module is genuinely built those assertions should be
 * replaced with ones about real records — deliberately, not by deleting a test
 * that started failing.
 */
describe("ElectionsPage", () => {
  it("names itself and says plainly that it holds nothing yet", () => {
    renderWithProviders(<ElectionsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Elections" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing is published here yet/i)).toBeInTheDocument();
  });

  it("names the source each future section will read from", () => {
    // So the module is designed from its sources rather than from a layout.
    // CERS in particular was established by probing, and is recorded so the
    // next person does not rediscover that Montana finance is structured data.
    renderWithProviders(<ElectionsPage />);
    expect(screen.getByText(/CERS/)).toBeInTheDocument();
    expect(screen.getByText(/Secretary of State candidate filings/)).toBeInTheDocument();
  });

  it("renders NO placeholder candidate, money figure, or tally", () => {
    const { container } = renderWithProviders(<ElectionsPage />);
    const text = container.textContent ?? "";

    // A currency amount of any size.
    expect(text).not.toMatch(/\$\s?\d/);
    // A vote or percentage tally.
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/\b\d+\s*(?:votes?|ballots?)\b/i);
    // The placeholder names the seed file uses, which have reached a page before.
    for (const fixture of ["Sample", "Placeholder", "Fixture", "Example", "Lorem"]) {
      expect(text).not.toContain(fixture);
    }
  });

  it("sends a reader to the records that DO exist", () => {
    // An empty module must not be a dead end, and must not imply the whole site
    // is empty.
    renderWithProviders(<ElectionsPage />);
    expect(screen.getByRole("link", { name: "Officials" })).toHaveAttribute(
      "href",
      "/officials",
    );
    expect(screen.getByRole("link", { name: "Votes" })).toHaveAttribute(
      "href",
      "/votes",
    );
    expect(
      screen.getByRole("link", { name: /What is and is not being collected/ }),
    ).toHaveAttribute("href", "/status");
  });
});
