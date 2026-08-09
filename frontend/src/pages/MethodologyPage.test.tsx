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
];

describe("MethodologyPage", () => {
  it("renders as the methodology page", () => {
    renderWithProviders(<MethodologyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Methodology" }),
    ).toBeInTheDocument();
  });

  it("names the publisher and an accountable editor", () => {
    renderWithProviders(<MethodologyPage />);
    const publisher = screen.getByRole("heading", {
      name: "Who publishes this",
    }).parentElement;
    expect(publisher).not.toBeNull();
    expect(publisher!.textContent).toMatch(/Cold Smoke Consulting/);
    expect(publisher!.textContent).toMatch(/Nick Allevato/);
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

  it("publishes a corrections route and a response clock", () => {
    const { container } = renderWithProviders(<MethodologyPage />);
    const mailto = container.querySelectorAll(
      'a[href="mailto:corrections@commissionwatch.bmux.sh"]',
    );
    expect(mailto.length).toBeGreaterThan(0);
    expect(screen.getByText("10 business days")).toBeInTheDocument();
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
