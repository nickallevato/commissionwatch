import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { SearchPage } from "./SearchPage";
import { splitSnippet } from "@/hooks/useSearch";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The query lives in the URL, so the page has to be mounted *at* one — the
 * shared `renderWithProviders` always starts at `/` and could only ever
 * exercise the empty state.
 */
function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<SearchPage />, { wrapper: Providers });
}

describe("SearchPage", () => {
  it("renders the search headline and kicker", () => {
    renderAt("/search");
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("The archive")).toBeInTheDocument();
  });

  it("asks for a term rather than reporting no results, before anything is searched", () => {
    renderAt("/search");
    expect(
      screen.getByText("Enter a term to search the published record."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No published record matches that search."),
    ).not.toBeInTheDocument();
  });

  it("returns matching agenda items for a query in the URL", async () => {
    renderAt("/search?q=rezone");
    const row = await screen.findByRole("article", {
      name: "Rezoning Application: 1234 Main St",
    });
    expect(within(row).getByText("Agenda item")).toBeInTheDocument();
    expect(within(row).getByText(/Item 2/)).toBeInTheDocument();
  });

  it("marks the match inside the snippet without injecting markup", async () => {
    renderAt("/search?q=rezone");
    const row = await screen.findByRole("article", {
      name: "Rezoning Application: 1234 Main St",
    });
    const marks = within(row).getAllByText("rezone", { selector: "mark" });
    expect(marks.length).toBeGreaterThanOrEqual(1);
    // The delimiters are control characters and must never survive into the DOM.
    expect(row.textContent).not.toContain("");
    expect(row.textContent).not.toContain("");
  });

  it("links a record to the meeting it belongs to", async () => {
    renderAt("/search?q=rezone");
    const row = await screen.findByRole("article", {
      name: "Rezoning Application: 1234 Main St",
    });
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      "/meetings/30000000-0000-4000-8000-000000000001",
    );
  });

  it("links an official at the roster, the only page that exists for one", async () => {
    renderAt("/search?q=Sarah");
    const row = await screen.findByRole("article", { name: "Sarah Chen" });
    expect(within(row).getByText("Official")).toBeInTheDocument();
    // `/officials`, not `/members` — the latter became a 301 in the vocabulary
    // rename, and a search result pointing at a redirect is a wasted hop.
    expect(within(row).getByRole("link")).toHaveAttribute("href", "/officials");
  });

  /**
   * Search grew `finding` and `matter` on the backend while the frontend union
   * still listed four kinds. Both would have rendered with an `undefined` label
   * and fallen through the link builder to the officials roster — a matter about
   * Ordinance 2145 linking to a list of people. The compiler caught it once the
   * union was corrected; these keep it caught.
   */
  it("labels and links a matter result", async () => {
    server.use(
      http.get("/api/search", () =>
        HttpResponse.json({
          data: [
            {
              kind: "matter",
              id: "a0000000-0000-4000-8000-000000000001",
              title: "Rezoning of 1234 Main St",
              snippet: "Rezoning of 1234 Main St",
              designator: "Ordinance 2145",
              commission_name: "City Commission",
              jurisdiction_name: "City of Bozeman",
            },
          ],
          total: 1,
          query: "2145",
        }),
      ),
    );
    renderAt("/search?q=2145");

    const row = await screen.findByRole("article", { name: "Rezoning of 1234 Main St" });
    expect(within(row).getByText("Matter")).toBeInTheDocument();
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      "/matters/a0000000-0000-4000-8000-000000000001",
    );
    expect(within(row).getByText(/Ordinance 2145/)).toBeInTheDocument();
  });

  /**
   * `meeting_id` is nullable for a records-derived finding, which is about an
   * artifact rather than a meeting. The wrong branch here renders
   * `/meetings/null`.
   */
  it("links a finding with no meeting at the findings page, not /meetings/null", async () => {
    server.use(
      http.get("/api/search", () =>
        HttpResponse.json({
          data: [
            {
              kind: "finding",
              id: "60000000-0000-4000-8000-000000000009",
              title: "Missing minutes",
              snippet: "Minutes were not published",
              flag_type: "missing_minutes",
              severity: "medium",
              meeting_id: null,
            },
          ],
          total: 1,
          query: "minutes",
        }),
      ),
    );
    renderAt("/search?q=minutes");

    const row = await screen.findByRole("article", { name: "Missing minutes" });
    expect(within(row).getByText("Finding")).toBeInTheDocument();
    expect(within(row).getByRole("link")).toHaveAttribute("href", "/findings");
    expect(row.textContent).not.toContain("null");
  });

  /**
   * The query feed has no other discovery path. There is no account to hang a
   * saved search on and no settings page by design, so if this link is not on
   * the results page the channel is unreachable — and the whole argument for
   * building it was that it needs no account and stores nothing about anyone.
   */
  it("offers the search itself as a subscription, carrying the query", async () => {
    renderAt("/search?q=rezone");
    const subscribe = await screen.findByRole("link", { name: /subscribe to this search/i });
    expect(subscribe).toHaveAttribute("href", "/feed.xml?q=rezone");
  });

  it("escapes a query with characters that would break the URL", async () => {
    renderAt("/search?q=" + encodeURIComponent('"capital plan" & budget'));
    const subscribe = await screen.findByRole("link", { name: /subscribe to this search/i });
    expect(subscribe).toHaveAttribute(
      "href",
      `/feed.xml?q=${encodeURIComponent('"capital plan" & budget')}`,
    );
  });

  it("says the subscription keeps no record of the subscriber", async () => {
    renderAt("/search?q=rezone");
    expect(
      await screen.findByText(/no record of who is subscribed/i),
    ).toBeInTheDocument();
  });

  it("offers no subscription before anything has been searched", () => {
    renderAt("/search");
    expect(
      screen.queryByRole("link", { name: /subscribe to this search/i }),
    ).not.toBeInTheDocument();
  });

  it("counts the results in the search strap", async () => {
    renderAt("/search?q=rezone");
    await screen.findByRole("article", {
      name: "Rezoning Application: 1234 Main St",
    });
    expect(screen.getByText(/result/)).toHaveTextContent("1 result");
  });

  it("says nothing *published* matches, not that nothing exists", async () => {
    renderAt("/search?q=zzzzznotaword");
    expect(
      await screen.findByText("No published record matches that search."),
    ).toBeInTheDocument();
  });

  it("puts a submitted query into the URL, so the search is linkable", async () => {
    const user = userEvent.setup();
    renderAt("/search");
    await user.type(screen.getByLabelText("Search the record"), "rezone");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("article", {
      name: "Rezoning Application: 1234 Main St",
    });
  });

  it("renders the failure line when the search cannot be completed", async () => {
    server.use(
      http.get("/api/search", () =>
        HttpResponse.json({ error: "boom", statusCode: 500 }, { status: 500 }),
      ),
    );
    renderAt("/search?q=rezone");
    expect(
      await screen.findByText("The search could not be completed."),
    ).toBeInTheDocument();
  });

  it("discloses that only published records, and only read agendas, are searchable", () => {
    renderAt("/search");
    expect(
      screen.getByText(/Only records an operator has published are searchable/),
    ).toBeInTheDocument();
    expect(screen.getByText(/minutes and agenda packets/i)).toBeInTheDocument();
  });
});

describe("splitSnippet", () => {
  it("splits a delimited snippet into plain and matched segments", () => {
    expect(splitSnippet("a term b")).toEqual([
      { text: "a ", match: false },
      { text: "term", match: true },
      { text: " b", match: false },
    ]);
  });

  it("returns plain text untouched", () => {
    expect(splitSnippet("nothing marked")).toEqual([
      { text: "nothing marked", match: false },
    ]);
  });

  it("keeps the remainder when a marker is never closed", () => {
    // Truncation must not swallow the tail: half a snippet rendered as nothing
    // would read as a result with no matching text in it.
    expect(splitSnippet("a term")).toEqual([
      { text: "a term", match: false },
    ]);
  });

  it("has nothing to split in an empty snippet", () => {
    expect(splitSnippet("")).toEqual([]);
  });
});
