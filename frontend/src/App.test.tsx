import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "./lib/test-utils";
import { App } from "./App";

describe("App", () => {
  it("renders the homepage with header", () => {
    renderWithProviders(<App />);
    expect(screen.getByText("CommissionWatch")).toBeInTheDocument();
    expect(screen.getByText("Welcome to CommissionWatch")).toBeInTheDocument();
  });
});
