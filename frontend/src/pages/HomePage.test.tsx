import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("renders welcome heading", () => {
    renderWithProviders(<HomePage />);
    expect(screen.getByText("Welcome to CommissionWatch")).toBeInTheDocument();
  });

  it("renders description text", () => {
    renderWithProviders(<HomePage />);
    expect(
      screen.getByText("Real estate commission monitoring, powered by AI."),
    ).toBeInTheDocument();
  });
});
