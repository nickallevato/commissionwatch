import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { ProactivePanel } from "./ProactivePanel";
import { STUB_SIGNALS } from "../lib/hub-stubs";

function renderPanel() {
  return render(
    <MemoryRouter>
      <ProactivePanel signals={STUB_SIGNALS} />
    </MemoryRouter>,
  );
}

describe("ProactivePanel", () => {
  it("renders all signal rows", () => {
    renderPanel();
    expect(
      screen.getByText("Inspection contingency expires in 3 days"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Lender appraisal received — $865K"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Buyer's agent replied re: closing date"),
    ).toBeInTheDocument();
  });

  it("displays agent attribution and CTA", () => {
    renderPanel();
    expect(screen.getAllByText("Domus")).toHaveLength(2);
    expect(screen.getByText("Deedus")).toBeInTheDocument();
    expect(screen.getByText("Draft response →")).toBeInTheDocument();
  });

  it("renders clickable rows", async () => {
    renderPanel();
    const buttons = screen.getAllByRole("button");
    const signalButtons = buttons.filter((b) => b.className.includes("w-full"));
    expect(signalButtons.length).toBe(3);
  });
});
