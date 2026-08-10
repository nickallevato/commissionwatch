import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { AdminSourcesPage } from "./AdminSourcesPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { PressroomSource } from "@/types";

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
  verdict: "healthy",
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
  verdict: "suspect",
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
  verdict: "disabled",
  latest_run: null,
};

function listHandler(data: PressroomSource[] = [gallatin, barren, blocked]) {
  return http.get("/api/admin/pressroom/sources", () =>
    HttpResponse.json({ data, total: data.length }),
  );
}

describe("AdminSourcesPage", () => {
  it("renders a lifetime count of zero as a failure, not as an empty cell", async () => {
    // Decision 1. The number that has been true for the product's whole life
    // should look wrong, because it is.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const zero = await screen.findByTestId("lifetime-records-s2");
    expect(zero).toHaveTextContent("0");
    expect(zero).toHaveAttribute("data-zero", "true");
    expect(zero).toHaveClass("text-accent");

    expect(
      screen.getAllByText("No record has ever been ingested from this source.").length,
    ).toBeGreaterThan(0);

    // And a source that has produced records is not dressed up as a failure.
    const healthy = screen.getByTestId("lifetime-records-s1");
    expect(healthy).toHaveAttribute("data-zero", "false");
    expect(healthy).not.toHaveClass("text-accent");
  });

  it("says Suspect with the hours and the expectation when a source has gone quiet", async () => {
    // Decision 2. Without both numbers, a dead scraper and a quiet month at
    // City Hall produce identical screens.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const cell = await screen.findByTestId("silence-s2");
    expect(within(cell).getByText("Suspect")).toBeInTheDocument();
    expect(cell).toHaveTextContent("31 h since last success");
    expect(cell).toHaveTextContent("expected every 12 h");
  });

  it("keeps a disabled source in the table and shows why it is off", async () => {
    // Decision 3. The reason lives in the console, not in somebody's memory.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("bozeman_legistar")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Why disabled"));
    expect(
      screen.getByText("bozemanmt.gov sits behind Akamai and returns 403 to the scraper."),
    ).toBeInTheDocument();
  });

  it("sweeps a single source and reports the outcome", async () => {
    let sweptId = "";
    server.use(
      listHandler(),
      http.post("/api/admin/pressroom/sources/:id/sweep", ({ params }) => {
        sweptId = String(params.id);
        return HttpResponse.json({ outcome: { kind: "queued" } }, { status: 202 });
      }),
    );

    renderWithProviders(<AdminSourcesPage />);
    // The adapter key now appears in its own row *and* in the silence-watch
    // bar, so waiting on the row's control is the unambiguous query.
    await screen.findByRole("button", { name: "Sweep now: gallatin_civicplus" });

    await userEvent.click(screen.getByRole("button", { name: "Sweep now: gallatin_civicplus" }));

    await waitFor(() => expect(sweptId).toBe("s1"));
    expect(await screen.findByText(/Sweep of gallatin_civicplus started — queued\./)).toBeInTheDocument();
  });

  it("says so when a sweep is already in flight rather than pretending it started", async () => {
    server.use(
      listHandler(),
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

  it("renders an error state when the listing fails", async () => {
    server.use(
      http.get("/api/admin/pressroom/sources", () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<AdminSourcesPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ingestion sources could not be loaded.");
  });

  it("puts the lifetime figure in a tile, and renders a lifetime total of zero as a failure", async () => {
    // Screen 02's first tile row. The number that has been true for the
    // product's whole life should look wrong at the top of the screen too,
    // not only in a cell somebody has to scroll to.
    server.use(listHandler([barren, blocked]));
    renderWithProviders(<AdminSourcesPage />);

    const tile = await screen.findByTestId("tile-lifetime-records");
    expect(tile).toHaveTextContent("0");
    expect(tile).toHaveAttribute("data-tone", "bad");
  });

  it("does not dress a real lifetime total up as a failure", async () => {
    server.use(listHandler([gallatin]));
    renderWithProviders(<AdminSourcesPage />);

    const tile = await screen.findByTestId("tile-lifetime-records");
    expect(tile).toHaveTextContent("412");
    expect(tile).toHaveAttribute("data-tone", "plain");
  });

  it("shows the longest silence as unbounded when a source has never succeeded", async () => {
    // Not the largest known figure: a source that never ran has been silent
    // for the whole life of the product, and rounding that to a plausible
    // number hides the worst case behind an ordinary one.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("∞")).toBeInTheDocument();
    expect(screen.getByText(/bozeman_legistar, never succeeded/)).toBeInTheDocument();
  });

  it("draws a fourteen-slot sweep strip and says in words how much of it is real", async () => {
    // The API returns `latest_run` and no history. The unknown slots are drawn
    // grey — no sweep — and the sentence says so, rather than the strip
    // implying thirteen sweeps nobody has a record of.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const cell = await screen.findByTestId("sweeps-s1");
    const bars = cell.querySelectorAll("i");
    expect(bars).toHaveLength(14);
    expect(bars[13]).toHaveAttribute("data-kind", "ok");
    expect(bars[0]).toHaveAttribute("data-kind", "none");
    expect(cell).toHaveTextContent("one sweep on record");
    expect(cell).toHaveTextContent("The other 13 slots hold no sweep");

    // A source that has never run has nothing real in its strip at all.
    const never = screen.getByTestId("sweeps-s3");
    expect(never).toHaveTextContent("no sweep is on record");
    for (const bar of never.querySelectorAll("i")) {
      expect(bar).toHaveAttribute("data-kind", "none");
    }
  });

  it("gives every row a status pill whose meaning is a word, and a stripe beside it", async () => {
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByTestId("verdict-s1")).toHaveTextContent("Healthy");
    expect(screen.getByTestId("verdict-s2")).toHaveTextContent("Suspect");
    expect(screen.getByTestId("verdict-s3")).toHaveTextContent("Disabled");

    // Three rows, three stripes, and none of them the only carrier of meaning.
    expect(screen.getAllByTestId("severity-stripe")).toHaveLength(3);
  });

  it("names the expected cadence in the silence-watch bar", async () => {
    // Without this, a dead scraper is invisible by construction.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const bar = await screen.findByTestId("silence-watch");
    expect(bar).toHaveTextContent("gallatin_civicplus");
    expect(bar).toHaveTextContent("every 6 h");
    expect(bar).toHaveTextContent("silence is treated as a failure until proven otherwise");
  });

  it("renders zero rows without crashing, and calls that out too", async () => {
    server.use(listHandler([]));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("No ingestion source is registered.")).toBeInTheDocument();
  });

  it("offers Enable on a disabled source and Disable on a live one", async () => {
    // The lever that was missing. A disabled source cannot sweep — the server
    // skips it before it does anything — so on that row this, not Sweep now, is
    // the button that does something, and it is styled as the primary one.
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const disabled = await screen.findByTestId("toggle-s3");
    expect(disabled).toHaveTextContent("Enable");
    const live = screen.getByTestId("toggle-s1");
    expect(live).toHaveTextContent("Disable");
  });

  it("requires a typed reason before a source can be enabled", async () => {
    server.use(listHandler());
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
      listHandler(),
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
      listHandler(),
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
      expect(screen.getByRole("status")).toHaveTextContent("reason is required");
    });
  });

  it("links each source to its ingested meetings", async () => {
    // Where a sweep's output becomes public. Offered even on a source with
    // nothing ingested: "0 awaiting review" answers "did that sweep land?"
    server.use(listHandler());
    renderWithProviders(<AdminSourcesPage />);

    const link = await screen.findByLabelText("Review ingested meetings: bozeman_legistar");
    expect(link).toHaveAttribute("href", "/admin/sources/s3/meetings");
  });
});
