import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RundownViewer } from "./RundownViewer";
import type { RundownKeyItem, RundownSheet } from "@/types";

/**
 * The rundown: the plain-language "what is actually in this meeting" panel that
 * sits above the agenda on a meeting page.
 *
 * It is derived content, and derived content is where a civic record is easiest
 * to quietly corrupt. So the suite is built around the two ways this panel can
 * lie.
 *
 * The first is *promising content that does not exist*. A rundown row can be on
 * file with nothing in it — no summary, no key items — because generation was
 * skipped or produced nothing. If the component still rendered its frame, the
 * reader would get the heading "Key items in this meeting" over empty space,
 * which reads as "we looked and there was nothing important here" rather than
 * "nothing was compiled". The component returns `null` instead, and that is the
 * single most important assertion in this file.
 *
 * The second is *fabricated provenance*. The "Compiled from the record · {date}"
 * chip is a citation: it tells the reader when this summary was made, which is
 * how they judge whether it predates the final agenda. When `generated_at` is
 * missing or unparseable the component renders no chip at all. It must never
 * substitute "Unknown", "—", or today's date, because any of those attaches a
 * provenance claim to a summary whose provenance we do not have. The tests
 * therefore assert the *absence* of the chip's prose, not merely the absence of
 * a well-formed date.
 *
 * The remaining cases cover the partial rundowns that are common in practice —
 * a summary with no items, items with no summary, items with no priority or
 * category — because each of those is a real shape from the pipeline, and each
 * must degrade to less content rather than to a crash or an empty promise.
 *
 * Fixtures use invented jurisdictions and invented people throughout. Nothing
 * here should be readable as a claim about a real board or a real official.
 */

function sheet(overrides: Partial<RundownSheet> = {}): RundownSheet {
  return {
    id: "rundown-1",
    meeting_id: "meeting-1",
    summary: null,
    key_items: null,
    generated_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const REZONE: RundownKeyItem = {
  title: "Rezone the Thistlewood mill parcel",
  description:
    "A request to rezone twelve acres from light industrial to mixed residential.",
  category: "Land use",
  priority: "high",
};

const BUDGET: RundownKeyItem = {
  title: "Second reading of the FY28 water fund",
  description: "The rate schedule returns for a second reading before adoption.",
  category: "Budget",
  priority: "medium",
};

const APPOINTMENT: RundownKeyItem = {
  title: "Appointment to the Larkmere Parks Board",
  description:
    "One seat is open following the resignation of Deputy Clerk Wren Ashgrove.",
  priority: "low",
};

const BARE: RundownKeyItem = {
  title: "Approval of the consent calendar",
  description: "Routine items are adopted together without separate discussion.",
};

describe("RundownViewer · an empty rundown renders nothing", () => {
  it("renders nothing when there is no summary and key_items is null", () => {
    const { container } = render(<RundownViewer rundown={sheet()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no summary and key_items is empty", () => {
    const { container } = render(
      <RundownViewer rundown={sheet({ key_items: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("does not print the heading over an empty rundown", () => {
    render(<RundownViewer rundown={sheet({ generated_at: "2026-07-19T12:00:00.000Z" })} />);
    // Even with a generation timestamp on file, a rundown with no content is
    // not a rundown. A heading here would promise items that do not exist.
    expect(screen.queryByText("Key items in this meeting")).toBeNull();
    expect(screen.queryByText(/Compiled from the record/)).toBeNull();
  });

  it("treats a whitespace-free empty summary string as no summary", () => {
    const { container } = render(<RundownViewer rundown={sheet({ summary: "" })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RundownViewer · frame", () => {
  it("renders a section labelled by its own heading", () => {
    render(<RundownViewer rundown={sheet({ key_items: [REZONE] })} />);
    const section = screen.getByRole("region", {
      name: "Key items in this meeting",
    });
    expect(section).toBeInTheDocument();
  });

  it("renders the kicker and the h2 with the id the section points at", () => {
    render(<RundownViewer rundown={sheet({ key_items: [REZONE] })} />);
    expect(screen.getByText("Rundown")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Key items in this meeting",
    });
    expect(heading).toHaveAttribute("id", "rundown-heading");
  });
});

describe("RundownViewer · provenance chip", () => {
  it("cites when the rundown was compiled, as a long date", () => {
    render(
      <RundownViewer
        rundown={sheet({
          key_items: [REZONE],
          generated_at: "2026-07-19T12:00:00.000Z",
        })}
      />,
    );
    expect(
      screen.getByText("Compiled from the record · July 19, 2026"),
    ).toBeInTheDocument();
  });

  it("renders no chip at all when generated_at is unparseable", () => {
    render(
      <RundownViewer
        rundown={sheet({ key_items: [REZONE], generated_at: "not a timestamp" })}
      />,
    );
    // No fallback text: an "Unknown" or "—" here would still read as a
    // provenance line for a summary whose provenance we do not have.
    expect(screen.queryByText(/Compiled from the record/)).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it("renders no chip at all when generated_at is null", () => {
    render(<RundownViewer rundown={sheet({ key_items: [REZONE] })} />);
    expect(screen.queryByText(/Compiled from the record/)).toBeNull();
  });

  it("still renders the rundown body when the chip is withheld", () => {
    render(
      <RundownViewer
        rundown={sheet({ key_items: [REZONE], generated_at: "2026-13-45" })}
      />,
    );
    expect(screen.getByText(REZONE.title)).toBeInTheDocument();
  });
});

describe("RundownViewer · summary", () => {
  const SUMMARY =
    "The board takes up one rezoning, a second reading of the water rate schedule, and one appointment.";

  it("renders the summary when present", () => {
    render(<RundownViewer rundown={sheet({ summary: SUMMARY })} />);
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
  });

  it("renders a rundown that has a summary and no key items", () => {
    render(<RundownViewer rundown={sheet({ summary: SUMMARY, key_items: [] })} />);
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders a rundown that has key items and no summary", () => {
    render(<RundownViewer rundown={sheet({ key_items: [REZONE] })} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByText(REZONE.title)).toBeInTheDocument();
  });
});

describe("RundownViewer · key items", () => {
  function renderItems(items: RundownKeyItem[]) {
    render(<RundownViewer rundown={sheet({ key_items: items })} />);
    return screen.getAllByRole("listitem");
  }

  it("renders one list item per key item, in order", () => {
    const items = renderItems([REZONE, BUDGET, APPOINTMENT]);
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(REZONE.title);
    expect(items[1]).toHaveTextContent(BUDGET.title);
    expect(items[2]).toHaveTextContent(APPOINTMENT.title);
  });

  it("renders each item's title as a heading and its description as prose", () => {
    const [item] = renderItems([REZONE]);
    const heading = within(item).getByRole("heading", { level: 4 });
    expect(heading).toHaveTextContent(REZONE.title);
    expect(within(item).getByText(REZONE.description)).toBeInTheDocument();
  });

  it("labels the priority in words as well as in colour", () => {
    const items = renderItems([REZONE, BUDGET, APPOINTMENT]);
    expect(within(items[0]).getByText("high priority")).toBeInTheDocument();
    expect(within(items[1]).getByText("medium priority")).toBeInTheDocument();
    expect(within(items[2]).getByText("low priority")).toBeInTheDocument();
  });

  it("renders the category when the item carries one", () => {
    const [item] = renderItems([REZONE]);
    expect(within(item).getByText("Land use")).toBeInTheDocument();
  });

  it("omits the category line entirely when the item has none", () => {
    const [item] = renderItems([APPOINTMENT]);
    expect(item).toHaveTextContent(APPOINTMENT.title);
    expect(within(item).queryByText("Land use")).toBeNull();
    expect(within(item).queryByText("Budget")).toBeNull();
  });

  it("renders an item with neither priority nor category", () => {
    const [item] = renderItems([BARE]);
    expect(within(item).getByText(BARE.title)).toBeInTheDocument();
    expect(within(item).getByText(BARE.description)).toBeInTheDocument();
    expect(within(item).queryByText(/priority$/)).toBeNull();
  });

  it("keeps a neutral rule on an item with no stated priority", () => {
    const [item] = renderItems([BARE]);
    expect(item).toHaveClass("border-rule");
    for (const className of ["border-sev4", "border-sev3", "border-sev2"]) {
      expect(item).not.toHaveClass(className);
    }
  });

  it("puts each priority on its own step of the severity ramp", () => {
    const items = renderItems([REZONE, BUDGET, APPOINTMENT]);
    expect(items[0]).toHaveClass("border-sev4");
    expect(items[1]).toHaveClass("border-sev3");
    expect(items[2]).toHaveClass("border-sev2");

    expect(within(items[0]).getByText("high priority")).toHaveClass("text-sev4");
    expect(within(items[1]).getByText("medium priority")).toHaveClass("text-sev3");
    expect(within(items[2]).getByText("low priority")).toHaveClass("text-sev2");
  });

  it("does not collapse high and low onto the same rule", () => {
    const items = renderItems([REZONE, APPOINTMENT]);
    expect(items[0]).not.toHaveClass("border-sev2");
    expect(items[1]).not.toHaveClass("border-sev4");
  });

  it("renders two items that share a title without dropping either", () => {
    const items = renderItems([
      BARE,
      { ...BARE, description: "The consent calendar returns after a pulled item." },
    ]);
    expect(items).toHaveLength(2);
    expect(screen.getAllByText(BARE.title)).toHaveLength(2);
  });
});
