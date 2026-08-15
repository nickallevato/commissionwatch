import { describe, it, expect } from "vitest";
import {
  absenceReasonFor,
  coverageForMeeting,
  sumTranscriptCoverage,
  unanimousState,
} from "./transcript-coverage";
import { transcriptCoverage } from "@/mocks/data";
import type { TranscriptCoverageRow } from "@/types";

function row(overrides: Partial<TranscriptCoverageRow> = {}): TranscriptCoverageRow {
  return {
    jurisdiction: "Fictional Springs",
    body: "Example Commission on Public Works",
    year: 2024,
    published: 0,
    absent: 0,
    unavailable: 0,
    unchecked: 0,
    checked_through: null,
    ...overrides,
  };
}

/**
 * The arithmetic under the transcript figures, tested apart from any page.
 *
 * What is actually being guarded is a refusal: `unanimousState` must return
 * `null` for a mixed year rather than the largest count. A "mostly absent" year
 * rendered as absent would publish, on a specific meeting's page, a claim that
 * the city published nothing — when the truth might be that our fetcher failed
 * on that one.
 */

describe("sumTranscriptCoverage", () => {
  it("keeps the four states apart and folds none into another", () => {
    const totals = sumTranscriptCoverage(transcriptCoverage);
    expect(totals).toEqual({
      published: 9,
      absent: 15,
      unavailable: 5,
      unchecked: 6,
      total: 35,
    });
  });

  it("is zero across the board for an archive nobody has swept", () => {
    expect(sumTranscriptCoverage([])).toEqual({
      published: 0,
      absent: 0,
      unavailable: 0,
      unchecked: 0,
      total: 0,
    });
  });
});

describe("coverageForMeeting", () => {
  it("matches on jurisdiction, body and calendar year together", () => {
    const found = coverageForMeeting(
      transcriptCoverage,
      "Boulder County",
      "Board of County Commissioners",
      "2024-12-10",
    );
    expect(found?.absent).toBe(11);
  });

  it("returns null when that body has no row for the meeting's year", () => {
    expect(
      coverageForMeeting(
        transcriptCoverage,
        "Boulder County",
        "Board of County Commissioners",
        "2019-03-04",
      ),
    ).toBeNull();
  });

  /**
   * `meetings.date` is a calendar date. Read with `new Date()` it becomes UTC
   * midnight, and a January 1 meeting lands in the previous year for every
   * reader west of Greenwich — matched against the wrong year's coverage.
   */
  it("reads the year off the date string rather than through a Date", () => {
    const january = row({ year: 2024, published: 3 });
    expect(
      coverageForMeeting(
        [january],
        "Fictional Springs",
        "Example Commission on Public Works",
        "2024-01-01",
      ),
    ).toBe(january);
  });
});

describe("unanimousState", () => {
  it("names the state when every meeting in the year shares it", () => {
    expect(unanimousState(row({ published: 12 }))).toBe("published");
    expect(unanimousState(row({ absent: 12 }))).toBe("absent");
    expect(unanimousState(row({ unavailable: 12 }))).toBe("unavailable");
    expect(unanimousState(row({ unchecked: 12 }))).toBe("unchecked");
  });

  it("refuses to pick a state out of a mixed year", () => {
    expect(unanimousState(row({ absent: 20, unavailable: 1 }))).toBeNull();
    expect(unanimousState(row({ published: 20, unchecked: 1 }))).toBeNull();
  });

  it("says nothing about a year with no meetings and nothing at all", () => {
    expect(unanimousState(row())).toBeNull();
    expect(unanimousState(null)).toBeNull();
  });
});

describe("absenceReasonFor", () => {
  /**
   * The mapping is the feature. `absent` is theirs and `unavailable` is ours,
   * and `<Absence>` renders the status-page link on exactly the reasons that
   * are ours — so swapping these two would put our outage on the city's record.
   */
  it("attributes an empty caption file to the source, not to us", () => {
    expect(absenceReasonFor("absent")).toBe("absent-upstream");
  });

  it("attributes a failed fetch to us", () => {
    expect(absenceReasonFor("unavailable")).toBe("request-failed");
  });

  it("calls an unswept recording unswept rather than empty", () => {
    expect(absenceReasonFor("unchecked")).toBe("not-yet-ingested");
  });
});
