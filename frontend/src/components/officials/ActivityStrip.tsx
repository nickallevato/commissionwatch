import type { OfficialActivityMonth } from "@/types";

/**
 * Twelve months of recorded votes, drawn from a baseline rule.
 *
 * Inline SVG, because the shape wanted here is a set of bars sitting *on* a
 * hairline that runs the full width — a printed convention, and one that a row
 * of divs can only approximate. Nothing external draws it.
 *
 * **A month with no votes is drawn as a tick on the baseline, never as
 * nothing.** The empty months are the information: a six-month gap in an
 * official's record is a fact about the record, and a strip that omitted them
 * would compress the gap out of existence and read as steady attendance.
 *
 * The strip is `aria-hidden`; `activitySentence` carries the same content in
 * words, because a row of rectangles is not information.
 */

const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

const WIDTH = 320;
const HEIGHT = 44;
const BASELINE = HEIGHT - 12;
const MIN_BAR = 2;

function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTH_INITIALS[index] ?? "?";
}

function activitySentence(months: readonly OfficialActivityMonth[]): string {
  if (months.length === 0) return "No activity window available.";
  const total = months.reduce((sum, month) => sum + month.votes, 0);
  const quiet = months.filter((month) => month.votes === 0).length;
  const first = months[0].month;
  const last = months[months.length - 1].month;
  return (
    `${total} recorded ${total === 1 ? "vote" : "votes"} between ${first} and ${last}, ` +
    `across ${months.length} months, of which ${quiet} recorded none.`
  );
}

export function ActivityStrip({ months }: { months: readonly OfficialActivityMonth[] }) {
  const peak = Math.max(1, ...months.map((month) => month.votes));
  const step = months.length > 0 ? WIDTH / months.length : WIDTH;
  const barWidth = Math.max(3, step * 0.55);

  return (
    <div data-testid="activity-strip">
      <span className="sr-only">{activitySentence(months)}</span>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-11 w-full"
      >
        {months.map((month, index) => {
          const x = index * step + (step - barWidth) / 2;
          const height =
            month.votes === 0 ? MIN_BAR : Math.max(MIN_BAR, (month.votes / peak) * (BASELINE - 4));
          return (
            <rect
              key={month.month}
              data-month={month.month}
              data-votes={month.votes}
              x={x}
              y={BASELINE - height}
              width={barWidth}
              height={height}
              fill={month.votes === 0 ? "var(--cw-rule)" : "var(--cw-ink)"}
            />
          );
        })}
        <line
          x1={0}
          y1={BASELINE}
          x2={WIDTH}
          y2={BASELINE}
          stroke="var(--cw-ink)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div
        aria-hidden="true"
        className="figure -mt-2 flex text-[9px] uppercase tracking-label text-muted"
      >
        {months.map((month) => (
          <span key={month.month} className="flex-1 text-center">
            {monthLabel(month.month)}
          </span>
        ))}
      </div>
    </div>
  );
}
