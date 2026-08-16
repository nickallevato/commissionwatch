import { Link } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { formatCount } from "@/hooks/useSource";
import { useMetrics } from "@/hooks/useMetrics";
import { useTranscriptCoverage } from "@/hooks/useTranscriptCoverage";
import { sumTranscriptCoverage } from "@/lib/transcript-coverage";

/**
 * `/metrics` — this project's own numbers, on the terms it demands of others.
 *
 * `/status` says whether ingestion is running. Nothing said how much of the
 * archive is actually published, how long a meeting waits, or how many findings
 * are sitting unreviewed. Those are the numbers a reader needs to know how far
 * to trust the record, and they are the numbers most easily left unsaid.
 *
 * The page is deliberately unflattering where the truth is unflattering. A
 * watchdog that will not be measured by its own standard is asking for a trust
 * it has not earned.
 *
 * Nothing here identifies a record. The API returns counts and durations only —
 * see `backend/src/services/metrics.ts` for why an aggregate count of withheld
 * records does not breach the publication wall, and for the line that must not
 * be crossed.
 */

function Figure({
  label,
  value,
  of,
  note,
}: {
  label: string;
  value: number | null;
  /** Renders as "12 of 37" — a share, not a bare number. */
  of?: number;
  note?: string;
}) {
  return (
    <div className="border-t border-rule pt-3">
      <dt className="label-sm">{label}</dt>
      <dd className="mt-1">
        <span className="figure text-2xl">
          {value === null ? "—" : formatCount(value)}
        </span>
        {of !== undefined ? (
          <span className="text-sm text-muted">
            {" of "}
            <span className="figure">{formatCount(of)}</span>
          </span>
        ) : null}
        {note ? <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p> : null}
      </dd>
    </div>
  );
}

export function MetricsPage() {
  const { data: metrics, isLoading, isError } = useMetrics();
  // A second endpoint, not a second opinion: `/api/metrics` returns nothing
  // about transcripts — `backend/src/services/metrics.ts` knows only the corpus
  // counts — while `/api/transcripts/coverage` already publishes the figures
  // this section needs. Fetching the read that exists beats adding a field to
  // a backend another agent owns.
  const coverage = useTranscriptCoverage();
  const transcripts = sumTranscriptCoverage(coverage.data ?? []);

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <p className="kicker">Our own record</p>
        <h1 className="headline mt-1.5 text-3xl sm:text-4xl">By the numbers</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          What this project has collected, what it has published, and how long it
          takes. We ask public bodies to be measurable; this is the same
          courtesy, returned. Where a number is unflattering it is still here.
        </p>
      </header>

      {isLoading ? (
        <p className="mt-8 text-sm text-ink-soft" role="status" aria-live="polite">
          Loading…
        </p>
      ) : isError || !metrics ? (
        <Absence reason="request-failed" subject="These figures" />
      ) : (
        <>
          <section className="mt-10" aria-labelledby="corpus">
            <h2 id="corpus" className="font-display text-xl tracking-headline">
              The archive
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              A meeting exists the moment a sweep finds it, and becomes public
              when an operator publishes it. The gap between these two numbers is
              the part of the record you cannot see yet.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              <Figure
                label="Meetings published"
                value={metrics.corpus.meetings_published}
                of={metrics.corpus.meetings_total}
              />
              <Figure label="Agenda items" value={metrics.corpus.agenda_items} />
              <Figure label="Matters" value={metrics.corpus.matters} />
              <Figure label="Recorded votes" value={metrics.corpus.votes} />
              <Figure
                label="Documents searchable"
                value={metrics.corpus.documents_indexed}
                of={metrics.corpus.documents_total}
                note="A stored document whose text could not be read — a scan, a Word file — is held but not searchable."
              />
            </dl>
          </section>

          <section className="mt-12" aria-labelledby="review">
            <h2 id="review" className="font-display text-xl tracking-headline">
              Review
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              Nothing naming a person is published automatically. A finding
              reaches the site only when a named operator approves it, so a large
              held count means work waiting, not work hidden.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              <Figure
                label="Findings published"
                value={metrics.review.findings_published}
                of={metrics.review.findings_total}
              />
              <Figure label="Findings awaiting review" value={metrics.review.findings_held} />
              <Figure
                label="Claims approved"
                value={metrics.review.claims_approved}
                of={metrics.review.claims_total}
              />
              <Figure
                label="Disputes resolved"
                value={metrics.review.disputes_resolved}
                of={metrics.review.disputes_received}
                note="Anyone named in a record can contest it."
              />
            </dl>
            <p className="mt-4 text-sm">
              <Link to="/corrections" className="underline underline-offset-2">
                The corrections log
              </Link>
            </p>
          </section>

          <section className="mt-12" aria-labelledby="quality">
            <h2 id="quality" className="font-display text-xl tracking-headline">
              How well we read it
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              Collecting a document is not the same as understanding it. These
              are the figures that say how much of what we read we can actually
              stand behind.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              <Figure
                label="Officials we cannot match"
                value={metrics.quality.roster_unmatched}
                note="People the minutes name who have no roster entry here. Every one is a true statement our checks will reject, so this number is a ceiling on what we can publish."
              />
              <Figure
                label="Seats on the roster"
                value={metrics.quality.roster_seats_sourced}
                of={metrics.quality.roster_seats_implied}
                note="Against the number of distinct officeholders the records mention."
              />
              <Figure
                label="Recorded vote tallies"
                value={metrics.quality.vote_events_approved}
                of={metrics.quality.vote_events_total}
              />
            </dl>
            {/* Transcripts, and the reason this is four figures rather than a
              percentage. `absent` is the custodian serving a well-formed
              caption file with nothing in it — a fact about their record, and
              era-shaped: 8 of 8 sampled 2013–2020 Bozeman clips are empty
              against 1 of 22 from 2021–2026. `unavailable` is us failing to
              get an answer. `unchecked` is a meeting nobody has asked about.
              Fold any two together and one party's silence is published as
              another's, which is the whole point of `transcript_status`. */}
            <h3 className="mt-8 font-sans text-base font-semibold text-ink">
              Transcripts
            </h3>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
              Meeting recordings whose captions the custodian publishes. These
              are four separate numbers on purpose: a caption file with nothing
              in it is what the city published, and a caption file we could not
              fetch is our failure. Neither is the other.
            </p>
            {coverage.isError ? (
              <Absence reason="request-failed" subject="Transcript coverage" />
            ) : (
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
                <Figure
                  label="Recordings with captions"
                  value={transcripts.published}
                  of={transcripts.total}
                  note="The custodian published captions and we hold them, indexed and searchable."
                />
                <Figure
                  label="Custodian published nothing"
                  value={transcripts.absent}
                  note="An empty caption file, served by the custodian. A fact about their record — not a failed fetch."
                />
                <Figure
                  label="We could not collect"
                  value={transcripts.unavailable}
                  note="We could not fetch or could not parse the caption file. This one is ours."
                />
                <Figure
                  label="Not yet checked"
                  value={transcripts.unchecked}
                  note="A recording no sweep has asked about yet. Omitted, it would let an unswept archive read as fully covered."
                />
              </dl>
            )}

            {/* The spread across bodies, because the totals above cannot say
              whether coverage is even: one body fully accounted for and one
              accounted for not at all sum to figures that read as partial
              coverage in both.

              No body is named, and that is a wall decision rather than a design
              one. This endpoint is public and takes no id, and the publication
              wall answers 404 rather than 403 so a stranger cannot enumerate
              what has been collected and withheld — "0 of 3 seats" beside a
              county's name would say we hold records for that county before an
              operator had published one. The per-body roll is the operator's
              view; it is theirs because they are the ones who have to go and
              source the roster. */}
            {metrics.roster ? (
              <>
                <h3 className="mt-8 font-sans text-base font-semibold text-ink">
                  How evenly the rosters cover
                </h3>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
                  Across the{" "}
                  <span className="figure">{metrics.roster.jurisdictions}</span> bodies
                  we watch. An average would hide the shape of this: one body we
                  can account for entirely and one we cannot account for at all
                  read, added together, as though both were half done.
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
                  <Figure
                    label="Fully accounted"
                    value={metrics.roster.accounted}
                    of={metrics.roster.jurisdictions}
                    note="Every officeholder named in what we have read has an entry here."
                  />
                  <Figure
                    label="Partly accounted"
                    value={metrics.roster.partial}
                    note="Some of the people named have an entry; the rest are statements we will reject."
                  />
                  <Figure
                    label="Not accounted at all"
                    value={metrics.roster.none}
                    note="Nobody the record names can be matched, so nothing quoting them can be published."
                  />
                  <Figure
                    label="Nothing read yet"
                    value={metrics.roster.unmeasured}
                    note="Nothing we have read from this body names an officeholder, so there is nothing to check against. Not the same as covered."
                  />
                  <Figure
                    label="Traceable to a document"
                    value={metrics.roster.traceable}
                    of={metrics.roster.jurisdictions}
                    note="Bodies whose roster entries can prove where they came from. None, today."
                  />
                </dl>
              </>
            ) : null}

            {metrics.quality.roster_sourced ? null : (
              <p className="mt-4 max-w-prose border-l-2 border-accent pl-4 text-sm leading-relaxed text-ink-soft">
                <strong>Our roster of officials is not yet sourced.</strong> We
                hold names and terms, but not a document to point at for them —
                so a roster entry here cannot currently be traced the way every
                other claim on this site can. Until it can, we treat the roster
                as a working list rather than a published record.
              </p>
            )}
          </section>

          <section className="mt-12" aria-labelledby="latency">
            <h2 id="latency" className="font-display text-xl tracking-headline">
              How long it takes
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              Days between a body sitting and this site publishing that meeting.
              A median rather than an average, because one meeting published two
              years late would make an average meaningless.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              <Figure
                label="Median days to publish"
                value={metrics.latency.median_days_to_publish}
                note={
                  metrics.latency.median_days_to_publish === null
                    ? "Nothing has been published yet, so there is no figure. This is not zero days."
                    : undefined
                }
              />
            </dl>
            {metrics.latency.last_published_at ? (
              <p className="mt-4 text-sm text-ink-soft">
                Most recently published{" "}
                <span className="figure">
                  {metrics.latency.last_published_at.slice(0, 10)}
                </span>
                .
              </p>
            ) : null}
          </section>

          <p className="mt-12 border-t border-rule pt-4 text-xs text-muted">
            Counted{" "}
            <span className="figure">{metrics.generated_at.slice(0, 10)}</span>.
            These figures are aggregates: they say how much of the record is
            withheld without saying which record, which is what keeps this page
            on the right side of the same wall everything else obeys. See the{" "}
            <Link to="/methodology" className="underline underline-offset-2">
              methodology
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
