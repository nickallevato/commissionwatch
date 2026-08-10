import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { within } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "../lib/test-utils";
import { server } from "@/mocks/server";
import { Layout } from "./Layout";
import { formatSweepAge } from "@/hooks/useIngestionStatus";

/**
 * The sweep line is served by MSW like every other API read. The default
 * handler answers `lastSuccessfulSweepAt: null`, so a test that is not about
 * the sweep never sees a timestamp somebody made up.
 */
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function sweptAt(value: string | null) {
  server.use(
    http.get("/api/ingestion/status", () =>
      HttpResponse.json({ lastSuccessfulSweepAt: value }),
    ),
  );
}

describe("Layout", () => {
  it("renders the masthead wordmark as a link home", () => {
    renderWithProviders(<Layout />);
    const wordmark = screen.getByRole("link", { name: "CommissionWatch" });
    expect(wordmark).toBeInTheDocument();
    expect(wordmark).toHaveAttribute("href", "/");
  });

  it("renders the primary navigation with all sections", () => {
    renderWithProviders(<Layout />);
    const nav = screen.getByRole("navigation", { name: "Primary" });

    const expected = [
      ["Findings", "/anomalies"],
      ["Meetings", "/meetings"],
      ["Officials", "/members"],
      ["Votes", "/votes"],
      // P6: search over the published record.
      ["Search", "/search"],
      // When these bodies sit, and the iCal feeds behind it.
      ["Calendar", "/calendar"],
      ["Methodology", "/methodology"],
      // B-e: the public self-serve alerts page. The admin routes are
      // deliberately absent — an operator door does not belong in a public
      // masthead, and this assertion is what keeps it out.
      ["Alerts", "/subscribe"],
    ] as const;

    for (const [label, href] of expected) {
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href,
      );
    }
    expect(within(nav).getAllByRole("link")).toHaveLength(expected.length);
  });

  it("renders the strap line with the jurisdictions", () => {
    renderWithProviders(<Layout />);
    expect(
      screen.getByText("Bozeman, MT · Gallatin County"),
    ).toBeInTheDocument();
  });

  /**
   * The masthead used to print "Last sweep 12 min ago" from a string constant,
   * true or not. These are the tests that stop it coming back: the age has to
   * come from `ingestion_runs`, and when there is nothing to report the site
   * has to say so rather than pick a number.
   */
  it("reports the sweep age from the ingestion status endpoint", async () => {
    const swept = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    sweptAt(swept);
    renderWithProviders(<Layout />);
    await waitFor(() =>
      expect(screen.getByText("Last sweep 12 min ago")).toBeInTheDocument(),
    );
  });

  it("says no sweep yet when nothing has ever swept", async () => {
    sweptAt(null);
    renderWithProviders(<Layout />);
    await waitFor(() =>
      expect(screen.getByText("No sweep yet")).toBeInTheDocument(),
    );
  });

  it("says no sweep yet when the status request fails", async () => {
    server.use(
      http.get(
        "/api/ingestion/status",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderWithProviders(<Layout />);
    await waitFor(() =>
      expect(screen.getByText("No sweep yet")).toBeInTheDocument(),
    );
  });

  it("never renders an invented sweep age", async () => {
    sweptAt(null);
    renderWithProviders(<Layout />);
    await waitFor(() =>
      expect(screen.getByText("No sweep yet")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Last sweep 12 min ago/)).not.toBeInTheDocument();
  });

  it("wires the menu button to the navigation with aria attributes", () => {
    renderWithProviders(<Layout />);
    const button = screen.getByRole("button", { name: /menu/i });
    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", nav.id);
    expect(nav.id).toBeTruthy();
  });

  it("toggles the menu open and closed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Layout />);
    const button = screen.getByRole("button", { name: /menu/i });

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the menu button reachable and operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Layout />);
    const button = screen.getByRole("button", { name: /menu/i });

    button.focus();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("closes the menu after following a navigation link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Layout />);
    const button = screen.getByRole("button", { name: /menu/i });

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Meetings" }));

    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the active section with aria-current", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Layout />);
    const nav = screen.getByRole("navigation", { name: "Primary" });

    await user.click(within(nav).getByRole("link", { name: "Findings" }));

    expect(within(nav).getByRole("link", { name: "Findings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders a main landmark for page content", () => {
    renderWithProviders(<Layout />);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders the footer disclaimer and source links", () => {
    renderWithProviders(<Layout />);
    expect(
      screen.getByText(
        "An independent watchdog project. Not affiliated with any government agency.",
      ),
    ).toBeInTheDocument();

    const footerNav = screen.getByRole("navigation", { name: "Footer" });
    expect(
      within(footerNav).getByRole("link", { name: "Methodology" }),
    ).toHaveAttribute("href", "/methodology");
    expect(
      within(footerNav).getByRole("link", { name: "Open data" }),
    ).toHaveAttribute("href", "/data");
  });

  it("offers a skip link to the main content", () => {
    renderWithProviders(<Layout />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main").id).toBe("main");
  });
});

describe("formatSweepAge", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  it("says no sweep yet for null, undefined and an unparseable instant", () => {
    expect(formatSweepAge(null, now)).toBe("No sweep yet");
    expect(formatSweepAge(undefined, now)).toBe("No sweep yet");
    expect(formatSweepAge("not a date", now)).toBe("No sweep yet");
  });

  it("counts minutes, hours and days", () => {
    expect(formatSweepAge("2026-08-09T11:48:00.000Z", now)).toBe(
      "Last sweep 12 min ago",
    );
    expect(formatSweepAge("2026-08-09T11:00:00.000Z", now)).toBe(
      "Last sweep 1 hr ago",
    );
    expect(formatSweepAge("2026-08-09T06:00:00.000Z", now)).toBe(
      "Last sweep 6 hrs ago",
    );
    expect(formatSweepAge("2026-08-08T12:00:00.000Z", now)).toBe(
      "Last sweep 1 day ago",
    );
    expect(formatSweepAge("2026-08-06T12:00:00.000Z", now)).toBe(
      "Last sweep 3 days ago",
    );
  });

  it("does not print a sweep in the future when the clocks disagree", () => {
    expect(formatSweepAge("2026-08-09T12:05:00.000Z", now)).toBe(
      "Last sweep just now",
    );
  });
});
