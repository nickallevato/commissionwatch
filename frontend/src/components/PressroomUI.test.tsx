import { describe, it, expect } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import {
  Dropzone,
  KeyValues,
  LogTail,
  SegmentedControl,
  SeverityStripe,
  Sparkline,
  SpendMeter,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
  type SparkBar,
} from "./PressroomUI";

/**
 * The console's presentation layer, tested for the properties that make it
 * honest rather than for the classes that make it pretty.
 *
 * Three of those properties are load-bearing and none of them is cosmetic: a
 * pill that means something only by being coloured means nothing to a quarter
 * of the people who might read it; a strip of fourteen bars is not information
 * to a screen reader unless something says what it shows; and a segmented
 * control that only responds to a mouse is a control a keyboard operator
 * cannot use at all.
 */

describe("StatusPill", () => {
  it("carries its meaning as text, not as a colour", () => {
    render(<StatusPill tone="bad">Never run</StatusPill>);
    const pill = screen.getByText("Never run");
    expect(pill).toBeInTheDocument();
    // The tone is an attribute the tests and the styling both read; the label
    // is what a person reads. Both are present, and the label is not optional.
    expect(pill).toHaveAttribute("data-tone", "bad");
  });

  it("keeps its label whatever the tone", () => {
    for (const tone of ["ok", "warn", "bad", "idle", "plain"] as const) {
      const { unmount } = render(<StatusPill tone={tone}>Healthy</StatusPill>);
      expect(screen.getByText("Healthy")).toBeInTheDocument();
      unmount();
    }
  });
});

describe("Sparkline", () => {
  const bars: SparkBar[] = [
    { kind: "ok", height: 12 },
    { kind: "none", height: 3 },
    { kind: "bad", height: 9 },
  ];

  it("says in words what the bars show", () => {
    render(<Sparkline bars={bars} label="one sweep on record, two slots empty" />);
    expect(screen.getByText("one sweep on record, two slots empty")).toBeInTheDocument();
  });

  it("draws a bar per slot and marks a slot with no sweep as its own kind", () => {
    render(<Sparkline bars={bars} label="three slots" />);
    const strip = screen.getByTestId("sparkline");
    const drawn = strip.querySelectorAll("i");
    expect(drawn).toHaveLength(3);
    // "no sweep at all" and "a short sweep" are different facts and are never
    // drawn the same.
    expect(drawn[1]).toHaveAttribute("data-kind", "none");
    expect(drawn[0]).toHaveAttribute("data-kind", "ok");
  });

  it("hides the bars themselves from the accessibility tree", () => {
    render(<Sparkline bars={bars} label="three slots" />);
    for (const bar of screen.getByTestId("sparkline").querySelectorAll("i")) {
      expect(bar).toHaveAttribute("aria-hidden", "true");
    }
  });
});

describe("SeverityStripe", () => {
  it("is decorative — the pill beside it carries the word", () => {
    render(<SeverityStripe severity="warn" />);
    const stripe = screen.getByTestId("severity-stripe");
    expect(stripe).toHaveAttribute("aria-hidden", "true");
    expect(stripe).toHaveAttribute("data-severity", "warn");
  });
});

describe("Tiles", () => {
  it("renders a figure with its label and its subtitle", () => {
    render(
      <Tiles>
        <Tile label="Records ingested" value={0} sub="lifetime" tone="bad" testId="t" />
      </Tiles>,
    );
    expect(screen.getByText("Records ingested")).toBeInTheDocument();
    expect(screen.getByTestId("t")).toHaveTextContent("0");
    expect(screen.getByTestId("t")).toHaveAttribute("data-tone", "bad");
    expect(screen.getByText("lifetime")).toBeInTheDocument();
  });
});

function Segmented() {
  const [value, setValue] = useState("medium");
  return (
    <SegmentedControl
      name="sev"
      label="Minimum severity"
      value={value}
      onChange={setValue}
      options={[
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a radio group, so the choice is announced as a choice", () => {
    render(<Segmented />);
    const group = screen.getByRole("radiogroup", { name: "Minimum severity" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "medium" })).toBeChecked();
  });

  it("changes on a click", async () => {
    render(<Segmented />);
    await userEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "medium" })).not.toBeChecked();
  });

  it("moves with the arrow keys and wraps, so it works without a mouse", async () => {
    render(<Segmented />);
    const medium = screen.getByRole("radio", { name: "medium" });
    medium.focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "high" })).toBeChecked();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "low" })).toBeChecked();

    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
  });

  it("keeps exactly one segment in the tab order", () => {
    render(<Segmented />);
    const tabbable = screen
      .getAllByRole("radio")
      .filter((node) => node.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
  });
});

describe("SpendMeter", () => {
  it("exposes the figure as a meter, not only as a bar", () => {
    render(<SpendMeter label="SMS this month" value={18} max={100} unit="msgs" />);
    const meter = screen.getByRole("meter", { name: "SMS this month" });
    expect(meter).toHaveAttribute("aria-valuenow", "18");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });

  it("says there is no cap rather than drawing a bar against an invented one", () => {
    render(<SpendMeter label="SMS this month" value={18} max={null} unit="msgs" />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/no cap recorded/)).toBeInTheDocument();
  });
});

describe("KeyValues, LogTail and WorkTitle", () => {
  it("renders a provenance row as a term and its definition", () => {
    render(<KeyValues testId="kv" items={[{ key: "Adapter", value: "gallatin@3" }]} />);
    expect(screen.getByText("Adapter")).toBeInTheDocument();
    expect(screen.getByText("gallatin@3")).toBeInTheDocument();
  });

  it("keeps a log tail's own whitespace", () => {
    render(<LogTail testId="tail">{"one\ntwo"}</LogTail>);
    expect(screen.getByTestId("tail").textContent).toBe("one\ntwo");
  });

  it("gives the screen one heading and a stamp beside it", () => {
    render(<WorkTitle title="Sources" stamp="4 registered" />);
    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("4 registered")).toBeInTheDocument();
  });
});

describe("Dropzone", () => {
  it("is a real file input, so it takes focus and a keyboard as well as a drop", async () => {
    let received = "";
    render(
      <Dropzone
        id="drop"
        title="Drop a document"
        hint="Hashed on arrival."
        onFiles={(files) => {
          received = files[0].name;
        }}
      />,
    );

    const input = screen.getByLabelText(/Drop a document/);
    expect(input).toHaveAttribute("type", "file");
    await userEvent.upload(input, new File(["bytes"], "award.txt", { type: "text/plain" }));
    expect(received).toBe("award.txt");
  });
});
