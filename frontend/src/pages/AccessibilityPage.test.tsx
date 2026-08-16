import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AccessibilityPage } from "./AccessibilityPage";

/**
 * These are public promises about this site's own accessibility. The page
 * would still look right with any one of them softened or removed — that is
 * exactly why each is pinned here: a test is how a promise survives a
 * refactor, and an unpinned admission is the first thing a future edit
 * quietly polishes away.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <AccessibilityPage />
    </MemoryRouter>,
  );
}

describe("AccessibilityPage", () => {
  it("renders as a page, with an h1", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: /accessibility/i }),
    ).toBeInTheDocument();
  });

  it("states the WCAG 2.2 AA conformance target", () => {
    renderPage();
    expect(screen.getByText(/WCAG 2.2 at Level AA/i)).toBeInTheDocument();
  });

  it("says the target is measured, not a held certification", () => {
    renderPage();
    expect(
      screen.getByText(/not a certification issued by anyone else/i),
    ).toBeInTheDocument();
  });

  it("names axe-core and the automated route scan", () => {
    renderPage();
    expect(screen.getByText(/axe-core/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/a11y\.test\.tsx/)).toBeInTheDocument();
  });

  it("states contrast is computed rather than eyeballed", () => {
    renderPage();
    expect(
      screen.getByText(/rather than judged by eye/i),
    ).toBeInTheDocument();
  });

  /**
   * The load-bearing admission. MUTATION-VERIFY: removing this sentence from
   * the page must fail this test, naming the limitation, not just fail some
   * unrelated assertion.
   */
  it("states the severity-colour contrast limitation, with both numbers", () => {
    renderPage();
    expect(
      screen.getByText(/Two severity colours fail AA contrast for normal text/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/3\.08:1/)).toBeInTheDocument();
    expect(screen.getByText(/3\.61:1/)).toBeInTheDocument();
  });

  it("states the mitigation: severity is never carried by colour alone", () => {
    renderPage();
    expect(
      screen.getByText(/severity is never carried by colour alone/i),
    ).toBeInTheDocument();
  });

  it("gives a reporting channel for an accessibility problem", () => {
    renderPage();
    const mailto = screen.getAllByRole("link", { name: /corrections@commissionwatch/i });
    expect(mailto.length).toBeGreaterThan(0);
  });

  it("explains why the dispute form is the wrong channel for a barrier report", () => {
    renderPage();
    expect(
      screen.getByText(/deliberately not through/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /the dispute form/i }),
    ).toHaveAttribute("href", "/corrections/dispute");
  });

  it("states the site is English-only and why", () => {
    renderPage();
    expect(
      screen.getByText(/This site is published in English only, and it will stay that way/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/unsourced derivative of exactly the kind this site refuses/i),
    ).toBeInTheDocument();
  });

  it("does not promise a translation", () => {
    renderPage();
    expect(
      screen.getByText(/no mechanism to produce and no plan to build/i),
    ).toBeInTheDocument();
  });

  it("links to the open-data export and the public-records request as alternatives", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /open-data export/i })).toHaveAttribute(
      "href",
      "/data",
    );
    expect(
      screen.getByRole("link", { name: /requesting a record/i }),
    ).toHaveAttribute("href", "/public-records");
  });
});
