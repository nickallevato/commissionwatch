import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import { StatusPage } from "./StatusPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { PublicExtraction, PublicStatus, PublicStatusSource } from "@/types";

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
    pipeline: "healthy",
    collection: { verdict: "collecting", last_record_at: "2026-08-10T06:00:00.000Z", hours_since_record: 2 },
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

/**
 * The state production was in until `extraction_runs` had a single row: minutes
 * stored, nothing read, and — the part that matters — no failure rate at all.
 */
function extraction(over: Partial<PublicExtraction> = {}): PublicExtraction {
  return {
    eligible: 9,
    read: 0,
    unread: 9,
    queued: 0,
    blocked: 0,
    failed: 0,
    reading: { measured: false, runs: 0 },
    ...over,
  };
}

function serve(status: Partial<PublicStatus>): void {
  const body: PublicStatus = {
    generated_at: "2026-08-10T09:00:00.000Z",
    last_successful_sweep_at: null,
    total: status.sources?.length ?? 0,
    sources: [],
    extraction: extraction(),
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
          pipeline: "never_run",
          collection: { verdict: "empty", last_record_at: null, hours_since_record: null },
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

  it("says the scraper is healthy and the archive is empty, rather than one word for both", async () => {
    // 2026-08-16: gallatin-civicplus read "Healthy" on this page while holding
    // zero records, ever. Both halves were true of different things, and the
    // page published the flattering one.
    serve({
      sources: [
        source({
          adapter_key: "gallatin-civicplus",
          pipeline: "healthy",
          collection: { verdict: "empty", last_record_at: null, hours_since_record: null },
          lifetime_records: 0,
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("gallatin-civicplus")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Nothing collected")).toBeInTheDocument();
    expect(screen.getByText("Scraper")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("keeps a disabled source listed and prints the reason it is off", async () => {
    const reason =
      "bozemanmt.gov returns a blanket Akamai block to every client, including this one.";
    serve({
      sources: [
        source({
          adapter_key: "bozeman-granicus",
          enabled: false,
          pipeline: "disabled",
          collection: { verdict: "disabled", last_record_at: null, hours_since_record: null },
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
          pipeline: "suspect",
          collection: { verdict: "collecting", last_record_at: "2026-08-10T06:00:00.000Z", hours_since_record: 2 },
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
          pipeline: "failing",
          collection: { verdict: "collecting", last_record_at: "2026-08-10T06:00:00.000Z", hours_since_record: 2 },
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

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("0 collected · 3 failed")).toBeInTheDocument();
  });

  /**
   * The raw `ingestion_runs.status` enum ("running" | "succeeded" | "partial"
   * | "failed") is a schema detail, not something a public, non-expert reader
   * should have to parse. `partial` in particular must not read as success:
   * it means some of the run's work succeeded and some did not.
   */
  it("labels a run's raw status in plain English, and does not call partial a success", async () => {
    serve({
      sources: [
        source({
          adapter_key: "partial-adapter",
          pipeline: "suspect",
          collection: { verdict: "collecting", last_record_at: "2026-08-10T06:00:00.000Z", hours_since_record: 2 },
          latest_run: {
            status: "partial",
            started_at: "2026-08-09T07:17:00.000Z",
            finished_at: "2026-08-09T07:19:00.000Z",
            records: 4,
            failures: 2,
          },
        }),
      ],
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText("Partly succeeded")).toBeInTheDocument();
    expect(screen.queryByText("partial")).toBeNull();
    expect(screen.queryByText("Succeeded")).toBeNull();
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
  // The reading backlog. Unmeasured is not zero.
  // -------------------------------------------------------------------------

  it("states the backlog depth, not only what was collected", async () => {
    serve({ sources: [], extraction: extraction({ eligible: 12, read: 3, unread: 9, queued: 2 }) });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByTestId("extraction-read")).toHaveTextContent("3");
    expect(screen.getByTestId("extraction-unread")).toHaveTextContent("9");
    expect(screen.getByTestId("extraction-queued")).toHaveTextContent("2");
  });

  /**
   * The one this section exists for. An unread share worked out over zero
   * passages is 0, and "0.0% went unread" is the most flattering sentence
   * available said on no evidence — the exact failure this project reports in
   * other people's publications. The page must say *unknown*, in words, and
   * print no percentage at all.
   */
  it("calls an unrun extractor unmeasured rather than reporting a clean sheet", async () => {
    serve({ sources: [], extraction: extraction({ reading: { measured: false, runs: 0 } }) });
    renderWithProviders(<StatusPage />);

    const panel = await screen.findByTestId("reading-unmeasured");
    expect(panel).toHaveTextContent("Not measured.");
    expect(panel).toHaveTextContent(/nothing has attempted to read a document yet/i);
    expect(panel).toHaveTextContent(/unknown, not a clean sheet/i);
    // No share, in any rendering of zero, within the reading panel itself.
    // (Scoped to the panel, not the whole page: the reliability-targets
    // section below legitimately states "99.0%" as a published target.)
    expect(panel.textContent).not.toMatch(/0(\.0)?%/);
  });

  it("still reports attempts that never reached a passage", async () => {
    serve({ sources: [], extraction: extraction({ reading: { measured: false, runs: 4 } }) });
    renderWithProviders(<StatusPage />);

    const panel = await screen.findByTestId("reading-unmeasured");
    expect(panel).toHaveTextContent("4 attempts are on record");
    expect(panel.textContent).not.toMatch(/0(\.0)?%/);
  });

  it("prints the measured share and what the failures were", async () => {
    // The real 2026-08-15 measurement.
    serve({
      sources: [],
      extraction: extraction({
        eligible: 10,
        read: 10,
        unread: 0,
        reading: {
          measured: true,
          runs: 20,
          meetings: 10,
          chunks: 24,
          chunks_unread: 5,
          unread_fraction: 0.208,
          claims_recovered: 88,
          reasons: [{ reason: "truncated-reply", chunks: 5, recovered: 88 }],
        },
      }),
    });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByTestId("chunks-unread")).toHaveTextContent("5");
    expect(document.body.textContent).toContain("20.8%");
    expect(screen.getByText(/the reply was cut off part-way through/)).toBeInTheDocument();
    // The salvage is the difference between "a fifth went unread" and "a fifth
    // was cut short after yielding most of what it had".
    expect(document.body.textContent).toMatch(/88/);
    expect(screen.queryByTestId("reading-unmeasured")).not.toBeInTheDocument();
  });

  it("says the backlog could not be read rather than showing an empty one", async () => {
    // A response with no `extraction` at all — an older API, or a broken one.
    server.use(
      http.get("/api/ingestion/sources", () =>
        HttpResponse.json({
          generated_at: "2026-08-10T09:00:00.000Z",
          last_successful_sweep_at: null,
          total: 0,
          sources: [],
        }),
      ),
    );
    renderWithProviders(<StatusPage />);

    expect(
      await screen.findByText(/The reading backlog could not be read/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("extraction-read")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reading-unmeasured")).not.toBeInTheDocument();
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

  // -------------------------------------------------------------------------
  // The reliability targets. Roadmap 6.6 — publish the SLO and its refusals.
  // -------------------------------------------------------------------------

  it("publishes the availability and ingestion-freshness targets", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(await screen.findByText(/99\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/GET \/api\/health/)).toBeInTheDocument();
    expect(screen.getByText(/database: connected/)).toBeInTheDocument();
    expect(screen.getByText(/7\.3 hours of downtime a month/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5×/)).toBeInTheDocument();
    expect(screen.getByText(/95%/)).toBeInTheDocument();
  });

  it("states publication latency has no target, and why, rather than inventing one", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(
      await screen.findByText(/No target is set, and that is a decision, not an omission/),
    ).toBeInTheDocument();
  });

  it("says the targets are not yet aggregated into a measured rolling figure", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    expect(
      await screen.findByText(/Neither target above is aggregated into a rolling figure yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/stated objectives, not\s*measured ones/),
    ).toBeInTheDocument();
  });

  it("states the refusals: no on-call, no night paging, no dispute response clock, no error budget", async () => {
    serve({ sources: [] });
    renderWithProviders(<StatusPage />);

    const promise = await screen.findByText(/What this does not promise:/);
    const container = promise.closest("p");
    expect(container).toHaveTextContent(/no on-call rotation/i);
    expect(container).toHaveTextContent(/no paging at night/i);
    expect(container).toHaveTextContent(/no guaranteed response time to a dispute/i);
    expect(container).toHaveTextContent(/no error budget policy/i);
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
