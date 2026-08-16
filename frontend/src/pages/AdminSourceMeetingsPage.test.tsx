import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AdminSourceMeetingsPage } from "./AdminSourceMeetingsPage";
import { server } from "@/mocks/server";
import type { PressroomMeetingSummary } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SOURCE = "11111111-1111-1111-1111-111111111111";
/**
 * `renderWithProviders` mounts its own `MemoryRouter` at "/", which cannot be
 * nested and carries no params. This page reads `:id`, so it is rendered
 * through a router whose entry supplies one — the same shape as the run and
 * meeting detail suites.
 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/admin/sources/${SOURCE}/meetings`]}>
      <Routes>
        <Route path="/admin/sources/:id/meetings" element={<AdminSourceMeetingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function meeting(overrides: Partial<PressroomMeetingSummary> = {}): PressroomMeetingSummary {
  return {
    id: "m1",
    date: "2026-08-04",
    time: "18:00",
    status: "completed",
    location: "City Hall",
    external_id: "08042026-107",
    agenda_url: "https://example.invalid/agenda",
    minutes_url: null,
    published_at: null,
    commission: { id: "c1", name: "County Commission" },
    document_count: 2,
    ...overrides,
  };
}

function listing(meetings: PressroomMeetingSummary[], unpublishedTotal?: number) {
  return {
    meetings,
    unpublished_total:
      unpublishedTotal ?? meetings.filter((row) => row.published_at === null).length,
    total: meetings.length,
  };
}

describe("the ingested-meetings screen", () => {
  it("shows the backlog awaiting review", async () => {
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting(), meeting({ id: "m2", date: "2026-08-05" })])),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("2026-08-04")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Held")).toHaveLength(2);
  });

  it("says how big the backlog is, not how much fitted on the page", async () => {
    // "Showing 2" would read as "there are 2". The count is deliberately
    // independent of the page size for exactly this reason.
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting(), meeting({ id: "m2" })], 512)),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("tile-backlog")).toHaveTextContent("512");
    });
  });

  it("will not let an already-published record be selected", async () => {
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(
          listing([
            meeting({ id: "m1" }),
            meeting({ id: "m2", published_at: "2026-08-09T00:00:00.000Z" }),
          ]),
        ),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("select-m1")).toBeEnabled();
    });
    expect(screen.getByTestId("select-m2")).toBeDisabled();
  });

  it("refuses to publish without a reason", async () => {
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting()])),
      ),
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId("select-m1")).toBeEnabled());
    await user.click(screen.getByTestId("select-m1"));

    // Selected, but the reason is empty — so the action is visibly unavailable
    // rather than failing with a 400 after the click.
    expect(screen.getByTestId("publish-selected")).toBeDisabled();

    await user.type(screen.getByLabelText(/why are these records being published/i), "Reviewed.");
    expect(screen.getByTestId("publish-selected")).toBeEnabled();
  });

  it("sends the selected ids and the typed reason", async () => {
    const sent = vi.fn();
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting(), meeting({ id: "m2", date: "2026-08-05" })])),
      ),
      http.post("/api/admin/pressroom/meetings/publish", async ({ request }) => {
        sent(await request.json());
        return HttpResponse.json({ published: ["m1"], already_published: [], not_found: [] });
      }),
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId("select-m1")).toBeEnabled());
    await user.click(screen.getByTestId("select-m1"));
    await user.type(
      screen.getByLabelText(/why are these records being published/i),
      "Dates match the source listing.",
    );
    await user.click(screen.getByTestId("publish-selected"));

    await waitFor(() => {
      expect(sent).toHaveBeenCalledWith({
        meeting_ids: ["m1"],
        reason: "Dates match the source listing.",
      });
    });
  });

  it("reports the outcomes that are not failures", async () => {
    // "Published 1" while three were skipped is a sentence that misleads the
    // person who has to answer for the record.
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting()])),
      ),
      http.post("/api/admin/pressroom/meetings/publish", () =>
        HttpResponse.json({
          published: ["m1"],
          already_published: ["m2", "m3"],
          not_found: ["m4"],
        }),
      ),
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId("select-m1")).toBeEnabled());
    await user.click(screen.getByTestId("select-m1"));
    await user.type(screen.getByLabelText(/why are these records being published/i), "Reviewed.");
    await user.click(screen.getByTestId("publish-selected"));

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("Published 1");
      expect(status).toHaveTextContent("2 were already public");
      expect(status).toHaveTextContent("1 matched no meeting");
    });
  });

  it("surfaces a refusal from the server rather than claiming success", async () => {
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([meeting()])),
      ),
      http.post("/api/admin/pressroom/meetings/publish", () =>
        HttpResponse.json({ error: "at most 200 meetings may be published at once" }, { status: 400 }),
      ),
    );

    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId("select-m1")).toBeEnabled());
    await user.click(screen.getByTestId("select-m1"));
    await user.type(screen.getByLabelText(/why are these records being published/i), "Reviewed.");
    await user.click(screen.getByTestId("publish-selected"));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("at most 200 meetings");
    });
  });

  it("says so plainly when nothing is held", async () => {
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json(listing([])),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/nothing is awaiting review/i)).toBeInTheDocument();
    });
  });

  it("reports a failed load instead of rendering an empty backlog", async () => {
    // An empty table and a broken endpoint look identical, and one of them
    // means "publish nothing" while the other means "you cannot see the queue".
    server.use(
      http.get(`/api/admin/pressroom/sources/${SOURCE}/meetings`, () =>
        HttpResponse.json({ error: "nope" }, { status: 500 }),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/i);
    });
    // And it does not also claim the queue is empty. A failed load has zero
    // rows too, and "nothing is awaiting review" is the more dangerous of the
    // two sentences to say wrongly.
    expect(screen.queryByText(/nothing is awaiting review/i)).not.toBeInTheDocument();
  });
});
