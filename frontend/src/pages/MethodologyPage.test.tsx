import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { MethodologyPage } from "./MethodologyPage";

/** Paths this app actually routes. Kept in step with `App.tsx` by hand, on purpose:
 *  if a route is removed, this list must be edited and the edit is the review. */
const ROUTED_PATHS = [
  "/",
  "/meetings",
  "/members",
  "/votes",
  "/anomalies",
  "/methodology",
  "/data-license",
  // P7. The statutory route this page promises, now a page rather than prose.
  "/public-records",
  // The per-source table this page used to promise "when the ingestion registry
  // ships". It has shipped, so the promise is now a link.
  "/status",
  // B3. The corrections log and the dispute route this page used to describe
  // without linking, because neither existed. Both do now.
  "/corrections",
  "/corrections/dispute",
];

describe("MethodologyPage", () => {
  it("renders as the methodology page", () => {
    renderWithProviders(<MethodologyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Methodology" }),
    ).toBeInTheDocument();
  });

  it("names an accountable individual, not an organisation or 'the team'", () => {
    // The organisation name was removed on request; the named person is the
    // half that carries the obligation. A site that publishes claims about
    // named people owes an address for service, and "the team" is not one —
    // so this assertion is narrowed, never dropped.
    renderWithProviders(<MethodologyPage />);
    const publisher = screen.getByRole("heading", {
      name: "Who publishes this",
    }).parentElement;
    expect(publisher).not.toBeNull();
    expect(publisher!.textContent).toMatch(/Nick Allevato/);
    expect(publisher!.textContent).not.toMatch(/Cold Smoke/i);
  });

  it("documents all six automated checks", () => {
    renderWithProviders(<MethodologyPage />);
    for (const label of [
      "Emergency session",
      "Minutes not published",
      "Quorum issue",
      "Last-minute agenda change",
      "Unanimous vote on a contested item",
      "Closed-door vote",
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
  });

  it("states what each check does not mean", () => {
    renderWithProviders(<MethodologyPage />);
    expect(screen.getAllByText("Does not mean")).toHaveLength(6);
  });

  it("states the provenance invariant and the pipeline stages in order", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    const stages = [...container.querySelectorAll("ol li h3")].map(
      (node) => node.textContent,
    );
    expect(stages).toEqual(["Fetch", "Hash", "Store", "Parse", "Analyze"]);
    expect(container.textContent).toMatch(
      /Every stage after\s+fetch\s+reads from the stored copy/,
    );
  });

  it("states the boundaries of what the project does", () => {
    renderWithProviders(<MethodologyPage />);
    expect(
      screen.getByRole("heading", { name: "What this project does not do" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never auto-publish|without an operator approving it/i),
    ).toBeInTheDocument();
  });

  it("publishes a corrections route, by email and as a page", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    const mailto = container.querySelectorAll(
      'a[href="mailto:corrections@commissionwatch.bmux.sh"]',
    );
    expect(mailto.length).toBeGreaterThan(0);
    expect(container.querySelector('a[href="/corrections"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="/corrections/dispute"]'),
    ).not.toBeNull();
  });

  /**
   * This assertion is the inverse of the one it replaces, on purpose.
   *
   * The page used to promise "2 business days", "10 business days", "24 hours"
   * and "3 business days" for handling a dispute. Nothing in this codebase
   * measured, tracked or alerted on any of them — four unenforced clocks on the
   * page belonging to the project whose subject is unenforced claims. B3
   * replaced them with what is actually guaranteed and by what, so the test
   * that pinned the old wording now fails if any of it comes back.
   */
  it("promises no response time that nothing enforces", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    expect(container.textContent).not.toMatch(/business days/i);
    expect(screen.getByText(/No response time is promised here/)).toBeInTheDocument();
    // And what replaced them names its own mechanism.
    expect(screen.getByText("Database trigger")).toBeInTheDocument();
  });

  it("links only to paths the app routes", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    const internal = [...container.querySelectorAll("a[href]")]
      .map((node) => node.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/"));

    expect(internal.length).toBeGreaterThan(0);
    for (const href of internal) {
      expect(ROUTED_PATHS, `${href} is not a routed path`).toContain(href);
    }
  });

  /**
   * The vendor-robots exception is only permitted while it is disclosed here.
   * These are the tests that make removing the disclosure fail rather than
   * quietly leave the crawler running against a policy the site no longer
   * publishes.
   */
  describe("the robots.txt disclosure", () => {
    it("states that the exception exists and where it applies", () => {
      renderWithProviders(<MethodologyPage />);
      expect(
        screen.getByRole("heading", { name: "How this site treats robots.txt" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/CommissionWatch fetches those records anyway/),
      ).toBeInTheDocument();
      expect(screen.getByText(/bozeman\.granicus\.com/)).toBeInTheDocument();
    });

    it("states the conditions the fetching runs under", () => {
      renderWithProviders(<MethodologyPage />);
      expect(
        screen.getByText(/One\s+request every ten seconds/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/No CAPTCHA is solved, no browser fingerprint/),
      ).toBeInTheDocument();
    });

    it("states that the exception ends if the disclosure does", () => {
      renderWithProviders(<MethodologyPage />);
      expect(
        screen.getByText(/the exception ends\s+with it/),
      ).toBeInTheDocument();
    });

    /**
     * The exception is written on the promise that the statutory route is
     * offered alongside it. P7 turned that promise into a page, so the link is
     * part of the disclosure and not decoration — losing it would leave the
     * exception standing on a sentence with nothing behind it.
     */
    it("offers the statutory route as a working destination", () => {
      const { container } = renderWithProviders(<MethodologyPage />);
      const link = container.querySelector('a[href="/public-records"]');
      expect(link).not.toBeNull();
      expect(link).toHaveTextContent("Request a record");
      expect(
        screen.getByText(/Nothing is sent on your behalf and\s+nothing you type is stored/),
      ).toBeInTheDocument();
    });
  });

  it("anchors every in-page link to a heading that exists", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    const anchors = [...container.querySelectorAll('a[href^="#"]')].map(
      (node) => node.getAttribute("href")!.slice(1),
    );

    expect(anchors.length).toBeGreaterThan(0);
    for (const id of anchors) {
      expect(container.querySelector(`#${id}`), `#${id} has no target`).not.toBeNull();
    }
  });
});
