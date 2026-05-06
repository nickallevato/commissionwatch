import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { VotesPage } from "./VotesPage";
import { server } from "../mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("VotesPage", () => {
  it("renders the heading", () => {
    renderWithProviders(<VotesPage />);
    expect(screen.getByRole("heading", { name: "Votes" })).toBeInTheDocument();
  });

  it("renders filter controls", () => {
    renderWithProviders(<VotesPage />);
    expect(screen.getByPlaceholderText("Filter by member ID")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
