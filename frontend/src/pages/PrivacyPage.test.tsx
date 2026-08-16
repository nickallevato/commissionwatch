import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PrivacyPage } from "./PrivacyPage";

/**
 * The privacy page makes factual claims about what the code does, and a page
 * like that decays the moment the code moves. These tests pin the claims that
 * would be actively misleading if they stopped being true, so that changing the
 * behaviour breaks the suite rather than quietly turning this page into a lie.
 *
 * They deliberately do not test prose. They test the four commitments a reader
 * would rely on, and the one admission that keeps the page honest.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

describe("PrivacyPage", () => {
  it("renders as a page, with an h1", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: /privacy and data handling/i }),
    ).toBeInTheDocument();
  });

  it("states that no IP address is stored against a dispute", () => {
    renderPage();
    expect(screen.getByText(/No IP address and no browser information/i)).toBeInTheDocument();
  });

  it("states that donor addresses were dropped from storage, not merely hidden", () => {
    renderPage();
    expect(
      screen.getByText(/removed the address columns from the database entirely/i),
    ).toBeInTheDocument();
  });

  it("states that search is not logged beyond aggregate counts", () => {
    renderPage();
    expect(screen.getByText(/deliberately unlogged beyond aggregate counts/i)).toBeInTheDocument();
  });

  /**
   * The load-bearing admission. A privacy page that implies a retention
   * schedule nobody implemented is worse than one that admits there is none,
   * and this assertion is what stops the admission being quietly softened
   * before the schedule actually exists.
   */
  it("admits that personal information has no deletion schedule yet", () => {
    renderPage();
    expect(screen.getByText(/no deletion schedule/i)).toBeInTheDocument();
    expect(screen.getByText(/it is the absence of one/i)).toBeInTheDocument();
  });

  it("offers a route to have a dispute contact removed", () => {
    renderPage();
    const mailto = screen.getAllByRole("link", { name: /corrections@commissionwatch/i });
    expect(mailto.length).toBeGreaterThan(0);
  });

  it("links to the dispute form rather than only describing it", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /contest it/i })).toHaveAttribute(
      "href",
      "/corrections/dispute",
    );
  });
});
