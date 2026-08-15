import { Link } from "react-router-dom";
import { Absence } from "@/components/ui/Absence";
import { Citation, ReviewStamp } from "@/components/ui/Citation";
import { useMeetingClaims } from "@/hooks/useClaims";

/**
 * The claim cards on a meeting record.
 *
 * A claim is what the minutes say a named person did, with the line that says
 * it, and it is **never its own page** — `docs/superpowers/specs/
 * 2026-08-14-published-claim-design.md` §3. It is addressable at `#claim-{id}`
 * and renders here, inside the record it came from. That is not a routing
 * preference: strip a procedural vote of the meeting it happened in and what
 * remains reads as a dossier entry about a living person. The context is the
 * difference between a record and a charge, so there is no per-claim route to
 * link at and no component here that could be mounted on one.
 *
 * Three things this component must not drop, because each of them is a
 * statement the reader is owed and each would vanish silently:
 *
 * **The sentence is the backend's.** `claim.text` is the string the operator
 * approved, byte for byte, re-rendered and hash-checked by the same code on
 * every read. This component prints it and never assembles one — a card that
 * built its own sentence from a subject and a verb would be publishing text
 * nobody approved.
 *
 * **Tombstones render.** A withdrawn claim shows what it previously said, when,
 * and why. A person named in one generally wants it gone, and the answer is
 * still no: it was published, it is in caches and feeds, and a reader arriving
 * from one of those needs a page saying *that sentence was wrong* rather than a
 * page showing nothing while the cached version stays the only version they
 * ever see. Silence is not a correction.
 *
 * **A withheld claim is stated.** When a pin no longer holds the backend sends
 * a count and no text. The page says a claim is being withheld pending
 * re-review. Omitting it would make a deliberate refusal to publish look like
 * an empty record.
 */

export interface MeetingClaimsProps {
  meetingId: string;
  /** How a reader should refer to the document — "Minutes, 12 March 2026". */
  sourceLabel: string;
}

/**
 * `2026-08-20T12:00:00Z` → `August 20, 2026`, in the site's date style.
 *
 * UTC, not the reader's zone: a retraction is stamped by the server, and
 * rendering it locally would move the date across midnight for half the country
 * and make the same withdrawal read as two different days.
 */
function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function MeetingClaims({ meetingId, sourceLabel }: MeetingClaimsProps) {
  const { data, isLoading, isError } = useMeetingClaims(meetingId);

  const claims = data?.claims ?? [];
  const tombstones = data?.tombstones ?? [];
  const withheld = data?.awaiting_re_review ?? 0;

  return (
    <section aria-labelledby="claims-heading" className="mt-10">
      <div className="rule-hi" />
      <div className="pt-3">
        <span className="kicker">From the minutes</span>
        <h2
          id="claims-heading"
          className="font-display text-2xl leading-headline tracking-headline text-ink"
        >
          What the record says people did
        </h2>
      </div>

      {isLoading ? (
        <p className="mt-4 label-sm" role="status">
          Loading claims…
        </p>
      ) : isError ? (
        <Absence reason="request-failed" subject="Claims from this meeting" />
      ) : (
        <>
          {claims.length === 0 && tombstones.length === 0 && (
            <Absence reason="not-reviewed" subject="claims" />
          )}

          {claims.length > 0 && (
            <div className="mt-4 space-y-8">
              {claims.map((claim) => (
                <article key={claim.id} id={claim.anchor} className="scroll-mt-8">
                  {/* The approved sentence, printed. Not rebuilt from the
                    subject and the action: those three fields are what the
                    sentence was assembled from, and the approval is of the
                    assembled bytes. */}
                  <h3 className="font-sans text-base font-semibold tracking-normal text-ink">
                    {claim.text}
                  </h3>

                  <Citation
                    citation={{
                      artifact_sha256: claim.artifact_sha256,
                      quote_offset: claim.quote_offset,
                      quote: claim.quote,
                      source_label: sourceLabel,
                    }}
                  />

                  <ReviewStamp approved_at={claim.approved_at} />

                  {/* Provenance of the extraction, separate from provenance of
                    the decision above it. A model read the document; a person
                    decided the sentence could publish. Collapsing the two
                    would let a reader think either one did both. */}
                  <p className="mt-1 text-xs text-muted">
                    Extracted by <span className="font-mono">{claim.model}</span> (prompt{" "}
                    <span className="font-mono">{claim.prompt_version}</span>), checked against the
                    stored document.
                  </p>

                  {/* Every published claim carries a way to contest it, so a
                    person named in one is not required to find a contact page.
                    It points at the meeting because `minute_claims` is not yet
                    in the backend's DISPUTABLE_TABLES — and the meeting is
                    where the claim lives, since a claim is never its own page. */}
                  <p className="mt-2 text-sm text-muted">
                    <Link
                      className="cite"
                      to={`/corrections/dispute?table=meetings&id=${meetingId}`}
                    >
                      This is wrong
                    </Link>
                  </p>
                </article>
              ))}
            </div>
          )}

          {tombstones.length > 0 && (
            <div className="mt-8 space-y-6">
              {tombstones.map((tombstone) => (
                <article
                  key={tombstone.id}
                  id={tombstone.anchor}
                  data-testid={`tombstone-${tombstone.id}`}
                  className="scroll-mt-8 border-l-2 border-accent py-1 pl-4"
                >
                  <p className="text-sm font-semibold text-ink">
                    This claim was withdrawn on{" "}
                    <span className="figure">{formatDay(tombstone.retracted_at)}</span>.
                  </p>
                  {tombstone.previous_text && (
                    <p className="mt-1 max-w-prose text-sm text-ink-soft">
                      It previously read: “{tombstone.previous_text}”
                    </p>
                  )}
                  <p className="mt-1 max-w-prose text-sm text-ink-soft">
                    Reason: {tombstone.retracted_reason}
                  </p>
                </article>
              ))}
            </div>
          )}

          {withheld > 0 && (
            <p data-testid="claims-withheld" className="mt-6 max-w-prose text-sm text-ink-soft">
              {withheld === 1
                ? "One claim from this meeting is awaiting re-review and is not shown."
                : `${withheld} claims from this meeting are awaiting re-review and are not shown.`}{" "}
              The sentence this site would render is not the sentence an operator approved, so
              nothing is published until someone reads it again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
