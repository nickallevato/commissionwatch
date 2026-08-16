import { Link, useParams } from "react-router";
import { Tile, Tiles } from "@/components/PressroomUI";
import { ActivityStrip } from "@/components/officials/ActivityStrip";
import { DonorOverlay } from "@/components/officials/DonorOverlay";
import { VoteBar } from "@/components/officials/VoteBar";
import { VotingTimeline } from "@/components/officials/VotingTimeline";
import { useOfficial } from "@/hooks/useOfficial";
import type { OfficialProfile } from "@/types";

/**
 * `/officials/:id` — one official, as a subject.
 *
 * This is a public editorial page, so it is built in the newspaper system the
 * rest of the site is built in: display serif for anything a reader reads,
 * tabular figures for anything that is a number, hairline rules instead of
 * cards, `tracking-label` micro-labels, and the single red accent spent only on
 * the two things that are unusual — a dissent, and a finding.
 *
 * ## Two things it says out loud rather than by omission
 *
 * A rate computed from nothing is `null` on the wire, and a `null` renders as
 * a sentence, never as `0%`. "Voted with the majority 0% of the time" and
 * "there was nothing comparable to measure" are different claims about a
 * person, and only one of them is true of an official with no roll calls yet.
 *
 * The campaign finance panel renders its coverage caveat whether or not there
 * is anything under it — see `DonorOverlay`.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatTermDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function percent(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)}%`;
}

function Masthead({ profile }: { profile: OfficialProfile }) {
  const { official } = profile;
  const office = [
    official.title,
    official.jurisdiction
      ? `${official.jurisdiction.name}, ${official.jurisdiction.state}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const term = `${formatTermDate(official.term_start)} – ${
    official.term_end ? formatTermDate(official.term_end) : "Present"
  }`;

  return (
    <header>
      <p className="kicker">The official record</p>
      <h1 className="headline mt-1">{official.name}</h1>
      {office && <p className="mt-3 text-sm text-muted">{office}</p>}
      <p className="figure mt-1 text-sm text-ink-soft">{term}</p>
    </header>
  );
}

function StandingFigures({ profile }: { profile: OfficialProfile }) {
  const attendance = percent(profile.attendance.rate);
  const alignment = percent(profile.alignment.rate);

  return (
    <Tiles>
      <Tile
        label="Votes recorded"
        value={profile.record.total}
        sub="in the published record"
        testId="tile-votes"
      />
      <Tile
        label="Present"
        value={attendance ?? "Not measured"}
        small={attendance === null}
        sub={
          profile.attendance.meetingsWithRollCall === 0
            ? "no roll call to measure"
            : `${profile.attendance.present} of ${profile.attendance.meetingsWithRollCall} roll calls`
        }
        testId="tile-attendance"
      />
      <Tile
        label="With the majority"
        value={alignment ?? "Not measured"}
        small={alignment === null}
        sub={
          profile.alignment.comparableVotes === 0
            ? "nothing comparable"
            : `${profile.alignment.withMajority} of ${profile.alignment.comparableVotes} comparable votes`
        }
        testId="tile-alignment"
      />
      <Tile
        label="Published findings"
        value={profile.findings.length}
        tone={profile.findings.length > 0 ? "bad" : "plain"}
        sub="reviewed by an editor"
        testId="tile-findings"
      />
    </Tiles>
  );
}

export function OfficialPage() {
  const { id } = useParams<{ id: string }>();
  const { data: profile, isLoading, isError } = useOfficial(id);

  if (isLoading) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading the official record</span>
        <div className="h-10 w-72 animate-pulse bg-paper-sunk" />
        <div className="mt-3 h-4 w-52 animate-pulse bg-paper-sunk" />
        <div className="mt-8 h-24 w-full animate-pulse bg-paper-sunk" />
      </div>
    );
  }

  if (isError || !profile) {
    return (
      <div>
        <p className="kicker">Not in the record</p>
        <h1 className="headline mt-1">This official could not be loaded</h1>
        <p className="mt-4 max-w-prose text-sm text-muted">
          Either no such official exists in the published record, or the request failed.
        </p>
        <p className="mt-4">
          <Link className="cite" to="/officials">
            Back to the roster
          </Link>
        </p>
      </div>
    );
  }

  return (
    <article>
      <Masthead profile={profile} />

      <div className="rule-hi mt-6" />

      <div className="mt-5">
        <StandingFigures profile={profile} />
      </div>

      <div className="mt-8 grid gap-8 sm:grid-cols-12">
        <section aria-labelledby="record-heading" className="sm:col-span-5">
          <h2 id="record-heading" className="label-sm">
            How the votes fall
          </h2>
          <div className="mt-3">
            <VoteBar record={profile.record} testId="record-vote-bar" />
          </div>
        </section>

        <section aria-labelledby="activity-heading" className="sm:col-span-7">
          <h2 id="activity-heading" className="label-sm">
            Recorded votes by month
          </h2>
          <div className="mt-3">
            <ActivityStrip months={profile.activity} />
          </div>
        </section>
      </div>

      <section aria-labelledby="timeline-heading" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-[3px] border-double border-rule pb-2.5">
          <h2
            id="timeline-heading"
            className="font-display text-2xl leading-headline tracking-headline text-ink"
          >
            The voting record
          </h2>
          <span className="figure text-[11px] text-muted">
            {profile.timeline.length} published{" "}
            {profile.timeline.length === 1 ? "sitting" : "sittings"}
          </span>
        </div>
        <div className="mt-4">
          <VotingTimeline entries={profile.timeline} />
        </div>
      </section>

      <div className="mt-10">
        <DonorOverlay findings={profile.findings} coverage={profile.finance} />
      </div>
    </article>
  );
}
