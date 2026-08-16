import { Link } from "react-router";
import type { Member } from "@/types";

/** A member's cast votes, counted by `vote_value`. */
export interface MemberVotingRecord {
  yes: number;
  no: number;
  abstain: number;
  absent: number;
  total: number;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format a `YYYY-MM-DD` term date as a readable date. Parsed by hand rather
 * than through `new Date()` so a date-only column never slips a day in a
 * negative-offset timezone.
 */
function formatTermDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

interface Props {
  member: Member;
  /** Omitted when the roster has no vote data for this official. */
  record?: MemberVotingRecord;
}

/**
 * One line of the officials roster: name set in the display serif, office and
 * term in muted sans, voting record in tabular mono.
 */
export function MemberCard({ member, record }: Props) {
  const headingId = `official-${member.id}`;

  const term = `${formatTermDate(member.term_start)} – ${
    member.term_end ? formatTermDate(member.term_end) : "Present"
  }`;

  const office = [
    member.title,
    member.jurisdiction
      ? `${member.jurisdiction.name}, ${member.jurisdiction.state}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      aria-labelledby={headingId}
      className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule py-6 sm:grid-cols-12"
    >
      <div className="sm:col-span-5">
        <h3
          id={headingId}
          className="font-display text-xl leading-headline tracking-headline text-ink"
        >
          {/* The roster is the index of `/officials/:id`, so the name is the
            way in. There is no separate "view profile" affordance: a second
            control to reach the same page is a second thing to maintain. */}
          <Link to={`/officials/${member.id}`} className="underline-offset-4 hover:underline">
            {member.name}
          </Link>
        </h3>
        {office && <p className="mt-1 text-sm text-muted">{office}</p>}
        {member.email && (
          <a className="cite mt-2" href={`mailto:${member.email}`}>
            {member.email}
          </a>
        )}
      </div>

      <div className="sm:col-span-3">
        <span className="label-sm">Term</span>
        <p className="figure mt-1 text-sm text-ink-soft">{term}</p>
      </div>

      <div className="sm:col-span-4">
        <span className="label-sm">Voting record</span>
        {record && record.total > 0 ? (
          <>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="figure text-xl text-ink">{record.total}</span>
              <span className="text-xs text-muted">
                {record.total === 1 ? "vote recorded" : "votes recorded"}
              </span>
            </p>
            <p className="figure mt-1 text-xs text-muted">
              {`${record.yes} yes · ${record.no} no · ${record.abstain} abstain · ${record.absent} absent`}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted">No recorded votes</p>
        )}
      </div>
    </article>
  );
}
