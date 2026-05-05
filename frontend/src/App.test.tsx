import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "./lib/test-utils";
import { App } from "./App";

describe("App", () => {
  it("renders the sidebar with app name", () => {
    renderWithProviders(<App />);
    expect(screen.getByText("CommissionWatch")).toBeInTheDocument();
  });

  it("renders the dashboard heading", () => {
    renderWithProviders(<App />);
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });
});
