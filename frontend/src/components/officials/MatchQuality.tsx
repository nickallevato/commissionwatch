import { BAND_CLASS, BAND_LABEL } from "@/components/officials/matchBands";
import type { StoredEntityDecision, StoredNameMatch } from "@/types";

/**
 * How a name match reads — on the public page and in the operator console.
 *
 * ## Why this is one file and not two
 *
 * The chip lived in `DonorOverlay.tsx` and the review queue rendered nothing at
 * all, which meant the person being asked to approve a claim saw less of its
 * uncertainty than the person who would eventually read it. Fixing that by
 * writing a second chip in the console would have fixed the symptom and kept the
 * disease: two components rendering the same stored band, free to drift into
 * describing it differently. So the chip moved here and both surfaces import it.
 * There is no arrangement of this codebase in which the public is told a match
 * is "possible" and the operator is told something else.
 *
 * ## What the words may never become
 *
 * `strong` is the ceiling of the method and the ceiling of the method is still a
 * name. No label here may read as "confirmed", "verified", "identified",
 * "proven" or "exact"; tests on both surfaces hold that. The chip carries
 * "— not a verified identity" **inside itself** rather than in small print
 * underneath, because a caveat that can be visually separated from the claim
 * will be.
 *
 * ## Colour is never the signal
 *
 * Every band carries its name as text. The border and text colour are the second
 * signal, matching `StatusPill`'s rule in `PressroomUI.tsx` — a band that meant
 * "weak" only by being grey would mean nothing to a good fraction of the people
 * who might read it.
 */

export function MatchConfidenceChip({
  match,
  testId,
}: {
  match: StoredNameMatch;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-band={match.band}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-label ${BAND_CLASS[match.band]}`}
    >
      {BAND_LABEL[match.band]}
      <span className="font-normal normal-case tracking-normal opacity-80">
        — not a verified identity
      </span>
    </span>
  );
}

function TermList({
  label,
  terms,
  tone,
  testId,
}: {
  label: string;
  terms: readonly string[];
  tone: string;
  testId: string;
}) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd data-testid={testId} className={`m-0 break-words font-mono tabular ${tone}`}>
        {terms.length > 0 ? terms.join(", ") : "none"}
      </dd>
    </>
  );
}

/**
 * The operator's version: everything the chip says, plus the working.
 *
 * On the public page the terms sit behind a disclosure, which is right for a
 * reader who has already been given the finding's own caveat in the sentence
 * they just read. It is wrong here. This is the screen where somebody decides
 * whether the claim gets published, and the single most useful thing they can
 * learn — that the whole finding rests on one common word — must not be one
 * click away. Nothing here is a `<details>`.
 *
 * The score is shown beside the band because the band is derived from it, and an
 * operator who can see both can tell a 0.5 that landed `moderate` from a 1.0
 * that landed there on a single long term.
 */
export function MatchQualityPanel({
  match,
  recipientMatch,
  recipientName,
  entityDecision,
  testId = "match-quality",
}: {
  match: StoredNameMatch;
  recipientMatch?: StoredNameMatch;
  recipientName?: string;
  /** The operator judgement in force on this pair now, if there is one. */
  entityDecision?: StoredEntityDecision | null;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      data-band={match.band}
      className="mt-4 border border-rule bg-paper-sunk px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-sm">What this rests on</span>
        <MatchConfidenceChip match={match} testId={`${testId}-chip`} />
        <span data-testid={`${testId}-score`} className="figure text-[11.5px] text-muted">
          score {match.score.toFixed(2)}
        </span>
        {recipientMatch && (
          <span className="text-[11.5px] text-muted">
            recipient name: {BAND_LABEL[recipientMatch.band].toLowerCase()}
          </span>
        )}
      </div>

      <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 text-[12.5px]">
        <TermList
          label="Donor terms found"
          terms={match.matchedTerms}
          tone="text-ink"
          testId={`${testId}-matched`}
        />
        <TermList
          label="Donor terms not found"
          terms={match.unmatchedTerms}
          tone="text-ink-soft"
          testId={`${testId}-unmatched`}
        />
        <TermList
          label="Terms ignored"
          terms={match.discardedTerms}
          tone="text-muted"
          testId={`${testId}-discarded`}
        />
        {recipientName !== undefined && (
          <>
            <dt className="text-muted">Recipient name</dt>
            <dd className="m-0 break-words font-mono tabular text-ink-soft">{recipientName}</dd>
          </>
        )}
      </dl>

      <p className="mt-2.5 max-w-prose text-[12.5px] leading-relaxed text-muted">
        Terms that name a kind of organisation — company, union, committee, foundation,
        association and the rest — are ignored before matching, so the same name is treated
        identically whoever filed it.
      </p>

      {entityDecision && (
        <p
          data-testid={`${testId}-entity-decision`}
          className="mt-2.5 border-l-2 border-ink px-3 py-1.5 text-[12.5px] leading-relaxed text-ink-soft"
        >
          An operator has judged this donor and this agenda subject to be{" "}
          <strong className="font-semibold text-ink">the same entity</strong>
          {entityDecision.operatorEmail ? ` — ${entityDecision.operatorEmail}` : ""}.{" "}
          {entityDecision.reason} This is a person&rsquo;s judgement about two names, and it
          neither publishes this finding nor makes the match a verified identity.
        </p>
      )}
    </section>
  );
}
