import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import { StatusPage } from "./StatusPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { PublicStatus, PublicStatusSource } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/status` — the public collection status.
 *
 * What this suite guards is the set of things the page must not quietly stop
 * doing: showing a source that has never run, showing a source that is off
 * along with the reason, and calling silence *suspect* rather than leaving a
 * dead scraper looking like a quiet month. Each of those is one deletion away
 * from a page that looks tidier and says less.
 *
 * It also pins the collection-conduct disclosure. The vendor-`robots.txt`
 * exception is valid only while it is disclosed, so the disclosure being
 * present is a functional requirement of the scraper, not decoration.
 */

function source(over: Partial<PublicStatusSource> = {}): PublicStatusSource {
  return {
    adapter_key: "example-adapter",
    jurisdiction: { name: "Example County", state: "MT" },
    enabled: true,
    disabled_reason: null,
    cron_expression: "17 7 * * *",
    expected_interval_hours: 24,
    last_success_at: "2026-08-09T07:17:00.000Z",
    lifetime_records: 12,
    silence: {
      verdict: "ok",
      hours_since_success: 3,
      expected_interval_hours: 24,
    },
    verdict: "healthy",
    latest_run: {
      status: "succeeded",
      started_at: "2026-08-09T07:17:00.000Z",
      finished_at: "2026-08-09T07:19:00.000Z",
      records: 12,
      failures: 0,
    },
    ...over,
  };
}

function serve(status: Partial<PublicStatus>): void {
  const body: PublicStatus = {
    generated_at: "2026-08-10T09:00:00.000Z",
    last_successful_sweep_at: null,
    total: status.sources?.length ?? 0,
    sources: [],
    ...status,
  };
  server.use(http.get("/api/ingestion/sources", () => HttpResponse.json(body)));
}

describe("StatusPage", () => {
  it("lists a source that has never run rather than leaving it off the page", async () => {
    serve({
      sources: [
        source({
          adapter_key: "mt-cers",
          verdict: "never_run",
          last_success_at: null,
          lifetime_records: 0,
          latest_run: null,
          expected_interval_hours: null,
          silence: {
            verdict: "unknown",
            hours_since_success: null,
            expected_interval_hours: null,
          },
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("mt-cers")).toBeInTheDocument();
    expect(screen.getAllByText("Never run").length).toBeGreaterThan(0);
    expect(screen.getByTestId("records-mt-cers")).toHaveTextContent("0");
    expect(
      screen.getByText("Nothing has ever been collected from this source."),
    ).toBeInTheDocument();
  });

  it("keeps a disabled source listed and prints the reason it is off", async () => {
    const reason =
      "bozemanmt.gov returns a blanket Akamai block to every client, including this one.";
    serve({
      sources: [
        source({
          adapter_key: "bozeman-granicus",
          enabled: false,
          verdict: "disabled",
          disabled_reason: reason,
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("bozeman-granicus")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    // In the open, not behind a disclosure. This is the page where "why is
    // Bozeman missing?" is answered.
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("says Suspect when a source is past its expected interval, with both numbers", async () => {
    serve({
      sources: [
        source({
          adapter_key: "quiet-adapter",
          verdict: "suspect",
          silence: {
            verdict: "suspect",
            hours_since_success: 96.4,
            expected_interval_hours: 24,
          },
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    const cell = await screen.findByTestId("silence-quiet-adapter");
    expect(cell).toHaveTextContent("Suspect");
    expect(cell).toHaveTextContent("96.4 h since last success");
    expect(cell).toHaveTextContent("expected every 24 h");
  });

  it("does not call an unstated interval healthy", async () => {
    serve({
      sources: [
        source({
          adapter_key: "no-expectation",
          expected_interval_hours: null,
          silence: {
            verdict: "unknown",
            hours_since_success: 900,
            expected_interval_hours: null,
          },
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    const cell = await screen.findByTestId("silence-no-expectation");
    expect(cell).toHaveTextContent("Unknown");
    expect(cell).toHaveTextContent("silence here means nothing either way");
  });

  it("reports a run as counts, never as an error string", async () => {
    serve({
      sources: [
        source({
          adapter_key: "failing-adapter",
          verdict: "failing",
          latest_run: {
            status: "failed",
            started_at: "2026-08-09T07:17:00.000Z",
            finished_at: "2026-08-09T07:19:00.000Z",
            records: 0,
            failures: 3,
          },
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText("0 collected · 3 failed")).toBeInTheDocument();
  });

  it("says No sweep yet rather than inventing a timestamp", async () => {
    serve({ sources: [], last_successful_sweep_at: null });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("No sweep yet")).toBeInTheDocument();
    expect(
      screen.getByText(/No source has completed a sweep that reached the database/),
    ).toBeInTheDocument();
  });

  it("calls an empty registry a configuration gap, not a quiet week", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("No ingestion source is registered.")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is being watched. That is a configuration gap, not a quiet week."),
    ).toBeInTheDocument();
  });

  it("says so when the status itself cannot be loaded", async () => {
    server.use(
      http.get("/api/ingestion/sources", () =>
        HttpResponse.json({ error: "boom", statusCode: 500 }, { status: 500 }),
      ),
    );
    renderWithProviders(<StatusPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The collection status could not be loaded",
    );
  });

  // -------------------------------------------------------------------------
  // The disclosure. The exception is only valid while this is on the page.
  // -------------------------------------------------------------------------

  it("discloses the vendor robots.txt exception in plain words", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText(/CommissionWatch fetches those records anyway/)).toBeInTheDocument();
    expect(screen.getByText(/Disallow: \//)).toBeInTheDocument();
    expect(screen.getByText(/ten-second crawl delay/)).toBeInTheDocument();
    expect(
      screen.getByText(/That exception is valid only while it is disclosed\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/If this disclosure is ever taken down, the exception ends with it/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never pretends to be a browser|It never/),
    ).toBeInTheDocument();
  });

  it("links to the full methodology and to the public-records route", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByRole("link", { name: "Methodology page" })).toHaveAttribute(
      "href",
      "/methodology#robots",
    );
    expect(screen.getByRole("link", { name: "Request a record" })).toHaveAttribute(
      "href",
      "/public-records",
    );
  });
});
