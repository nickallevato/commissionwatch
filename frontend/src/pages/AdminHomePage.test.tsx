import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AdminHomePage } from "./AdminHomePage";
import { AuthProvider } from "../contexts/AuthContext";
import { server } from "@/mocks/server";
import type { PressroomSource } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/admin` used to be a list of links to the other pages, because there was no
 * navigation in the console and something had to stand in for it. The rail is
 * that navigation now, so this page answers the two questions an operator
 * opens the console to ask — did the presses run, and is anything waiting on
 * me — and these tests are about those two answers.
 */

function source(
  id: string,
  verdict: PressroomSource["verdict"],
  lifetime: number,
): PressroomSource {
  return {
    id,
    adapter_key: `adapter_${id}`,
    enabled: true,
    disabled_reason: null,
    health_status: "healthy",
    cron_expression: "0 */6 * * *",
    expected_interval_hours: 6,
    consecutive_failures: 0,
    jurisdiction: { id: "j1", name: "Gallatin County", state: "MT" },
    last_success_at: verdict === "never_run" ? null : "2026-08-10T06:00:00.000Z",
    lifetime_records: lifetime,
    silence: { verdict: "ok", hours_since_success: 2, expected_interval_hours: 6 },
    verdict,
    latest_run: null,
  };
}

/** The page reads the operator off the session, so the provider is real here. */
function renderDashboard() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <AdminHomePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

function sourcesHandler(data: PressroomSource[]) {
  return http.get("/api/admin/pressroom/sources", () =>
    HttpResponse.json({ data, total: data.length }),
  );
}

function queueHandler(pending: number, overdue: number) {
  return http.get("/api/admin/review/queue", () =>
    HttpResponse.json({
      data: [],
      counts: { pending, overdue, approved: 0, rejected: 0 },
      policy: {
        id: "p1",
        hold_at_or_above: "medium",
        review_window_hours: 72,
        updated_by: null,
        updated_by_email: null,
        updated_at: "2026-08-10T00:00:00.000Z",
      },
    }),
  );
}

describe("AdminHomePage", () => {
  it("is a dashboard and not a menu — it answers whether the presses ran", async () => {
    server.use(sourcesHandler([source("s1", "healthy", 412)]), queueHandler(0, 0));
    renderDashboard();

    const verdict = await screen.findByTestId("press-verdict");
    expect(verdict).toHaveTextContent("Every registered source is inside its own expected interval");
  });

  it("names the sources that are not collecting rather than reporting a count alone", async () => {
    server.use(
      sourcesHandler([
        source("s1", "healthy", 412),
        source("s2", "never_run", 0),
        source("s3", "suspect", 3),
      ]),
      queueHandler(0, 0),
    );
    renderDashboard();

    const verdict = await screen.findByTestId("press-verdict");
    expect(verdict).toHaveTextContent("2 of 3 sources");
    expect(verdict).toHaveTextContent("adapter_s2, adapter_s3");
  });

  it("renders a lifetime total of zero in the failure treatment", async () => {
    // The same rule as the Sources screen: the number that has been true for
    // the product's whole life should look wrong, because it is.
    server.use(sourcesHandler([source("s1", "healthy", 0)]), queueHandler(0, 0));
    renderDashboard();

    const tile = await screen.findByTestId("dashboard-lifetime-records");
    expect(tile).toHaveTextContent("0");
    expect(tile).toHaveAttribute("data-tone", "bad");
  });

  it("says it does not know rather than reporting calm when the listing fails", async () => {
    server.use(
      http.get("/api/admin/pressroom/sources", () => new HttpResponse(null, { status: 500 })),
      queueHandler(0, 0),
    );
    renderDashboard();

    const verdict = await screen.findByTestId("press-verdict");
    expect(verdict).toHaveTextContent("could not be read");
    expect(verdict).toHaveTextContent("cannot say whether the presses ran");
  });

  it("counts what is waiting on the operator, and reds it when any of it is overdue", async () => {
    server.use(sourcesHandler([source("s1", "healthy", 412)]), queueHandler(4, 1));
    renderDashboard();

    await waitFor(() => expect(screen.getByText("1 overdue")).toBeInTheDocument());
    expect(screen.getByText("Waiting on you")).toBeInTheDocument();
  });

  it("no longer stands in for navigation — it links to two surfaces, not to all of them", async () => {
    server.use(sourcesHandler([source("s1", "healthy", 412)]), queueHandler(0, 0));
    renderDashboard();

    await screen.findByTestId("press-verdict");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "Every source, its sweeps and its silence watch" }),
    ).toHaveAttribute("href", "/admin/sources");
    expect(screen.getByRole("link", { name: "Open the queue" })).toHaveAttribute(
      "href",
      "/admin/review",
    );
  });
});
