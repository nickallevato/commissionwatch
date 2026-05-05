import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { HomePage } from "./HomePage";
import { server } from "../mocks/server";
import { beforeAll, afterAll, afterEach } from "vitest";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("HomePage", () => {
  it("renders dashboard heading", () => {
    renderWithProviders(<HomePage />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders description text", () => {
    renderWithProviders(<HomePage />);
    expect(
      screen.getByText("Recent commission meetings at a glance."),
    ).toBeInTheDocument();
  });
});
