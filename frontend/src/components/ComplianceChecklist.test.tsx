import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ComplianceChecklist } from "./ComplianceChecklist";
import { STUB_COMPLIANCE } from "../lib/hub-stubs";

describe("ComplianceChecklist", () => {
  it("renders all compliance items", () => {
    render(<ComplianceChecklist items={STUB_COMPLIANCE} />);
    expect(screen.getByText("Property Disclosure Statement")).toBeInTheDocument();
    expect(screen.getByText("Lead-Based Paint Disclosure")).toBeInTheDocument();
    expect(screen.getByText("Wood Heat Disclosure")).toBeInTheDocument();
    expect(screen.getByText("Mold Disclosure")).toBeInTheDocument();
    expect(screen.getByText("Methamphetamine Contamination")).toBeInTheDocument();
  });

  it("shows completion count in header", () => {
    render(<ComplianceChecklist items={STUB_COMPLIANCE} />);
    expect(screen.getByText("Compliance · 3/5")).toBeInTheDocument();
  });

  it("shows due date for incomplete items", () => {
    render(<ComplianceChecklist items={STUB_COMPLIANCE} />);
    expect(screen.getByText("Due May 12")).toBeInTheDocument();
    expect(screen.getByText("Due May 15")).toBeInTheDocument();
  });
});
