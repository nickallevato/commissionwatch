import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { DataLicensePage } from "./DataLicensePage";

/** Paths this app actually routes — see the note in `MethodologyPage.test.tsx`. */
const ROUTED_PATHS = [
  "/",
  "/meetings",
  "/members",
  "/votes",
  "/anomalies",
  "/methodology",
  "/data-license",
];

describe("DataLicensePage", () => {
  it("renders as the data license page", () => {
    renderWithProviders(<DataLicensePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Data license" }),
    ).toBeInTheDocument();
  });

  it("licenses the three layers separately", () => {
    renderWithProviders(<DataLicensePage />);
    expect(screen.getByText("The compiled dataset")).toBeInTheDocument();
    expect(screen.getByText("CC BY 4.0")).toBeInTheDocument();
    expect(screen.getByText("The code")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("The government documents")).toBeInTheDocument();
    expect(screen.getByText("No license asserted")).toBeInTheDocument();
  });

  it("gives an attribution line a reuser can copy", () => {
    renderWithProviders(<DataLicensePage />);
    expect(
      screen.getByText(/Data from CommissionWatch — commissionwatch\.bmux\.sh/),
    ).toBeInTheDocument();
  });

  it("lists what is withheld with a reason for each", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    const heading = screen.getByRole("heading", {
      name: "What is withheld, and why",
    });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const rows = section!.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.querySelectorAll("td")).toHaveLength(2);
    }
    expect(container.textContent).toMatch(/Subscriber email addresses/);
  });

  it("marks the corrections request as a request, not a license term", () => {
    renderWithProviders(<DataLicensePage />);
    expect(screen.getByText("A request, not a term")).toBeInTheDocument();
  });

  it("links to the canonical license texts", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    expect(
      container.querySelector(
        'a[href="https://creativecommons.org/licenses/by/4.0/"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'a[href="https://github.com/nickallevato/commissionwatch"]',
      ),
    ).not.toBeNull();
  });

  it("links only to paths the app routes", () => {
    const { container } = renderWithProviders(<DataLicensePage />);
    const internal = [...container.querySelectorAll("a[href]")]
      .map((node) => node.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/"));

    expect(internal.length).toBeGreaterThan(0);
    for (const href of internal) {
      expect(ROUTED_PATHS, `${href} is not a routed path`).toContain(href);
    }
  });
});
