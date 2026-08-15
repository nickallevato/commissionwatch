import { Link } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { useMetrics } from "@/hooks/useMetrics";

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
          {value === null ? "—" : value.toLocaleString()}
        </span>
        {of !== undefined ? (
          <span className="text-sm text-muted">
            {" of "}
            <span className="figure">{of.toLocaleString()}</span>
          </span>
        ) : null}
        {note ? <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p> : null}
      </dd>
    </div>
  );
}

export function MetricsPage() {
  const { data: metrics, isLoading, isError } = useMetrics();

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
        <p className="mt-8 text-sm text-ink-soft">Loading…</p>
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
