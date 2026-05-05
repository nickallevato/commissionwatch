import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnomalyBadge } from "./AnomalyBadge";

describe("AnomalyBadge", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(
      <AnomalyBadge count={0} maxSeverity="low" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders count with severity styling", () => {
    render(<AnomalyBadge count={3} maxSeverity="high" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
