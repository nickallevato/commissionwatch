import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MatterDetailPage } from "./MatterDetailPage";
import { formatDay } from "@/lib/dates";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SPANNING = "a0000000-0000-4000-8000-000000000001";
const DORMANT = "a0000000-0000-4000-8000-000000000003";

function renderAt(id: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/matters/${id}`]}>
        <Routes>
          <Route path="/matters/:id" element={<MatterDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MatterDetailPage", () => {
  it("headlines the matter by its designator and title", async () => {
    renderAt(SPANNING);
    // The loading state renders an <h1> too, so this waits for the record's
    // own heading rather than whichever h1 exists first.
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: /1234 Main St/i,
    });
    expect(heading).toHaveTextContent("Ordinance 2145");
  });

  it("lists every published appearance, oldest first", async () => {
    renderAt(SPANNING);
    await screen.findByRole("heading", { name: /on the agenda/i });

    const dates = screen
      .getAllByRole("link", { name: /^[A-Z][a-z]+ \d{1,2}, \d{4}$/ })
      .map((link) => link.textContent);
    // A timeline reads forwards: a reader is following a story, not checking
    // for news.
    expect(dates).toEqual([
      formatDay("2024-11-06"),
      formatDay("2024-11-20"),
      formatDay("2024-12-04"),
    ]);
  });

  /**
   * The load-bearing one. A body renaming an item between readings is exactly
   * what this page exists to surface, so each appearance shows the title as
   * printed at *that* meeting rather than the matter's normalised title.
   */
  it("shows each appearance's own title, including a rename between readings", async () => {
    renderAt(SPANNING);
    expect(
      await screen.findByText(/continued from 6 November/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/second reading/i)).toBeInTheDocument();
  });

  it("states the basis on which each appearance was joined to the matter", async () => {
    renderAt(SPANNING);
    // Joining two records is an assertion; the reader sees the basis without
    // having to ask, and there is no fuzzy rule to hide.
    const bases = await screen.findAllByText(/matched on its file number/i);
    expect(bases).toHaveLength(3);
  });

  it("links each appearance to its meeting", async () => {
    renderAt(SPANNING);
    const link = await screen.findByRole("link", { name: formatDay("2024-11-06") });
    expect(link).toHaveAttribute("href", "/meetings/30000000-0000-4000-8000-000000000001");
  });

  it("explains a dormant matter as an absence, not as a withdrawal", async () => {
    renderAt(DORMANT);
    expect(
      await screen.findByText(/has not been withdrawn — it simply has not returned/i),
    ).toBeInTheDocument();
  });

  it("says the counts and the list cover published meetings only", async () => {
    renderAt(SPANNING);
    expect(
      await screen.findByText(/have not been published are not listed and are not counted/i),
    ).toBeInTheDocument();
  });

  /**
   * 404 covers "no such matter" and "withheld" alike. The copy must not
   * distinguish them — telling a stranger which it was would confirm that
   * something exists and is being withheld, which is the state an operator has
   * not finished deciding about.
   */
  it("treats unknown and withheld identically on a 404", async () => {
    server.use(
      http.get("/api/matters/:id", () => new HttpResponse(null, { status: 404 })),
    );
    renderAt(SPANNING);

    expect(
      await screen.findByRole("heading", { level: 1, name: /matter not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/may never have existed, or it may have no appearance/i))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to all matters/i })).toHaveAttribute(
      "href",
      "/matters",
    );
  });

  it("announces the wait rather than rendering it as inert text", () => {
    server.use(
      http.get("/api/matters/:id", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderAt(SPANNING);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading…");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});
