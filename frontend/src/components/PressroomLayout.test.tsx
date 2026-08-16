import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { PressroomLayout } from "./PressroomLayout";
import { AuthProvider } from "../contexts/AuthContext";
import { server } from "@/mocks/server";
import type { PressroomSource } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const OPERATOR = {
  id: "op-1",
  email: "operator@commissionwatch.bmux.sh",
  name: "Operator",
  role: "operator",
  last_login_at: null,
};

function sessionHandler() {
  return http.get("/api/admin/session", () => HttpResponse.json({ operator: OPERATOR }));
}

/** The pip's listing. Most tests here do not care about it and want it quiet. */
function emptySources() {
  return http.get("/api/admin/pressroom/sources", () => HttpResponse.json({ data: [], total: 0 }));
}

function source(id: string, verdict: PressroomSource["verdict"]): PressroomSource {
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
    last_success_at: null,
    lifetime_records: 0,
    silence: { verdict: "unknown", hours_since_success: null, expected_interval_hours: null },
    verdict,
    latest_run: null,
  };
}

function renderShell(at = "/admin/sources") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route element={<PressroomLayout />}>
            <Route path="/admin" element={<p>Dashboard</p>} />
            <Route path="/admin/sources" element={<p>Sources screen</p>} />
            <Route path="/admin/channels" element={<p>Channels screen</p>} />
          </Route>
          <Route path="/admin/login" element={<p>Signed out</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("PressroomLayout", () => {
  it("gives the console a nav of its own, grouped by the job you came to do", async () => {
    server.use(sessionHandler(), emptySources());
    renderShell();

    const nav = await screen.findByRole("navigation", { name: "Pressroom" });
    for (const group of ["Operate", "Record", "Deliver", "Later"]) {
      expect(within(nav).getByRole("heading", { name: group })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: /Sources/ })).toHaveAttribute(
      "href",
      "/admin/sources",
    );
  });

  it("carries no public reader nav — the operator is backstage", async () => {
    server.use(sessionHandler(), emptySources());
    renderShell();

    await screen.findByRole("navigation", { name: "Pressroom" });
    for (const reader of ["Findings", "Methodology", "Search", "Alerts"]) {
      expect(screen.queryByRole("link", { name: reader })).toBeNull();
    }
  });

  it("marks the current page in three ways, not by colour alone", async () => {
    server.use(sessionHandler(), emptySources());
    renderShell("/admin/sources");

    const current = await screen.findByRole("link", { name: /Sources/ });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.className).toContain("border-accent");
    expect(current.className).toContain("font-semibold");
  });

  it("renders a surface with no route as text rather than as a dead link", async () => {
    server.use(sessionHandler(), emptySources());
    renderShell();

    await screen.findByRole("navigation", { name: "Pressroom" });
    expect(screen.queryByRole("link", { name: /^Runs/ })).toBeNull();
    const runs = screen.getByTestId("rail-runs");
    expect(runs.tagName).toBe("SPAN");
    expect(runs).toHaveTextContent("A run is reached from its source row");
  });

  it("shows a failure pip counting the sources that are not collecting", async () => {
    server.use(
      sessionHandler(),
      http.get("/api/admin/pressroom/sources", () =>
        HttpResponse.json({
          data: [source("s1", "healthy"), source("s2", "never_run"), source("s3", "suspect")],
          total: 3,
        }),
      ),
    );
    renderShell();

    const pip = await screen.findByTestId("rail-pip");
    expect(pip).toHaveTextContent("2");
    expect(pip).toHaveTextContent("sources not collecting");
  });

  it("shows no pip at all when the count cannot be read, rather than a zero it does not know", async () => {
    server.use(
      sessionHandler(),
      http.get("/api/admin/pressroom/sources", () => new HttpResponse(null, { status: 500 })),
    );
    renderShell();

    await screen.findByRole("navigation", { name: "Pressroom" });
    await waitFor(() => expect(screen.getByText("Sources screen")).toBeInTheDocument());
    expect(screen.queryByTestId("rail-pip")).toBeNull();
  });

  it("names the signed-in operator and signs them out", async () => {
    let deleted = false;
    server.use(
      sessionHandler(),
      http.delete("/api/admin/session", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderShell();

    expect(await screen.findByText("operator@commissionwatch.bmux.sh")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(deleted).toBe(true));
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
  });

  it("renders the routed screen inside a main landmark reachable by skip link", async () => {
    server.use(sessionHandler(), emptySources());
    renderShell();

    expect(await screen.findByText("Sources screen")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "pressroom-work");
    expect(screen.getByRole("link", { name: "Skip to the work" })).toHaveAttribute(
      "href",
      "#pressroom-work",
    );
  });
});
