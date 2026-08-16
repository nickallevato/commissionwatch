import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { DisputePage } from "./DisputePage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `/corrections/dispute`.
 *
 * The person using this page is usually the subject of something they believe
 * is wrong about them, so what this suite guards is mostly what the page says
 * before they type: that it goes to a person, that it is never published, that
 * it changes no record by itself, and that **nothing is emailed** — the
 * reference on the confirmation screen is the only copy, and a page that let
 * someone leave without knowing that would leave them waiting on a message
 * nobody sends.
 *
 * It renders at a real route rather than bare, because the record can arrive as
 * a query parameter from a link on the record's own page.
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
  return render(
    <Routes>
      <Route path="/corrections/dispute" element={<DisputePage />} />
    </Routes>,
    { wrapper: Providers },
  );
}

const MEETING = "22222222-2222-4222-8222-222222222222";
const LINKED = `/corrections/dispute?table=meetings&id=${MEETING}`;

async function fillTheForm() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("What is wrong"), "The location is wrong.");
  await user.type(
    screen.getByLabelText("Your account of it"),
    "It was held in the annexe.",
  );
  await user.type(screen.getByLabelText("How to reach you"), "a@example.invalid");
  return user;
}

describe("DisputePage", () => {
  it("says what happens before anyone types", () => {
    const { container } = renderAt(LINKED);
    expect(
      screen.getByRole("heading", { level: 1, name: "Contest a record" }),
    ).toBeInTheDocument();
    expect(container.textContent).toMatch(/It goes to a person/);
    expect(container.textContent).toMatch(/It is never published/);
    expect(container.textContent).toMatch(/changes no record by itself/);
    expect(container.textContent).toMatch(/Nothing is emailed to you/);
    expect(container.textContent).toMatch(/No identity documents/);
  });

  it("asks for three things and nothing else", () => {
    renderAt(LINKED);
    expect(screen.getByLabelText("What is wrong")).toBeInTheDocument();
    expect(screen.getByLabelText("Your account of it")).toBeInTheDocument();
    expect(screen.getByLabelText("How to reach you")).toBeInTheDocument();
    // No identity fields, and no address bar when the record came from a link.
    expect(screen.queryByLabelText(/identity|passport|licence|license/i)).toBeNull();
    expect(
      screen.queryByLabelText("The address of the page you disagree with"),
    ).toBeNull();
  });

  it("files against the linked record and shows the reference, saying to keep it", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post("/api/corrections/disputes", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            reference: "CW-4KQ7M2XP",
            status: "received",
            received_at: "2026-08-10T12:00:00.000Z",
          },
          { status: 201 },
        );
      }),
    );

    renderAt(LINKED);
    const user = await fillTheForm();
    await user.click(screen.getByRole("button", { name: "File this dispute" }));

    expect(await screen.findByText("CW-4KQ7M2XP")).toBeInTheDocument();
    expect(screen.getByText(/Write it down now/)).toBeInTheDocument();
    expect(body.target_table).toBe("meetings");
    expect(body.target_id).toBe(MEETING);
  });

  it("recovers the record from a pasted address when there is no link", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post("/api/corrections/disputes", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { reference: "CW-ABCDEFGH", status: "received", received_at: "x" },
          { status: 201 },
        );
      }),
    );

    renderAt("/corrections/dispute");
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("The address of the page you disagree with"),
      `https://commissionwatch.bmux.sh/meetings/${MEETING}`,
    );
    await fillTheForm();
    await user.click(screen.getByRole("button", { name: "File this dispute" }));

    await waitFor(() => expect(body.target_id).toBe(MEETING));
  });

  it("says what to do when the address names no record here", async () => {
    renderAt("/corrections/dispute");
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("The address of the page you disagree with"),
      "https://example.invalid/something",
    );
    await fillTheForm();
    await user.click(screen.getByRole("button", { name: "File this dispute" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not name a record on this site/,
    );
  });

  it("shows the API's refusal verbatim rather than smoothing it over", async () => {
    server.use(
      http.post("/api/corrections/disputes", () =>
        HttpResponse.json(
          {
            error:
              "Too many disputes from this address. Try again later, or write to the corrections address on the Methodology page.",
            statusCode: 429,
          },
          { status: 429 },
        ),
      ),
    );

    renderAt(LINKED);
    const user = await fillTheForm();
    await user.click(screen.getByRole("button", { name: "File this dispute" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Too many disputes from this address/,
    );
  });
});
