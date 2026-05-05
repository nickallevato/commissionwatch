import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "../lib/test-utils";
import { NotFoundPage } from "./NotFoundPage";

describe("NotFoundPage", () => {
  it("renders 404 message", () => {
    renderWithProviders(<NotFoundPage />);
    expect(screen.getByText("Page Not Found")).toBeInTheDocument();
  });

  it("has a link back to home", () => {
    renderWithProviders(<NotFoundPage />);
    const link = screen.getByRole("link", { name: "Go back home" });
    expect(link).toHaveAttribute("href", "/");
  });
});
