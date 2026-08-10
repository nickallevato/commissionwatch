import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";
import type { MeetingStatus } from "@/types";

/**
 * The meeting status pill.
 *
 * The badge is one span carrying one word, which makes it easy to treat as
 * decoration. It is not. It is the only place in a meeting header that says
 * whether the meeting *happened*, and readers take that word at face value —
 * a cancelled meeting mistaken for a completed one is a false statement about
 * the public record, not a styling nit. So the suite pins two things.
 *
 * First, that each status prints its own word. The component leans on CSS
 * `uppercase` rather than transforming the string, which means the accessible
 * name stays the raw enum value; anyone who "fixes" that by hardcoding display
 * strings has changed what the DOM asserts, and these tests should notice.
 *
 * Second, and the reason this file exists, that `cancelled` is visually
 * distinct from `completed`. Those two are the pair a reader is most likely to
 * confuse and the pair a careless palette edit is most likely to collapse
 * together, because both are "the meeting is over" states. They must never
 * share a class string.
 *
 * The expectations are keyed by the `MeetingStatus` union rather than written
 * out as loose strings, so adding a fourth status to the enum fails the
 * typecheck here instead of quietly shipping an untested badge.
 */

const EXPECTED_CLASSES: Record<MeetingStatus, readonly string[]> = {
  scheduled: ["border-ink", "text-ink"],
  completed: ["border-rule", "text-muted"],
  cancelled: ["border-accent", "text-accent"],
};

const STATUSES = Object.keys(EXPECTED_CLASSES) as MeetingStatus[];

/** Shape shared by every badge — the pill itself, independent of severity. */
const BASE_CLASSES = [
  "inline-flex",
  "items-center",
  "whitespace-nowrap",
  "rounded-full",
  "border",
  "bg-paper",
  "font-sans",
  "font-semibold",
  "uppercase",
  "tracking-label",
];

function renderBadge(status: MeetingStatus): HTMLElement {
  render(<StatusBadge status={status} />);
  return screen.getByText(status);
}

describe("StatusBadge", () => {
  it.each(STATUSES)("renders %s as its own literal status word", (status) => {
    const badge = renderBadge(status);
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveTextContent(status);
  });

  it.each(STATUSES)("gives %s its own colour classes", (status) => {
    const badge = renderBadge(status);
    for (const className of EXPECTED_CLASSES[status]) {
      expect(badge).toHaveClass(className);
    }
  });

  it.each(STATUSES)("keeps the shared pill shape on %s", (status) => {
    const badge = renderBadge(status);
    for (const className of BASE_CLASSES) {
      expect(badge).toHaveClass(className);
    }
  });

  it.each(STATUSES)("renders exactly one badge for %s", (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getAllByText(status)).toHaveLength(1);
  });

  it("does not dress a cancelled meeting as a completed one", () => {
    const cancelled = renderBadge("cancelled");
    for (const className of EXPECTED_CLASSES.completed) {
      expect(cancelled).not.toHaveClass(className);
    }
  });

  it("does not dress a completed meeting as a cancelled one", () => {
    const completed = renderBadge("completed");
    for (const className of EXPECTED_CLASSES.cancelled) {
      expect(completed).not.toHaveClass(className);
    }
  });

  it("gives every status a distinct style, not just cancelled", () => {
    const seen = new Set<string>();
    for (const status of STATUSES) {
      seen.add(EXPECTED_CLASSES[status].join(" "));
    }
    expect(seen.size).toBe(STATUSES.length);

    const rendered = STATUSES.map((status) => {
      const { unmount } = render(<StatusBadge status={status} />);
      const className = screen.getByText(status).className;
      unmount();
      return className;
    });
    expect(new Set(rendered).size).toBe(STATUSES.length);
  });

  it("never substitutes prose for the status value", () => {
    const { container } = render(<StatusBadge status="cancelled" />);
    // "cancelled" is the record's word. Softening it to "postponed" or
    // "rescheduled" would report a state the record does not contain.
    expect(container.textContent).toBe("cancelled");
  });
});
