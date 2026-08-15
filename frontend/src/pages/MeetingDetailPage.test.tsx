import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/mocks/server";
import { MeetingDetailPage } from "./MeetingDetailPage";
import type { MeetingDetail } from "@/hooks/useMeetings";
import type {
  AgendaItem,
  AnomalyFlag,
  AnomalyFlagType,
  Commission,
  Jurisdiction,
  Member,
  MeetingDocument,
  MeetingStatus,
  PublicClaims,
  Vote,
  VoteValue,
} from "@/types";

/**
 * The meeting record page — the one screen where CommissionWatch stops
 * summarising and states, item by item, what a body did on a given day.
 *
 * What this suite is really guarding is the difference between reporting the
 * record and reporting our own database. The page used to carry an "Adjourned"
 * row; `meetings` has no `adjourned_at` column, so that row printed the words
 * "Not recorded" on every meeting that has ever existed. Read by a member of
 * the public, "Not recorded" is a statement about the custodian's minutes — it
 * says the city failed to write something down. What it actually described was
 * a column we never built. The first test below exists so that row cannot come
 * back without someone deleting a test that explains why it is a lie.
 *
 * The rest of the suite is the same discipline applied to the smaller claims.
 * A cancelled meeting must not read as an ordinary one. A tied vote must not
 * read as passed — `outcomeOf` calls a tie `failed`, which is right and is the
 * case a reader would get wrong. A citation chip must point at the document the
 * flag was actually drawn from, because a chip pointing at the wrong PDF is
 * worse than no chip: it invites a reader to check, and the check appears to
 * confirm. When there are no minutes the page must say so and offer the
 * records-request route rather than quietly rendering a shorter page; that
 * nudge is the entire publication-gap path and it must not disappear.
 *
 * Every name here is invented. Seed and fixture data in this project never
 * names a real official — see the comment atop backend/seeds/001_pilot_data.ts
 * for the audit that made that a rule.
 */

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/* ------------------------------------------------------------------ render */

const MEETING_ID = "8f1d0c66-1111-4a00-9000-000000000001";

/**
 * The page reads its id off the route, so it has to be mounted under one. Kept
 * local: `renderWithProviders` mounts a bare MemoryRouter with no path, which
 * would leave `useParams` empty and every query disabled.
 */
function renderPage(id: string = MEETING_ID) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/meetings/${id}`]}>
        <Routes>
          <Route path="/meetings/:id" element={<MeetingDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ---------------------------------------------------------------- fixtures */

const JURISDICTION_ID = "8f1d0c66-2222-4a00-9000-000000000001";
const COMMISSION_ID = "8f1d0c66-3333-4a00-9000-000000000001";

const jurisdiction: Jurisdiction = {
  id: JURISDICTION_ID,
  name: "Fictional Springs",
  state: "ZZ",
  type: "city",
  website_url: null,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

const commission: Commission & { jurisdiction: Jurisdiction } = {
  id: COMMISSION_ID,
  jurisdiction_id: JURISDICTION_ID,
  name: "Example Commission on Public Works",
  description: null,
  meeting_schedule: null,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  jurisdiction,
};

function makeMember(id: string, name: string): Member {
  return {
    id,
    jurisdiction_id: JURISDICTION_ID,
    name,
    title: "Commissioner",
    email: null,
    term_start: "2024-01-01T00:00:00.000Z",
    term_end: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  };
}

const roster: Member[] = [
  makeMember("8f1d0c66-4444-4a00-9000-000000000001", "Avery Sample"),
  makeMember("8f1d0c66-4444-4a00-9000-000000000002", "Jordan Placeholder"),
  makeMember("8f1d0c66-4444-4a00-9000-000000000003", "Riley Fixture"),
  makeMember("8f1d0c66-4444-4a00-9000-000000000004", "Casey Example"),
  makeMember("8f1d0c66-4444-4a00-9000-000000000005", "Morgan Stand-In"),
];

function makeMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  const status: MeetingStatus = "completed";
  return {
    id: MEETING_ID,
    commission_id: COMMISSION_ID,
    date: "2024-12-03",
    time: "18:00:00",
    location: "Fictional Springs City Hall, Room 2",
    status,
    agenda_url: null,
    minutes_url: null,
    published_at: "2024-12-04T00:00:00.000Z",
    created_at: "2024-11-01T00:00:00.000Z",
    updated_at: "2024-12-04T00:00:00.000Z",
    commission,
    agenda_items: [],
    documents: [],
    ...overrides,
  };
}

function makeItem(
  id: string,
  item_number: number,
  title: string,
  overrides: Partial<AgendaItem> = {},
): AgendaItem {
  return {
    id,
    meeting_id: MEETING_ID,
    item_number,
    title,
    description: null,
    category: null,
    field_confidence: {},
    created_at: "2024-11-01T00:00:00.000Z",
    updated_at: "2024-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const ITEM_ONE = "8f1d0c66-5555-4a00-9000-000000000001";
const ITEM_TWO = "8f1d0c66-5555-4a00-9000-000000000002";
const ITEM_THREE = "8f1d0c66-5555-4a00-9000-000000000003";

function makeDocument(
  id: string,
  title: string,
  document_type: string,
  url: string,
): MeetingDocument {
  return {
    id,
    meeting_id: MEETING_ID,
    title,
    document_type,
    url,
    created_at: "2024-12-04T00:00:00.000Z",
    updated_at: "2024-12-04T00:00:00.000Z",
  };
}

const minutesDoc = makeDocument(
  "8f1d0c66-6666-4a00-9000-000000000001",
  "Minutes, December 3",
  "minutes",
  "https://records.example.invalid/minutes-2024-12-03.pdf",
);

const agendaDoc = makeDocument(
  "8f1d0c66-6666-4a00-9000-000000000002",
  "Agenda packet, December 3",
  "agenda",
  "https://records.example.invalid/agenda-2024-12-03.pdf",
);

const staffReportDoc = makeDocument(
  "8f1d0c66-6666-4a00-9000-000000000003",
  "Staff report on the culvert bid",
  "staff_report",
  "https://records.example.invalid/staff-report-culvert.pdf",
);

let voteSeq = 0;
function makeVote(
  memberId: string,
  value: VoteValue,
  agendaItemId: string | null,
): Vote {
  voteSeq += 1;
  return {
    id: `8f1d0c66-7777-4a00-9000-${String(voteSeq).padStart(12, "0")}`,
    meeting_id: MEETING_ID,
    agenda_item_id: agendaItemId,
    member_id: memberId,
    vote: value,
    created_at: "2024-12-03T18:30:00.000Z",
  };
}

function makeFlag(
  flag_type: AnomalyFlagType,
  overrides: Partial<AnomalyFlag> = {},
): AnomalyFlag {
  return {
    id: "8f1d0c66-8888-4a00-9000-000000000001",
    meeting_id: MEETING_ID,
    agenda_item_id: null,
    flag_type,
    severity: "medium",
    description: "Recorded for review by a person.",
    metadata: null,
    source: "auto",
    created_at: "2024-12-05T00:00:00.000Z",
    ...overrides,
  };
}

/* ---------------------------------------------------------------- handlers */

function list<T>(data: T[]) {
  return HttpResponse.json({ data, total: data.length });
}

interface Scenario {
  /** `null` stands for a meeting the API has no row for. */
  meeting?: MeetingDetail | null;
  agendaItems?: AgendaItem[];
  documents?: MeetingDocument[];
  votes?: Vote[];
  anomalies?: AnomalyFlag[];
  members?: Member[];
  /** Three fields, not a list — see `PublicClaims`. */
  claims?: PublicClaims;
}

/** Every endpoint the page fans out to, so no test leans on a shared fixture. */
function install(scenario: Scenario = {}) {
  const {
    meeting = makeMeeting(),
    agendaItems = [],
    documents = [],
    votes = [],
    anomalies = [],
    members = roster,
    claims = { claims: [], tombstones: [], awaiting_re_review: 0 },
  } = scenario;

  server.use(
    http.get("/api/meetings/:id/claims", () => HttpResponse.json(claims)),
    http.get("/api/meetings/:id", () =>
      meeting
        ? HttpResponse.json(meeting)
        : new HttpResponse(null, { status: 404, statusText: "Not Found" }),
    ),
    http.get("/api/meetings/:id/agenda-items", () => list(agendaItems)),
    http.get("/api/meetings/:id/documents", () => list(documents)),
    http.get("/api/meetings/:id/agenda-diff", () => list([])),
    http.get("/api/votes", () => list(votes)),
    http.get("/api/anomalies", () => list(anomalies)),
    http.get("/api/members", () => list(members)),
  );
}

/* ----------------------------------------------------------------- lookups */

/** The `<dd>` beside a standing-head `<dt>`. */
function fieldValue(label: string): string {
  const term = screen.getByText(label);
  const value = term.parentElement?.querySelector("dd");
  if (!value) throw new Error(`no value rendered for the "${label}" field`);
  return value.textContent ?? "";
}

/** The figure printed under a stat-band label. */
function statValue(label: string): string {
  const figure = screen.getByText(label).parentElement?.querySelector("p");
  if (!figure) throw new Error(`no figure rendered for the "${label}" stat`);
  return figure.textContent ?? "";
}

function itemRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest("tr");
  if (!row) throw new Error(`no agenda row rendered for "${title}"`);
  return row;
}

/* -------------------------------------------------------------------- tests */

describe("MeetingDetailPage", () => {
  describe("what the page claims about the record", () => {
    /**
     * There is no "Adjourned" row, and restoring one would be restoring an
     * unsourceable claim. `meetings` stores a date, a nullable time, a location
     * and a status — there is no `adjourned_at` column and never has been — so
     * the row could only ever render the literal string "Not recorded", on
     * every meeting, forever. "Not recorded" reads as a fact about the
     * custodian's minutes. It would be describing our schema gap instead, in
     * the city's voice. If an adjournment time is one day extracted from
     * minutes, it gets a column first, and then it gets a row here.
     *
     * `Convened` and `Location` stay, and are asserted present, because
     * `meetings.time` and `meetings.location` are real nullable columns: their
     * "Not recorded" is true of the source.
     */
    it("carries no Adjourned row, and keeps the fields the schema can source", async () => {
      install({ meeting: makeMeeting() });
      renderPage();

      await screen.findByRole("heading", { name: /Meeting of/ });

      expect(screen.queryByText("Adjourned")).toBeNull();
      expect(screen.queryByText(/adjourn/i)).toBeNull();

      expect(screen.getByText("Convened")).toBeInTheDocument();
      expect(fieldValue("Convened")).toBe("6:00 p.m.");
      expect(screen.getByText("Location")).toBeInTheDocument();
      expect(fieldValue("Location")).toBe(
        "Fictional Springs City Hall, Room 2",
      );
    });

    it('says "Not recorded" only where the column is genuinely null', async () => {
      install({ meeting: makeMeeting({ time: null, location: null }) });
      renderPage();

      await screen.findByRole("heading", { name: /Meeting of/ });

      expect(fieldValue("Convened")).toBe("Not recorded");
      expect(fieldValue("Location")).toBe("Not recorded");
    });
  });

  describe("the standing head", () => {
    it("datelines the meeting with jurisdiction, body, date and status", async () => {
      install({ meeting: makeMeeting() });
      renderPage();

      expect(
        await screen.findByRole("heading", {
          name: "Meeting of December 3, 2024",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Fictional Springs, ZZ")).toBeInTheDocument();
      expect(
        screen.getByText("Example Commission on Public Works"),
      ).toBeInTheDocument();
      expect(screen.getByText("completed")).toBeInTheDocument();
    });

    /** A cancelled meeting reading as an ordinary one is a false statement. */
    it("names a cancelled meeting as cancelled in the headline and the badge", async () => {
      install({ meeting: makeMeeting({ status: "cancelled" }) });
      renderPage();

      expect(
        await screen.findByRole("heading", {
          name: "Cancelled meeting of December 3, 2024",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("cancelled")).toBeInTheDocument();
    });
  });

  describe("when the record is not there", () => {
    it("reports a 404 as no meeting on file, rather than an empty page", async () => {
      install({ meeting: null });
      renderPage();

      expect(
        await screen.findByRole("heading", {
          name: "No meeting on file for this record.",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Not found")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /All meetings/ })).toHaveAttribute(
        "href",
        "/meetings",
      );
    });

    it("distinguishes a failed request from a missing record, and quotes it", async () => {
      install();
      server.use(
        http.get(
          "/api/meetings/:id",
          () =>
            new HttpResponse(null, {
              status: 500,
              statusText: "Internal Server Error",
            }),
        ),
      );
      renderPage();

      expect(
        await screen.findByRole("heading", {
          name: "This meeting record could not be loaded.",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Error")).toBeInTheDocument();
      expect(
        screen.getByText("API error: 500 Internal Server Error"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Not found")).toBeNull();
    });

    it("announces the wait rather than flashing an empty record", () => {
      install();
      server.use(
        http.get("/api/meetings/:id", async () => {
          await delay("infinite");
          return HttpResponse.json(makeMeeting());
        }),
      );
      renderPage();

      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("Loading meeting record…");
      expect(status).toHaveAttribute("aria-live", "polite");
    });
  });

  describe("the agenda and its votes", () => {
    it("prints one row per item, numbered and titled", async () => {
      install({
        agendaItems: [
          makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road", {
            description: "Award of the construction contract.",
            category: "Public works",
          }),
          makeItem(ITEM_TWO, 2, "Fee schedule for placeholder permits"),
        ],
      });
      renderPage();

      await screen.findByText("Fee schedule for placeholder permits");
      const first = itemRow("Culvert replacement on Sample Road");
      expect(within(first).getByText("1")).toBeInTheDocument();
      expect(
        within(first).getByText("Award of the construction contract."),
      ).toBeInTheDocument();
      expect(within(first).getByText("Public works")).toBeInTheDocument();
      expect(statValue("Agenda items")).toBe("2");
    });

    it("renders an em dash and no recorded vote where nobody voted", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
      });
      renderPage();

      await screen.findByText("Culvert replacement on Sample Road");
      const row = itemRow("Culvert replacement on Sample Road");
      expect(within(row).getByText("—")).toBeInTheDocument();
      const result = within(row).getByText("No recorded vote");
      expect(result).toHaveClass("text-muted");
    });

    it("tallies a passing vote as yes–no with an en dash", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
        votes: [
          makeVote(roster[0].id, "yes", ITEM_ONE),
          makeVote(roster[1].id, "yes", ITEM_ONE),
          makeVote(roster[2].id, "no", ITEM_ONE),
          makeVote(roster[3].id, "abstain", ITEM_ONE),
          makeVote(roster[4].id, "absent", ITEM_ONE),
        ],
      });
      renderPage();

      await screen.findByText("Culvert replacement on Sample Road");
      const row = itemRow("Culvert replacement on Sample Road");
      // U+2013, the en dash the vote cell composes the tally with.
      expect(within(row).getByText("2–1")).toBeInTheDocument();
      expect(within(row).getByText("Passed")).toHaveClass("text-pass");
      expect(
        within(row).getByText("1 abstained · 1 absent"),
      ).toBeInTheDocument();
    });

    it("calls a vote with more noes than ayes failed", async () => {
      install({
        agendaItems: [makeItem(ITEM_TWO, 2, "Fee schedule for placeholder permits")],
        votes: [
          makeVote(roster[0].id, "yes", ITEM_TWO),
          makeVote(roster[1].id, "no", ITEM_TWO),
          makeVote(roster[2].id, "no", ITEM_TWO),
        ],
      });
      renderPage();

      await screen.findByText("Fee schedule for placeholder permits");
      const row = itemRow("Fee schedule for placeholder permits");
      expect(within(row).getByText("1–2")).toBeInTheDocument();
      expect(within(row).getByText("Failed")).toHaveClass("text-fail");
    });

    /**
     * A tie does not carry. `outcomeOf` returns `failed` when the ayes equal
     * the noes and both are non-zero, and the page must say Failed rather than
     * leaving a reader to infer that a 2–2 vote passed.
     */
    it("calls a tied vote failed, not passed", async () => {
      install({
        agendaItems: [makeItem(ITEM_THREE, 3, "Rezoning of the Example parcel")],
        votes: [
          makeVote(roster[0].id, "yes", ITEM_THREE),
          makeVote(roster[1].id, "yes", ITEM_THREE),
          makeVote(roster[2].id, "no", ITEM_THREE),
          makeVote(roster[3].id, "no", ITEM_THREE),
        ],
      });
      renderPage();

      await screen.findByText("Rezoning of the Example parcel");
      const row = itemRow("Rezoning of the Example parcel");
      expect(within(row).getByText("2–2")).toBeInTheDocument();
      expect(within(row).getByText("Failed")).toHaveClass("text-fail");
      expect(within(row).queryByText("Passed")).toBeNull();
    });

    it("states an empty agenda rather than rendering a bare heading", async () => {
      install({ agendaItems: [] });
      renderPage();

      expect(
        await screen.findByText("No agenda items on file for this meeting."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("says the agenda failed to load instead of implying there was none", async () => {
      install();
      server.use(
        http.get(
          "/api/meetings/:id/agenda-items",
          () =>
            new HttpResponse(null, {
              status: 500,
              statusText: "Internal Server Error",
            }),
        ),
      );
      renderPage();

      expect(
        await screen.findByText(
          "The agenda for this meeting could not be loaded.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("No agenda items on file for this meeting."),
      ).toBeNull();
    });

    it("counts a single vote recorded against no agenda item", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
        votes: [makeVote(roster[0].id, "yes", null)],
      });
      renderPage();

      const note = await screen.findByText(/without an agenda item/);
      expect(note).toHaveTextContent(
        "1 vote is recorded against this meeting without an agenda item.",
      );
    });

    it("pluralises the unlinked-vote line", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
        votes: [
          makeVote(roster[0].id, "yes", null),
          makeVote(roster[1].id, "no", null),
        ],
      });
      renderPage();

      const note = await screen.findByText(/without an agenda item/);
      expect(note).toHaveTextContent(
        "2 votes are recorded against this meeting without an agenda item.",
      );
    });
  });

  describe("attendance", () => {
    it("records no roll rather than an attendance of zero", async () => {
      install({ votes: [] });
      renderPage();

      await screen.findByRole("heading", { name: /Meeting of/ });
      expect(statValue("Attendance")).toBe("—");
      expect(screen.getByText("No roll recorded")).toBeInTheDocument();
    });

    it("counts the members who cast anything but an absence, over the seats", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
        votes: [
          makeVote(roster[0].id, "yes", ITEM_ONE),
          makeVote(roster[1].id, "no", ITEM_ONE),
          makeVote(roster[2].id, "abstain", ITEM_ONE),
          makeVote(roster[3].id, "absent", ITEM_ONE),
        ],
      });
      renderPage();

      await screen.findByText("Culvert replacement on Sample Road");
      // Three of the five seats answered the roll; the absence is not presence.
      expect(statValue("Attendance")).toBe("3/5");
      expect(screen.getByText("Voting members present")).toBeInTheDocument();
    });

    it("takes the seat count from the roll when more members voted than the roster knows", async () => {
      install({
        agendaItems: [makeItem(ITEM_ONE, 1, "Culvert replacement on Sample Road")],
        members: roster.slice(0, 2),
        votes: [
          makeVote(roster[0].id, "yes", ITEM_ONE),
          makeVote(roster[1].id, "yes", ITEM_ONE),
          makeVote(roster[2].id, "yes", ITEM_ONE),
          makeVote(roster[3].id, "absent", ITEM_ONE),
        ],
      });
      renderPage();

      await screen.findByText("Culvert replacement on Sample Road");
      expect(statValue("Attendance")).toBe("3/4");
    });
  });

  describe("the records-request route", () => {
    it("offers a request when no minutes are in the record", async () => {
      install({ meeting: makeMeeting({ minutes_url: null }), documents: [agendaDoc] });
      renderPage();

      expect(
        await screen.findByText(/No minutes for this meeting are in the record/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Request this record" }),
      ).toHaveAttribute("href", `/public-records?meeting=${MEETING_ID}`);
    });

    it("stays silent when the minutes are on file", async () => {
      install({ meeting: makeMeeting(), documents: [minutesDoc] });
      renderPage();

      await screen.findByRole("heading", { name: /Meeting of/ });
      expect(
        screen.queryByRole("link", { name: "Request this record" }),
      ).toBeNull();
      expect(
        screen.queryByText(/No minutes for this meeting are in the record/),
      ).toBeNull();
    });
  });

  describe("citation chips", () => {
    it("cites the named source document, not the fallback", async () => {
      install({
        documents: [minutesDoc, staffReportDoc],
        anomalies: [
          makeFlag("quorum_issue", {
            source: "manual",
            metadata: { source_document: staffReportDoc.title },
          }),
        ],
      });
      renderPage();

      const chip = await screen.findByRole("link", {
        name: `Source: ${staffReportDoc.title}`,
      });
      expect(chip).toHaveAttribute("href", staffReportDoc.url);
      expect(chip).toHaveAttribute("target", "_blank");
      expect(screen.getByText("Added in review")).toBeInTheDocument();
    });

    it("says there are no minutes on file, without linking anywhere", async () => {
      install({
        meeting: makeMeeting({ minutes_url: null }),
        documents: [],
        anomalies: [makeFlag("missing_minutes")],
      });
      renderPage();

      const chip = await screen.findByText("Source: no minutes on file");
      expect(chip.tagName).toBe("SPAN");
      expect(
        screen.queryByRole("link", { name: /Source: no minutes on file/ }),
      ).toBeNull();
      expect(screen.getByText("Minutes not published")).toBeInTheDocument();
    });

    it("falls back to the minutes for a flag about what happened in the room", async () => {
      install({
        meeting: makeMeeting({
          minutes_url: "https://records.example.invalid/minutes.pdf",
          agenda_url: "https://records.example.invalid/agenda.pdf",
        }),
        documents: [],
        anomalies: [makeFlag("quorum_issue")],
      });
      renderPage();

      const chip = await screen.findByRole("link", { name: "Source: minutes" });
      expect(chip).toHaveAttribute(
        "href",
        "https://records.example.invalid/minutes.pdf",
      );
    });

    it("falls back to the agenda when there are no minutes", async () => {
      install({
        meeting: makeMeeting({
          minutes_url: null,
          agenda_url: "https://records.example.invalid/agenda.pdf",
        }),
        documents: [],
        anomalies: [makeFlag("quorum_issue")],
      });
      renderPage();

      const chip = await screen.findByRole("link", { name: "Source: agenda" });
      expect(chip).toHaveAttribute(
        "href",
        "https://records.example.invalid/agenda.pdf",
      );
    });

    /**
     * The flags section used to disappear when a meeting had none, and a
     * disappearing section is the one empty state this project has ruled out:
     * "nothing was flagged", "everything flagged here is still in review" and
     * "the request failed" are three different facts and the reader could tell
     * none of them apart. `<Absence>` is the shared grammar for saying which,
     * and the status link is what marks the third as ours.
     */
    it("states an empty flag list rather than dropping the section", async () => {
      install({ anomalies: [] });
      renderPage();

      expect(
        await screen.findByText(
          "No findings from this record have been reviewed yet.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Nothing flagged on this record" }),
      ).toBeInTheDocument();
      // Not ours, so no status link is offered for it.
      expect(
        screen.queryByRole("link", { name: /collection status/i }),
      ).toBeNull();
    });

    it("owns a failed flag request instead of rendering it as an empty record", async () => {
      install();
      server.use(
        http.get("/api/anomalies", () =>
          HttpResponse.json({ error: "boom", statusCode: 500 }, { status: 500 }),
        ),
      );
      renderPage();

      expect(
        await screen.findByText(/Findings on this meeting could not be loaded/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /collection status/i }),
      ).toHaveAttribute("href", "/status");
      expect(
        screen.queryByText(
          "No findings from this record have been reviewed yet.",
        ),
      ).toBeNull();
    });

    it("names the meeting record, unlinked, when nothing is published", async () => {
      install({
        meeting: makeMeeting({ minutes_url: null, agenda_url: null }),
        documents: [],
        anomalies: [makeFlag("last_minute_agenda_change")],
      });
      renderPage();

      const chip = await screen.findByText("Source: meeting record");
      expect(chip.tagName).toBe("SPAN");
      expect(screen.getByText("One anomaly on this record")).toBeInTheDocument();
      expect(statValue("Flags")).toBe("1");
    });
  });
});

/**
 * The claim cards.
 *
 * A claim is the highest-stakes thing this site publishes: one sentence naming
 * a living person, quoting the line of the minutes that says it. These tests
 * guard the three ways the surface can fail quietly.
 *
 * **The sentence is the API's.** `text` is the string an operator approved and
 * the backend re-renders and hash-checks on every read. A page that rebuilt it
 * from a subject and an action would publish text nobody approved, which is why
 * the fixture below carries a `text` that no template over its own fields could
 * produce.
 *
 * **A tombstone renders.** Showing a withdrawn sentence is not an oversight and
 * is argued in published-claim §7: it is in caches and feeds, and a reader
 * arriving from one needs a page saying *that sentence was wrong* rather than a
 * page showing nothing.
 *
 * **A withheld claim is stated.** `awaiting_re_review` is a deliberate refusal
 * to publish. Dropped silently it reads as an empty record.
 */
describe("MeetingDetailPage · claims", () => {
  const CLAIM_ID = "8f1d0c66-9999-4a00-9000-000000000001";
  const SHA = "b".repeat(64);

  function makeClaim(): PublicClaims["claims"][number] {
    return {
      id: CLAIM_ID,
      anchor: `claim-${CLAIM_ID}`,
      // Deliberately not derivable from any field on this object: the page
      // must print what the API sent, not assemble its own sentence.
      text: "Avery Sample — voted no on Ordinance 2145, second reading",
      quote:
        "Commissioner Sample voted no on the motion to adopt Ordinance 2145.",
      artifact_sha256: SHA,
      quote_offset: 4096,
      source_path: `/source/${SHA}#offset-4096`,
      approved_at: "2026-08-14T17:00:00.000Z",
      model: "test-extractor",
      prompt_version: "claim-extract@2",
    };
  }

  it("renders the approved sentence, its quote and its anchor", async () => {
    install({ claims: { claims: [makeClaim()], tombstones: [], awaiting_re_review: 0 } });
    renderPage();

    const heading = await screen.findByText(
      "Avery Sample — voted no on Ordinance 2145, second reading",
    );
    // The anchor is the address. A claim is never its own page, so this is the
    // only thing a link to one can point at.
    expect(heading.closest("article")).toHaveAttribute("id", `claim-${CLAIM_ID}`);
    expect(
      screen.getByText(
        /Commissioner Sample voted no on the motion to adopt Ordinance 2145\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Approved for publication by an operator on/),
    ).toBeInTheDocument();
  });

  it("prints the API's sentence rather than one built from the claim's parts", async () => {
    const claim = makeClaim();
    install({ claims: { claims: [claim], tombstones: [], awaiting_re_review: 0 } });
    renderPage();

    const heading = await screen.findByText(claim.text);
    // Exact, not substring: a page that rendered "Avery Sample — voted no on
    // Ordinance 2145" from a triple would satisfy a `toContain` against the
    // longer approved string.
    expect(heading.textContent).toBe(claim.text);
  });

  it("says a meeting's claims have not been reviewed rather than showing nothing", async () => {
    install();
    renderPage();

    expect(
      await screen.findByText(/No claims from this record have been reviewed yet\./),
    ).toBeInTheDocument();
  });

  it("renders a tombstone with the withdrawn text, the date and the reason", async () => {
    install({
      claims: {
        claims: [],
        tombstones: [
          {
            id: CLAIM_ID,
            anchor: `claim-${CLAIM_ID}`,
            retracted_at: "2026-08-20T12:00:00.000Z",
            retracted_reason:
              "the minutes were reissued and the vote is recorded differently",
            previous_text:
              "Avery Sample — voted no on Ordinance 2145, second reading",
          },
        ],
        awaiting_re_review: 0,
      },
    });
    renderPage();

    const stone = await screen.findByTestId(`tombstone-${CLAIM_ID}`);
    expect(stone).toHaveAttribute("id", `claim-${CLAIM_ID}`);
    expect(stone.textContent).toContain("This claim was withdrawn on August 20, 2026");
    expect(stone.textContent).toContain(
      "It previously read: “Avery Sample — voted no on Ordinance 2145, second reading”",
    );
    expect(stone.textContent).toContain(
      "Reason: the minutes were reissued and the vote is recorded differently",
    );
  });

  it("states that a claim is withheld pending re-review", async () => {
    install({ claims: { claims: [], tombstones: [], awaiting_re_review: 1 } });
    renderPage();

    const line = await screen.findByTestId("claims-withheld");
    expect(line.textContent).toContain(
      "One claim from this meeting is awaiting re-review and is not shown.",
    );
  });
});

/**
 * The transcript section, mounted.
 *
 * `MeetingTranscript.test.tsx` covers the three states; what is checked here is
 * that the page hands it the keys `/api/transcripts/coverage` actually groups
 * on — `j.name`, `c.name` and the meeting's calendar year. Passing ids instead
 * would match nothing and the section would quietly report a body we have never
 * swept, on a meeting whose transcript we hold.
 */
describe("MeetingDetailPage · transcript", () => {
  /**
   * The field `GET /api/meetings/:id` gained on 2026-08-15, passed through.
   *
   * What is guarded here is that the page hands the component the API's own
   * value rather than a default of its own: `undefined` (a backend that
   * predates the field) and `null` (a meeting with no recording filed) are
   * different facts, and either one substituted for the other would put a
   * sentence on a public page that the record does not support. The two
   * documents are the Bozeman shape — one sitting, two clips — and the
   * coverage endpoint must not be consulted at all.
   */
  it("states each transcript document the meeting response carried", async () => {
    install({
      meeting: makeMeeting({
        transcript: {
          documents: [
            {
              meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000a",
              clip_id: "2325",
              state: "published",
              cue_count: 1284,
              observed_sha256: "b".repeat(64),
              last_checked_at: "2024-12-04T00:00:00.000Z",
            },
            {
              meeting_document_id: "8f1d0c66-6666-4a00-9000-00000000000b",
              clip_id: "2326",
              state: "absent",
              cue_count: 0,
              observed_sha256: "c".repeat(64),
              last_checked_at: "2024-12-04T00:00:00.000Z",
            },
          ],
          published: 1,
          absent: 1,
          unavailable: 0,
          unchecked: 0,
          checked_through: "2024-12-04T00:00:00.000Z",
        },
      }),
    });
    server.use(
      http.get("/api/transcripts/coverage", () => {
        throw new Error("the meeting page must not fall back to year coverage");
      }),
    );
    renderPage();

    const rendered = await screen.findAllByTestId("transcript-document");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveAttribute("data-state", "published");
    expect(rendered[1]).toHaveAttribute("data-state", "absent");
    expect(screen.queryByTestId("transcript-year")).not.toBeInTheDocument();
  });

  it("says there is no recording filed when the API answers null", async () => {
    install({ meeting: makeMeeting({ transcript: null }) });
    renderPage();

    const panel = await screen.findByTestId("transcript-none");
    expect(panel.textContent).toContain(
      "The record shows no recording of this meeting.",
    );
    expect(screen.queryByTestId("transcript-document")).not.toBeInTheDocument();
  });

  it("reads coverage for this meeting's body and year", async () => {
    install();
    server.use(
      http.get("/api/transcripts/coverage", () =>
        HttpResponse.json({
          coverage: [
            {
              jurisdiction: jurisdiction.name,
              body: commission.name,
              year: 2024,
              published: 7,
              absent: 0,
              unavailable: 0,
              unchecked: 0,
              checked_through: "2024-12-04T00:00:00.000Z",
            },
          ],
        }),
      ),
    );
    renderPage();

    const panel = await screen.findByTestId("transcript-published");
    expect(panel.textContent).toContain("The custodian published captions");
  });

  it("says no sweep has run rather than inventing a state for an unswept body", async () => {
    install();
    server.use(
      http.get("/api/transcripts/coverage", () =>
        HttpResponse.json({ coverage: [] }),
      ),
    );
    renderPage();

    expect(
      await screen.findByText(
        /No sweep has collected transcripts for this body yet\./,
      ),
    ).toBeInTheDocument();
  });
});
