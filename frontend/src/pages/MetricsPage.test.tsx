import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { renderWithProviders, screen } from "@/lib/test-utils";
import { MetricsPage } from "./MetricsPage";
import { server } from "@/mocks/server";
import { metrics } from "@/mocks/data";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * What this suite guards is the set of statements the page must never stop
 * making. The numbers themselves are the API's problem; the ways this page
 * could quietly become flattering are its own.
 */

describe("MetricsPage", () => {
  it("leads with the project measuring itself", async () => {
    renderWithProviders(<MetricsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /by the numbers/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/we ask public bodies to be measurable/i)).toBeInTheDocument();
  });

  /**
   * The gap between ingested and published is the single most useful figure
   * here and the one most easily dropped in a redesign — it is the number that
   * says how much of the record a reader cannot see yet.
   */
  it("shows published as a share of the total, never alone", async () => {
    renderWithProviders(<MetricsPage />);
    const published = await screen.findByText(String(metrics.corpus.meetings_published));
    const row = published.closest("div");
    expect(row?.textContent).toContain(String(metrics.corpus.meetings_total));
  });

  it("shows findings awaiting review rather than only those published", async () => {
    renderWithProviders(<MetricsPage />);
    expect(await screen.findByText(/findings awaiting review/i)).toBeInTheDocument();
  });

  it("explains that a held finding is work waiting, not work hidden", async () => {
    renderWithProviders(<MetricsPage />);
    expect(
      await screen.findByText(/means work waiting, not work hidden/i),
    ).toBeInTheDocument();
  });

  /**
   * The load-bearing one. "Never published anything" and "publishes instantly"
   * both want to render as 0, and the backend had exactly that bug —
   * `Number(null)` is 0 and `Number.isFinite(0)` is true. The API returns null
   * now, and this asserts the page says so in words rather than drawing a dash
   * a reader would read as zero.
   */
  it("says nothing has been published rather than showing zero days", async () => {
    server.use(
      http.get("/api/metrics", () =>
        HttpResponse.json({
          ...metrics,
          latency: { median_days_to_publish: null, last_published_at: null },
        }),
      ),
    );
    renderWithProviders(<MetricsPage />);

    expect(await screen.findByText(/this is not zero days/i)).toBeInTheDocument();
    expect(screen.queryByText(/most recently published/i)).not.toBeInTheDocument();
  });

  it("distinguishes a load failure from an empty archive", async () => {
    server.use(http.get("/api/metrics", () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<MetricsPage />);

    expect(await screen.findByText(/failure on our side/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /the archive/i })).not.toBeInTheDocument();
  });

  it("states that the figures are aggregates and identify no record", async () => {
    renderWithProviders(<MetricsPage />);
    expect(
      await screen.findByText(/without saying which record/i),
    ).toBeInTheDocument();
  });

  it("notes that an unreadable document is held but not searchable", async () => {
    renderWithProviders(<MetricsPage />);
    expect(await screen.findByText(/held but not searchable/i)).toBeInTheDocument();
  });
});
