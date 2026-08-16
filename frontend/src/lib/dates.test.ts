import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatDay, formatDayShort, formatTimestamp } from "./dates";

describe("formatDay", () => {
  it("names the same calendar day the ISO string names, west of Greenwich or not", () => {
    // `new Date("2024-12-10")` is UTC midnight. In a negative-offset zone that
    // renders as December 9 — the exact bug this function exists to prevent.
    // This assertion is timezone-independent because formatDay never
    // constructs a `Date` from the input at all.
    expect(formatDay("2024-12-10")).toBe("December 10, 2024");
  });

  it("formats a full ISO timestamp by its date portion", () => {
    expect(formatDay("2026-08-14T00:00:00.000Z")).toBe("August 14, 2026");
  });

  it("returns malformed input unchanged", () => {
    expect(formatDay("not-a-date")).toBe("not-a-date");
    expect(formatDay("")).toBe("");
  });
});

describe("formatDayShort", () => {
  it("renders weekday, short month, day, year", () => {
    // 2026-08-14 is a Friday.
    expect(formatDayShort("2026-08-14")).toBe("Fri, Aug 14, 2026");
  });

  it("does not shift the day", () => {
    expect(formatDayShort("2024-12-10")).toBe("Tue, Dec 10, 2024");
  });

  it("returns malformed input unchanged", () => {
    expect(formatDayShort("not-a-date")).toBe("not-a-date");
    expect(formatDayShort("")).toBe("");
  });
});

describe("formatTimestamp", () => {
  it("always carries an explicit UTC label", () => {
    const result = formatTimestamp("2026-08-14T17:02:00.000Z");
    expect(result).toContain("UTC");
    expect(result).toBe("2026-08-14 at 17:02 UTC");
  });

  it("labels UTC regardless of the offset in the input", () => {
    const result = formatTimestamp("2026-08-14T09:02:00-08:00");
    expect(result).toContain("UTC");
  });

  it("returns malformed input unchanged", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp("")).toBe("");
  });
});

/**
 * No page renders a bare `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`.
 *
 * Each of those, called with no explicit locale and timezone, renders in
 * whatever the reader's browser happens to be set to — silently. That is not
 * a style nit on the page whose purpose is recording exactly when a published
 * claim changed: an unlabelled local-timezone timestamp is how a correction's
 * time becomes wrong for a reader without either of them noticing. Text-scanned
 * off disk, the same technique `backend/test/workflow-monitor-env.test.ts`
 * uses for YAML, because the whole point is to catch the pattern growing back
 * in a file nobody thought to grep.
 */
describe("no page calls the bare Locale* Date formatters directly", () => {
  const PAGES_DIR = join(__dirname, "..", "pages");
  const FORBIDDEN = ["toLocaleString(", "toLocaleDateString(", "toLocaleTimeString("];

  /**
   * The only two calls left after migrating every page to `formatDay`,
   * `formatDayShort`, or `formatTimestamp`, and why each earns the exception
   * rather than a fourth export from this module:
   *
   * `AdminSourcesPage.tsx` and `AdminHomePage.tsx` each show a "read HH:MM"
   * freshness ticker next to the operator console's page title — `readAt` is
   * `Date.now()` captured on load, a live wall-clock instant for the operator
   * glancing at their own screen right now, not a stored record's timestamp.
   * `formatTimestamp` names UTC and always prints the date, which is correct
   * for "when did this happen" and wrong for "is this page stale" — an
   * operator does not want their own local clock relabelled UTC, and does not
   * want today's date repeated every few seconds. Nothing else on either page
   * calls a bare Locale* formatter.
   */
  const ALLOWED: Record<string, string> = {
    "AdminSourcesPage.tsx":
      "readAt is Date.now(), a live local-clock freshness ticker beside the " +
      "page title, not a stored record's timestamp — see the block comment above.",
    "AdminHomePage.tsx":
      "readAt is Date.now(), a live local-clock freshness ticker beside the " +
      "page title, not a stored record's timestamp — see the block comment above.",
  };

  const pageFiles = readdirSync(PAGES_DIR).filter(
    (file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"),
  );

  it("found the pages directory and it is not empty", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it("the allow-list only names files that still exist, so it cannot go stale", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(pageFiles).toContain(file);
    }
  });

  for (const file of pageFiles) {
    if (file in ALLOWED) continue;
    it(`${file} does not call a bare Locale* date formatter`, () => {
      const text = readFileSync(join(PAGES_DIR, file), "utf8");
      for (const needle of FORBIDDEN) {
        expect(
          text.includes(needle),
          `${file} calls ${needle} directly. A bare Locale* call on a Date ` +
            "renders in whatever timezone the reader's browser happens to be " +
            "set to, unlabelled — exactly the defect that made a correction's " +
            "timestamp silently wrong depending who read it. Use formatDay, " +
            "formatDayShort, or formatTimestamp from src/lib/dates.ts instead.",
        ).toBe(false);
      }
    });
  }

  for (const [file, reason] of Object.entries(ALLOWED)) {
    it(`${file} still calls a bare Locale* formatter only where allow-listed (${reason})`, () => {
      const text = readFileSync(join(PAGES_DIR, file), "utf8");
      const stillPresent = FORBIDDEN.some((needle) => text.includes(needle));
      expect(
        stillPresent,
        `${file} is on the allow-list for a live local-clock ticker but no ` +
          "longer calls a bare Locale* formatter at all — remove it from ALLOWED " +
          "so the guard covers it like every other page.",
      ).toBe(true);
    });
  }
});
