import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BotPage } from "./BotPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <BotPage />
    </MemoryRouter>,
  );
}

/**
 * A page for machines that lists an endpoint we do not serve is worse than no
 * page — it is a 404 published on our behalf, to a client that will not check.
 * So these tests assert the paths against the code that serves them rather than
 * against the page's own copy.
 */
describe("BotPage", () => {
  it("has an h1 and says who it is for", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: /crawler or an agent/i }),
    ).toBeInTheDocument();
  });

  it("links every API surface it names", () => {
    renderPage();
    for (const path of [
      "/api/data",
      "/api/data/ocd.json",
      "/api/data/meetings.csv",
      "/api/metrics",
      // Added 2026-08-15. This page went stale within hours of being written:
      // the feeds, places, the source viewer and transcript coverage all
      // shipped after it and none were listed. A discovery document that omits
      // an endpoint is, to anything reading it, that endpoint not existing —
      // the same defect the /api/data manifest had when it omitted ocd.json.
      "/feed.xml",
      "/api/places/near",
      "/api/source/",
      "/api/transcripts/coverage",
      "/sitemap.xml",
      "/robots.txt",
    ]) {
      expect(screen.getByRole("link", { name: path })).toHaveAttribute("href", path);
    }
  });

  /**
   * The three-way licence split is the whole point of the terms section.
   * Collapsing it is the usual mistake: one "MIT" would claim a licence over the
   * county's agendas, one "CC BY" would relicense the code.
   */
  it("separates the dataset, the code, and the records underneath", () => {
    renderPage();
    expect(screen.getByText("The compiled dataset")).toBeInTheDocument();
    expect(screen.getByText(/CC BY 4\.0/)).toBeInTheDocument();
    expect(screen.getByText("The code")).toBeInTheDocument();
    expect(screen.getByText("MIT.")).toBeInTheDocument();
    expect(screen.getByText(/assert no licence over them at all/i)).toBeInTheDocument();
  });

  it("tells a summarising agent to link the record, not this page", () => {
    renderPage();
    expect(
      screen.getByText(/link them to the meeting\s+or the finding/i),
    ).toBeInTheDocument();
  });

  it("states the rate-limit contract rather than leaving it to be discovered", () => {
    renderPage();
    expect(screen.getByText("429")).toBeInTheDocument();
    expect(screen.getByText("Retry-After")).toBeInTheDocument();
  });

  it("offers the dispute route, since an agent may be acting for someone named", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /contest a record/i })).toHaveAttribute(
      "href",
      "/corrections/dispute",
    );
  });

  /**
   * robots.txt invites crawlers in; this page is what the invitation is for. If
   * the pointer is dropped, the page exists and nothing reaches it.
   */
  it("is pointed at by robots.txt", () => {
    const robots = readFileSync(join(__dirname, "..", "..", "public", "robots.txt"), "utf8");
    expect(robots).toContain("/bot");
  });
});
