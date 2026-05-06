import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { MembersPage } from "./MembersPage";
import { server } from "../mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MembersPage", () => {
  it("renders the heading", () => {
    renderWithProviders(<MembersPage />);
    expect(screen.getByRole("heading", { name: "Officials" })).toBeInTheDocument();
  });
});
