import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { Layout } from "./Layout";

describe("Layout", () => {
  it("renders the header with app name", () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText("CommissionWatch")).toBeInTheDocument();
  });
});
