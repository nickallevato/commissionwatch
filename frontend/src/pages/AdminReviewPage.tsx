import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DisputeQueue } from "@/components/DisputeQueue";
import { FlagBar, PressroomCard, SegmentedControl, WorkTitle } from "@/components/PressroomUI";
import { MatchQualityPanel } from "@/components/officials/MatchQuality";
import { BAND_SHORT_LABEL } from "@/components/officials/matchBands";
import { severityLabels, severityOrder } from "@/components/severity";
import type {
  AnomalySeverity,
  EntityResolutionDecision,
  FindingCitation,
  NameMatchBand,
  ReviewQueueItem,
  ReviewQueueResponse,
  ReviewQueueSort,
  ReviewRequestStatus,
} from "@/types";
import { formatTimestamp } from "@/lib/dates";

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
 *
 * **The match quality is above the buttons too, and it is not a footnote.** A
 * `vote_donor_conflict` rests on a fuzzy name match. The public officials page
 * has always rendered how uncertain that is — a band, in the same visual weight
 * as a severity pill, carrying "not a verified identity" inside the chip. This
 * screen rendered none of it, which meant the person deciding whether to publish
 * a claim knew less about it than the person who would read it. That is
 * backwards, and `MatchQualityPanel` — the same component, sharing the same
 * labels — is the fix. Unlike the public page it is not behind a disclosure:
 * this is the screen where the single most useful fact about a finding may be
 * that it rests on one common word, and that must not be one click away.
 *
 * **The weak-match policy is stated, not implied.** A weak match is dropped at
 * detection and never reaches this queue. The sentence saying so is rendered
 * verbatim from `match_policy.statement`, so the screen and the detector cannot
 * drift into describing the same rule differently.
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

/**
 * The band filter. `all` is first because it is the working default — an
 * operator should meet the whole queue unless they have chosen not to.
 *
 * `weak` is offered even though the policy keeps weak matches out of the queue.
 * A queue that can contain one — a finding raised before the threshold existed,
 * or by a path that does not go through it — must be reachable, and a filter
 * that returns nothing is a truthful answer to "is there anything weak in
 * here?". Hiding the option would make that question unaskable.
 */
const BAND_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "weak", label: BAND_SHORT_LABEL.weak },
  { value: "moderate", label: BAND_SHORT_LABEL.moderate },
  { value: "strong", label: BAND_SHORT_LABEL.strong },
];

const SORTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "default", label: "Overdue first" },
  { value: "weakest_first", label: "Weakest match first" },
];

function isBand(value: string): value is NameMatchBand {
  return value === "weak" || value === "moderate" || value === "strong";
}

function isSeverity(value: string): value is AnomalySeverity {
  return (severityOrder as readonly string[]).includes(value);
}

function severityLabel(value: string): string {
  return isSeverity(value) ? severityLabels[value] : value;
}

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return formatTimestamp(value);
}

/**
 * Hours since an ISO instant, floored, or `null` for a timestamp that does not
 * parse. Arithmetic on an instant, not a calendar rendering — `lib/dates.ts`
 * carries no duration formatter, so this stays local to the page, matching the
 * precedent `AdminSourcesPage.tsx`'s `agoLabel` set.
 */
function hoursSince(iso: string, nowMs: number): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 3_600_000));
}

function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

type LoadResult = { ok: true; body: ReviewQueueResponse } | { ok: false };

export function AdminReviewPage() {
  const [tab, setTab] = useState<ReviewTab>("findings");
  const [status, setStatus] = useState<ReviewRequestStatus>("pending_review");
  const [band, setBand] = useState<"all" | NameMatchBand>("all");
  const [sort, setSort] = useState<ReviewQueueSort>("default");
  const [listing, setListing] = useState<ReviewQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  /**
   * When this round of data was read. Doubles as "now" for every finding's
   * age-against-window figure, so they never drift against each other or
   * against a live clock mid-render — the same reasoning `AdminSourcesPage`
   * gives for its own `readAt`.
   */
  const [readAt, setReadAt] = useState<number | null>(null);

  // Fetching and applying are separated so the effect can await the request and
  // touch state only in the continuation — an effect body that calls setState
  // synchronously causes a cascading render, and a fast unmount would set state
  // on a component that is already gone.
  const fetchQueue = useCallback(async (): Promise<LoadResult> => {
    const params = new URLSearchParams({ status, sort });
    if (band !== "all") params.set("band", band);
    try {
      const res = await fetch(`/api/admin/review/queue?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as ReviewQueueResponse };
    } catch {
      return { ok: false };
    }
  }, [band, sort, status]);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setListing(result.body);
      setError("");
    } else {
      setError("The review queue could not be loaded.");
    }
    setReadAt(Date.now());
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

  /**
   * The operator's answer to the question the matcher cannot answer.
   *
   * Deliberately neither an approval nor a rejection, and the notice says so:
   * recording that two names denote the same entity does not publish anything,
   * and recording that they do not does not reject this finding. Both are
   * judgements about a pair of names that outlive this finding, which is the
   * whole point — the same pair comes back every sweep.
   */
  async function judge(item: ReviewQueueItem, decision: EntityResolutionDecision) {
    const flagId = item.finding.id;
    const reason = (reasonById[flagId] ?? "").trim();
    if (reason === "") {
      setNotice("A judgement about two names needs a stated reason.");
      return;
    }
    setBusy(flagId);
    setNotice("");
    const ok = await post(`/api/admin/review/queue/${flagId}/entity-resolution`, {
      decision,
      reason,
    });
    if (ok) {
      setNotice(
        decision === "same_entity"
          ? "Recorded: same entity. This finding is still held — judging is not approving."
          : "Recorded: different entities. This pair will not be raised again. This finding is still held; reject it to close it.",
      );
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
  // `readAt` is set in the same call that clears `loading`, so by the time any
  // card below renders it is never null — the fallback keeps this a pure
  // expression rather than a `Date.now()` call during render.
  const nowMs = readAt ?? 0;

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

      {/* The policy, in the project's own words rather than this page's
        paraphrase of them. Rendered whether or not anything below it is a
        name-match finding: an operator is entitled to know what is *not* in
        this queue, and an empty queue with no explanation reads as "nothing
        matched" when the truth may be "something matched and we decided it did
        not count". */}
      {listing && (
        <div className="mt-6">
          <FlagBar label="What a match is worth" tone="warn" testId="match-policy">
            {listing.match_policy.statement}
          </FlagBar>
        </div>
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

      {/* Working the queue by how much a claim rests on, rather than meeting
        the ambiguous ones at random halfway down a list. */}
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <span className="label-sm">Name match</span>
          <div className="mt-1.5">
            <SegmentedControl
              name="band"
              label="Filter by name-match band"
              options={BAND_FILTERS}
              value={band}
              onChange={(value) => {
                setLoading(true);
                setBand(value === "all" || !isBand(value) ? "all" : value);
              }}
            />
          </div>
        </div>
        <div>
          <span className="label-sm">Order</span>
          <div className="mt-1.5">
            <SegmentedControl
              name="sort"
              label="Order the queue"
              options={SORTS}
              value={sort}
              onChange={(value) => {
                setLoading(true);
                setSort(value === "weakest_first" ? "weakest_first" : "default");
              }}
            />
          </div>
        </div>
        {listing && (
          <p data-testid="band-counts" className="text-[12.5px] text-muted">
            Awaiting review:{" "}
            <span className="tabular">{listing.band_counts.weak}</span> weak ·{" "}
            <span className="tabular">{listing.band_counts.moderate}</span> possible ·{" "}
            <span className="tabular">{listing.band_counts.strong}</span> close ·{" "}
            <span className="tabular">{listing.band_counts.unbanded}</span> not a name match
          </p>
        )}
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

                {/* Above the buttons, never behind a disclosure. See the
                  header: an operator should be able to see that a finding
                  rests on one common word and refuse it without opening
                  anything. */}
                {item.evidence && (
                  <MatchQualityPanel
                    match={item.evidence.donorMatch}
                    recipientMatch={item.evidence.recipientMatch}
                    recipientName={item.evidence.contributions[0]?.recipientName}
                    entityDecision={item.entity_decision}
                    testId={`match-quality-${flagId}`}
                  />
                )}

                <p className="mt-2 label-sm">
                  {item.context.jurisdiction_name ?? "No jurisdiction"} ·{" "}
                  {item.context.commission_name ?? "No commission"} · raised{" "}
                  {formatStamp(item.finding.created_at)} · window closes{" "}
                  {formatStamp(item.request.expires_at)}
                </p>

                {/* Rule 6: an age without its expectation is not checkable.
                  "31 h" alone says nothing; against the policy's own window it
                  is a fact an operator can act on. */}
                {listing &&
                  (() => {
                    const hours = hoursSince(item.finding.created_at, nowMs);
                    if (hours === null) return null;
                    return (
                      <p
                        data-testid={`age-${flagId}`}
                        className="mt-1 text-[12.5px] text-ink-soft"
                      >
                        <span
                          className={`figure ${
                            item.request.overdue ? "font-semibold text-accent" : "text-ink"
                          }`}
                        >
                          {hours} h
                        </span>{" "}
                        against a{" "}
                        <span className="figure text-ink">{listing.policy.review_window_hours} h</span>{" "}
                        window
                      </p>
                    );
                  })()}

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

                    {/* Separated from the three decisions above by its own
                      heading, because it is not a fourth decision about this
                      finding. It is a judgement about two names that outlives
                      this finding and is reused on the next sweep. */}
                    {item.evidence && (
                      <div
                        data-testid={`entity-resolution-${flagId}`}
                        className="border-t border-rule pt-3"
                      >
                        <p className="max-w-prose text-[12.5px] leading-relaxed text-muted">
                          Are the donor and the subject of this agenda item the same entity?
                          Answering records your judgement against this pair of names and reuses
                          it on later sweeps. It publishes nothing: this finding stays held
                          either way.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy === flagId}
                            onClick={() => void judge(item, "same_entity")}
                            className={`${secondaryButtonClass} ${focusRing}`}
                          >
                            Same entity
                          </button>
                          <button
                            type="button"
                            disabled={busy === flagId}
                            onClick={() => void judge(item, "different_entity")}
                            className={`${secondaryButtonClass} ${focusRing}`}
                          >
                            Different entities
                          </button>
                        </div>
                      </div>
                    )}
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
