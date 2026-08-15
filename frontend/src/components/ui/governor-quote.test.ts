import { describe, it, expect } from "vitest";
import { markUnsupported } from "./governor-quote";

/**
 * Marking the wrong span of a quote is worse than marking none.
 *
 * The operator is about to approve a sentence about a named person on the
 * strength of this quote. A mark they read as the judge's objection, sitting on
 * a phrase the judge never named, is a misdirection dressed as evidence — so the
 * cases below are the ways a locator drifts: PDF whitespace, a fragment that is
 * a description rather than a quotation, two fragments that touch, and a
 * near-match in the wrong case.
 */

const QUOTE = "Commissioner Sample moved to table the item; Commissioner Fixture seconded.";

function marked(result: ReturnType<typeof markUnsupported>): string[] {
  return result.segments.filter((segment) => segment.unsupported).map((segment) => segment.text);
}

function whole(result: ReturnType<typeof markUnsupported>): string {
  return result.segments.map((segment) => segment.text).join("");
}

describe("markUnsupported", () => {
  it("returns the whole quote whether or not anything matched", () => {
    expect(whole(markUnsupported(QUOTE, ["moved"]))).toBe(QUOTE);
    expect(whole(markUnsupported(QUOTE, []))).toBe(QUOTE);
    expect(whole(markUnsupported(QUOTE, ["nothing like this"]))).toBe(QUOTE);
  });

  it("marks the fragment where it appears", () => {
    const result = markUnsupported(QUOTE, ["moved to table the item"]);
    expect(marked(result)).toEqual(["moved to table the item"]);
    expect(result.unlocated).toEqual([]);
  });

  it("matches across the line breaks PDF extraction invents", () => {
    // `pdf-text.ts` rebuilds a line from positioned glyph runs, so the quote can
    // carry a newline where the judge's reply has a space. Byte equality would
    // fail here on wording that is plainly present.
    const wrapped = "Commissioner Sample moved\n   to table the item.";
    const result = markUnsupported(wrapped, ["moved to table the item"]);
    expect(marked(result)).toEqual(["moved\n   to table the item"]);
  });

  it("reports a fragment that is a description rather than a quotation", () => {
    // The prompt asks the judge to name "the person, the action, or the matter"
    // in a few words, so this is the common case and not an edge one.
    const result = markUnsupported(QUOTE, ["the action attributed to Fixture"]);
    expect(marked(result)).toEqual([]);
    expect(result.unlocated).toEqual(["the action attributed to Fixture"]);
  });

  it("joins overlapping fragments into one mark", () => {
    const result = markUnsupported(QUOTE, ["moved to table", "to table the item"]);
    expect(marked(result)).toEqual(["moved to table the item"]);
  });

  it("does not match in the wrong case", () => {
    // A case-insensitive match would let a fragment land on a different
    // occurrence further along, and the operator would read that mark as the
    // finding.
    const result = markUnsupported(QUOTE, ["MOVED"]);
    expect(marked(result)).toEqual([]);
    expect(result.unlocated).toEqual(["MOVED"]);
  });

  it("ignores an empty fragment instead of marking the whole quote", () => {
    // `indexOf("")` is 0. Without the guard this would mark from the start of
    // the quote to nowhere.
    const result = markUnsupported(QUOTE, ["   "]);
    expect(marked(result)).toEqual([]);
    expect(result.unlocated).toEqual([]);
  });
});
