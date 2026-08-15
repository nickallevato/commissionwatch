import type { AbsenceReason } from "@/components/ui/Absence";
import type { TranscriptCoverageRow } from "@/types";

/**
 * Reading `GET /api/transcripts/coverage` without flattening it.
 *
 * **The API exposes no per-meeting transcript state.** `transcript_status` is
 * keyed on `meeting_document_id` and every public read of it is aggregated:
 * `/api/transcripts/coverage` groups by jurisdiction, body and calendar year,
 * and `/api/meetings/:id` returns `meeting_documents` rows, which carry a
 * `document_type` and no state at all. A transcript document row is written at
 * discovery, before anyone has looked at the bytes, so its presence says the
 * custodian's archive lists a recording and nothing whatever about whether the
 * caption file has words in it — the 8-byte empty file produces exactly the
 * same row.
 *
 * So this module derives what is derivable and refuses the rest. A year whose
 * meetings are *unanimously* one state says that state about every meeting in
 * it, this one included; a mixed year says only what it says, per year, and the
 * meeting page must not pick a state out of it. Guessing would mean publishing
 * our own fetch failure as the city's silence, which is the single thing
 * `migrations/089_create_transcript_status.ts` exists to prevent.
 */

export interface TranscriptTotals {
  published: number;
  absent: number;
  unavailable: number;
  unchecked: number;
  /** Every meeting document of kind `transcript` behind the publication wall. */
  total: number;
}

/** Totals across every body and year. Four figures out, never one. */
export function sumTranscriptCoverage(
  rows: readonly TranscriptCoverageRow[],
): TranscriptTotals {
  const totals: TranscriptTotals = {
    published: 0,
    absent: 0,
    unavailable: 0,
    unchecked: 0,
    total: 0,
  };
  for (const row of rows) {
    totals.published += row.published;
    totals.absent += row.absent;
    totals.unavailable += row.unavailable;
    totals.unchecked += row.unchecked;
  }
  totals.total =
    totals.published + totals.absent + totals.unavailable + totals.unchecked;
  return totals;
}

/**
 * The row covering one meeting: same jurisdiction, same body, same calendar
 * year. The year comes off the `YYYY-MM-DD` prefix rather than `new Date()`,
 * which would read a date-only value as UTC midnight and put a January 1
 * meeting in the previous year west of Greenwich.
 */
export function coverageForMeeting(
  rows: readonly TranscriptCoverageRow[],
  jurisdiction: string,
  body: string,
  date: string,
): TranscriptCoverageRow | null {
  const match = /^(\d{4})/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  return (
    rows.find(
      (row) =>
        row.jurisdiction === jurisdiction &&
        row.body === body &&
        row.year === year,
    ) ?? null
  );
}

/** The three `transcript_status` states, plus the fourth thing coverage counts. */
export type TranscriptState =
  | "published"
  | "absent"
  | "unavailable"
  | "unchecked";

/**
 * The state true of every meeting in this group, or `null` when the group is
 * mixed and no single state is true of all of them.
 *
 * This is the whole per-meeting inference and it is deliberately narrow. Only a
 * unanimous year licenses a statement about one sitting inside it; anything
 * else would be attributing one meeting's outcome to another, and in the
 * `unavailable` direction that means publishing our outage as the custodian's
 * record.
 */
export function unanimousState(
  row: TranscriptCoverageRow | null,
): TranscriptState | null {
  if (!row) return null;
  const counts: ReadonlyArray<[TranscriptState, number]> = [
    ["published", row.published],
    ["absent", row.absent],
    ["unavailable", row.unavailable],
    ["unchecked", row.unchecked],
  ];
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  const sole = counts.find(([, count]) => count === total);
  return sole ? sole[0] : null;
}

/**
 * How `<Absence>` should phrase a meeting with no transcript to show.
 *
 * The mapping is the point of the whole feature. `absent` is the custodian
 * publishing nothing, which `absent-upstream` states without blaming us;
 * `unavailable` is ours, and `request-failed` is the reason that says so and
 * links to the status page. Nothing here may map an upstream fact onto one of
 * our failures or the reverse.
 */
export function absenceReasonFor(state: TranscriptState): AbsenceReason {
  switch (state) {
    case "absent":
      return "absent-upstream";
    case "unavailable":
      return "request-failed";
    case "unchecked":
      return "not-yet-ingested";
    case "published":
      // A published transcript is not an absence. Callers branch before this,
      // and the case is here so a new state cannot be added without the
      // compiler asking what its absence copy is.
      return "none-exist";
  }
}
