import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnomalyBadge, SeverityMark, severityRank } from "./AnomalyBadge";

describe("AnomalyBadge", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(<AnomalyBadge count={0} maxSeverity="low" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the count alongside the severity numeral", () => {
    render(<AnomalyBadge count={3} maxSeverity="high" />);

    expect(screen.getByText("3")).toBeInTheDocument();
    // The severity square carries its rank, so severity never rides on colour.
    expect(screen.getByTitle("Severity 4 of 5 — High")).toBeInTheDocument();
  });

  it("says 'flag' for one entry and 'flags' for several", () => {
    const { rerender } = render(<AnomalyBadge count={1} maxSeverity="low" />);
    expect(screen.getByText("flag")).toBeInTheDocument();

    rerender(<AnomalyBadge count={2} maxSeverity="low" />);
    expect(screen.getByText("flags")).toBeInTheDocument();
  });
});

describe("SeverityMark", () => {
  it("prints the rank for every severity and names it for screen readers", () => {
    const cases = [
      { severity: "critical", rank: 5, label: "critical" },
      { severity: "high", rank: 4, label: "high" },
      { severity: "medium", rank: 3, label: "medium" },
      { severity: "low", rank: 2, label: "low" },
    ] as const;

    for (const { severity, rank, label } of cases) {
      const { unmount } = render(<SeverityMark severity={severity} />);

      expect(severityRank[severity]).toBe(rank);
      expect(screen.getByText(String(rank))).toBeInTheDocument();
      expect(
        screen.getByText(`Severity ${rank} of 5, ${label}`),
      ).toBeInTheDocument();

      unmount();
    }
  });
});
