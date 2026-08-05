import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { MembersPage } from "./MembersPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Pick a jurisdiction by its visible label. The fixture ids are UUIDs, so the
 * label is the only stable handle a test should reach for.
 */
async function selectJurisdiction(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const select = screen.getByLabelText("Jurisdiction");
  await user.selectOptions(
    select,
    await within(select).findByRole("option", { name: label }),
  );
}

describe("MembersPage", () => {
  it("renders the officials headline and kicker", () => {
    renderWithProviders(<MembersPage />);
    expect(
      screen.getByRole("heading", { name: "Officials" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The roster")).toBeInTheDocument();
  });

  it("renders a roster row per official once loaded", async () => {
    renderWithProviders(<MembersPage />);
    await screen.findByRole("article", { name: "Sarah Chen" });
    expect(
      screen.getByRole("article", { name: "Marcus Thompson" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });

  it("counts the roster in the filter strap", async () => {
    renderWithProviders(<MembersPage />);
    await screen.findByRole("article", { name: "Sarah Chen" });
    expect(screen.getByText("officials")).toHaveTextContent("5 officials");
  });

  it("renders each official's term as readable dates", async () => {
    renderWithProviders(<MembersPage />);
    const row = await screen.findByRole("article", { name: "Sarah Chen" });
    expect(
      within(row).getByText("Jan 15, 2023 – Jan 15, 2027"),
    ).toBeInTheDocument();
  });

  it("summarises each official's voting record from the vote record", async () => {
    renderWithProviders(<MembersPage />);
    const chen = await screen.findByRole("article", { name: "Sarah Chen" });
    await waitFor(() => {
      expect(
        within(chen).getByText("2 yes · 0 no · 0 abstain · 0 absent"),
      ).toBeInTheDocument();
    });

    const park = screen.getByRole("article", { name: "Lisa Park" });
    expect(
      within(park).getByText("1 yes · 1 no · 0 abstain · 0 absent"),
    ).toBeInTheDocument();
  });

  it("filters the roster by jurisdiction", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MembersPage />);
    await screen.findByRole("article", { name: "Sarah Chen" });

    await selectJurisdiction(user, "Boulder County, CO");

    await screen.findByRole("article", { name: "James Rodriguez" });
    expect(
      screen.queryByRole("article", { name: "Sarah Chen" }),
    ).not.toBeInTheDocument();
  });

  it("reports an empty roster rather than rendering nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MembersPage />);
    await screen.findByRole("article", { name: "Sarah Chen" });

    await selectJurisdiction(user, "Austin, TX");

    expect(
      await screen.findByText("No officials on record for this jurisdiction."),
    ).toBeInTheDocument();
  });
});
