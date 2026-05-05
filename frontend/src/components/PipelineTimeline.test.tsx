import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PipelineTimeline } from "./PipelineTimeline";
import { STUB_PIPELINE } from "../lib/hub-stubs";

describe("PipelineTimeline", () => {
  it("renders all 5 pipeline stages", () => {
    render(<PipelineTimeline segments={STUB_PIPELINE} closeDate="Jun 14, 2026" />);
    expect(screen.getByText("Listed")).toBeInTheDocument();
    expect(screen.getByText("Offer")).toBeInTheDocument();
    expect(screen.getByText("Inspection")).toBeInTheDocument();
    expect(screen.getByText("Appraisal")).toBeInTheDocument();
    expect(screen.getByText("Closing")).toBeInTheDocument();
  });

  it("displays the close date", () => {
    render(<PipelineTimeline segments={STUB_PIPELINE} closeDate="Jun 14, 2026" />);
    expect(screen.getByText("Jun 14, 2026")).toBeInTheDocument();
  });

  it("renders the panel title", () => {
    render(<PipelineTimeline segments={STUB_PIPELINE} />);
    expect(screen.getByText("Pipeline")).toBeInTheDocument();
  });
});
