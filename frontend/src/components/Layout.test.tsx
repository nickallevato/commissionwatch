import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { renderWithProviders, screen } from "../lib/test-utils";
import { Layout } from "./Layout";

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

  it("renders the strap line with jurisdictions and sweep status", () => {
    renderWithProviders(<Layout />);
    expect(
      screen.getByText("Bozeman, MT · Gallatin County"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last sweep 12 min ago/)).toBeInTheDocument();
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
      within(footerNav).getByRole("link", { name: "Data License" }),
    ).toHaveAttribute("href", "/data-license");
  });

  it("offers a skip link to the main content", () => {
    renderWithProviders(<Layout />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main").id).toBe("main");
  });
});
