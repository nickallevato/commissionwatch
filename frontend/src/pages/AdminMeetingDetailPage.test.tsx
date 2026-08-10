import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AdminMeetingDetailPage } from "./AdminMeetingDetailPage";
import { server } from "@/mocks/server";
import type {
  MeetingParseStatus, DisputeItem, MeetingDetailPayload } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `renderWithProviders` mounts its own `MemoryRouter` at "/", which cannot be
 * nested and carries no params. This page reads `:id`.
 */
function renderMeeting(id = "m1", search = "") {
  return render(
    <MemoryRouter initialEntries={[`/admin/meetings/${id}${search}`]}>
      <Routes>
        <Route path="/admin/meetings/:id" element={<AdminMeetingDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PUBLISHED_AT = "2026-08-10T18:00:00.000Z";

/**
 * Parsed, and it found what is in `agenda_items`. The suites that care about
 * the other states override this — "not parsed yet" and "parsed, found
 * nothing" are different sentences on this screen and each gets its own test.
 */
const PARSED: MeetingParseStatus = {
  state: "done",
  total: 1,
  done: 1,
  outstanding: 0,
  failed: 0,
  last_error: null,
};

const base: MeetingDetailPayload = {
  parse: PARSED,
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
      dispute_id: null,
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
      dispute_id: null,
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

  /**
   * The join. `record_corrections.dispute_id` exists and the public log renders
   * off it, so the only thing missing was an operator screen that sets it —
   * and a link the operator has to retype is a link that exists only when
   * somebody remembers to make it.
   */
  describe("a correction prompted by a dispute", () => {
    const dispute: DisputeItem = {
      dispute: {
        id: "dsp-1",
        reference: "CW-7K2M4NPQ",
        target_table: "agenda_items",
        target_id: "a1",
        contested: "The title of item 1 is not what the agenda says.",
        account: "I read the agenda. It says CONSENT AGENDA ITEM 4.",
        contact: "someone@example.test",
        status: "upheld",
        review_state: "held",
        reviewer_operator_id: null,
        reviewer_email: "operator@example.test",
        review_reason: "The agenda published for that date reads differently.",
        reviewed_at: "2026-08-09T00:00:00.000Z",
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      },
      context: {
        meeting_id: "m1",
        meeting_date: "2026-08-04T00:00:00.000Z",
        commission_name: "Board of County Commissioners",
        jurisdiction_name: "Gallatin County",
        record_summary: "Agenda item · CONSENT AGENDA ITEM 4 CONTINUED",
      },
    };

    const disputeHandler = http.get("/api/admin/review/disputes/:id", () =>
      HttpResponse.json(dispute),
    );

    it("carries the dispute into the request, and preselects the contested row", async () => {
      let body: unknown = null;
      server.use(
        detailHandler(),
        disputeHandler,
        http.post("/api/admin/pressroom/corrections", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: "corr-3" }, { status: 201 });
        }),
      );
      renderMeeting("m1", "?dispute=dsp-1");

      const banner = await screen.findByTestId("dispute-link");
      expect(banner).toHaveTextContent("CW-7K2M4NPQ");
      expect(banner).toHaveTextContent("The title of item 1 is not what the agenda says.");

      // The dispute names the row it contests, so the form opens on it.
      await waitFor(() =>
        expect(screen.getByLabelText("Target")).toHaveValue("agenda_items:a1"),
      );

      await userEvent.type(screen.getByLabelText("New value"), "CONSENT AGENDA ITEM 4");
      await userEvent.type(
        screen.getByLabelText("Correction reason"),
        "The agenda published for that date reads CONSENT AGENDA ITEM 4",
      );
      await userEvent.click(screen.getByRole("button", { name: "Record correction" }));

      await waitFor(() =>
        expect(body).toEqual({
          target_table: "agenda_items",
          target_id: "a1",
          field: "title",
          new_value: "CONSENT AGENDA ITEM 4",
          reason: "The agenda published for that date reads CONSENT AGENDA ITEM 4",
          dispute_id: "dsp-1",
        }),
      );
    });

    it("omits the link when the operator unchecks it, rather than sending null", async () => {
      let body: unknown = null;
      server.use(
        detailHandler(),
        disputeHandler,
        http.post("/api/admin/pressroom/corrections", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: "corr-4" }, { status: 201 });
        }),
      );
      renderMeeting("m1", "?dispute=dsp-1");

      await screen.findByTestId("dispute-link");
      await userEvent.click(
        screen.getByLabelText("Record this correction against the dispute"),
      );
      await userEvent.type(screen.getByLabelText("New value"), "CONSENT AGENDA ITEM 4");
      await userEvent.type(screen.getByLabelText("Correction reason"), "The agenda reads so");
      await userEvent.click(screen.getByRole("button", { name: "Record correction" }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body).not.toHaveProperty("dispute_id");
    });

    it("says so and corrects anyway when the dispute cannot be loaded", async () => {
      // Refusing to correct a record over a broken query string would be the
      // worse failure. The page states what it could not resolve instead.
      let body: unknown = null;
      server.use(
        detailHandler(),
        http.get("/api/admin/review/disputes/:id", () =>
          HttpResponse.json({ error: "Dispute not found", statusCode: 404 }, { status: 404 }),
        ),
        http.post("/api/admin/pressroom/corrections", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: "corr-5" }, { status: 201 });
        }),
      );
      renderMeeting("m1", "?dispute=dsp-missing");

      expect(await screen.findByTestId("dispute-link-error")).toHaveTextContent(
        "without a link to one",
      );
      expect(screen.queryByTestId("dispute-link")).not.toBeInTheDocument();

      await userEvent.type(screen.getByLabelText("New value"), "City Hall annexe");
      await userEvent.type(screen.getByLabelText("Correction reason"), "The agenda says annexe");
      await userEvent.click(screen.getByRole("button", { name: "Record correction" }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body).not.toHaveProperty("dispute_id");
    });

    it("marks the prompted rows in the history and leaves the others alone", async () => {
      server.use(
        detailHandler({
          ...base,
          corrections: [
            { ...base.corrections[0], dispute_id: "dsp-1" },
            base.corrections[1],
          ],
        }),
        disputeHandler,
      );
      renderMeeting("m1", "?dispute=dsp-1");

      expect(await screen.findByTestId("correction-dispute-corr-old")).toHaveTextContent(
        "Prompted by dispute CW-7K2M4NPQ",
      );
      expect(screen.queryByTestId("correction-dispute-corr-new")).not.toBeInTheDocument();
    });
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
        // Nothing attached means nothing was ever fetched, so there is nothing
        // for the parser to have read. Saying "the parser found no agenda item"
        // here would claim a result nobody produced.
        parse: { state: "no_document", total: 0, done: 0, outstanding: 0, failed: 0, last_error: null },
      }),
    );
    renderMeeting();

    // By test id: the extracted-text panel says something similar for the same
    // state, and a bare text query would match both.
    expect(await screen.findByTestId("parse-state")).toHaveTextContent(
      /no document has been fetched for this meeting/i,
    );
    expect(screen.getByText("No document is linked to this meeting.")).toBeInTheDocument();
    expect(screen.getByText("Nothing on this record has been corrected.")).toBeInTheDocument();
  });

  it("says plainly that publishing would be over a known defect, and counts the items", async () => {
    // Decision 8's gate. The override is permitted; it is never silent.
    server.use(detailHandler());
    renderMeeting();

    const gate = await screen.findByTestId("publish-gate");
    expect(gate).toHaveTextContent("1 item marked Fix");
    expect(gate).toHaveTextContent("publishing over a known defect");
  });

  it("says so just as plainly when there is no defect to publish over", async () => {
    server.use(
      detailHandler({
        ...base,
        agenda_items: [
          {
            ...base.agenda_items[0],
            field_confidence: {
              title: { level: "high", reason: "Matched the minutes verbatim" },
            },
          },
        ],
      }),
    );
    renderMeeting();

    const gate = await screen.findByTestId("publish-gate");
    expect(gate).toHaveTextContent("No field on this record is marked Fix");
  });

  it("marks a low-confidence field Fix and a high-confidence one OK, on the same item", async () => {
    // Seven good items and one mangled one is not a low-confidence meeting,
    // and one mangled title is not a low-confidence item — so the row's own
    // pill reads the worst mark on it and never an average of them.
    server.use(detailHandler());
    renderMeeting();

    expect(await screen.findByTestId("confidence-a1-title")).toHaveTextContent("Fix");
    expect(screen.getByTestId("confidence-a1-description")).toHaveTextContent("OK");
    expect(screen.getByTestId("item-mark-a1")).toHaveTextContent("Fix");
  });

  it("shows the artifact's hash and admits the page count is not recorded", async () => {
    server.use(detailHandler());
    renderMeeting();

    const panel = await screen.findByTestId("artifact-facts");
    expect(panel).toHaveTextContent("0f1e…e1f0");
    expect(panel).toHaveTextContent("481203 bytes");
    // The mockup shows a page count. Nothing stores one, so the row stays and
    // says so rather than carrying a plausible number.
    expect(panel).toHaveTextContent("Not recorded");
  });

  it("shows the parsed value for the item most in need of a look", async () => {
    server.use(detailHandler());
    renderMeeting();

    const text = await screen.findByTestId("extracted-text");
    expect(text).toHaveTextContent("CONSENT AGENDA ITEM 4 CONTINUED");
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

describe("zero agenda items means two different things", () => {
  it("says 'not parsed yet' while the parse job is queued", async () => {
    // The live Bozeman case: the sweep timed out with every parse job pending,
    // and the screen reported a parser result for a document the parser had
    // never opened.
    server.use(
      http.get("/api/admin/pressroom/meetings/m1", () =>
        HttpResponse.json({
          ...base,
          agenda_items: [],
          parse: { state: "not_run", total: 1, done: 0, outstanding: 1, failed: 0, last_error: null },
        }),
      ),
    );

    renderMeeting();

    await waitFor(() => {
      expect(screen.getByTestId("parse-state")).toHaveTextContent(/not parsed yet/i);
    });
    expect(screen.getByTestId("parse-state")).toHaveTextContent(/1 parse job queued/i);
    expect(screen.queryByText(/no agenda item was extracted/i)).not.toBeInTheDocument();
  });

  it("says the parser found nothing once it has actually run", async () => {
    server.use(
      http.get("/api/admin/pressroom/meetings/m1", () =>
        HttpResponse.json({
          ...base,
          agenda_items: [],
          parse: { state: "done", total: 1, done: 1, outstanding: 0, failed: 0, last_error: null },
        }),
      ),
    );

    renderMeeting();

    await waitFor(() => {
      expect(screen.getByTestId("parse-state")).toHaveTextContent(
        /read this document and found no agenda item/i,
      );
    });
  });

  it("shows a failed parse with its error verbatim", async () => {
    server.use(
      http.get("/api/admin/pressroom/meetings/m1", () =>
        HttpResponse.json({
          ...base,
          agenda_items: [],
          parse: {
            state: "failed",
            total: 1,
            done: 0,
            outstanding: 0,
            failed: 1,
            last_error: "Unreadable content type application/msword",
          },
        }),
      ),
    );

    renderMeeting();

    await waitFor(() => {
      expect(screen.getByTestId("parse-state")).toHaveTextContent(
        "Unreadable content type application/msword",
      );
    });
  });
});
