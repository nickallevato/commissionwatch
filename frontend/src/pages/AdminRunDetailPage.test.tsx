import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AdminRunDetailPage } from "./AdminRunDetailPage";
import { server } from "@/mocks/server";
import type { RunDetail } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `renderWithProviders` mounts its own `MemoryRouter` at "/", which cannot be
 * nested and carries no params. This page reads `:id`, so it is rendered
 * through a router whose entry supplies one.
 */
function renderRun(id = "run-1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/runs/${id}`]}>
      <Routes>
        <Route path="/admin/runs/:id" element={<AdminRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PARSE_ERROR =
  "Unreadable content type application/msword at ViewFile/Agenda/3821 — skipped";

const partialRun: RunDetail = {
  run: {
    id: "run-1",
    source_id: "s1",
    status: "partial",
    started_at: "2026-08-10T06:00:00.000Z",
    finished_at: "2026-08-10T06:07:00.000Z",
    counts: { meetings: 34 },
    error: null,
  },
  source: { id: "s1", adapter_key: "gallatin_civicplus", jurisdiction_name: "Gallatin County" },
  jobs: {
    total: 37,
    by_status: { pending: 0, running: 0, done: 34, failed: 3, blocked: 0 },
    by_stage: [
      { stage: "fetch", status: "done", count: 37 },
      { stage: "parse", status: "done", count: 34 },
      { stage: "parse", status: "failed", count: 3 },
    ],
  },
  failures: [
    {
      id: "job-9",
      stage: "parse",
      status: "failed",
      attempts: 2,
      last_error: PARSE_ERROR,
      target: { sha256: "abc" },
      next_attempt_at: "2026-08-10T07:00:00.000Z",
    },
  ],
  outcome: { headline: "partial", records: 34, failures: 3 },
};

function runHandler(detail: RunDetail = partialRun) {
  return http.get("/api/admin/pressroom/runs/:id", () => HttpResponse.json(detail));
}

describe("AdminRunDetailPage", () => {
  it("keeps a partial run green and still shows the failed job's error verbatim", async () => {
    // Decision 4, both halves. A run that parsed 34 of 37 is a success with a
    // footnote; collapsing it to "failed" trains the operator to ignore the
    // status, and then the real failure goes unread.
    server.use(runHandler());
    renderRun();

    const headline = await screen.findByTestId("run-headline");
    expect(headline).toHaveTextContent("Partial");
    expect(headline).toHaveClass("text-pass");
    expect(headline).not.toHaveClass("text-accent");

    expect(screen.getByText(PARSE_ERROR)).toBeInTheDocument();
    expect(screen.getByText("parse · failed")).toBeInTheDocument();
  });

  it("gives a failed run the failure treatment", async () => {
    server.use(
      runHandler({
        ...partialRun,
        run: { ...partialRun.run, status: "failed", error: "403 from the origin" },
        outcome: { headline: "failed", records: 0, failures: 37 },
      }),
    );
    renderRun();

    const headline = await screen.findByTestId("run-headline");
    expect(headline).toHaveTextContent("Failed");
    expect(headline).toHaveClass("text-accent");
  });

  it("re-parses stored bytes, reports the enqueued count, and says no source is contacted", async () => {
    // Decision 5. This is a different verb from "Sweep now".
    let posted = "";
    server.use(
      runHandler(),
      http.post("/api/admin/pressroom/runs/:id/reparse", ({ params }) => {
        posted = String(params.id);
        return HttpResponse.json({ run_id: "run-2", enqueued: 3 }, { status: 202 });
      }),
    );

    renderRun();
    await screen.findByTestId("run-headline");

    expect(screen.getByText("No request is made to the source.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Re-parse stored bytes" }));

    await waitFor(() => expect(posted).toBe("run-1"));
    expect(
      await screen.findByText(
        "Re-parse run run-2 enqueued 3 parse jobs against stored bytes.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a run with no jobs at all without crashing", async () => {
    server.use(
      runHandler({
        ...partialRun,
        run: { ...partialRun.run, status: "running", finished_at: null, counts: {} },
        jobs: {
          total: 0,
          by_status: { pending: 0, running: 0, done: 0, failed: 0, blocked: 0 },
          by_stage: [],
        },
        failures: [],
        outcome: { headline: "running", records: 0, failures: 0 },
      }),
    );
    renderRun();

    expect(await screen.findByText("No job in this run failed.")).toBeInTheDocument();
  });

  it("shows one red stage row against the green ones rather than one red run", async () => {
    // Screen 03. 34 of 37 parsed is a success with a footnote; a table that
    // collapsed to "failed" would train the operator to ignore the status.
    server.use(runHandler());
    renderRun();

    const headline = await screen.findByTestId("run-headline");
    expect(headline).toHaveClass("text-pass");

    // Three stage rows: two done, one failed, each with its own count.
    expect(screen.getAllByText("done")).toHaveLength(2);
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("parse")).toHaveLength(2);
    // 34 parsed of 37 fetched — both counts survive on the stage table, and
    // both appear again in the tiles, so these count rather than assert one.
    expect(screen.getAllByText("34").length).toBeGreaterThan(0);
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);
  });

  it("admits which provenance the run does not carry instead of inventing it", async () => {
    // The mockup shows a robots check, a rate limit, a user agent, an artifact
    // count and a deploy sha. `GET /runs/:id` carries the adapter and no more,
    // and a fabricated provenance line is worse than a missing one.
    server.use(runHandler());
    renderRun();

    const panel = await screen.findByTestId("provenance");
    expect(panel).toHaveTextContent("gallatin_civicplus");
    for (const key of ["Robots", "Rate limit", "User-agent", "Artifacts", "Deploy sha"]) {
      expect(panel).toHaveTextContent(key);
    }
    expect(panel.textContent ?? "").toContain("Not recorded on the run");
  });

  it("uses the failed jobs' own error text as the log tail, because there is no log", async () => {
    server.use(runHandler());
    renderRun();

    const tail = await screen.findByTestId("log-tail");
    expect(tail).toHaveTextContent(PARSE_ERROR);
  });

  it("draws the actions it cannot yet perform as disabled rather than as buttons that lie", async () => {
    server.use(runHandler());
    renderRun();

    await screen.findByTestId("run-headline");
    expect(screen.getByRole("button", { name: "Retry 3 failed jobs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Backfill date range…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Re-parse stored bytes" })).toBeEnabled();
  });

  it("renders an error state when the run cannot be loaded", async () => {
    server.use(
      http.get("/api/admin/pressroom/runs/:id", () => new HttpResponse(null, { status: 404 })),
    );
    renderRun("missing");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That run could not be loaded.");
  });
});

describe("a run in progress is a monitor", () => {
  /** 89 fetched of 429, still going — the shape of the first live Bozeman sweep. */
  const runningRun: RunDetail = {
    ...partialRun,
    run: {
      ...partialRun.run,
      status: "running",
      started_at: "2026-08-10T21:49:33.000Z",
      finished_at: null,
    },
    jobs: {
      total: 429,
      by_status: { pending: 339, running: 1, done: 89, failed: 0, blocked: 0 },
      by_stage: [
        { stage: "discover", status: "done", count: 1 },
        { stage: "fetch", status: "done", count: 88 },
        { stage: "fetch", status: "pending", count: 250 },
        { stage: "parse", status: "pending", count: 89 },
      ],
    },
    outcome: { headline: "running", records: 90, failures: 0 },
  };

  it("shows how far along it is rather than only that it is running", async () => {
    server.use(http.get("/api/admin/pressroom/runs/run-1", () => HttpResponse.json(runningRun)));
    renderRun();

    const progress = await screen.findByTestId("sweep-progress");
    expect(progress).toHaveTextContent("89 of 429 jobs");
    expect(progress).toHaveTextContent("340 queued");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "21");
  });

  it("explains a stopped run with work still queued as a limit, not a failure", async () => {
    // The defect this replaced: a sweep that fetched 89 documents perfectly and
    // ran out of clock was reported identically to a dead scraper.
    server.use(
      http.get("/api/admin/pressroom/runs/run-1", () =>
        HttpResponse.json({
          ...runningRun,
          run: { ...runningRun.run, status: "partial", finished_at: "2026-08-10T22:04:33.000Z" },
          outcome: { headline: "partial", records: 90, failures: 0 },
        }),
      ),
    );
    renderRun();

    const progress = await screen.findByTestId("sweep-progress");
    expect(progress).toHaveTextContent(/reached its time limit rather than failing/i);
    expect(progress).toHaveTextContent(/the next sweep continues where this one stopped/i);
  });

  it("says nothing is outstanding when every job finished", async () => {
    server.use(
      http.get("/api/admin/pressroom/runs/run-1", () =>
        HttpResponse.json({
          ...runningRun,
          run: { ...runningRun.run, status: "succeeded", finished_at: "2026-08-10T22:04:33.000Z" },
          jobs: {
            ...runningRun.jobs,
            by_status: { pending: 0, running: 0, done: 429, failed: 0, blocked: 0 },
          },
          outcome: { headline: "succeeded", records: 429, failures: 0 },
        }),
      ),
    );
    renderRun();

    const progress = await screen.findByTestId("sweep-progress");
    expect(progress).toHaveTextContent(/every job in this run reached a terminal state/i);
  });
});
