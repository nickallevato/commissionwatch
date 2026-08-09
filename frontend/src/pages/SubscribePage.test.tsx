import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { SubscribePage } from "./SubscribePage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("SubscribePage", () => {
  it("offers a destination, a jurisdiction and a cadence — the three parts of a subscription", async () => {
    renderWithProviders(<SubscribePage />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Jurisdiction")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "How often" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /As it happens/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Daily digest/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Weekly digest/ })).toBeInTheDocument();
  });

  it("posts a destination, jurisdiction and cadence to the unified alerts API", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/alerts", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ verify_token: "t".repeat(64) }, { status: 201 });
      }),
    );

    renderWithProviders(<SubscribePage />);
    await userEvent.type(screen.getByLabelText("Email"), "reader@example.invalid");
    await userEvent.click(screen.getByRole("radio", { name: /Weekly digest/ }));
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({
      channel_type: "email",
      destination: "reader@example.invalid",
      cadence: "weekly",
    });
  });

  it("says nothing is sent until the address is confirmed", async () => {
    server.use(
      http.post("/api/alerts", () =>
        HttpResponse.json({ verify_token: "t".repeat(64) }, { status: 201 }),
      ),
    );

    renderWithProviders(<SubscribePage />);
    await userEvent.type(screen.getByLabelText("Email"), "reader@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/confirmation link/i);
  });

  it("surfaces the API's reason for a rejection rather than a blank failure", async () => {
    server.use(
      http.post("/api/alerts", () =>
        HttpResponse.json({ error: "Jurisdiction not found", statusCode: 400 }, { status: 400 }),
      ),
    );

    renderWithProviders(<SubscribePage />);
    await userEvent.type(screen.getByLabelText("Email"), "reader@example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Jurisdiction not found");
  });
});
