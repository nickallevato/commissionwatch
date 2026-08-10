import type { OfficialVotingRecord } from "@/types";

/**
 * A voting record as one ruled bar rather than four numbers in a row.
 *
 * Divs and inline widths. No charting library — a four-segment bar does not
 * need eighty kilobytes of JavaScript, and this site is read by people on the
 * end of a rural connection.
 *
 * Every segment carries its count in the legend beneath, so the bar is the
 * fast read and the legend is the record. Colour is never the only signal:
 * a reader who cannot distinguish the green from the red still has "Yes 14"
 * in tabular figures under it.
 */

interface Segment {
  key: keyof Omit<OfficialVotingRecord, "total">;
  label: string;
  /** A token from tailwind.config.ts. Nothing here invents a colour. */
  fill: string;
}

const SEGMENTS: readonly Segment[] = [
  { key: "yes", label: "Yes", fill: "bg-pass" },
  { key: "no", label: "No", fill: "bg-accent" },
  { key: "abstain", label: "Abstain", fill: "bg-sev3" },
  { key: "absent", label: "Absent", fill: "bg-muted" },
];

function voteBarSentence(record: OfficialVotingRecord): string {
  if (record.total === 0) return "No votes recorded.";
  const parts = SEGMENTS.filter((segment) => record[segment.key] > 0).map(
    (segment) => `${record[segment.key]} ${segment.label.toLowerCase()}`,
  );
  return `${record.total} recorded ${record.total === 1 ? "vote" : "votes"}: ${parts.join(", ")}.`;
}

export function VoteBar({
  record,
  compact = false,
  testId,
}: {
  record: OfficialVotingRecord;
  /** Timeline rows drop the legend; the row already carries the figures. */
  compact?: boolean;
  testId?: string;
}) {
  if (record.total === 0) {
    return (
      <p className="text-[12.5px] text-muted" data-testid={testId}>
        No votes recorded
      </p>
    );
  }

  return (
    <div data-testid={testId}>
      <span className="sr-only">{voteBarSentence(record)}</span>
      <span
        aria-hidden="true"
        className={`flex w-full overflow-hidden border border-rule ${compact ? "h-1.5" : "h-3"}`}
      >
        {SEGMENTS.map((segment) => {
          const count = record[segment.key];
          if (count === 0) return null;
          return (
            <i
              key={segment.key}
              data-segment={segment.key}
              className={`block ${segment.fill}`}
              style={{ width: `${(count / record.total) * 100}%` }}
            />
          );
        })}
      </span>

      {!compact && (
        <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {SEGMENTS.map((segment) => (
            <li key={segment.key} className="flex items-baseline gap-1.5">
              <i className={`inline-block h-2 w-2 flex-none translate-y-[-1px] ${segment.fill}`} />
              <span className="label-sm">{segment.label}</span>
              <span className="figure text-[13px] text-ink">{record[segment.key]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
