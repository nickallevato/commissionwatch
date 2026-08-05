import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Render the whole app at a given URL, so these tests exercise the route table
 * rather than a page component in isolation. A page can be perfectly built and
 * still be unreachable — that is exactly the bug this file guards.
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

/**
 * Vocabulary from an unrelated real-estate transaction product whose dashboard
 * was once routed at /hub inside this app. CommissionWatch covers public
 * meetings, votes and anomalies — never deals, buyers or inspection reports.
 * If any of this renders again, a foreign surface has been reintroduced.
 */
const FOREIGN_VOCABULARY = [
  /proactive/i,
  /inspection contingency/i,
  /lead-based paint/i,
  /methamphetamine/i,
  /buyer's agent/i,
  /domus/i,
  /deedus/i,
];

/** Every path the primary navigation points at that has a page behind it. */
const ROUTED_NAV_PATHS = [
  "/anomalies",
  "/meetings",
  "/members",
  "/votes",
] as const;

describe("App shell", () => {
  it("renders the masthead wordmark", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: "CommissionWatch" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("renders the home page at the index route", () => {
    renderAt("/");
    expect(screen.queryByText("Page Not Found")).toBeNull();
  });
});

describe("App routing", () => {
  it.each(ROUTED_NAV_PATHS)("resolves %s to a page, not the 404", (path) => {
    renderAt(path);
    expect(screen.queryByText("Page Not Found")).toBeNull();
  });

  it("renders the votes record at /votes", () => {
    renderAt("/votes");
    expect(screen.getByRole("heading", { name: "Votes" })).toBeInTheDocument();
  });

  it("marks the nav item for the current route as active", () => {
    renderAt("/votes");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const active = within(nav).getByRole("link", { name: "Votes" });
    expect(active).toHaveAttribute("aria-current", "page");
  });

  it("renders the 404 page for an unknown path", () => {
    renderAt("/no-such-page");
    expect(screen.getByText("Page Not Found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go back home" }),
    ).toBeInTheDocument();
  });
});

describe("App product boundary", () => {
  it("does not route /hub to a page", () => {
    renderAt("/hub");
    expect(screen.getByText("Page Not Found")).toBeInTheDocument();
  });

  it.each(["/", "/hub", ...ROUTED_NAV_PATHS])(
    "renders no real-estate transaction vocabulary at %s",
    (path) => {
      const { container } = renderAt(path);
      const text = container.textContent ?? "";
      for (const pattern of FOREIGN_VOCABULARY) {
        expect(text).not.toMatch(pattern);
      }
    },
  );
});
