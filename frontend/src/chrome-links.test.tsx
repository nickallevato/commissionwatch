import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { server } from "@/mocks/server";
import { NOT_FOUND_HEADING } from "./pages/NotFoundPage";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The site chrome must not link anywhere the route table cannot serve.
 *
 * This is not covered by asserting on the nav alone: a nav link with no route
 * behind it still renders — React Router falls through to the catch-all and
 * draws the 404 *inside* the masthead and colophon, so the page looks whole
 * while the destination is dead. The only check that catches it walks the links
 * the chrome actually renders and mounts the real app at each one.
 *
 * Reading the hrefs off the DOM rather than listing them here is deliberate:
 * a link added to `Layout` without a matching route in `App` fails this test
 * without anyone remembering to extend a fixture.
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

  return render(<App />, { wrapper: Providers });
}

/** Internal hrefs the masthead and colophon point at, as rendered. */
function chromeHrefs(): string[] {
  const hrefs = new Set<string>();
  for (const landmark of ["Primary", "Footer"]) {
    const nav = screen.getByRole("navigation", { name: landmark });
    for (const link of within(nav).getAllByRole("link")) {
      const href = link.getAttribute("href");
      if (href?.startsWith("/")) hrefs.add(href);
    }
  }
  return [...hrefs];
}

describe("site chrome links", () => {
  it("points every masthead and colophon link at a route that resolves", () => {
    renderAt("/");
    const hrefs = chromeHrefs();
    cleanup();

    // Guard the guard: an empty list must fail rather than vacuously pass.
    expect(hrefs.length).toBeGreaterThanOrEqual(6);

    const dead: string[] = [];
    for (const href of hrefs) {
      renderAt(href);
      if (screen.queryByText(NOT_FOUND_HEADING)) dead.push(href);
      cleanup();
    }

    expect(dead).toEqual([]);
  });

  it("renders a heading inside <main> at every chrome destination", () => {
    renderAt("/");
    const hrefs = chromeHrefs();
    cleanup();

    const headless: string[] = [];
    for (const href of hrefs) {
      renderAt(href);
      const headings = within(screen.getByRole("main")).queryAllByRole(
        "heading",
      );
      if (headings.length === 0) headless.push(href);
      cleanup();
    }

    expect(headless).toEqual([]);
  });

  it("detects a dead destination when there is one", () => {
    // The walk above is only worth anything if this probe fires. An unrouted
    // path renders the 404 inside the full chrome — masthead, colophon and all
    // — which is exactly what a dead nav link looked like before it was fixed.
    renderAt("/definitely-not-a-route");
    expect(screen.getByText(NOT_FOUND_HEADING)).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Primary" }),
    ).toBeInTheDocument();
  });

  it("serves the methodology page at /methodology", () => {
    renderAt("/methodology");
    expect(
      screen.getByRole("heading", { level: 1, name: "Methodology" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND_HEADING)).toBeNull();
  });

  it("serves the open data page at /data", () => {
    renderAt("/data");
    expect(
      screen.getByRole("heading", { level: 1, name: "Open data" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND_HEADING)).toBeNull();
  });

  it("still serves the page at its original address, /data-license", () => {
    // The page was published at `/data-license` before `/data` existed. A site
    // whose subject is other people's broken published claims does not break a
    // URL it asked readers to cite.
    renderAt("/data-license");
    expect(
      screen.getByRole("heading", { level: 1, name: "Open data" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND_HEADING)).toBeNull();
  });

  it("serves the meeting calendar at /calendar", () => {
    renderAt("/calendar");
    expect(
      screen.getByRole("heading", { level: 1, name: "When these bodies sit" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND_HEADING)).toBeNull();
  });
});
