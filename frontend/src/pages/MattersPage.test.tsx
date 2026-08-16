import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { renderWithProviders, screen } from "@/lib/test-utils";
import { MattersPage } from "./MattersPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MattersPage", () => {
  it("renders the headline and says what a matter is", async () => {
    renderWithProviders(<MattersPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Matters" })).toBeInTheDocument();
    expect(screen.getByText(/subject a body is deciding/i)).toBeInTheDocument();
  });

  it("lists each matter with its designator and links to its own page", async () => {
    renderWithProviders(<MattersPage />);

    const link = await screen.findByRole("link", { name: /Ordinance 2145/i });
    expect(link).toHaveAttribute("href", "/matters/a0000000-0000-4000-8000-000000000001");
  });

  /**
   * The count is split across text nodes by the `figure` span that gives it
   * tabular numerals, so these match on the element's normalised textContent
   * rather than on a single node.
   */
  const withText = (pattern: RegExp) => (_content: string, element: Element | null) =>
    element !== null &&
    element.tagName === "P" &&
    pattern.test(element.textContent?.replace(/\s+/g, " ") ?? "");

  it("shows the appearance count, which is what makes a matter worth having", async () => {
    renderWithProviders(<MattersPage />);
    // Three meetings, one story. A per-meeting archive cannot say this.
    expect(await screen.findByText(withText(/3 appearances/))).toBeInTheDocument();
  });

  it("singularises a matter that has appeared once", async () => {
    renderWithProviders(<MattersPage />);
    expect(await screen.findByText(withText(/1 appearance(?!s)/))).toBeInTheDocument();
  });

  /**
   * `dormant` is the state no other page in this product can show, because its
   * defining feature is that nothing happened. If the label ever regresses to
   * something that reads as a decision, the page has lost its whole point.
   */
  it("labels a dormant matter as inactivity rather than as an outcome", async () => {
    renderWithProviders(<MattersPage />);
    expect(await screen.findByText("No recent activity")).toBeInTheDocument();
  });

  it("gives the status filter a visible, programmatic label", () => {
    renderWithProviders(<MattersPage />);
    expect(screen.getByLabelText(/^status$/i)).toHaveRole("combobox");
  });

  it("explains the selected status, because 'dormant' is not self-evident", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MattersPage />);

    await user.selectOptions(screen.getByLabelText(/^status$/i), "dormant");
    expect(await screen.findByText(/no decision recorded\. it may return/i)).toBeInTheDocument();
  });

  it("filters server-side rather than in the browser", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    server.use(
      http.get("/api/matters", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("state") ?? "");
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    renderWithProviders(<MattersPage />);
    await user.selectOptions(screen.getByLabelText(/^status$/i), "decided");

    // `state` is derived by the API at read time; a browser-side filter would
    // be filtering on a value the browser cannot recompute.
    // Copy now comes from `<Absence>`, which states an empty *record* rather
    // than an empty page — the component exists to keep that distinction from
    // drifting per page.
    await screen.findByText(/the record shows no matters currently decided/i);
    expect(seen).toContain("decided");
  });

  /**
   * A failure and an empty record are different statements, and a transparency
   * site that renders "none" when it means "we could not ask" is making the
   * strongest possible claim on the weakest evidence.
   */
  it("says a load failure is ours, not that the record is empty", async () => {
    server.use(http.get("/api/matters", () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<MattersPage />);

    expect(await screen.findByText(/failure on our side/i)).toBeInTheDocument();
    expect(screen.queryByText(/no matters have been assembled/i)).not.toBeInTheDocument();
  });

  it("distinguishes an empty record from a failure", async () => {
    server.use(http.get("/api/matters", () => HttpResponse.json({ data: [], total: 0 })));
    renderWithProviders(<MattersPage />);

    expect(await screen.findByText(/no sweep has collected matters yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/failure on our side/i)).not.toBeInTheDocument();
  });

  it("announces the wait rather than rendering it as inert text", () => {
    server.use(
      http.get("/api/matters", async () => {
        await delay("infinite");
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );
    renderWithProviders(<MattersPage />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading matters…");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});
