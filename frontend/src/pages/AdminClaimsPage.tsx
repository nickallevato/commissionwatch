import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FlagBar, PressroomCard, WorkTitle } from "@/components/PressroomUI";
import { Absence } from "@/components/ui/Absence";
import { Citation, ReviewStamp } from "@/components/ui/Citation";
import { abbreviateSha } from "@/components/ui/citation-source";
import type { ClaimQueueResponse, ClaimQueueStatus, ClaimQuoteContext, ClaimReviewItem } from "@/types";

/**
 * `/admin/claims` — the screen `minute_claims` waited for.
 *
 * Migration 072 shipped a table with a `status` nothing ever wrote, so every
 * extracted claim sat `held` forever and no operator could approve one. The
 * backend's half landed in `services/review/claims.ts`; this is the other half,
 * and four things about it are decisions rather than layout.
 *
 * **The quote is shown in its artifact context, with the span marked.** ±500
 * characters, above the buttons, never behind a disclosure. An operator
 * approving a sentence they cannot see in situ is rubber-stamping, and this is
 * the single most important element on the page. When the context cannot be
 * loaded the screen says so instead of quietly rendering a shorter card.
 *
 * **The sentence shown is `render.text`, from the backend.** Approval pins
 * exact bytes: the string, its sha256 and the render version. The published
 * sentence is a function of the claim's three fields *and* of a label map *and*
 * of a template, so a console that assembled its own version from the triple
 * would be asking an operator to approve something adjacent to what publishes.
 * There is no template in this file for that reason.
 *
 * **There is no bulk approve, and no select-all.** A screen that approves forty
 * claims in one click publishes forty unread sentences about named people. If
 * throughput becomes the binding constraint the answer is a better
 * single-claim screen. The API takes one id per call and this page has one
 * button per claim.
 *
 * **A refusal is shown, not hidden.** `render.approvable` disables the approve
 * button and `render.blocked_reason` is rendered in place beside it — in the
 * backend's own words, because paraphrasing "the bytes this claim cites are not
 * stored" into "cannot approve" gives the operator a dead button and no way to
 * fix it.
 *
 * It follows `AdminReviewPage`'s idiom deliberately: same card, same reason
 * box, same verbatim API refusals. The two queues are one job — deciding
 * whether something naming a person becomes public — and an operator should not
 * have to learn a second product to do the second half of it.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonClass =
  "border border-ink bg-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const secondaryButtonClass =
  "border border-rule px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink disabled:opacity-50";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

const STATUSES: readonly ClaimQueueStatus[] = ["held", "approved", "rejected"];

const STATUS_LABEL: Record<ClaimQueueStatus, string> = {
  held: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
};

/** What an empty queue means, per filter. Never a bare "nothing here". */
const EMPTY_SUBJECT: Record<ClaimQueueStatus, string> = {
  held: "claims awaiting review",
  approved: "approved claims",
  rejected: "rejected claims",
};

/**
 * What a row is, in the operator's words.
 *
 * `minute_claims.status` stays `approved` after a retraction — the wall is
 * `approved AND retracted_at IS NULL` — so the column alone would label a
 * withdrawn claim as published.
 */
function statusChip(status: string, retractedAt: string | null): string {
  if (retractedAt !== null) return "Withdrawn";
  if (status === "held") return STATUS_LABEL.held;
  if (status === "approved") return STATUS_LABEL.approved;
  if (status === "rejected") return STATUS_LABEL.rejected;
  return status;
}

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/**
 * The window of document text with the quote marked.
 *
 * The offsets index the window, not the document — the backend has already
 * sliced it. They are checked rather than trusted: a span that does not fall
 * inside the text it is supposed to index would otherwise mark an arbitrary
 * run of characters, which is worse than marking none, because the operator
 * would read the highlight as the quote and approve on it.
 *
 * The text came out of a third-party PDF. It renders as React text nodes and
 * there is no `dangerouslySetInnerHTML` anywhere near it.
 */
function QuoteInContext({ context, claimId }: { context: ClaimQuoteContext; claimId: string }) {
  const usable =
    context.quote_start >= 0 &&
    context.quote_end > context.quote_start &&
    context.quote_end <= context.text.length;

  return (
    <div className="mt-2">
      <p className="text-xs text-muted">
        Characters <span className="figure">{context.window_offset.toLocaleString("en-US")}</span>
        {" to "}
        <span className="figure">
          {(context.window_offset + context.text.length).toLocaleString("en-US")}
        </span>{" "}
        of the stored document.
        {!context.offset_matches_stored && (
          <>
            {" "}
            The quote was found by searching the text, not at the offset stored with the claim, so
            the two disagree about where it is.
          </>
        )}
      </p>
      <p
        data-testid={`quote-context-${claimId}`}
        className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words border border-rule bg-paper p-3 font-mono text-xs leading-relaxed text-ink"
      >
        {usable ? (
          <>
            {context.text.slice(0, context.quote_start)}
            <mark data-testid={`quote-span-${claimId}`} className="bg-accent/20 text-ink">
              {context.text.slice(context.quote_start, context.quote_end)}
            </mark>
            {context.text.slice(context.quote_end)}
          </>
        ) : (
          context.text
        )}
      </p>
      {!usable && (
        <p className="mt-2 text-xs text-ink-soft">
          The quote span does not fall inside this window, so nothing is marked. Read the document
          before deciding.
        </p>
      )}
    </div>
  );
}

type LoadResult = { ok: true; body: ClaimQueueResponse } | { ok: false };

type ClaimDecision = "approve" | "reject" | "retract";

const DECIDED: Record<ClaimDecision, string> = {
  approve: "Approved and published. The decision is in the correction log.",
  reject: "Rejected. This claim can never publish.",
  retract:
    "Withdrawn. The meeting page now shows a tombstone at the same anchor saying what it read.",
};

export function AdminClaimsPage() {
  const [status, setStatus] = useState<ClaimQueueStatus>("held");
  const [listing, setListing] = useState<ClaimQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  // Fetching and applying are separated for the reason AdminReviewPage gives:
  // an effect body that calls setState synchronously causes a cascading render,
  // and a fast unmount would set state on a component that is already gone.
  const fetchQueue = useCallback(async (): Promise<LoadResult> => {
    const params = new URLSearchParams({ status });
    try {
      const res = await fetch(`/api/admin/claims/queue?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as ClaimQueueResponse };
    } catch {
      return { ok: false };
    }
  }, [status]);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setListing(result.body);
      setError("");
    } else {
      setError("The claims queue could not be loaded.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchQueue();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchQueue]);

  async function reload() {
    applyResult(await fetchQueue());
  }

  /**
   * One claim, one call. The reason is checked here as well as by the API,
   * which 400s without one — a form that let an operator press a button and
   * receive an error it could have prevented is a form that trains them to
   * ignore errors.
   */
  async function decide(item: ClaimReviewItem, decision: ClaimDecision) {
    const claimId = item.claim.id;
    const reason = (reasonById[claimId] ?? "").trim();
    if (reason === "") {
      setNotice("A decision needs a stated reason.");
      return;
    }
    setBusy(claimId);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/claims/${claimId}/${decision}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        // Verbatim. The API's refusals say exactly what is wrong — "no
        // unsourced claim reaches the public site", "never the motive" — and a
        // paraphrase here would be a second thing to debug.
        setNotice(payload?.error ?? "The decision could not be recorded.");
      } else {
        setNotice(DECIDED[decision]);
        setReasonById((current) => ({ ...current, [claimId]: "" }));
        await reload();
      }
    } catch {
      setNotice("The decision could not be sent.");
    }
    setBusy("");
  }

  const items = listing?.data ?? [];

  return (
    <>
      <WorkTitle
        title="Claims"
        stamp={
          listing
            ? `${listing.counts.held} awaiting review · ${listing.counts.overdue} overdue`
            : undefined
        }
      />

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
        A claim is one sentence about one named person, assembled by code from
        the record and a quote of it. Nothing here publishes itself. Approving
        one pins the exact sentence you read below — if what this site would
        render ever stops matching it, the claim is withheld rather than
        re-rendered.
      </p>

      {listing && (
        <dl className="mt-6 grid gap-4 sm:grid-cols-5">
          <div>
            <dt className="label-sm">Awaiting review</dt>
            <dd className="mt-1 figure text-lg text-ink">{listing.counts.held}</dd>
          </div>
          <div>
            <dt className="label-sm">Overdue</dt>
            <dd
              data-testid="overdue-count"
              className={`mt-1 figure text-lg ${
                listing.counts.overdue > 0 ? "text-accent" : "text-ink"
              }`}
            >
              {listing.counts.overdue}
            </dd>
          </div>
          <div>
            <dt className="label-sm">Approved</dt>
            <dd className="mt-1 figure text-lg text-ink">{listing.counts.approved}</dd>
          </div>
          <div>
            <dt className="label-sm">Rejected</dt>
            <dd className="mt-1 figure text-lg text-ink">{listing.counts.rejected}</dd>
          </div>
          <div>
            <dt className="label-sm">Withdrawn</dt>
            <dd className="mt-1 figure text-lg text-ink">{listing.counts.retracted}</dd>
          </div>
        </dl>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {STATUSES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setLoading(true);
              setStatus(option);
            }}
            aria-pressed={status === option}
            className={`${status === option ? buttonClass : secondaryButtonClass} ${focusRing}`}
          >
            {STATUS_LABEL[option]}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-6 border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="mt-6 border-l-2 border-ink bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading claims…
        </p>
      ) : items.length === 0 ? (
        <Absence reason="none-exist" subject={EMPTY_SUBJECT[status]} />
      ) : (
        <div className="mt-8 space-y-6">
          {items.map((item) => {
            const claim = item.claim;
            const claimId = claim.id;
            const held = claim.status === "held";
            const retractable = claim.status === "approved" && claim.retracted_at === null;
            const pin = item.render.pin;

            return (
              <PressroomCard key={claimId}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="label-sm">{claim.subject_name}</span>
                  <span className="label-sm">{claim.action.replace(/_/g, " ")}</span>
                  {/* The claim's own status, not the filter's. A retracted
                    claim is still `approved` in the column, and a chip reading
                    the filter would call it published. */}
                  <span className="label-sm">{statusChip(claim.status, claim.retracted_at)}</span>
                  {claim.overdue && (
                    <span
                      data-testid={`overdue-${claimId}`}
                      className="text-[11px] font-semibold uppercase tracking-label text-accent"
                    >
                      Overdue · still held
                    </span>
                  )}
                </div>

                <p className="mt-2 label-sm">
                  {item.context.jurisdiction_name ?? "No jurisdiction"} ·{" "}
                  {item.context.commission_name ?? "No commission"} · meeting of{" "}
                  {item.context.meeting_date ? item.context.meeting_date.slice(0, 10) : "unknown"} ·
                  extracted {formatStamp(claim.created_at)}
                </p>

                <h3 className="mt-6 font-display text-base font-semibold text-ink">
                  The sentence that would publish
                </h3>
                {/* `render.text`, from the API. This is the string approval
                  pins; assembling one here from the subject and the action
                  would pin bytes nobody read. */}
                {item.render.text ? (
                  <p
                    data-testid={`render-text-${claimId}`}
                    className="mt-2 max-w-prose border-l-2 border-ink pl-4 text-base leading-relaxed text-ink"
                  >
                    {item.render.text}
                  </p>
                ) : (
                  <p
                    data-testid={`render-text-${claimId}`}
                    className="mt-2 max-w-prose text-sm text-ink-soft"
                  >
                    This claim renders no sentence, so there is nothing to approve.
                  </p>
                )}
                <p className="mt-1 text-xs text-muted">
                  Rendered by <span className="font-mono">{item.render.version}</span>
                  {item.render.sha256 && (
                    <>
                      {" · "}
                      <span className="font-mono" title={item.render.sha256}>
                        {abbreviateSha(item.render.sha256)}
                      </span>
                    </>
                  )}
                </p>

                {/* The pin, broken. Not a warning about a formatting drift: the
                  claim is withheld from every reader until someone reads the
                  new sentence, and the operator is the someone. */}
                {pin?.state === "awaiting_re_review" && (
                  <div className="mt-4" data-testid={`awaiting-re-review-${claimId}`}>
                    <FlagBar label="Awaiting re-review" tone="warn">
                      This claim was approved and is not being published. {pin.reason}. It stays
                      withheld until someone reads the sentence above and approves it again.
                    </FlagBar>
                  </div>
                )}

                <h3 className="mt-6 font-display text-base font-semibold text-ink">
                  The quote, in the document it came from
                </h3>
                <Citation
                  citation={{
                    artifact_sha256: item.citation.artifact_sha256,
                    quote_offset: item.citation.quote_offset,
                    quote: item.citation.quote,
                    source_label: "Stored document",
                    source_url: item.citation.source_url,
                  }}
                />
                {item.citation.context ? (
                  <QuoteInContext context={item.citation.context} claimId={claimId} />
                ) : (
                  <p
                    data-testid={`no-context-${claimId}`}
                    className="mt-2 border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
                  >
                    {item.citation.artifact_stored
                      ? "No extracted text is stored for this document, so the quote cannot be shown in context. Open the source before deciding."
                      : "The bytes this claim cites are not stored, so a reader could not check it."}
                  </p>
                )}

                <p className="mt-3 text-xs text-muted">
                  Extracted by <span className="font-mono">{claim.model}</span> (prompt{" "}
                  <span className="font-mono">{claim.prompt_version}</span>)
                  {" · "}
                  <Link
                    to={`/admin/meetings/${claim.meeting_id}`}
                    className={`underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
                  >
                    Open the meeting record
                  </Link>
                </p>

                {held || retractable ? (
                  <div className="mt-6 space-y-3">
                    <label className="block">
                      <span className="label-sm">Reason</span>
                      <textarea
                        rows={2}
                        value={reasonById[claimId] ?? ""}
                        onChange={(event) =>
                          setReasonById((current) => ({
                            ...current,
                            [claimId]: event.target.value,
                          }))
                        }
                        className={`${fieldClass} ${focusRing}`}
                        aria-label={`Reason for ${claimId}`}
                      />
                    </label>

                    {/* One button per claim, and nothing that acts on a
                      selection. See the header. */}
                    <div className="flex flex-wrap gap-2">
                      {held && (
                        <>
                          <button
                            type="button"
                            disabled={busy === claimId || !item.render.approvable}
                            onClick={() => void decide(item, "approve")}
                            className={`${buttonClass} ${focusRing}`}
                          >
                            Approve and publish
                          </button>
                          <button
                            type="button"
                            disabled={busy === claimId}
                            onClick={() => void decide(item, "reject")}
                            className={`${secondaryButtonClass} ${focusRing}`}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {retractable && (
                        <button
                          type="button"
                          disabled={busy === claimId}
                          onClick={() => void decide(item, "retract")}
                          className={`${secondaryButtonClass} ${focusRing}`}
                        >
                          Withdraw
                        </button>
                      )}
                    </div>

                    {/* In place, in the API's words, never in a tooltip: a
                      disabled button with its reason one hover away is a
                      disabled button with no reason. */}
                    {held && item.render.blocked_reason && (
                      <p
                        data-testid={`blocked-${claimId}`}
                        className="border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
                      >
                        This claim cannot be approved: {item.render.blocked_reason}.
                      </p>
                    )}

                    {item.render.motive_terms.length > 0 && (
                      <p
                        data-testid={`motive-${claimId}`}
                        className="text-sm text-ink-soft"
                      >
                        A claim describes the record, never the motive. The sentence uses:{" "}
                        {item.render.motive_terms.join(", ")}.
                      </p>
                    )}
                  </div>
                ) : (
                  <dl className="mt-6 grid gap-4 sm:grid-cols-3">
                    <div>
                      <dt className="label-sm">Decided</dt>
                      <dd className="mt-1 text-sm text-ink tabular">
                        {formatStamp(claim.reviewed_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="label-sm">Reason</dt>
                      <dd className="mt-1 text-sm text-ink">
                        {claim.review_reason ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="label-sm">Withdrawn because</dt>
                      <dd className="mt-1 text-sm text-ink">
                        {claim.retracted_reason ?? "Not withdrawn"}
                      </dd>
                    </div>
                  </dl>
                )}

                <ReviewStamp
                  approved_at={claim.approved_at}
                  retracted_at={claim.retracted_at}
                />
              </PressroomCard>
            );
          })}
        </div>
      )}
    </>
  );
}
