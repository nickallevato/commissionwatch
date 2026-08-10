import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import { CalendarPage } from "./CalendarPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";
import type { CalendarJurisdiction, CalendarMeetingSummary } from "@/types";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/calendar` — when these bodies sit.
 *
 * The assertion this suite exists for is the one about a meeting with no
 * published start time. `meetings` stores a nullable TIME beside its DATE, most
 * rows have no time, and the easy rendering of a null there is *12:00 AM* —
 * this site's cast published as the city's schedule. So the page must say the
 * time is not published, and must never print midnight.
 *
 * The rest guards the honest empty states: an empty calendar and a failed
 * request must not render identically, and neither may be dressed as good news.
 */

function meeting(over: Partial<CalendarMeetingSummary> = {}): CalendarMeetingSummary {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    date: "2026-08-14",
    time: "19:00",
    body_name: "Gallatin County Commission",
    location: "Community Room",
    status: "scheduled",
    ...over,
  };
}

function jurisdiction(over: Partial<CalendarJurisdiction> = {}): CalendarJurisdiction {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Gallatin County",
    state: "MT",
    timezone: "America/Denver",
    ics_url: "/api/calendar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ics",
    upcoming: [meeting()],
    recent: [],
    ...over,
  };
}

function serve(data: CalendarJurisdiction[]) {
  server.use(
    http.get("/api/calendar", () =>
      HttpResponse.json({ data, total: data.length }),
    ),
  );
}

describe("CalendarPage", () => {
  it("lists a jurisdiction's upcoming meetings with the body that sits", async () => {
    serve([jurisdiction()]);
    renderWithProviders(<CalendarPage />);

    expect(
      await screen.findByRole("heading", { name: "Gallatin County, MT" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Gallatin County Commission")).toBeInTheDocument();
    expect(screen.getByText("7:00 PM")).toBeInTheDocument();
  });

  it("says a meeting's time is not published rather than printing midnight", async () => {
    serve([jurisdiction({ upcoming: [meeting({ time: null })] })]);
    const { container } = renderWithProviders(<CalendarPage />);

    expect(await screen.findByText("Time not published")).toBeInTheDocument();
    // The specific wrong answer, named so a regression cannot pass by rendering
    // some other formatting of zero.
    expect(container.textContent).not.toMatch(/12:00 AM/);
    expect(container.textContent).not.toMatch(/00:00/);
  });

  it("offers a subscribable feed per jurisdiction", async () => {
    serve([jurisdiction()]);
    renderWithProviders(<CalendarPage />);

    const link = await screen.findByTestId(
      "ics-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(link).toHaveAttribute(
      "href",
      "/api/calendar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ics",
    );
  });

  it("names the jurisdiction's timezone beside its feed", async () => {
    serve([jurisdiction()]);
    renderWithProviders(<CalendarPage />);
    expect(await screen.findByText("America/Denver")).toBeInTheDocument();
  });

  it("says an empty calendar is empty, without dressing it up", async () => {
    serve([jurisdiction({ upcoming: [], recent: [] })]);
    renderWithProviders(<CalendarPage />);

    expect(
      await screen.findByText(
        /No upcoming meeting is on the published record for this jurisdiction/,
      ),
    ).toBeInTheDocument();
  });

  it("distinguishes a failed request from an empty calendar", async () => {
    server.use(
      http.get("/api/calendar", () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<CalendarPage />);

    const alert = await screen.findByRole("alert");
    // The page must not let a failure read as "nobody is meeting".
    expect(alert.textContent).toMatch(/not saying there are no meetings/);
  });

  it("states the two rules that would otherwise put a meeting on the wrong hour", async () => {
    serve([jurisdiction()]);
    const { container } = renderWithProviders(<CalendarPage />);
    await screen.findByRole("heading", { name: "Gallatin County, MT" });

    expect(container.textContent).toMatch(
      /meeting with no published start time is an all-day entry/,
    );
    expect(container.textContent).toMatch(/carries no end time/);
  });

  it("marks a cancelled meeting", async () => {
    serve([jurisdiction({ upcoming: [meeting({ status: "cancelled" })] })]);
    renderWithProviders(<CalendarPage />);
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });
});
