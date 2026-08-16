import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Absence, type AbsenceReason } from "./Absence";

function renderAbsence(reason: AbsenceReason, subject = "matters") {
  return render(
    <MemoryRouter>
      <Absence reason={reason} subject={subject} />
    </MemoryRouter>,
  );
}

/**
 * The distinction this component exists to protect is the one between "there
 * are none" and "we could not ask". Everything else here is copy; that one is a
 * claim about the public record.
 */
describe("Absence", () => {
  it("names a load failure as ours and does not say the record is empty", () => {
    renderAbsence("request-failed", "Matters");
    expect(screen.getByText(/failure on our side/i)).toBeInTheDocument();
    expect(screen.getByText(/not a statement that there are none/i)).toBeInTheDocument();
  });

  it("points at the collection status only when the absence is ours", () => {
    renderAbsence("sweep-failed");
    expect(screen.getByRole("link", { name: /collection status/i })).toHaveAttribute(
      "href",
      "/status",
    );
  });

  it("does not blame ourselves for a record that genuinely holds none", () => {
    renderAbsence("none-exist");
    expect(screen.getByText(/the record shows no matters/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /collection status/i })).not.toBeInTheDocument();
  });

  /**
   * "Held" and "missing" are different facts about a public record, and the
   * withheld case is the one a reader is entitled to be told about explicitly —
   * it says the records exist.
   */
  it("says a withheld record exists rather than that nothing does", () => {
    renderAbsence("withheld", "Minutes");
    expect(screen.getByText(/have not been published yet/i)).toBeInTheDocument();
    expect(screen.getByText(/exist for this record/i)).toBeInTheDocument();
  });

  /**
   * The transcripts work turns on this: an 8-byte empty caption file is a
   * publication of nothing, which is not the same as no publication.
   */
  it("distinguishes the source publishing nothing from there being nothing", () => {
    renderAbsence("absent-upstream", "transcript");
    expect(screen.getByText(/the source published no transcript here/i)).toBeInTheDocument();
  });

  it("frames unreviewed records as waiting, not as absent", () => {
    renderAbsence("not-reviewed", "claims");
    expect(screen.getByText(/have been reviewed yet/i)).toBeInTheDocument();
  });

  /**
   * A reason meaning "we don't know" is deliberately absent — if the system
   * cannot say why something is empty that is a defect in the ingestion ledger,
   * not a copy problem. This fails if one is ever added without a decision.
   */
  it("offers no reason that means we cannot say why", () => {
    const reasons: AbsenceReason[] = [
      "not-yet-ingested",
      "sweep-failed",
      "withheld",
      "none-exist",
      "not-reviewed",
      "absent-upstream",
      "request-failed",
    ];
    for (const reason of reasons) {
      const { container, unmount } = renderAbsence(reason);
      // Every reason must produce a real sentence. `getByText(/\S/)` was the
      // first attempt and matched several nested nodes at once — the assertion
      // is about the rendered text as a whole, not about any one element.
      expect((container.textContent ?? "").trim().length).toBeGreaterThan(20);
      unmount();
    }
    expect(reasons).toHaveLength(7);
  });
});
