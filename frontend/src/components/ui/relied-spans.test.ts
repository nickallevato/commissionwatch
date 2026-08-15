import { describe, it, expect } from "vitest";
import { reliedInWindow } from "./relied-spans";

/**
 * The governor judges ±2,000 characters and the review screen shows ±500, so
 * **most relied-on spans fall outside what the operator is looking at**. That is
 * the two windows being different sizes on purpose, not a failure — and the
 * failure would be rendering two of four and saying nothing.
 */
describe("reliedInWindow", () => {
  const text = "0123456789abcdefghij";
  const offset = 1000;

  it("re-bases a document span into the window and quotes it verbatim", () => {
    const result = reliedInWindow([{ start: 1002, end: 1006 }], text, offset);
    expect(result.quotes).toEqual(["2345"]);
    expect(result.outside).toBe(0);
  });

  it("counts a span the window does not reach rather than dropping it", () => {
    const result = reliedInWindow(
      [
        { start: 1002, end: 1006 },
        { start: 5000, end: 5010 },
      ],
      text,
      offset,
    );
    expect(result.quotes).toEqual(["2345"]);
    expect(result.outside).toBe(1);
  });

  /**
   * A span clipped at the window edge would present half a sentence as the
   * thing the judge relied on, which misrepresents the evidence in the
   * direction of looking thinner than it was.
   */
  it("does not clip a span that straddles the window edge", () => {
    expect(reliedInWindow([{ start: 995, end: 1005 }], text, offset).outside).toBe(1);
    expect(reliedInWindow([{ start: 1015, end: 1030 }], text, offset).outside).toBe(1);
  });

  it("treats a whitespace-only span as unreachable rather than quoting nothing", () => {
    const spaces = "     hello     ";
    expect(reliedInWindow([{ start: 0, end: 3 }], spaces, 0).outside).toBe(1);
  });

  it("returns nothing at all for no spans", () => {
    expect(reliedInWindow([], text, offset)).toEqual({ quotes: [], outside: 0 });
  });
});
