import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { RunOptions } from "axe-core";
import { App } from "./App";
import { server } from "@/mocks/server";
import { expectNoA11yViolations } from "./lib/test-utils";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Scan the reader's site for accessibility violations at the route level.
 *
 * The whole `App` is rendered rather than a page component, because half of
 * what axe checks is structural and only exists once the chrome is present:
 * landmark uniqueness, whether page content sits inside a region, and heading
 * order across the masthead and the page together. A page scanned on its own
 * reports a `region` violation for markup that is perfectly placed in the real
 * document, which is the kind of false alarm that gets a suite switched off.
 *
 * Public pages only. The operator console is behind auth and is not the surface
 * this project is judged on.
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
 * Exactly one rule is turned off, and only because it cannot execute here
 * rather than because we dislike its answer. `color-contrast` needs a layout
 * engine and a canvas to sample rendered pixels; jsdom has neither, so axe
 * throws `HTMLCanvasElement.prototype.getContext is not implemented` and
 * reports the rule as incomplete for every node on every page. Leaving it on
 * buys no coverage and floods the run with a stack trace per route. The
 * palette's contrast is a design-token question and is fixed in
 * `tailwind.config.ts`, not per component.
 *
 * Nothing else is excluded. A rule that fires means the markup is wrong.
 */
const A11Y_OPTIONS: RunOptions = {
  rules: { "color-contrast": { enabled: false } },
};

const PUBLIC_ROUTES = [
  "/",
  "/meetings",
  "/matters",
  "/officials",
  "/votes",
  "/findings",
  "/search",
  "/elections",
  "/calendar",
  "/methodology",
  "/privacy",
  "/public-records",
  "/corrections",
  "/status",
  "/data",
  "/subscribe",
  // The `*` route. A 404 is a page a reader genuinely lands on, and it is the
  // one most likely to be built without care.
  "/no-such-page",
] as const;

describe("public site accessibility", () => {
  it.each(PUBLIC_ROUTES)("has no axe violations at %s", async (path) => {
    const { container } = renderAt(path);

    // Wait for the page's own heading before scanning. Several pages derive
    // their <h1> from a fetched record, and scanning mid-flight would audit a
    // loading state rather than the page.
    await screen.findByRole("heading", { level: 1 });

    await expectNoA11yViolations(container, A11Y_OPTIONS);
  });
});

/**
 * Route changes in an SPA replace the document without a page load. Without
 * this, following a nav link left both the tab order and a screen reader's
 * cursor sitting in the masthead, with no signal that the record on screen had
 * changed — the skip link existed but nothing ever used it.
 */
describe("focus on route change", () => {
  it("moves focus to the new page's h1 when a nav link is followed", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Votes" }));

    await waitFor(() => {
      const heading = screen.getByRole("heading", { level: 1, name: "Votes" });
      expect(document.activeElement).toBe(heading);
    });
  });

  it("does not steal focus on the first render of a fresh page load", () => {
    renderAt("/votes");

    // A full page load already starts the reader at the top of the document.
    // Grabbing focus here would move a reader who had not asked to be moved.
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the h1 out of the tab order", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Votes" }));

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Votes",
    });
    // tabIndex -1 makes it a programmatic target only. A keyboard user tabbing
    // through the page must never land on a heading.
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});
