import { Link } from "react-router-dom";
import { FlagBar } from "@/components/PressroomUI";
import { MatchConfidenceChip } from "@/components/officials/MatchQuality";
import type { FinanceCoverage, OfficialFinding, VoteDonorEvidence } from "@/types";

/**
 * The donor overlay, and the standing caveat that must never be separated
 * from it.
 *
 * ## The caveat renders whether or not there is anything to show
 *
 * This is the whole design of this component. A reader who opens an official's
 * page, finds an empty donor panel and is told nothing will supply their own
 * reason, and both available reasons are wrong: either this official is
 * unusually clean, or this site is broken. The true reason is that one filing
 * system has been consulted and it is the federal one, which a city
 * commissioner has probably never filed with.
 *
 * So the `FlagBar` is outside the conditional. There is no arrangement of this
 * component in which findings appear and the caveat does not, and none in which
 * the panel is empty and silent. The sentence itself is server-side — it is
 * rendered verbatim from `finance.caveat` rather than restated here, so the
 * page and the API cannot drift into saying different things.
 *
 * ## Uncertainty is a label, not a footnote
 *
 * Every finding carries a name-match chip in the same visual weight as the
 * finding's own severity, and the chip never says "match". It says what kind of
 * match, and it says "not a verified identity" in the chip itself rather than
 * in small print underneath. The disclosure below it lists the terms that
 * matched, the terms that did not, and the terms the matcher was blind to,
 * because a reader who can see the match can judge it — and roughly half the
 * time the honest judgement is "that is a coincidence".
 *
 * The chip itself lives in `MatchQuality.tsx` and is shared with the operator
 * review queue. It used to live here, and the console rendered nothing — so the
 * person deciding whether to publish a claim saw less of its uncertainty than
 * the person who would read it. One component now serves both, so the two can
 * never describe the same stored band differently.
 */

// Re-exported so the public page's own tests keep importing the chip from the
// component they are about. The definition is in `MatchQuality.tsx`.
export { MatchConfidenceChip };

function MatchDisclosure({ evidence }: { evidence: VoteDonorEvidence }) {
  return (
    <details className="mt-3 border-t border-rule pt-2.5">
      <summary className="label-sm cursor-pointer text-ink hover:text-accent">
        How this link was made
      </summary>
      <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 text-[12.5px]">
        <dt className="text-muted">Donor terms found</dt>
        <dd className="m-0 font-mono tabular text-ink">
          {evidence.donorMatch.matchedTerms.join(", ") || "none"}
        </dd>
        <dt className="text-muted">Donor terms not found</dt>
        <dd className="m-0 font-mono tabular text-ink-soft">
          {evidence.donorMatch.unmatchedTerms.join(", ") || "none"}
        </dd>
        <dt className="text-muted">Terms ignored</dt>
        <dd className="m-0 font-mono tabular text-muted">
          {evidence.donorMatch.discardedTerms.join(", ") || "none"}
        </dd>
        <dt className="text-muted">Recipient name</dt>
        <dd className="m-0 font-mono tabular text-ink-soft">
          {evidence.contributions[0]?.recipientName ?? "—"}
        </dd>
      </dl>
      <p className="mt-2.5 max-w-prose text-[12.5px] leading-relaxed text-muted">
        Terms that name a kind of organisation — company, union, committee, foundation,
        association and the rest — are ignored before matching, so the same name is treated
        identically whoever filed it.
      </p>
    </details>
  );
}

function Citations({ evidence }: { evidence: VoteDonorEvidence }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" data-testid="finding-citations">
      {evidence.contributions.map((contribution) => {
        const stamp = `${contribution.contributionDate} · ${formatUsd(contribution.amount)}`;
        return (
          <li key={contribution.contributionId}>
            {contribution.documentUrl ? (
              <a
                className="cite"
                href={contribution.documentUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {stamp} · filing {contribution.imageNumber}
              </a>
            ) : (
              <a
                className="cite"
                href={contribution.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {stamp} · {contribution.sourceSystem} {contribution.externalId}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function FindingCard({ finding }: { finding: OfficialFinding }) {
  return (
    <article
      data-testid="official-finding"
      className="border-t border-rule py-5 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="kicker">{finding.flag_type.split("_").join(" ")}</span>
        {finding.evidence && (
          <MatchConfidenceChip match={finding.evidence.donorMatch} testId="match-confidence" />
        )}
      </div>

      <p className="mt-2 max-w-prose text-[14.5px] leading-relaxed text-ink">
        {finding.description}
      </p>

      {finding.evidence ? (
        <>
          <Citations evidence={finding.evidence} />
          <MatchDisclosure evidence={finding.evidence} />
        </>
      ) : (
        finding.meeting_id && (
          <p className="mt-2">
            <Link className="cite" to={`/meetings/${finding.meeting_id}`}>
              The sitting this was found in
            </Link>
          </p>
        )
      )}
    </article>
  );
}

export function DonorOverlay({
  findings,
  coverage,
}: {
  findings: readonly OfficialFinding[];
  coverage: FinanceCoverage;
}) {
  const planned = coverage.systems.filter((system) => system.state === "planned");

  return (
    <section aria-labelledby="donor-overlay-heading" data-testid="donor-overlay">
      <h2
        id="donor-overlay-heading"
        className="font-display text-2xl leading-headline tracking-headline text-ink"
      >
        Campaign finance
      </h2>

      {/* Outside every conditional below. See the header. */}
      <div className="mt-3">
        <FlagBar label="What this covers" tone="warn" testId="finance-coverage-caveat">
          {coverage.caveat}
        </FlagBar>
      </div>

      {planned.length > 0 && (
        <p className="mt-2 max-w-prose text-[12.5px] leading-relaxed text-muted">
          Not yet read:{" "}
          {planned.map((system, index) => (
            <span key={system.key}>
              {index > 0 && ", "}
              <a className="underline underline-offset-2 hover:text-ink" href={system.url}>
                {system.name}
              </a>{" "}
              — {system.scope}
            </span>
          ))}
        </p>
      )}

      <div className="mt-6">
        {findings.length === 0 ? (
          <p className="border-t border-rule py-8 text-sm text-muted">
            Nothing has been published linking this official&rsquo;s votes to a campaign filing.
            An absence here is an absence in the federal record, and it is also the ordinary
            case: nothing is published until an editor has read it.
          </p>
        ) : (
          findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)
        )}
      </div>
    </section>
  );
}
