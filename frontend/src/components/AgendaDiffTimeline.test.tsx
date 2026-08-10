import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgendaDiffTimeline } from "./AgendaDiffTimeline";
import type {
  AgendaChange,
  DocumentTimeline,
  DocumentVersionSummary,
  VersionItem,
} from "@/types";

/**
 * P5 · the two-column diff.
 *
 * The case that gets the most attention here is the **one-version** one,
 * because it is the common case: most documents are published once and never
 * revised. It must render calmly — a single sentence about when the document
 * first appeared — rather than as an empty comparison, a broken column, or a
 * "no changes" badge asserting the result of a comparison that never happened.
 */

const ROLL_CALL: VersionItem = { item_number: 1, title: "Roll call" };
const BUDGET: VersionItem = { item_number: 2, title: "FY27 budget resolution" };
const REZONE: VersionItem = { item_number: 3, title: "Rezone 400 N Wallace" };

function version(no: number, overrides: Partial<DocumentVersionSummary> = {}): DocumentVersionSummary {
  return {
    id: `v${no}`,
    version_no: no,
    first_seen_at: `2026-07-${String(19 + no).padStart(2, "0")}T18:00:00.000Z`,
    sha256: String(no).repeat(64),
    byte_size: 1000 + no,
    item_count: 2,
    ...overrides,
  };
}

function timeline(overrides: Partial<DocumentTimeline> = {}): DocumentTimeline {
  return {
    document_id: "doc-1",
    title: "Agenda",
    document_type: "agenda",
    url: "https://example.invalid/agenda",
    versions: [version(1)],
    diffs: [],
    ...overrides,
  };
}

function pair(changes: AgendaChange[], from: VersionItem[], to: VersionItem[]) {
  return {
    from: version(1, { item_count: from.length }),
    to: version(2, { item_count: to.length }),
    changes,
    from_items: from,
    to_items: to,
  };
}

function renderTimeline(timelines: DocumentTimeline[] | undefined, state = {}) {
  return render(
    <AgendaDiffTimeline
      timelines={timelines}
      isLoading={false}
      isError={false}
      {...state}
    />,
  );
}

describe("AgendaDiffTimeline · one version, the common case", () => {
  it("states when the single version was first seen, with no comparison", () => {
    renderTimeline([timeline({ versions: [version(1, { item_count: 4 })] })]);

    expect(screen.getByText(/One version on file, first seen/)).toBeInTheDocument();
    expect(screen.getByText(/with 4 items extracted/)).toBeInTheDocument();
    // No two-column comparison is offered, because there is nothing to compare.
    expect(screen.queryByText("Earlier version")).not.toBeInTheDocument();
    expect(screen.queryByText("Later version")).not.toBeInTheDocument();
  });

  it("says nothing was revised rather than claiming nothing changed", () => {
    renderTimeline([timeline()]);
    expect(
      screen.getByText(/Every document on this meeting has been published once/),
    ).toBeInTheDocument();
  });

  it("says the items were not extracted rather than printing zero", () => {
    renderTimeline([timeline({ versions: [version(1, { item_count: null })] })]);
    expect(screen.getByText(/Its items were not extracted/)).toBeInTheDocument();
  });

  it("uses the singular for a single extracted item", () => {
    renderTimeline([timeline({ versions: [version(1, { item_count: 1 })] })]);
    expect(screen.getByText(/with 1 item extracted/)).toBeInTheDocument();
  });

  it("cites the version's content address", () => {
    renderTimeline([timeline({ versions: [version(1)] })]);
    expect(screen.getByTitle("1".repeat(64))).toBeInTheDocument();
  });
});

describe("AgendaDiffTimeline · two versions", () => {
  const added: AgendaChange[] = [
    { kind: "added", item_number: 3, title: "Rezone 400 N Wallace" },
  ];

  function revised() {
    return timeline({
      versions: [version(1), version(2)],
      diffs: [pair(added, [ROLL_CALL, BUDGET], [ROLL_CALL, BUDGET, REZONE])],
    });
  }

  it("labels each column with its version and its first_seen_at", () => {
    renderTimeline([revised()]);
    expect(screen.getByText("Earlier version")).toBeInTheDocument();
    expect(screen.getByText("Later version")).toBeInTheDocument();
    // Both content addresses are cited, which is what makes the diff checkable.
    expect(screen.getByTitle("1".repeat(64))).toBeInTheDocument();
    expect(screen.getByTitle("2".repeat(64))).toBeInTheDocument();
  });

  it("marks the added item on the later side only", () => {
    renderTimeline([revised()]);
    expect(screen.getAllByText("Rezone 400 N Wallace")).toHaveLength(1);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
  });

  it("summarises the change as a count, in both columns' terms", () => {
    renderTimeline([revised()]);
    expect(screen.getByText(/1 item added/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 documents on this meeting were republished/)).toBeInTheDocument();
  });

  it("marks a removal on the earlier side", () => {
    renderTimeline([
      timeline({
        versions: [version(1), version(2)],
        diffs: [
          pair(
            [{ kind: "removed", item_number: 3, title: "Rezone 400 N Wallace" }],
            [ROLL_CALL, REZONE],
            [ROLL_CALL],
          ),
        ],
      }),
    ]);
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.queryByText("Added")).not.toBeInTheDocument();
  });

  it("marks a retitle on both sides", () => {
    renderTimeline([
      timeline({
        versions: [version(1), version(2)],
        diffs: [
          pair(
            [
              {
                kind: "retitled",
                item_number: 2,
                title: "FY27 budget resolution",
                previous_title: "Budget resolution",
              },
            ],
            [ROLL_CALL, { item_number: 2, title: "Budget resolution" }],
            [ROLL_CALL, BUDGET],
          ),
        ],
      }),
    ]);
    expect(screen.getAllByText("Retitled")).toHaveLength(2);
  });

  it("leaves an unchanged item unmarked", () => {
    renderTimeline([revised()]);
    // "Roll call" appears in both columns and carries no mark in either.
    expect(screen.getAllByText("Roll call")).toHaveLength(2);
    expect(screen.queryByText("Unchanged")).not.toBeInTheDocument();
  });

  it("declines to compare when a version was never extracted", () => {
    renderTimeline([
      timeline({
        versions: [version(1, { item_count: null }), version(2)],
        diffs: [
          {
            from: version(1, { item_count: null }),
            to: version(2),
            changes: null,
            from_items: null,
            to_items: [ROLL_CALL],
          },
        ],
      }),
    ]);
    expect(screen.getByText(/no comparison is offered/)).toBeInTheDocument();
    expect(
      screen.getByText(/Items were not extracted from this version/),
    ).toBeInTheDocument();
  });
});

describe("AgendaDiffTimeline · states", () => {
  it("renders a skeleton while loading", () => {
    render(<AgendaDiffTimeline timelines={undefined} isLoading isError={false} />);
    expect(screen.getByText("What changed, and when")).toBeInTheDocument();
  });

  it("says the history could not be loaded on error", () => {
    render(<AgendaDiffTimeline timelines={undefined} isLoading={false} isError />);
    expect(
      screen.getByText(/version history for this meeting could not be loaded/),
    ).toBeInTheDocument();
  });

  it("says there are no stored versions rather than rendering nothing", () => {
    renderTimeline([]);
    expect(screen.getByText(/No stored versions on file/)).toBeInTheDocument();
  });

  it("never characterises a change, only records it", () => {
    const { container } = renderTimeline([
      timeline({
        versions: [version(1), version(2)],
        diffs: [
          pair(
            [{ kind: "added", item_number: 3, title: "Rezone 400 N Wallace" }],
            [ROLL_CALL],
            [ROLL_CALL, REZONE],
          ),
        ],
      }),
    ]);
    const text = container.textContent?.toLowerCase() ?? "";
    for (const word of [
      "quietly",
      "slipped",
      "buried",
      "sneak",
      "deliberate",
      "suspicious",
      "improper",
      "controversial",
      "hidden",
    ]) {
      expect(text).not.toContain(word);
    }
  });
});
