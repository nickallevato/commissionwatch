import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AdminRosterPage } from "./AdminRosterPage";
import { server } from "@/mocks/server";
import type { RosterRoll, RosterRollRow } from "@/types";

/**
 * `/admin/roster` — the screen that says which body's roster is unsourced.
 *
 * What this suite guards is not layout:
 *
 * **The unmatched names are on the page.** A count alone does not tell an
 * operator which page to go and find. Each of those names is a true claim the
 * verifier discards.
 *
 * **A body nothing has been read for is not reported as covered.** Every body
 * is in that state today, and "nothing to match against" rendering as full
 * coverage is the exact confident zero this project exists to catch.
 *
 * **The zero is rendered as a zero.** No roster row can prove where it came
 * from, and the screen says so rather than implying a process is under way.
 *
 * **A failed request is not an empty roll.** Two operator screens shipped that
 * bug in one day. "This project watches no bodies" is a claim; "we could not
 * ask" is the truth when the fetch fails.
 *
 * **No form writes a member row.** The gap is not missing names, it is names
 * that cannot prove anything, and a text box here would close the count while
 * making the record worse.
 *
 * Every name here is invented.
 */

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const UNMEASURED: RosterRollRow = {
  jurisdiction_id: "11111111-2222-4333-8444-000000000001",
  jurisdiction_name: "Fictional County",
  seats_sourced: 0,
  seats_traceable: 0,
  seats_implied: 0,
  unmatched: [],
  provenance: "unsourced",
  state: "unmeasured",
  website_url: null,
  sources: [],
};

const PARTIAL: RosterRollRow = {
  jurisdiction_id: "11111111-2222-4333-8444-000000000002",
  jurisdiction_name: "Invented City",
  seats_sourced: 3,
  seats_traceable: 1,
  seats_implied: 4,
  unmatched: ["nowak", "vogel"],
  provenance: "partial",
  state: "partial",
  website_url: "https://example.invalid/commission",
  sources: [{ adapter_key: "invented-civicplus", enabled: false }],
};

function roll(data: RosterRollRow[] = [UNMEASURED, PARTIAL]): RosterRoll {
  return {
    as_of: "2026-08-15",
    data,
    totals: {
      seats_sourced: data.reduce((total, row) => total + row.seats_sourced, 0),
      seats_traceable: data.reduce((total, row) => total + row.seats_traceable, 0),
      seats_implied: data.reduce((total, row) => total + row.seats_implied, 0),
      unmatched: data.reduce((total, row) => total + row.unmatched.length, 0),
    },
    provenance: {
      jurisdictions: data.length,
      accounted: data.filter((row) => row.state === "accounted").length,
      partial: data.filter((row) => row.state === "partial").length,
      none: data.filter((row) => row.state === "none").length,
      unmeasured: data.filter((row) => row.state === "unmeasured").length,
      traceable: data.filter((row) => row.provenance === "sourced").length,
    },
  };
}

function serve(body: RosterRoll): void {
  server.use(http.get("/api/admin/roster", () => HttpResponse.json(body)));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminRosterPage />
    </MemoryRouter>,
  );
}

describe("AdminRosterPage", () => {
  it("names the body and the officeholders its roster does not account for", async () => {
    serve(roll());
    renderPage();

    await waitFor(() => expect(screen.getByText("Invented City")).toBeInTheDocument());

    const unmatched = screen.getByTestId(`unmatched-${PARTIAL.jurisdiction_id}`);
    expect(within(unmatched).getByText("nowak")).toBeInTheDocument();
    expect(within(unmatched).getByText("vogel")).toBeInTheDocument();
  });

  it("does not report a body nothing has been read for as covered", async () => {
    serve(roll());
    renderPage();

    await waitFor(() => expect(screen.getByText("Fictional County")).toBeInTheDocument());

    expect(screen.getByTestId(`state-${UNMEASURED.jurisdiction_id}`)).toHaveTextContent(
      "Nothing read names an officeholder",
    );
    // The distinction is the whole point: no evidence either way, rather than
    // a roster that matched everything because there was nothing to match.
    expect(screen.getByText(/absence of evidence in both directions/i)).toBeInTheDocument();
  });

  it("says plainly that nothing is sourced when nothing is", async () => {
    serve(roll([UNMEASURED]));
    renderPage();

    await waitFor(() => expect(screen.getByTestId("nothing-sourced")).toBeInTheDocument());
    expect(screen.getByTestId("tile-traceable")).toHaveTextContent("0");
    expect(screen.getByTestId("tile-traceable")).toHaveAttribute("data-tone", "bad");
  });

  it("hides the nothing-sourced flag once a seat can prove where it came from", async () => {
    serve(roll([PARTIAL]));
    renderPage();

    await waitFor(() => expect(screen.getByText("Invented City")).toBeInTheDocument());
    expect(screen.queryByTestId("nothing-sourced")).not.toBeInTheDocument();
  });

  it("orders the body costing the most claims first", async () => {
    serve(roll());
    renderPage();

    await waitFor(() => expect(screen.getByText("Invented City")).toBeInTheDocument());

    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(headings).toEqual(["Invented City", "Fictional County"]);
  });

  it("distinguishes a failed request from an empty record", async () => {
    server.use(
      http.get("/api/admin/roster", () => new HttpResponse(null, { status: 500 })),
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/i),
    );
    expect(screen.getByText(/failure on our side, not a statement that there are none/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/The record shows no jurisdictions/i)).not.toBeInTheDocument();
  });

  it("reports a genuinely empty roll as empty, not as a failure", async () => {
    serve(roll([]));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/The record shows no jurisdictions/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("states the remedy and the loader that enforces it, and offers no way to type a name in", async () => {
    serve(roll());
    renderPage();

    await waitFor(() => expect(screen.getByTestId("step-1")).toBeInTheDocument());
    expect(screen.getByTestId("step-2")).toHaveTextContent(/Fetch a published roster/i);
    expect(screen.getByTestId("loader-command")).toHaveTextContent("roster-load.ts");
    expect(screen.getByTestId("loader-command")).toHaveTextContent("--commit");

    // No writer on this screen, by construction. See the page header.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the recorded site when there is one and refuses to invent one when there is not", async () => {
    serve(roll());
    renderPage();

    await waitFor(() => expect(screen.getByText("Invented City")).toBeInTheDocument());

    const withSite = screen.getByTestId(`start-${PARTIAL.jurisdiction_id}`);
    expect(within(withSite).getByRole("link")).toHaveAttribute(
      "href",
      "https://example.invalid/commission",
    );

    const without = screen.getByTestId(`start-${UNMEASURED.jurisdiction_id}`);
    expect(without).toHaveTextContent(/no site for this body/i);
    expect(within(without).queryByRole("link")).not.toBeInTheDocument();
  });
});
