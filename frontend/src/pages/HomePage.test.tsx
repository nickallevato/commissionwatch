import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";
import { http, HttpResponse } from "msw";
import { within } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "../lib/test-utils";
import { HomePage } from "./HomePage";
import { server } from "../mocks/server";
import { flagTypeLabels } from "../components/flag-labels";
import type {
  AgendaItem,
  AnomalyFlag,
  Commission,
  Jurisdiction,
  Meeting,
  Vote,
} from "../types";

/* ---------------------------------------------------------------------------
   Fixtures

   Declared here rather than pulled from src/mocks/data.ts so the front-page
   assertions stay pinned to a record this file controls: the shared fixture set
   is edited freely by other pages' tests.
   ------------------------------------------------------------------------- */

const TS = "2024-12-01T00:00:00Z";
const stamps = { created_at: TS, updated_at: TS };

/**
 * Every meeting the public API can return has been published — the routes
 * filter on the column — so the fixtures say so rather than leaving it out.
 */
const publishedStamps = { ...stamps, published_at: TS };

const boulder: Jurisdiction = {
  id: "j-boulder",
  name: "Boulder County",
  state: "CO",
  type: "county",
  website_url: null,
  ...stamps,
};

const denver: Jurisdiction = {
  id: "j-denver",
  name: "Denver",
  state: "CO",
  type: "city",
  website_url: null,
  ...stamps,
};

const bocc: Commission = {
  id: "c-bocc",
  jurisdiction_id: boulder.id,
  name: "Board of County Commissioners",
  description: null,
  meeting_schedule: null,
  ...stamps,
};

const pz: Commission = {
  id: "c-pz",
  jurisdiction_id: denver.id,
  name: "Planning & Zoning Commission",
  description: null,
  meeting_schedule: null,
  ...stamps,
};

/** The meeting the front page reports on: the newest `completed` one. */
const lastMeeting: Meeting = {
  id: "m-last",
  commission_id: bocc.id,
  date: "2024-12-10",
  time: "09:30",
  location: "Boulder County Courthouse",
  status: "completed",
  agenda_url: null,
  minutes_url: null,
  ...publishedStamps,
  commission: { ...bocc, jurisdiction: boulder },
};

const olderMeeting: Meeting = {
  id: "m-older",
  commission_id: pz.id,
  date: "2024-12-03",
  time: "18:00",
  location: "City Hall",
  status: "completed",
  agenda_url: null,
  minutes_url: null,
  ...publishedStamps,
  commission: { ...pz, jurisdiction: denver },
};

const cancelledMeeting: Meeting = {
  id: "m-cancelled",
  commission_id: pz.id,
  date: "2024-12-30",
  time: null,
  location: null,
  status: "cancelled",
  agenda_url: null,
  minutes_url: null,
  ...publishedStamps,
  commission: { ...pz, jurisdiction: denver },
};

const nextMeeting: Meeting = {
  id: "m-next",
  commission_id: pz.id,
  date: "2024-12-17",
  time: "18:00",
  location: "City Hall",
  status: "scheduled",
  agenda_url: "https://example.gov/agenda.pdf",
  minutes_url: null,
  ...publishedStamps,
  commission: { ...pz, jurisdiction: denver },
};

const laterMeeting: Meeting = {
  id: "m-later",
  commission_id: bocc.id,
  date: "2025-01-07",
  time: "09:30",
  location: "Boulder County Courthouse",
  status: "scheduled",
  agenda_url: null,
  minutes_url: null,
  ...publishedStamps,
  commission: { ...bocc, jurisdiction: boulder },
};

const meetings: Meeting[] = [
  olderMeeting,
  laterMeeting,
  lastMeeting,
  nextMeeting,
  cancelledMeeting,
];

const agendaItem = (
  id: string,
  item_number: number,
  title: string,
): AgendaItem => ({
  id,
  meeting_id: lastMeeting.id,
  item_number,
  title,
  field_confidence: {},
  description: null,
  category: null,
  ...stamps,
});

const agendaItems: AgendaItem[] = [
  agendaItem("ai-2", 2, "Land Use Change: Niwot Rural Area"),
  agendaItem("ai-1", 1, "Approval of Minutes"),
  agendaItem("ai-3", 3, "Variance Request: 400 Elm Street"),
];

const vote = (
  id: string,
  agenda_item_id: string,
  member_id: string,
  value: Vote["vote"],
): Vote => ({
  id,
  meeting_id: lastMeeting.id,
  agenda_item_id,
  member_id,
  vote: value,
  created_at: "2024-12-10T10:00:00Z",
});

/** ai-1 unvoted, ai-2 carries 2-1, ai-3 fails 1-2. */
const votes: Vote[] = [
  vote("v1", "ai-2", "mem-1", "yes"),
  vote("v2", "ai-2", "mem-2", "yes"),
  vote("v3", "ai-2", "mem-3", "no"),
  vote("v4", "ai-3", "mem-1", "yes"),
  vote("v5", "ai-3", "mem-2", "no"),
  vote("v6", "ai-3", "mem-3", "no"),
];

const flags: AnomalyFlag[] = [
  {
    id: "f-low",
    meeting_id: olderMeeting.id,
    agenda_item_id: null,
    flag_type: "unanimous_controversial",
    severity: "low",
    description: "Unanimous vote on a contested item.",
    metadata: null,
    source: "auto",
    created_at: "2024-12-03T12:00:00Z",
  },
  {
    id: "f-critical",
    meeting_id: lastMeeting.id,
    agenda_item_id: null,
    flag_type: "quorum_issue",
    severity: "critical",
    description: "Board proceeded without a quorum.",
    metadata: null,
    source: "auto",
    created_at: "2024-12-10T12:00:00Z",
  },
  {
    id: "f-medium",
    meeting_id: cancelledMeeting.id,
    agenda_item_id: null,
    flag_type: "missing_minutes",
    severity: "medium",
    description: "No cancellation notice was filed.",
    metadata: null,
    source: "manual",
    created_at: "2024-12-30T12:00:00Z",
  },
  {
    id: "f-high",
    meeting_id: olderMeeting.id,
    agenda_item_id: null,
    flag_type: "last_minute_agenda_change",
    severity: "high",
    description: "Item added 18 hours before the meeting.",
    metadata: null,
    source: "auto",
    created_at: "2024-12-03T18:00:00Z",
  },
];

function useFrontPageFixtures() {
  server.use(
    http.get("/api/meetings", () =>
      HttpResponse.json({ data: meetings, total: meetings.length }),
    ),
    http.get("/api/meetings/:id/agenda-items", ({ params }) => {
      const data = agendaItems.filter((item) => item.meeting_id === params.id);
      return HttpResponse.json({ data, total: data.length });
    }),
    http.get("/api/votes", ({ request }) => {
      const meetingId = new URL(request.url).searchParams.get("meeting_id");
      const data = votes.filter((v) => v.meeting_id === meetingId);
      return HttpResponse.json({ data, total: data.length });
    }),
    http.get("/api/anomalies", () =>
      HttpResponse.json({ data: flags, total: flags.length }),
    ),
  );
}

/* ---------------------------------------------------------------------------
   Harness
   ------------------------------------------------------------------------- */

const LAST_MEETING_NAME = "Board of County Commissioners";

beforeAll(() => server.listen());
beforeEach(() => useFrontPageFixtures());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function renderFrontPage() {
  renderWithProviders(<HomePage />);
  await screen.findByRole("region", { name: LAST_MEETING_NAME });
}

function region(name: string) {
  return screen.getByRole("region", { name });
}

/* ---------------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------------- */

describe("HomePage front page", () => {
  describe("lead finding", () => {
    /**
     * This block used to assert the h1 read "No finding has been published yet"
     * *while the mocked `/api/anomalies` returned four flags*. It passed,
     * because the lead column rendered a hardcoded constant unconditionally
     * even though this same component already imported and called
     * `useAnomalies` for its rail. The test was pinning the defect: the front
     * page would have gone on reporting no findings while `/findings` and the
     * feeds carried them.
     *
     * So the assertions are inverted rather than removed, and the empty case is
     * now tested explicitly — which is what the old test was *believed* to be
     * doing.
     */
    it("leads with the most recently published finding", async () => {
      await renderFrontPage();

      expect(screen.getByText("Latest finding")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: flagTypeLabels["missing_minutes"],
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("No cancellation notice was filed."),
      ).toBeInTheDocument();
    });

    /**
     * The ordering decision, pinned. `f-medium` is the newest flag
     * (2024-12-30); `f-critical` is the most severe. The lead takes the newest.
     *
     * A front page ordered by severity would pin the worst thing ever found to
     * the masthead indefinitely and would be editorialising by ordering. The
     * severity-ranked view is the rail beside it, which is asserted separately.
     */
    it("takes the newest finding, not the most severe one", async () => {
      await renderFrontPage();

      const headline = screen.getByTestId("lead-finding-headline");
      expect(headline).toHaveTextContent(flagTypeLabels["missing_minutes"]);
      expect(headline).not.toHaveTextContent(flagTypeLabels["quorum_issue"]);
    });

    it("says so honestly when nothing has been published", async () => {
      server.use(
        http.get("/api/anomalies", () => HttpResponse.json({ data: [], total: 0 })),
      );
      await renderFrontPage();

      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "No finding has been published yet",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/This column carries the most recent published finding/),
      ).toBeInTheDocument();
    });

    /**
     * The byline used to read "Generated {today} · N meetings reviewed", and
     * this test pinned it. Both halves were untrue: nothing is generated —
     * there is no finding above the byline — and the number is what the
     * meetings endpoint returned, not a count of anything anybody reviewed.
     *
     * So the assertion now holds the opposite line. `Generated` and `reviewed`
     * are asserted *absent*, because the failure this test exists to catch is
     * somebody restoring a claim the data cannot support.
     */
    it("counts the meetings in the record, and claims nothing about review", async () => {
      await renderFrontPage();

      const byline = screen.getByText(/meetings in the published record/);
      expect(byline.textContent).toMatch(/^5 meetings in the published record$/);
      expect(screen.queryByText(/meetings reviewed/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Generated /)).not.toBeInTheDocument();
    });
  });

  describe("last meeting", () => {
    it("leads with the newest completed meeting, its date and jurisdiction", async () => {
      await renderFrontPage();

      const section = region(LAST_MEETING_NAME);
      expect(within(section).getByText("Last meeting")).toBeInTheDocument();
      expect(section.textContent).toContain("December 10, 2024");
      expect(section.textContent).toContain("Boulder County, CO");
    });

    it("shows the flag count for that meeting", async () => {
      await renderFrontPage();

      expect(region(LAST_MEETING_NAME).textContent).toContain("1 flag");
    });

    it("renders the agenda table with Item, Title, Vote and Result columns", async () => {
      await renderFrontPage();

      const table = await screen.findByRole("table");
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent);
      expect(headers).toEqual(["Item", "Title", "Vote", "Result"]);
    });

    it("orders rows by item number and shows each tally and result", async () => {
      await renderFrontPage();

      const table = await screen.findByRole("table");
      await within(table).findByText("Approval of Minutes");

      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(3);

      expect(rows[0].textContent).toContain("Approval of Minutes");
      expect(rows[0].textContent).toContain("No vote recorded");

      expect(rows[1].textContent).toContain("Land Use Change: Niwot Rural Area");
      expect(within(rows[1]).getByText("2–1")).toBeInTheDocument();
      expect(within(rows[1]).getByText("Passed")).toBeInTheDocument();

      expect(rows[2].textContent).toContain("Variance Request: 400 Elm Street");
      expect(within(rows[2]).getByText("1–2")).toBeInTheDocument();
      expect(within(rows[2]).getByText("Failed")).toBeInTheDocument();
    });

    it("colours passed and failed results with the vote-outcome colours", async () => {
      await renderFrontPage();

      expect((await screen.findByText("Passed")).className).toContain("text-pass");
      expect(screen.getByText("Failed").className).toContain("text-fail");
    });

    it("sets vote figures in the tabular mono figure style", async () => {
      await renderFrontPage();

      expect((await screen.findByText("2–1")).className).toContain("figure");
    });
  });

  describe("open flags rail", () => {
    it("lists flags most severe first with jurisdiction and date beneath", async () => {
      await renderFrontPage();

      const rail = region("Open flags");
      const items = await within(rail).findAllByRole("listitem");
      expect(items).toHaveLength(4);

      expect(items[0].textContent).toContain(flagTypeLabels.quorum_issue);
      expect(items[0].textContent).toContain("Boulder County, CO");
      expect(items[0].textContent).toContain("December 10, 2024");

      expect(items[1].textContent).toContain(
        flagTypeLabels.last_minute_agenda_change,
      );
      expect(items[1].textContent).toContain("Denver, CO");

      expect(items[2].textContent).toContain(flagTypeLabels.missing_minutes);
      expect(items[3].textContent).toContain(
        flagTypeLabels.unanimous_controversial,
      );
    });

    it("marks each flag with a severity square coloured by severity", async () => {
      await renderFrontPage();

      const items = await within(region("Open flags")).findAllByRole("listitem");
      const square = (index: number) =>
        items[index].querySelector("[aria-hidden='true']")?.className ?? "";

      expect(square(0)).toContain("bg-sev4");
      expect(square(1)).toContain("bg-sev4");
      expect(square(2)).toContain("bg-sev3");
      expect(square(3)).toContain("bg-sev2");
    });
  });

  describe("next up rail", () => {
    it("lists scheduled meetings in date order with their agenda-posted status", async () => {
      await renderFrontPage();

      const items = await within(region("Next up")).findAllByRole("listitem");
      expect(items).toHaveLength(2);

      expect(items[0].textContent).toContain("Planning & Zoning Commission");
      expect(items[0].textContent).toContain("December 17, 2024");
      expect(within(items[0]).getByText("Agenda posted")).toBeInTheDocument();

      expect(items[1].textContent).toContain("January 7, 2025");
      expect(within(items[1]).getByText("Agenda not posted")).toBeInTheDocument();
    });

    it("excludes completed and cancelled meetings", async () => {
      await renderFrontPage();

      const rail = region("Next up");
      expect(rail.textContent).not.toContain("December 30, 2024");
      expect(rail.textContent).not.toContain("December 10, 2024");
    });
  });

  describe("loading and error states", () => {
    it("shows a visible loading state before the record arrives", () => {
      renderWithProviders(<HomePage />);

      expect(screen.getByText("Loading the meeting record…")).toBeInTheDocument();
      expect(screen.getByText("Loading upcoming meetings…")).toBeInTheDocument();
      expect(screen.getByText("Loading open flags…")).toBeInTheDocument();
    });

    it("surfaces an error when meetings cannot be loaded", async () => {
      server.use(
        http.get("/api/meetings", () => new HttpResponse(null, { status: 500 })),
      );
      renderWithProviders(<HomePage />);

      expect(
        await screen.findByText(
          "The meeting record could not be loaded. Try again shortly.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Upcoming meetings could not be loaded."),
      ).toBeInTheDocument();
    });

    it("surfaces an error when open flags cannot be loaded", async () => {
      server.use(
        http.get("/api/anomalies", () => new HttpResponse(null, { status: 500 })),
      );
      renderWithProviders(<HomePage />);

      expect(
        await screen.findByText("Open flags could not be loaded."),
      ).toBeInTheDocument();
    });

    it("surfaces an error when the agenda cannot be loaded", async () => {
      server.use(
        http.get(
          "/api/meetings/:id/agenda-items",
          () => new HttpResponse(null, { status: 500 }),
        ),
      );
      renderWithProviders(<HomePage />);

      expect(
        await screen.findByText("Agenda items could not be loaded."),
      ).toBeInTheDocument();
    });

    it("says so when no completed meeting is on the record", async () => {
      server.use(
        http.get("/api/meetings", () =>
          HttpResponse.json({ data: [], total: 0 }),
        ),
      );
      renderWithProviders(<HomePage />);

      expect(
        await screen.findByText("No completed meeting is on the record yet."),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByText("No meetings scheduled.")).toBeInTheDocument(),
      );
    });
  });
});
