import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DisputeQueue } from "@/components/DisputeQueue";
import { PressroomCard, WorkTitle } from "@/components/PressroomUI";
import { severityLabels, severityOrder } from "@/components/severity";
import type {
  AnomalySeverity,
  FindingCitation,
  ReviewQueueItem,
  ReviewQueueResponse,
  ReviewRequestStatus,
} from "@/types";

/**
 * `/admin/review` — the operator queue. B-a.
 *
 * This is the only screen in the product from which a generated claim about a
 * named person becomes public, so three things about it are deliberate.
 *
 * **The evidence is above the buttons, not behind a disclosure.** Every finding
 * renders its citations — the stored artifacts it rests on, by hash, with the
 * document each came from — between the claim and the decision. An operator who
 * has to click to see what a claim is founded on is an operator who will
 * eventually not click.
 *
 * **A finding with no citation shows the refusal in place of the approve
 * button.** The API enforces it either way; showing it here means the operator
 * learns why from the screen rather than from a 409.
 *
 * **There is no bulk action.** Approving in a batch is approving without
 * reading, on the one screen whose whole purpose is that somebody read it.
 *
 * **B3's disputes are the second tab, not a second console.** A dispute is a
 * stranger's contest of a record rather than a claim this project makes, so it
 * gets its own tab, its own two decisions and its own explanation — but the
 * same screen and the same audit log, because an operator should have one place
 * they review things. The tab strip is the whole of the shared chrome; nothing
 * below it is shared, and `DisputeQueue` says why.
 */

type ReviewTab = "findings" | "disputes";

const TAB_LABEL: Record<ReviewTab, string> = {
  findings: "Findings",
  disputes: "Disputes",
};

const TABS: readonly ReviewTab[] = ["findings", "disputes"];

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonClass =
  "border border-ink bg-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const secondaryButtonClass =
  "border border-rule px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink disabled:opacity-50";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

const STATUS_LABEL: Record<ReviewRequestStatus, string> = {
  pending_review: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
};

const CITATION_LABEL: Record<FindingCitation["kind"], string> = {
  flag_artifact: "The document this finding is about",
  metadata_sha256: "Cited by the detector",
  meeting_document: "Stored document for this meeting",
};

const STATUSES: readonly ReviewRequestStatus[] = ["pending_review", "approved", "rejected"];

function isSeverity(value: string): value is AnomalySeverity {
  return (severityOrder as readonly string[]).includes(value);
}

function severityLabel(value: string): string {
  return isSeverity(value) ? severityLabels[value] : value;
}

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

type LoadResult = { ok: true; body: ReviewQueueResponse } | { ok: false };

export function AdminReviewPage() {
  const [tab, setTab] = useState<ReviewTab>("findings");
  const [status, setStatus] = useState<ReviewRequestStatus>("pending_review");
  const [listing, setListing] = useState<ReviewQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});

  // Fetching and applying are separated so the effect can await the request and
  // touch state only in the continuation — an effect body that calls setState
  // synchronously causes a cascading render, and a fast unmount would set state
  // on a component that is already gone.
  const fetchQueue = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch(`/api/admin/review/queue?status=${status}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as ReviewQueueResponse };
    } catch {
      return { ok: false };
    }
  }, [status]);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setListing(result.body);
      setError("");
    } else {
      setError("The review queue could not be loaded.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    // No `setLoading(true)` here: a setState in an effect body causes a
    // cascading render, and the lint rule that catches it is not one to
    // silence. Switching tabs sets it from the click handler instead, which is
    // where the state change actually originates.
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

  async function post(path: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        // Verbatim. The API's refusals say exactly what is wrong — "cites no
        // stored artifact", "never the motive" — and paraphrasing one here
        // would be a second thing to debug.
        setNotice(payload?.error ?? "The decision could not be recorded.");
        return false;
      }
      return true;
    } catch {
      setNotice("The decision could not be sent.");
      return false;
    }
  }

  async function decide(item: ReviewQueueItem, decision: "approve" | "reject") {
    const flagId = item.finding.id;
    const reason = (reasonById[flagId] ?? "").trim();
    if (reason === "") {
      setNotice("A decision needs a stated reason.");
      return;
    }
    setBusy(flagId);
    setNotice("");
    const ok = await post(`/api/admin/review/queue/${flagId}/${decision}`, { reason });
    if (ok) {
      setNotice(
        decision === "approve"
          ? "Approved and published. The decision is in the correction log."
          : "Rejected. The finding stays held and cannot be published.",
      );
      setReasonById((current) => ({ ...current, [flagId]: "" }));
      await reload();
    }
    setBusy("");
  }

  async function saveEdit(item: ReviewQueueItem) {
    const flagId = item.finding.id;
    const reason = (reasonById[flagId] ?? "").trim();
    const draft = draftById[flagId] ?? item.finding.description;
    if (reason === "") {
      setNotice("An edit needs a stated reason.");
      return;
    }
    setBusy(flagId);
    setNotice("");
    const ok = await post(`/api/admin/review/queue/${flagId}/edit`, {
      field: "description",
      new_value: draft,
      reason,
    });
    if (ok) {
      setNotice("Edited. The previous wording is in the correction log.");
      await reload();
    }
    setBusy("");
  }

  const items = listing?.data ?? [];

  return (
    <>
      <WorkTitle
        title="Review queue"
        stamp={listing ? `${listing.counts.pending} pending · ${listing.counts.overdue} overdue` : undefined}
      />

      {/* The whole of the shared chrome. Everything below it is per tab, and
        that is the point: the two objects want different handling, and a
        screen that treated them the same would be the defect. */}
      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Review queue">
        {TABS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={tab === option}
            onClick={() => setTab(option)}
            className={`border-b-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-label ${focusRing} ${
              tab === option
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {TAB_LABEL[option]}
          </button>
        ))}
      </div>

      {tab === "disputes" ? (
        <DisputeQueue />
      ) : (
        <>
      <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
        Nothing naming a person publishes itself. A finding here is real, stored
        and citable, and absent from every public response until someone named
        approves it with a stated reason. Rejecting one leaves it held — there is
        no state in which a refused finding can be published.
      </p>

      {listing && (
        <dl className="mt-6 grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="label-sm">Awaiting review</dt>
            <dd className="mt-1 figure text-lg text-ink">{listing.counts.pending}</dd>
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
        </dl>
      )}

      {listing && (
        <p className="mt-4 text-sm text-muted">
          Findings at{" "}
          <strong className="font-semibold text-ink">
            {severityLabel(listing.policy.hold_at_or_above).toLowerCase()}
          </strong>{" "}
          severity or above wait for an operator; below it they publish. The
          review window is {listing.policy.review_window_hours} hours — past it a
          request reads overdue and stays held. An expired request publishes
          nothing.
        </p>
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
            className={`${
              status === option ? buttonClass : secondaryButtonClass
            } ${focusRing}`}
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
        <p role="status" className="mt-6 border-l-2 border-ink bg-paper px-4 py-3 text-sm text-ink-soft">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading queue…
        </p>
      ) : items.length === 0 ? (
        <PressroomCard className="mt-8">
          <p className="text-sm text-muted">
            {status === "pending_review"
              ? "No finding is waiting for review."
              : `No finding has been ${status === "approved" ? "approved" : "rejected"}.`}
          </p>
        </PressroomCard>
      ) : (
        <div className="mt-8 space-y-6">
          {items.map((item) => {
            const flagId = item.finding.id;
            const pending = item.request.status === "pending_review";
            const citable = item.citations.length > 0;
            return (
              <PressroomCard key={flagId}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="label-sm">{severityLabel(item.finding.severity)}</span>
                  <span className="label-sm">{item.finding.flag_type.replace(/_/g, " ")}</span>
                  <span className="label-sm">{STATUS_LABEL[item.request.status]}</span>
                  {item.request.overdue && (
                    <span
                      data-testid={`overdue-${flagId}`}
                      className="text-[11px] font-semibold uppercase tracking-label text-accent"
                    >
                      Overdue · still held
                    </span>
                  )}
                </div>

                <p className="mt-3 max-w-prose text-base leading-relaxed text-ink">
                  {item.finding.description}
                </p>

                <p className="mt-2 label-sm">
                  {item.context.jurisdiction_name ?? "No jurisdiction"} ·{" "}
                  {item.context.commission_name ?? "No commission"} · raised{" "}
                  {formatStamp(item.finding.created_at)} · window closes{" "}
                  {formatStamp(item.request.expires_at)}
                </p>

                {item.finding.meeting_id && (
                  <p className="mt-2">
                    <Link
                      to={`/admin/meetings/${item.finding.meeting_id}`}
                      className={`text-sm text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
                    >
                      Open the meeting record
                    </Link>
                  </p>
                )}

                <h3 className="mt-6 font-display text-base font-semibold text-ink">
                  What this rests on
                </h3>
                {citable ? (
                  <ul className="mt-2 divide-y divide-rule border-y border-rule">
                    {item.citations.map((citation) => (
                      <li key={`${citation.artifact_id}:${citation.kind}`} className="py-3">
                        <p className="label-sm">{CITATION_LABEL[citation.kind]}</p>
                        <p className="mt-1 font-mono text-xs text-ink">
                          sha256 {shortHash(citation.sha256)}… ·{" "}
                          <span className="tabular">{citation.byte_size}</span> bytes
                        </p>
                        <p className="mt-1 text-sm text-ink-soft">
                          {citation.document_title ?? "Not attached to a listed document"}
                          {citation.version_no === null ? "" : ` · version ${citation.version_no}`}
                        </p>
                        {citation.source_url && (
                          <p className="mt-1 break-words font-mono text-xs text-muted">
                            {citation.source_url}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p
                    data-testid={`unsourced-${flagId}`}
                    className="mt-2 border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
                  >
                    This finding cites no stored artifact, so it cannot be
                    approved. No unsourced claim reaches the public site.
                  </p>
                )}

                {pending ? (
                  <div className="mt-6 space-y-3">
                    <label className="block">
                      <span className="label-sm">Reason</span>
                      <textarea
                        rows={2}
                        value={reasonById[flagId] ?? ""}
                        onChange={(event) =>
                          setReasonById((current) => ({
                            ...current,
                            [flagId]: event.target.value,
                          }))
                        }
                        className={`${fieldClass} ${focusRing}`}
                        aria-label={`Reason for ${flagId}`}
                      />
                    </label>

                    <label className="block">
                      <span className="label-sm">Description</span>
                      <textarea
                        rows={3}
                        value={draftById[flagId] ?? item.finding.description}
                        onChange={(event) =>
                          setDraftById((current) => ({
                            ...current,
                            [flagId]: event.target.value,
                          }))
                        }
                        className={`${fieldClass} ${focusRing}`}
                        aria-label={`Description for ${flagId}`}
                      />
                    </label>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy === flagId || !citable}
                        onClick={() => void decide(item, "approve")}
                        className={`${buttonClass} ${focusRing}`}
                      >
                        Approve and publish
                      </button>
                      <button
                        type="button"
                        disabled={busy === flagId}
                        onClick={() => void decide(item, "reject")}
                        className={`${secondaryButtonClass} ${focusRing}`}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={busy === flagId}
                        onClick={() => void saveEdit(item)}
                        className={`${secondaryButtonClass} ${focusRing}`}
                      >
                        Save edit
                      </button>
                    </div>
                  </div>
                ) : (
                  <dl className="mt-6 grid gap-4 sm:grid-cols-3">
                    <div>
                      <dt className="label-sm">Decided by</dt>
                      <dd className="mt-1 text-sm text-ink">
                        {item.request.reviewer_email ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="label-sm">Decided</dt>
                      <dd className="mt-1 text-sm text-ink tabular">
                        {formatStamp(item.request.reviewed_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="label-sm">Reason</dt>
                      <dd className="mt-1 text-sm text-ink">
                        {item.request.review_comment ?? "Not recorded"}
                      </dd>
                    </div>
                  </dl>
                )}
              </PressroomCard>
            );
          })}
        </div>
      )}
        </>
      )}
    </>
  );
}
