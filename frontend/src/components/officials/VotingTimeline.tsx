import { Link } from "react-router-dom";
import type { OfficialTimelineEntry } from "@/types";
import { VoteBar } from "./VoteBar";

/**
 * The voting record as a timeline, not a table dump.
 *
 * Each sitting is one ruled row: the date set in the mono figure face in a
 * fixed-width rail on the left, so the dates form a column a reader's eye can
 * run down; the body of the sitting to its right; the composed vote bar
 * beneath, so a unanimous consent agenda and a 3–2 zoning fight look different
 * before either is read.
 *
 * A dissent is the one thing on the row set in the accent, because it is the
 * one thing on the row that is unusual.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` split by hand — `new Date()` on a date-only value slips a day. */
function formatDay(value: string): { day: string; month: string; year: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return { day: value, month: "", year: "" };
  const [, year, month, day] = match;
  return { day: String(Number(day)), month: MONTHS[Number(month) - 1] ?? "", year };
}

export function VotingTimeline({ entries }: { entries: readonly OfficialTimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="border-t border-rule py-8 text-sm text-muted">
        No sitting in the published record has a roll call naming this official. That is a
        statement about the published record, not about attendance.
      </p>
    );
  }

  return (
    <ol className="border-t border-rule" data-testid="voting-timeline">
      {entries.map((entry) => {
        const { day, month, year } = formatDay(entry.date);
        return (
          <li
            key={entry.meeting_id}
            data-testid="timeline-entry"
            className="grid grid-cols-[3.75rem_1fr] gap-x-4 gap-y-2 border-b border-rule py-4 sm:grid-cols-[4.5rem_1fr_9rem]"
          >
            <div className="text-center">
              <span className="figure block text-xl leading-none text-ink">{day}</span>
              <span className="label-sm mt-1 block">{month}</span>
              <span className="figure block text-[10px] text-muted">{year}</span>
            </div>

            <div className="min-w-0">
              <Link
                to={`/meetings/${entry.meeting_id}`}
                className="font-display text-lg leading-headline tracking-headline text-ink underline-offset-4 hover:underline"
              >
                {entry.commission_name}
              </Link>
              {entry.location && <p className="mt-0.5 text-[12.5px] text-muted">{entry.location}</p>}
              <p className="figure mt-1.5 text-[12.5px] text-ink-soft">
                {entry.record.total} {entry.record.total === 1 ? "vote" : "votes"}
                {entry.dissents > 0 && (
                  <>
                    {" · "}
                    <span className="text-accent">
                      {entry.dissents} against the majority
                    </span>
                  </>
                )}
              </p>
            </div>

            <div className="col-span-2 sm:col-span-1 sm:self-center">
              <VoteBar record={entry.record} compact testId="timeline-vote-bar" />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
