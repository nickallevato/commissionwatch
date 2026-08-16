import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { AdminSourcesPage } from "./AdminSourcesPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { PressroomSource, QueueStats, RecentRun } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const gallatin: PressroomSource = {
  id: "s1",
  adapter_key: "gallatin_civicplus",
  enabled: true,
  disabled_reason: null,
  health_status: "healthy",
  cron_expression: "0 */6 * * *",
  expected_interval_hours: 6,
  consecutive_failures: 0,
  jurisdiction: { id: "j1", name: "Gallatin County", state: "MT" },
  last_success_at: "2026-08-10T06:00:00.000Z",
  lifetime_records: 412,
  silence: { verdict: "ok", hours_since_success: 2, expected_interval_hours: 6 },
  pipeline: "healthy",
  collection: { verdict: "collecting", last_record_at: "2026-08-10T06:00:00.000Z", hours_since_record: 2 },
  latest_run: {
    id: "r1",
    status: "succeeded",
    started_at: "2026-08-10T06:00:00.000Z",
    finished_at: "2026-08-10T06:04:00.000Z",
    counts: { meetings: 4 },
    error: null,
  },
};

/** Never produced a record, and quiet well past its own expected interval. */
const barren: PressroomSource = {
  id: "s2",
  adapter_key: "helena_granicus",
  enabled: true,
  disabled_reason: null,
  health_status: "degraded",
  cron_expression: "0 */12 * * *",
  expected_interval_hours: 12,
  consecutive_failures: 0,
  jurisdiction: { id: "j2", name: "Lewis and Clark County", state: "MT" },
  last_success_at: "2026-08-09T00:00:00.000Z",
  lifetime_records: 0,
  silence: { verdict: "suspect", hours_since_success: 31, expected_interval_hours: 12 },
  pipeline: "suspect",
  collection: { verdict: "empty", last_record_at: null, hours_since_record: null },
  latest_run: null,
};

const blocked: PressroomSource = {
  id: "s3",
  adapter_key: "bozeman_legistar",
  enabled: false,
  disabled_reason: "bozemanmt.gov sits behind Akamai and returns 403 to the scraper.",
  health_status: "blocked",
  cron_expression: "0 */6 * * *",
  expected_interval_hours: null,
  consecutive_failures: 3,
  jurisdiction: { id: "j3", name: "Bozeman", state: "MT" },
  last_success_at: null,
  lifetime_records: 0,
  silence: { verdict: "unknown", hours_since_success: null, expected_interval_hours: null },
  pipeline: "disabled",
  collection: { verdict: "disabled", last_record_at: null, hours_since_record: null },
  latest_run: null,
};

const emptyQueue: QueueStats = {
  depth: 0,
  oldest_pending_at: null,
  drained_last_hour: 0,
  fetch_loop_enabled: true,
  by_stage: [],
  by_source: [],
  read_at: "2026-08-16T12:00:00.000Z",
};

function sourcesHandler(data: PressroomSource[] = [gallatin, barren, blocked]) {
  return http.get("/api/admin/pressroom/sources", () =>
    HttpResponse.json({ data, total: data.length }),
  );
}

function queueHandler(data: QueueStats = emptyQueue) {
  return http.get("/api/admin/pressroom/queue", () => HttpResponse.json(data));
}

function runsHandler(data: RecentRun[] = []) {
  return http.get("/api/admin/pressroom/runs", () => HttpResponse.json({ data, total: data.length }));
}

/** The three fetches every render makes, with harmless defaults for the two
 *  a given test isn't exercising. Pass overrides for the one(s) under test. */
function allHandlers(opts: {
  sources?: PressroomSource[];
  queue?: QueueStats;
  runs?: RecentRun[];
  queueStatus?: number;
  runsStatus?: number;
  sourcesStatus?: number;
}) {
  const list: ReturnType<typeof http.get>[] = [];
  list.push(
    opts.sourcesStatus !== undefined
      ? http.get("/api/admin/pressroom/sources", () => new HttpResponse(null, { status: opts.sourcesStatus }))
      : sourcesHandler(opts.sources),
  );
  list.push(
    opts.queueStatus !== undefined
      ? http.get("/api/admin/pressroom/queue", () => new HttpResponse(null, { status: opts.queueStatus }))
      : queueHandler(opts.queue),
  );
  list.push(
    opts.runsStatus !== undefined
      ? http.get("/api/admin/pressroom/runs", () => new HttpResponse(null, { status: opts.runsStatus }))
      : runsHandler(opts.runs),
  );
  return list;
}

describe("AdminSourcesPage", () => {
  // -------------------------------------------------------------------------
  // Decision 1: zero is a failure state
  // -------------------------------------------------------------------------
  it("renders a lifetime collected count of zero as a failure, not as an empty cell", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const zero = await screen.findByTestId("collected-s2");
    expect(zero).toHaveTextContent("0 collected, ever");
    expect(zero).toHaveAttribute("data-zero", "true");
    expect(zero).toHaveClass("text-accent");

    // And a source that has produced records is not dressed up as a failure.
    const healthy = screen.getByTestId("collected-s1");
    expect(healthy).toHaveAttribute("data-zero", "false");
    expect(healthy).not.toHaveClass("text-accent");
    expect(healthy).toHaveTextContent("412");
  });

  // -------------------------------------------------------------------------
  // Decision 2: silence watch
  // -------------------------------------------------------------------------
  it("shows a suspect source's concern in its state and both silence figures in its facts line", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const state = await screen.findByTestId("state-s2");
    expect(state).toHaveTextContent("Suspect");

    const facts = screen.getByTestId("facts-s2");
    expect(facts).toHaveTextContent("31 h ago");
    expect(facts).toHaveTextContent("expected every 12 h");
  });

  it("says whether anything drains fetch outside a sweep", async () => {
    // A deep queue that is not moving has two very different causes. Before
    // this line the screen could not tell a broken worker from a fetch stage
    // that only runs for fifteen minutes a night — which is what production
    // was doing while 1,639 jobs aged for three days.
    server.use(...allHandlers({ queue: { ...emptyQueue, fetch_loop_enabled: false } }));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("fetch only drains during a sweep")).toBeInTheDocument();
  });

  it("says the archive is empty beside the state of the machinery, not instead of it", async () => {
    // Two pills, because they answer different questions. `barren` has run and
    // collected nothing; one word had to choose which of those to report.
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByTestId("state-s2")).toHaveTextContent("Suspect");
    expect(screen.getByTestId("archive-s2")).toHaveTextContent("No records");
    expect(screen.getByTestId("archive-s1")).toHaveTextContent("Collecting");
  });

  it("leaves a disabled source one pill, because two would say the same thing", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByTestId("state-s3")).toHaveTextContent("Off");
    expect(screen.queryByTestId("archive-s3")).toBeNull();
  });

  it("does not call a healthy, within-interval source suspect", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const state = await screen.findByTestId("state-s1");
    expect(state).not.toHaveTextContent("Suspect");
    expect(state).toHaveTextContent("Idle");
  });

  // -------------------------------------------------------------------------
  // Decision 3: disabled sources stay listed with their reason
  // -------------------------------------------------------------------------
  it("keeps a disabled source in the list, marked Off, and shows why", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("bozeman_legistar")).toBeInTheDocument();
    expect(await screen.findByTestId("state-s3")).toHaveTextContent("Off");
    expect(
      screen.getByText("bozemanmt.gov sits behind Akamai and returns 403 to the scraper."),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The live block
  // -------------------------------------------------------------------------
  it("renders the live block only when a run is running, with the own/others split", async () => {
    const liveRun: RecentRun = {
      run_id: "run-live",
      adapter_key: "gallatin_civicplus",
      status: "running",
      started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      finished_at: null,
      own_completed: 4,
      own_outstanding: 1,
      others_completed: 10,
    };
    server.use(...allHandlers({ runs: [liveRun] }));
    renderWithProviders(<AdminSourcesPage />);

    const live = await screen.findByTestId("live-block");
    expect(live).toHaveTextContent("gallatin_civicplus");
    expect(within(live).getByTestId("live-own")).toHaveTextContent("4");
    expect(live).toHaveTextContent("10");
    expect(live).toHaveTextContent("of its own jobs");
    expect(live).toHaveTextContent("for other sources");

    const bar = within(live).getByTestId("live-bar");
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("4"));
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("10"));

    expect(screen.queryByText("Nothing is sweeping.")).not.toBeInTheDocument();
  });

  it("shows 'Nothing is sweeping.' — not an empty panel — when no run is running", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("Nothing is sweeping.")).toBeInTheDocument();
    expect(screen.queryByTestId("live-block")).not.toBeInTheDocument();
  });

  it("marks a zero own-count with the accent colour — the diagnosis this screen exists for", async () => {
    const starved: RecentRun = {
      run_id: "run-starved",
      adapter_key: "gallatin_civicplus",
      status: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: null,
      own_completed: 0,
      own_outstanding: 1,
      others_completed: 90,
    };
    server.use(...allHandlers({ runs: [starved] }));
    renderWithProviders(<AdminSourcesPage />);

    const own = await screen.findByTestId("live-own");
    expect(own).toHaveTextContent("0");
    expect(own).toHaveAttribute("data-zero", "true");
    expect(own).toHaveClass("text-accent");
  });

  it("does not carry the accent colour when a running sweep's own count is non-zero", async () => {
    const busy: RecentRun = {
      run_id: "run-busy",
      adapter_key: "gallatin_civicplus",
      status: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: null,
      own_completed: 6,
      own_outstanding: 0,
      others_completed: 90,
    };
    server.use(...allHandlers({ runs: [busy] }));
    renderWithProviders(<AdminSourcesPage />);

    const own = await screen.findByTestId("live-own");
    expect(own).toHaveTextContent("6");
    expect(own).toHaveAttribute("data-zero", "false");
    expect(own).not.toHaveClass("text-accent");
  });

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------
  it("renders queue depth and the stage split from the queue endpoint", async () => {
    const stats: QueueStats = {
      depth: 976,
      oldest_pending_at: "2026-08-13T00:00:00.000Z",
      drained_last_hour: 0,
      fetch_loop_enabled: true,
      by_stage: [
        { stage: "fetch", pending: 972 },
        { stage: "discover", pending: 4 },
      ],
      by_source: [],
      read_at: "2026-08-16T12:00:00.000Z",
    };
    server.use(...allHandlers({ queue: stats }));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByTestId("queue-depth")).toHaveTextContent("976");
    const stageBar = screen.getByTestId("queue-stage-bar");
    expect(stageBar).toHaveAttribute("aria-label", expect.stringContaining("972 fetch"));
    expect(stageBar).toHaveAttribute("aria-label", expect.stringContaining("4 discover"));
    expect(screen.getByText(/fetch 972/)).toBeInTheDocument();
    expect(screen.getByText(/discover 4/)).toBeInTheDocument();
    expect(screen.getByText("drained last hour")).toBeInTheDocument();
  });

  it("shows a queue read failure as an error, and does not render zeros in its place", async () => {
    server.use(...allHandlers({ queueStatus: 500 }));
    renderWithProviders(<AdminSourcesPage />);

    const alert = await screen.findByTestId("queue-error");
    expect(alert).toHaveTextContent(/queue could not be read/i);
    expect(screen.queryByTestId("queue-depth")).not.toBeInTheDocument();

    // The sources it does have still render.
    expect(await screen.findByText("gallatin_civicplus")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Sweep history
  // -------------------------------------------------------------------------
  it("renders the last-five-sweeps table with its six columns", async () => {
    const runs: RecentRun[] = [
      {
        run_id: "run-1",
        adapter_key: "gallatin_civicplus",
        status: "partial",
        started_at: "2026-08-16T05:13:00.000Z",
        finished_at: "2026-08-16T05:27:00.000Z",
        own_completed: 0,
        own_outstanding: 1,
        others_completed: 90,
      },
      {
        run_id: "run-2",
        adapter_key: "bozeman_granicus",
        status: "partial",
        started_at: "2026-08-15T07:17:00.000Z",
        finished_at: "2026-08-15T07:32:00.000Z",
        own_completed: 3,
        own_outstanding: 0,
        others_completed: 0,
      },
    ];
    server.use(...allHandlers({ runs }));
    renderWithProviders(<AdminSourcesPage />);

    const table = await screen.findByTestId("sweep-history");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Source",
      "Finished",
      "Outcome",
      "Own",
      "Others’",
      "Left",
    ]);

    const row1 = within(table).getByTestId("history-row-run-1");
    expect(row1).toHaveTextContent("gallatin_civicplus");
    expect(row1).toHaveTextContent("partial");
    expect(row1).toHaveTextContent("90");
    expect(within(row1).getByTestId("history-own-run-1")).toHaveTextContent("0");

    const row2 = within(table).getByTestId("history-row-run-2");
    expect(row2).toHaveTextContent("bozeman_granicus");
    expect(row2).toHaveTextContent("3");
  });

  // -------------------------------------------------------------------------
  // Actions — untouched by the re-layout
  // -------------------------------------------------------------------------
  it("sweeps a single source and reports the outcome", async () => {
    let sweptId = "";
    server.use(
      ...allHandlers({}),
      http.post("/api/admin/pressroom/sources/:id/sweep", ({ params }) => {
        sweptId = String(params.id);
        return HttpResponse.json({ outcome: { kind: "queued" } }, { status: 202 });
      }),
    );

    renderWithProviders(<AdminSourcesPage />);
    await screen.findByRole("button", { name: "Sweep now: gallatin_civicplus" });

    await userEvent.click(screen.getByRole("button", { name: "Sweep now: gallatin_civicplus" }));

    await waitFor(() => expect(sweptId).toBe("s1"));
    expect(await screen.findByText(/Sweep of gallatin_civicplus started — queued\./)).toBeInTheDocument();
  });

  it("says so when a sweep is already in flight rather than pretending it started", async () => {
    server.use(
      ...allHandlers({}),
      http.post("/api/admin/pressroom/sources/:id/sweep", () =>
        HttpResponse.json({ error: "already running" }, { status: 409 }),
      ),
    );

    renderWithProviders(<AdminSourcesPage />);
    await screen.findByRole("button", { name: "Sweep now: gallatin_civicplus" });
    await userEvent.click(screen.getByRole("button", { name: "Sweep now: gallatin_civicplus" }));

    expect(
      await screen.findByText("A sweep of gallatin_civicplus is already in flight."),
    ).toBeInTheDocument();
  });

  it("renders an error state when the source listing fails", async () => {
    server.use(...allHandlers({ sourcesStatus: 500 }));
    renderWithProviders(<AdminSourcesPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ingestion sources could not be loaded.");
  });

  it("renders zero rows without crashing, and calls that out too", async () => {
    server.use(...allHandlers({ sources: [] }));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("No ingestion source is registered.")).toBeInTheDocument();
  });

  it("offers Enable on a disabled source and Disable on a live one", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const disabled = await screen.findByTestId("toggle-s3");
    expect(disabled).toHaveTextContent("Enable");
    const live = screen.getByTestId("toggle-s1");
    expect(live).toHaveTextContent("Disable");
  });

  it("requires a typed reason before a source can be enabled", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-s3"));

    const confirm = screen.getByRole("button", { name: "Enable source" });
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByLabelText(/why is bozeman_legistar being enabled/i),
      "Adapter reviewed.",
    );
    expect(confirm).toBeEnabled();
  });

  it("sends the toggle with the typed reason and the inverted flag", async () => {
    const sent = vi.fn();
    server.use(
      ...allHandlers({}),
      http.patch("/api/admin/pressroom/sources/s3", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({ id: "s3", enabled: true, disabled_reason: null });
      }),
    );
    renderWithProviders(<AdminSourcesPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-s3"));
    await user.type(
      screen.getByLabelText(/why is bozeman_legistar being enabled/i),
      "Akamai block resolved; authorised.",
    );
    await user.click(screen.getByRole("button", { name: "Enable source" }));

    await waitFor(() => {
      expect(sent).toHaveBeenCalledWith({
        enabled: true,
        reason: "Akamai block resolved; authorised.",
      });
    });
  });

  it("surfaces a refusal rather than claiming the source was enabled", async () => {
    server.use(
      ...allHandlers({}),
      http.patch("/api/admin/pressroom/sources/s3", () =>
        HttpResponse.json({ error: "reason is required" }, { status: 400 }),
      ),
    );
    renderWithProviders(<AdminSourcesPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("toggle-s3"));
    await user.type(screen.getByLabelText(/why is bozeman_legistar being enabled/i), "x");
    await user.click(screen.getByRole("button", { name: "Enable source" }));

    await waitFor(() => {
      expect(screen.getByTestId("notice")).toHaveTextContent("reason is required");
    });
  });

  it("links each source to its ingested meetings", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const link = await screen.findByLabelText("Review ingested meetings: bozeman_legistar");
    expect(link).toHaveAttribute("href", "/admin/sources/s3/meetings");
  });

  it("links each source with a known latest run to its runs", async () => {
    server.use(...allHandlers({}));
    renderWithProviders(<AdminSourcesPage />);

    const link = await screen.findByLabelText("Runs: gallatin_civicplus");
    expect(link).toHaveAttribute("href", "/admin/runs/r1");
  });
});
