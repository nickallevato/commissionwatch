import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AdminMeetingDetailPage } from "./AdminMeetingDetailPage";
import { server } from "@/mocks/server";
import type { MeetingDetailPayload } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `renderWithProviders` mounts its own `MemoryRouter` at "/", which cannot be
 * nested and carries no params. This page reads `:id`.
 */
function renderMeeting(id = "m1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/meetings/${id}`]}>
      <Routes>
        <Route path="/admin/meetings/:id" element={<AdminMeetingDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PUBLISHED_AT = "2026-08-10T18:00:00.000Z";

const base: MeetingDetailPayload = {
  meeting: {
    id: "m1",
    commission_id: "c1",
    date: "2026-08-04T00:00:00.000Z",
    time: "18:00",
    location: "City Hall, 121 N Rouse Ave",
    status: "completed",
    agenda_url: "https://example.test/agenda",
    minutes_url: null,
    external_id: "GAL-3821",
    published_at: null,
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T00:00:00.000Z",
  },
  commission: { id: "c1", name: "Board of County Commissioners" },
  jurisdiction: { id: "j1", name: "Gallatin County", state: "MT" },
  agenda_items: [
    {
      id: "a1",
      meeting_id: "m1",
      item_number: 1,
      title: "CONSENT AGENDA ITEM 4 CONTINUED",
      description: "Approval of the claims register for July.",
      category: "consent",
      field_confidence: {
        title: { level: "low", reason: "Heading split across two PDF columns" },
        description: { level: "high", reason: "Matched the minutes verbatim" },
      },
      created_at: "2026-08-05T00:00:00.000Z",
      updated_at: "2026-08-05T00:00:00.000Z",
    },
  ],
  documents: [
    {
      id: "d1",
      meeting_id: "m1",
      title: "Agenda packet",
      document_type: "agenda",
      url: "https://example.test/packet.pdf",
      created_at: "2026-08-05T00:00:00.000Z",
      updated_at: "2026-08-05T00:00:00.000Z",
    },
  ],
  artifacts: [
    {
      id: "art1",
      sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      storage_key: "artifacts/0f/1e/packet.pdf",
      content_type: "application/pdf",
      source_url: "https://example.test/packet.pdf",
      byte_size: 481203,
      fetched_at: "2026-08-05T00:00:00.000Z",
    },
  ],
  corrections: [
    {
      id: "corr-old",
      target_table: "meetings",
      target_id: "m1",
      field: "location",
      old_value: "City Hall",
      new_value: "City Hall, 121 N Rouse Ave",
      reason: "Street address was truncated by the scraper",
      operator_email: "operator@example.test",
      created_at: "2026-08-06T00:00:00.000Z",
    },
    {
      id: "corr-new",
      target_table: "agenda_items",
      target_id: "a1",
      field: "title",
      old_value: "CONSENT AGENDA ITEM 4",
      new_value: "CONSENT AGENDA ITEM 4 CONTINUED",
      reason: "Heading was split across two PDF columns",
      operator_email: "operator@example.test",
      created_at: "2026-08-07T00:00:00.000Z",
    },
  ],
};

function detailHandler(payload: MeetingDetailPayload = base) {
  return http.get("/api/admin/pressroom/meetings/:id", () => HttpResponse.json(payload));
}

describe("AdminMeetingDetailPage", () => {
  it("marks confidence per field, never once for the item", async () => {
    // Decision 6. Seven good agenda items and one mangled one is not a
    // low-confidence meeting, and one mangled title is not a low-confidence item.
    server.use(detailHandler());
    renderMeeting();

    const title = await screen.findByTestId("confidence-a1-title");
    expect(title).toHaveAttribute("data-level", "low");
    expect(title).toHaveTextContent("Heading split across two PDF columns");

    const description = screen.getByTestId("confidence-a1-description");
    expect(description).toHaveAttribute("data-level", "high");
    expect(description).toHaveTextContent("Matched the minutes verbatim");

    // The two marks disagree, and both survive — there is no single score to
    // collapse them into.
    expect(title.getAttribute("data-level")).not.toBe(description.getAttribute("data-level"));
  });

  it("shows 'Ingested, not published' and offers Publish, and requires a reason", async () => {
    // Decision 8, first half.
    server.use(detailHandler());
    renderMeeting();

    expect(await screen.findByTestId("publication-state")).toHaveTextContent(
      "Ingested, not published",
    );

    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toBeDisabled();

    await userEvent.type(
      screen.getByLabelText("Publication reason"),
      "Checked against the posted agenda",
    );
    expect(publish).toBeEnabled();
  });

  it("posts the publish reason", async () => {
    let body: unknown = null;
    server.use(
      detailHandler(),
      http.post("/api/admin/pressroom/meetings/:id/publish", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ published_at: PUBLISHED_AT });
      }),
    );
    renderMeeting();

    await screen.findByTestId("publication-state");
    await userEvent.type(
      screen.getByLabelText("Publication reason"),
      "Checked against the posted agenda",
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(body).toEqual({ reason: "Checked against the posted agenda" }),
    );
  });

  it("shows the publication timestamp and offers Unpublish once published", async () => {
    // Decision 8, second half.
    server.use(
      detailHandler({ ...base, meeting: { ...base.meeting, published_at: PUBLISHED_AT } }),
    );
    renderMeeting();

    const state = await screen.findByTestId("publication-state");
    expect(state).toHaveTextContent(new Date(PUBLISHED_AT).toLocaleString());
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("posts a correction with the selected target and field, and renders the history newest-first", async () => {
    // Decision 7. Append-only: the history has no control on it because there
    // is no edit path — the database raises on UPDATE and DELETE.
    let body: unknown = null;
    server.use(
      detailHandler(),
      http.post("/api/admin/pressroom/corrections", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "corr-3" }, { status: 201 });
      }),
    );
    renderMeeting();

    await screen.findByLabelText("New value");
    await userEvent.selectOptions(screen.getByLabelText("Field"), "location");
    await userEvent.type(screen.getByLabelText("New value"), "Community Room, 311 W Main");
    await userEvent.type(
      screen.getByLabelText("Correction reason"),
      "Meeting was moved and the scraper kept the old room",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record correction" }));

    await waitFor(() =>
      expect(body).toEqual({
        target_table: "meetings",
        target_id: "m1",
        field: "location",
        new_value: "Community Room, 311 W Main",
        reason: "Meeting was moved and the scraper kept the old room",
      }),
    );

    const history = screen.getByTestId("corrections-history");
    const entries = within(history).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("Heading was split across two PDF columns");
    expect(entries[1]).toHaveTextContent("Street address was truncated by the scraper");

    // Nothing in the log can be typed over.
    expect(within(history).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(history).queryAllByRole("button")).toHaveLength(0);
  });

  it("re-parses stored bytes without contacting the source", async () => {
    // Decision 5, the meeting half.
    let posted = "";
    server.use(
      detailHandler(),
      http.post("/api/admin/pressroom/meetings/:id/reparse", ({ params }) => {
        posted = String(params.id);
        return HttpResponse.json({ run_id: "run-7", enqueued: 1 }, { status: 202 });
      }),
    );
    renderMeeting();

    await screen.findByRole("button", { name: "Re-parse stored bytes" });
    expect(screen.getByText("No request is made to the source.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Re-parse stored bytes" }));

    await waitFor(() => expect(posted).toBe("m1"));
    expect(
      await screen.findByText("Re-parse run run-7 enqueued 1 parse job against stored bytes."),
    ).toBeInTheDocument();
  });

  it("renders a meeting with nothing attached to it without crashing", async () => {
    server.use(
      detailHandler({
        ...base,
        agenda_items: [],
        documents: [],
        artifacts: [],
        corrections: [],
      }),
    );
    renderMeeting();

    expect(await screen.findByText("No agenda item was extracted.")).toBeInTheDocument();
    expect(screen.getByText("No document is linked to this meeting.")).toBeInTheDocument();
    expect(screen.getByText("Nothing on this record has been corrected.")).toBeInTheDocument();
  });

  it("renders an error state when the meeting cannot be loaded", async () => {
    server.use(
      http.get("/api/admin/pressroom/meetings/:id", () => new HttpResponse(null, { status: 404 })),
    );
    renderMeeting("missing");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That meeting could not be loaded.");
  });
});
