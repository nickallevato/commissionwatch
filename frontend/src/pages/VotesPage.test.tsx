import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/lib/test-utils";
import { VotesPage } from "./VotesPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REZONING = "Rezoning Application: 1234 Main St";

async function findRecordRow(title: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: title });
  const row = trigger.closest("tr");
  if (!row) throw new Error(`No record row for "${title}"`);
  return row;
}

describe("VotesPage", () => {
  it("renders the votes headline and kicker", () => {
    renderWithProviders(<VotesPage />);
    expect(screen.getByRole("heading", { name: "Votes" })).toBeInTheDocument();
    expect(screen.getByText("The record")).toBeInTheDocument();
  });

  it("renders the filter controls", () => {
    renderWithProviders(<VotesPage />);
    expect(screen.getByLabelText("Jurisdiction")).toBeInTheDocument();
    expect(screen.getByLabelText("Result")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Item or commission"),
    ).toBeInTheDocument();
  });

  it("renders the record table with a column per vote value", async () => {
    renderWithProviders(<VotesPage />);
    await findRecordRow(REZONING);

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Date",
      "Meeting",
      "Item",
      "Yes",
      "No",
      "Abstain",
      "Absent",
      "Result",
    ]);
  });

  it("renders one row per agenda item voted on, with date, meeting and tally", async () => {
    renderWithProviders(<VotesPage />);
    const row = await findRecordRow(REZONING);

    await waitFor(() => {
      const cells = within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent);
      expect(cells).toEqual([
        "Dec 3, 2024",
        "Planning & Zoning CommissionDenver, CO",
        REZONING,
        "2",
        "1",
        "0",
        "0",
        "Passed",
      ]);
    });
  });

  it("marks a record as passed when yes outnumbers no", async () => {
    renderWithProviders(<VotesPage />);
    const row = await findRecordRow("Site Plan Review: Riverside Commerce Park");
    expect(within(row).getByText("Passed")).toBeInTheDocument();
  });

  it("counts the visible records", async () => {
    renderWithProviders(<VotesPage />);
    await findRecordRow(REZONING);
    expect(screen.getByText("records")).toHaveTextContent("3 records");
  });

  it("filters by result", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VotesPage />);
    await findRecordRow(REZONING);

    await user.selectOptions(screen.getByLabelText("Result"), "failed");

    expect(
      screen.getByText("No vote records match these filters."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: REZONING })).toBeNull();
  });

  it("filters by search text and clears again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VotesPage />);
    await findRecordRow(REZONING);

    await user.type(screen.getByLabelText("Search"), "Riverside");

    expect(screen.queryByRole("button", { name: REZONING })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Site Plan Review: Riverside Commerce Park",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.getByRole("button", { name: REZONING }),
    ).toBeInTheDocument();
  });

  it("filters by jurisdiction", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VotesPage />);
    await findRecordRow(REZONING);

    // The fixture ids are UUIDs, so select by the visible label instead.
    const select = screen.getByLabelText("Jurisdiction");
    await user.selectOptions(
      select,
      await within(select).findByRole("option", { name: "Boulder County, CO" }),
    );

    expect(screen.queryByRole("button", { name: REZONING })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Land Use Change: Niwot Rural Area" }),
    ).toBeInTheDocument();
  });

  it("expands a record into a per-member roll call", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VotesPage />);
    const trigger = await screen.findByRole("button", { name: REZONING });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const rollCall = await screen.findByRole("list");
    const entries = within(rollCall)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(entries).toEqual([
      "Lisa ParkNo",
      "Marcus ThompsonYes",
      "Sarah ChenYes",
    ]);
  });

  it("never uses yea/nay vocabulary", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VotesPage />);
    const trigger = await screen.findByRole("button", { name: REZONING });
    await user.click(trigger);
    await screen.findByRole("list");

    expect(screen.queryByText(/\b(yea|nay)s?\b/i)).toBeNull();
  });
});
