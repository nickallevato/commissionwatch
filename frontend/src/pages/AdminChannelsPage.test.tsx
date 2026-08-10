import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { AdminChannelsPage } from "./AdminChannelsPage";
import { renderWithProviders } from "@/lib/test-utils";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MASKED = "https://discord.com/…f4a2";

function listHandler() {
  return http.get("/api/admin/channels", () =>
    HttpResponse.json({
      data: [
        {
          id: "c1",
          channel_type: "discord",
          name: "Operator alerts",
          enabled: true,
          config_masked: MASKED,
        },
      ],
      total: 1,
    }),
  );
}

describe("AdminChannelsPage", () => {
  it("shows the masked credential and never a full webhook URL", async () => {
    server.use(listHandler());
    renderWithProviders(<AdminChannelsPage />);

    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    expect(screen.getByText(new RegExp(MASKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });

  it("does not populate the form from the stored config — it accepts a replacement", async () => {
    // The archive's page read config back to fill its edit form. Under W7's
    // masking rule the API does not return a stored credential to anyone, so
    // the form starts empty by construction rather than by convention.
    server.use(listHandler());
    renderWithProviders(<AdminChannelsPage />);

    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("clears the credential field after a successful add", async () => {
    server.use(
      listHandler(),
      http.post("/api/admin/channels", () =>
        HttpResponse.json(
          { id: "c2", channel_type: "discord", name: "New", enabled: true, config_masked: MASKED },
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<AdminChannelsPage />);
    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("Name"), "New");
    await userEvent.type(screen.getByLabelText("Webhook URL"), "https://discord.com/api/webhooks/1/secret");
    await userEvent.click(screen.getByRole("button", { name: "Add channel" }));

    // A credential left in a form field sits in the DOM for as long as the tab
    // is open.
    await waitFor(() => expect(screen.getByLabelText("Webhook URL")).toHaveValue(""));
  });

  it("tags the stored credential rather than reading it back, and never shows a full URL", async () => {
    // Screen 05's masked field. "Stored" is the whole of what the API will
    // say about a credential, and the page says exactly that much.
    server.use(
      listHandler(),
      http.get("/api/admin/channels/:id", () =>
        HttpResponse.json({
          channel: { id: "c1", channel_type: "discord", name: "Operator alerts" },
          routes: [],
        }),
      ),
    );
    renderWithProviders(<AdminChannelsPage />);

    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit routing: Operator alerts" }));

    expect(await screen.findByText("Stored")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/api\/webhooks/);
  });

  it("posts a route with the severity and cadence chosen on the segmented controls", async () => {
    let posted: Record<string, unknown> = {};
    server.use(
      listHandler(),
      http.get("/api/admin/channels/:id", () =>
        HttpResponse.json({
          channel: { id: "c1", channel_type: "discord", name: "Operator alerts" },
          routes: [],
        }),
      ),
      http.post("/api/admin/channels/:id/routes", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "r1" }, { status: 201 });
      }),
    );

    renderWithProviders(<AdminChannelsPage />);
    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit routing: Operator alerts" }));

    await screen.findByRole("radiogroup", { name: "Minimum severity for this route" });
    await userEvent.click(screen.getByRole("radio", { name: "critical" }));
    await userEvent.click(screen.getByRole("radio", { name: "daily" }));
    await userEvent.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() =>
      expect(posted).toEqual({
        event_type: "anomaly.flagged",
        min_severity: "critical",
        cadence: "daily",
      }),
    );
  });

  it("says there is no SMS cap rather than drawing a bar against an invented one", async () => {
    server.use(
      listHandler(),
      http.get("/api/admin/channels/:id", () =>
        HttpResponse.json({
          channel: { id: "c1", channel_type: "discord", name: "Operator alerts" },
          routes: [],
        }),
      ),
    );
    renderWithProviders(<AdminChannelsPage />);

    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit routing: Operator alerts" }));

    expect(await screen.findByText(/no cap recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("keeps the SSRF rule on the screen where a webhook is entered", async () => {
    server.use(listHandler());
    renderWithProviders(<AdminChannelsPage />);

    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());
    expect(screen.getByText(/private, loopback or link-local ranges/)).toBeInTheDocument();
  });

  it("surfaces a rejected URL rather than failing silently", async () => {
    server.use(
      listHandler(),
      http.post("/api/admin/channels", () =>
        HttpResponse.json(
          { error: "Discord webhook URLs must be on discord.com", statusCode: 400 },
          { status: 400 },
        ),
      ),
    );

    renderWithProviders(<AdminChannelsPage />);
    await waitFor(() => expect(screen.getByText("Operator alerts")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("Name"), "Bad");
    await userEvent.type(screen.getByLabelText("Webhook URL"), "http://169.254.169.254/");
    await userEvent.click(screen.getByRole("button", { name: "Add channel" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Discord webhook URLs must be on discord.com");
  });
});
