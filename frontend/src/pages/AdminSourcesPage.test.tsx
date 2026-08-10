import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
    await screen.findByText("gallatin_civicplus");

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
    await screen.findByText("gallatin_civicplus");
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

  it("renders zero rows without crashing, and calls that out too", async () => {
    server.use(listHandler([]));
    renderWithProviders(<AdminSourcesPage />);

    expect(await screen.findByText("No ingestion source is registered.")).toBeInTheDocument();
  });
});
