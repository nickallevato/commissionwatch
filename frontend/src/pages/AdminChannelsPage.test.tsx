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
