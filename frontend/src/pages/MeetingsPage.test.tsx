import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/lib/test-utils";
import { MeetingsPage } from "./MeetingsPage";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** The fixture ids are UUIDs, so the visible label is the only stable handle. */
async function selectByLabel(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  const select = screen.getByLabelText(field);
  await user.selectOptions(
    select,
    await within(select).findByRole("option", { name: option }),
  );
}

describe("MeetingsPage", () => {
  it("renders the calendar headline and kicker", () => {
    renderWithProviders(<MeetingsPage />);
    expect(
      screen.getByRole("heading", { name: "Meetings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The calendar")).toBeInTheDocument();
  });

  it("gives every filter control a visible, programmatic label", () => {
    renderWithProviders(<MeetingsPage />);

    // Reachable by accessible name — the only handle a screen reader has.
    expect(screen.getByLabelText(/^jurisdiction$/i)).toHaveRole("combobox");
    expect(screen.getByLabelText(/^status$/i)).toHaveRole("combobox");
    expect(screen.getByLabelText(/^from$/i)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(/^to$/i)).toHaveAttribute("type", "date");
  });

  it("binds each filter label to its control by htmlFor/id, visibly", () => {
    renderWithProviders(<MeetingsPage />);

    for (const [text, controlId] of [
      ["Jurisdiction", "meetings-jurisdiction"],
      ["Status", "meetings-status"],
      ["From", "meetings-date-from"],
      ["To", "meetings-date-to"],
    ]) {
      const label = screen.getByText(text);
      expect(label.tagName).toBe("LABEL");
      expect(label).toHaveAttribute("for", controlId);
      // Visible to everyone, in the established micro-label style — not sr-only.
      expect(label).toHaveClass("label-sm");
      expect(label).toBeVisible();
    }
  });

  it("does not lean on a placeholder to name the date range", () => {
    renderWithProviders(<MeetingsPage />);

    // <input type="date"> renders no placeholder, so one would name nothing.
    expect(screen.getByLabelText(/^from$/i)).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText(/^to$/i)).not.toHaveAttribute("placeholder");
  });

  it("renders one row per meeting, datelined and dated", async () => {
    renderWithProviders(<MeetingsPage />);
    const row = await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });
    expect(row).toHaveTextContent("Denver, CO · Tue, Dec 3, 2024 at 18:00");
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });

  it("counts the calendar in the filter strap", async () => {
    renderWithProviders(<MeetingsPage />);
    await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });
    expect(screen.getByText("meetings")).toHaveTextContent("5 meetings");
  });

  it("links each row to its meeting record", async () => {
    renderWithProviders(<MeetingsPage />);
    const row = await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      "/meetings/30000000-0000-4000-8000-000000000001",
    );
  });

  it("shows the flag tally and status on a flagged meeting", async () => {
    renderWithProviders(<MeetingsPage />);
    const row = await screen.findByRole("article", {
      name: "Board of County Commissioners, Tue, Dec 10, 2024",
    });
    expect(
      await within(row).findByText(/Severity 5 of 5, critical/),
    ).toBeInTheDocument();
    expect(within(row).getByText("completed")).toBeInTheDocument();
  });

  it("filters by jurisdiction", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MeetingsPage />);
    await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });

    await selectByLabel(user, "Jurisdiction", "Boulder County, CO");

    await screen.findByRole("article", {
      name: "Board of County Commissioners, Tue, Dec 10, 2024",
    });
    expect(
      screen.queryByRole("article", {
        name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
      }),
    ).not.toBeInTheDocument();
  });

  it("reports an empty calendar rather than rendering nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MeetingsPage />);
    await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });

    await selectByLabel(user, "Jurisdiction", "Austin, TX");
    await selectByLabel(user, "Status", "Scheduled");

    expect(
      await screen.findByText("No meetings match these filters."),
    ).toBeInTheDocument();
  });

  it("clears every filter from the strap", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MeetingsPage />);
    await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });

    await selectByLabel(user, "Status", "Cancelled");
    await screen.findByRole("article", {
      name: "Planning Commission, Thu, Dec 12, 2024",
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await screen.findByRole("article", {
      name: "Planning & Zoning Commission, Tue, Dec 3, 2024",
    });
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });
});
