import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FlagBar, PressroomCard, SegmentedControl, WorkTitle } from "@/components/PressroomUI";
import { Absence } from "@/components/ui/Absence";
import { Citation } from "@/components/ui/Citation";
import { PRECISION_GRADES, precisionOf } from "@/components/places/precision";
import { formatCount } from "@/hooks/useSource";
import {
  PLACE_LINK_STATUSES,
  PLACE_SUBJECT_KINDS,
  type PlaceLinkQueueResponse,
  type PlaceLinkReviewItem,
  type PlaceLinkStatus,
  type PlaceQuoteContext,
  type PlacePrecision,
  type PlaceSubjectKind,
} from "@/types";
import { formatTimestamp } from "@/lib/dates";

/**
 * `/admin/place-links` — the screen `place_links` waited for.
 *
 * Migration 094 shipped a `status` defaulting to `held` and nothing ever wrote
 * it, so `wherePlaceLinkPublic` could never match and the public map could only
 * ever be empty. `services/review/place-links.ts` is the backend half; this is
 * the other one, and it deliberately reads like `AdminClaimsPage` — same card,
 * same reason box, same verbatim API refusals — because an operator should not
 * have to learn a second review product to decide the second kind of row.
 *
 * Six things here are decisions rather than layout.
 *
 * **The quote is shown in the line that carries it.** An address is the easiest
 * thing in a document to attach to the wrong item, so the window is above the
 * buttons and never behind a disclosure. When the text is not held the screen
 * says which of the two reasons applies — no stored bytes, or bytes with no
 * extracted text — rather than rendering a shorter card.
 *
 * **The precision is stated in words, next to the coordinate.** Every US Census
 * match is a TIGER address-range interpolation, so `block` is the honest grade
 * and it means the block is right and the building may be a few doors out. The
 * sentence comes from the API's `precision_meaning` — the backend's
 * `PRECISION_MEANING` — rather than from a copy kept here, because a second copy
 * of a rule is a second thing that goes stale.
 *
 * **The coordinate is printed no more finely than its grade supports.** Six
 * decimal places on a block-grade latitude claims a metre nobody surveyed. The
 * number of digits is a function of `PRECISION_GRADES[...].uncertainty_metres`,
 * and a grade this build does not recognise prints at the coarsest setting with
 * that fact stated. There is no map on this screen: a pin would be the same lie
 * drawn larger.
 *
 * **An `inferred` link cannot be approved and can be rejected.** The wall
 * excludes it whatever its status, so `approved` on one would be a row that says
 * published and shows nothing. The approve button is disabled with the API's own
 * refusal beside it; reject stays live, because refusing a lead is a real
 * decision.
 *
 * **A withheld subject does not block approval, and the screen says so.** The
 * wall keeps the pin off the map until the subject goes out. An operator who was
 * not told would approve a link, look at the map, and read the absence as a bug.
 *
 * **Both decisions require a reason, here as well as in the API.** The backend
 * 400s without one. A form that lets an operator press a button and receive an
 * error it could have prevented trains them to ignore errors.
 *
 * There is no bulk approve and there must not be one. Forty pins in one click is
 * forty unread addresses a reader will be told a decision landed on.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonClass =
  "border border-ink bg-ink px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const secondaryButtonClass =
  "border border-rule px-4 py-2 text-[11px] font-semibold uppercase tracking-label text-muted hover:border-ink hover:text-ink disabled:opacity-50";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

/** The filter's own vocabulary. `all` is not a status — it is the absence of the filter. */
type StatusFilter = PlaceLinkStatus | "all";
type KindFilter = PlaceSubjectKind | "all";

const STATUS_LABEL: Record<PlaceLinkStatus, string> = {
  held: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
};

const KIND_LABEL: Record<PlaceSubjectKind, string> = {
  agenda_item: "Agenda item",
  meeting: "Meeting",
  document: "Document",
  finding: "Finding",
};

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  ...PLACE_LINK_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
];

const KIND_OPTIONS = [
  { value: "all", label: "All subjects" },
  ...PLACE_SUBJECT_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
];

/** What an empty queue means, per status filter. Never a bare "nothing here". */
const EMPTY_SUBJECT: Record<StatusFilter, string> = {
  all: "place links",
  held: "place links awaiting review",
  approved: "approved place links",
  rejected: "rejected place links",
};

function isStatusFilter(value: string): value is StatusFilter {
  if (value === "all") return true;
  for (const status of PLACE_LINK_STATUSES) if (status === value) return true;
  return false;
}

function isKindFilter(value: string): value is KindFilter {
  if (value === "all") return true;
  for (const kind of PLACE_SUBJECT_KINDS) if (kind === value) return true;
  return false;
}

/**
 * The row's own status in the operator's words.
 *
 * Written as a loop over the constant rather than `STATUS_LABEL[status as
 * PlaceLinkStatus]`: the column is `string` on the wire because it is `string`
 * in the route's own types, and a cast would render an unknown value as
 * whatever branch fell through instead of as itself.
 */
function statusLabel(status: string): string {
  for (const known of PLACE_LINK_STATUSES) {
    if (known === status) return STATUS_LABEL[known];
  }
  return status;
}

function subjectKindLabel(kind: string): string {
  for (const known of PLACE_SUBJECT_KINDS) {
    if (known === kind) return KIND_LABEL[known];
  }
  return kind;
}

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return formatTimestamp(value);
}

/**
 * How many decimal places a grade earns.
 *
 * One degree of latitude is roughly 111 km, so a decimal place is roughly 11 km,
 * 1.1 km, 110 m, 11 m, 1.1 m. Printing to a finer place than the grade's own
 * uncertainty asserts a resolution the geocoder never had — the geography spec's
 * single most common way civic maps mislead, applied to the digits rather than
 * to a radius.
 *
 * The thresholds pick the decimal place *nearest* the grade's uncertainty rather
 * than the first one finer than it. The distinction is the whole point and the
 * first version of this table got it backwards: `block` carries 100 m and was
 * printed to four places, which is 11 m — nine times finer than the record
 * supports, on the grade the geocoder actually produces. An operator copying
 * those digits into any map lands on a building, and the ±100 m written beside
 * them does not undo a number that looks surveyed.
 *
 *   exact         10 m  → 4 places (11 m)
 *   block        100 m  → 3 places (110 m)
 *   centroid     250 m  → 3 places (110 m), the nearer of 110 m and 1.1 km
 *   jurisdiction  none  → 2 places (1.1 km)
 *
 * `null` uncertainty is `jurisdiction`, which carries no position at all; an
 * unrecognised grade is treated the same way, because a coordinate with no known
 * error bar is exactly the thing being refused.
 */
function decimalsFor(precision: PlacePrecision | null): number {
  if (precision === null) return 2;
  const metres = PRECISION_GRADES[precision].uncertainty_metres;
  if (metres === null) return 2;
  if (metres <= 20) return 4;
  if (metres <= 500) return 3;
  return 2;
}

/**
 * The coordinate, and the grade that qualifies it, in one element.
 *
 * They are one element on purpose: a latitude printed on its own line and a
 * precision printed somewhere below it is a number a reader can copy without the
 * caveat. There is no map here — see the file header.
 */
function Coordinate({
  lat,
  lon,
  precision,
  precisionMeaning,
  linkId,
}: {
  lat: number;
  lon: number;
  precision: string;
  precisionMeaning: string | null;
  linkId: string;
}) {
  const grade = precisionOf(precision);
  const digits = decimalsFor(grade);
  const placed = grade !== null && PRECISION_GRADES[grade].uncertainty_metres !== null;

  return (
    <div className="mt-4" data-testid={`coordinate-${linkId}`}>
      <p className="label-sm">Position</p>
      <p className="mt-1 text-sm text-ink">
        <span className="figure tabular" data-testid={`coordinate-figures-${linkId}`}>
          {lat.toFixed(digits)}, {lon.toFixed(digits)}
        </span>{" "}
        <span
          data-testid={`precision-grade-${linkId}`}
          className="text-[11px] font-semibold uppercase tracking-label text-muted"
        >
          {grade === null ? `Precision: ${precision}` : PRECISION_GRADES[grade].label}
          {placed && grade !== null && PRECISION_GRADES[grade].uncertainty_metres !== null && (
            <> · ±{formatCount(PRECISION_GRADES[grade].uncertainty_metres)} m</>
          )}
        </span>
      </p>
      {/* The backend's own sentence. `PRECISION_MEANING` lives on the server and
        is asserted exhaustive over the precision list there, so a fifth grade
        arrives with words rather than as a bare column value. */}
      <p data-testid={`precision-meaning-${linkId}`} className="mt-1 max-w-prose text-sm text-ink-soft">
        {precisionMeaning ??
          "This build's server has no plain-words meaning for that precision, so nothing here says what the coordinate supports. Do not approve it on the figures alone."}
      </p>
      {!placed && (
        <p className="mt-1 max-w-prose text-xs text-muted">
          This grade carries no position on the ground. The figures above are what the record
          resolved to, not a spot a reader should be shown as one.
        </p>
      )}
    </div>
  );
}

/**
 * The window of document text with the quote marked.
 *
 * The offsets index the window, not the document — the backend sliced it. They
 * are checked rather than trusted: a span falling outside the text would mark an
 * arbitrary run of characters, which is worse than marking none, because the
 * operator reads the highlight as the quote and approves on it.
 *
 * The text came out of a third-party PDF. It renders as React text nodes and
 * there is no `dangerouslySetInnerHTML` anywhere near it.
 */
function QuoteInContext({ context, linkId }: { context: PlaceQuoteContext; linkId: string }) {
  const usable =
    context.quote_start >= 0 &&
    context.quote_end > context.quote_start &&
    context.quote_end <= context.text.length;

  return (
    <div className="mt-2">
      <p className="text-xs text-muted">
        Characters <span className="figure">{formatCount(context.window_offset)}</span>
        {" to "}
        <span className="figure">
          {formatCount(context.window_offset + context.text.length)}
        </span>{" "}
        of the stored document.
        {!context.offset_matches_stored && (
          <>
            {" "}
            The quote was found by searching the text, not at the offset stored with the link, so
            the two disagree about where it is.
          </>
        )}
      </p>
      <p
        data-testid={`quote-context-${linkId}`}
        className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words border border-rule bg-paper p-3 font-mono text-xs leading-relaxed text-ink"
      >
        {usable ? (
          <>
            {context.text.slice(0, context.quote_start)}
            <mark data-testid={`quote-span-${linkId}`} className="bg-accent/20 text-ink">
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

/** Everything the operator needs about the bytes, or the fact that there are none. */
function Evidence({ item }: { item: PlaceLinkReviewItem }) {
  const linkId = item.link.id;
  const citation = item.citation;

  if (citation === null) {
    return (
      <div className="mt-6" data-testid={`no-citation-${linkId}`}>
        <FlagBar label="No citation" tone="bad">
          This link quotes nothing. Only an <span className="font-mono">inferred</span> link is
          allowed to, and an inferred link is never public — so there is no document here to read
          before deciding.
        </FlagBar>
      </div>
    );
  }

  return (
    <>
      <h3 className="mt-6 font-display text-base font-semibold text-ink">
        The quote, in the document it came from
      </h3>
      <Citation
        citation={{
          artifact_sha256: citation.artifact_sha256,
          quote_offset: citation.quote_offset,
          quote: citation.quote,
          source_label: "Stored document",
          source_url: citation.source_url,
        }}
      />
      {/* `viewer_path`, from the API, not a path assembled here. It is the
        `?offset=&len=` query form: the server picks the window, so a `#offset-`
        fragment would never leave the browser and every one of these would open
        a three-hundred-page packet at character zero. */}
      <p className="mt-2 text-xs text-muted">
        <Link
          to={citation.viewer_path}
          data-testid={`viewer-link-${linkId}`}
          className={`underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
        >
          Open the document at this quote
        </Link>
      </p>
      {citation.context ? (
        <QuoteInContext context={citation.context} linkId={linkId} />
      ) : (
        <p
          data-testid={`no-context-${linkId}`}
          className="mt-2 border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
        >
          {citation.artifact_stored
            ? "No extracted text is stored for this document, so the quote cannot be shown in context. Open the source before deciding."
            : "The bytes this link cites are not stored, so a reader could not check it."}
        </p>
      )}
      <p data-testid={`stored-${linkId}`} className="mt-2 text-xs text-muted">
        {citation.artifact_stored
          ? "The cited bytes are stored, so a reader can check this quote."
          : "The cited bytes are not stored."}
        {citation.context && !citation.context.offset_matches_stored && (
          <> The stored offset does not match where the quote actually is.</>
        )}
      </p>
    </>
  );
}

/**
 * Whether a reader can already see what this link attaches to.
 *
 * Stated either way rather than only when withheld: "this subject is public"
 * carries information, and a note that appears only in the bad case teaches an
 * operator to read its absence as nothing having been checked.
 */
function SubjectPublicity({ item }: { item: PlaceLinkReviewItem }) {
  const linkId = item.link.id;
  if (item.subject.is_public) {
    return (
      <p data-testid={`subject-publicity-${linkId}`} className="mt-3 text-sm text-ink-soft">
        The record this link attaches to is already public, so approving it puts the pin on the map.
      </p>
    );
  }
  return (
    <div className="mt-3" data-testid={`subject-publicity-${linkId}`}>
      <FlagBar label="Subject not published" tone="idle">
        The record this link attaches to has not been published, so an approved pin stays off the
        map until it is. That does not block approval and it is not a fault here — the wall is doing
        its job, and the pin appears when the record does.
      </FlagBar>
    </div>
  );
}

type LoadResult = { ok: true; body: PlaceLinkQueueResponse } | { ok: false };

type LinkDecision = "approve" | "reject";

const DECIDED: Record<LinkDecision, string> = {
  approve: "Approved. The decision is in the correction log.",
  reject: "Rejected. This link can never publish.",
};

export function AdminPlaceLinksPage() {
  const [status, setStatus] = useState<StatusFilter>("held");
  const [kind, setKind] = useState<KindFilter>("all");
  const [listing, setListing] = useState<PlaceLinkQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  // Fetching and applying are separated for the reason AdminClaimsPage gives: an
  // effect body calling setState synchronously cascades a render, and a fast
  // unmount would set state on a component that is already gone.
  const fetchQueue = useCallback(async (): Promise<LoadResult> => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (kind !== "all") params.set("subject_kind", kind);
    const query = params.toString();
    try {
      const res = await fetch(
        `/api/admin/place-links/queue${query === "" ? "" : `?${query}`}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) return { ok: false };
      return { ok: true, body: (await res.json()) as PlaceLinkQueueResponse };
    } catch {
      return { ok: false };
    }
  }, [kind, status]);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setListing(result.body);
      setError("");
    } else {
      setError("The place-link queue could not be loaded.");
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
   * One link, one call. The reason is checked here as well as by the API, which
   * 400s without one — see the file header.
   */
  async function decide(item: PlaceLinkReviewItem, decision: LinkDecision) {
    const linkId = item.link.id;
    const reason = (reasonById[linkId] ?? "").trim();
    if (reason === "") {
      setNotice("A decision needs a stated reason.");
      return;
    }
    setBusy(linkId);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/place-links/${linkId}/${decision}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        // Verbatim. The API's refusals say exactly what is wrong, and a
        // paraphrase here would be a second thing to debug.
        setNotice(payload?.error ?? "The decision could not be recorded.");
      } else {
        setNotice(DECIDED[decision]);
        setReasonById((current) => ({ ...current, [linkId]: "" }));
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
        title="Place links"
        stamp={listing ? `${listing.counts.held} awaiting review` : undefined}
      />

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-soft">
        A place link says a record is about a location. Approving one is what puts a pin on the
        public map, and nothing here publishes itself. A pin is a claim about where a decision
        happened: read the quote in the document below, and read the precision — most of these are
        interpolated along a street, not surveyed at a building.
      </p>

      {listing && (
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="label-sm">Awaiting review</dt>
            <dd data-testid="count-held" className="mt-1 figure text-lg text-ink">
              {listing.counts.held}
            </dd>
          </div>
          <div>
            <dt className="label-sm">Approved</dt>
            <dd data-testid="count-approved" className="mt-1 figure text-lg text-ink">
              {listing.counts.approved}
            </dd>
          </div>
          <div>
            <dt className="label-sm">Rejected</dt>
            <dd data-testid="count-rejected" className="mt-1 figure text-lg text-ink">
              {listing.counts.rejected}
            </dd>
          </div>
        </dl>
      )}
      {listing && (
        <p className="mt-2 text-xs text-muted">
          Counted over every link, not over the page below — filtering does not move these figures.
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <SegmentedControl
          label="Filter by status"
          name="place-link-status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(next) => {
            if (!isStatusFilter(next)) return;
            setLoading(true);
            setStatus(next);
          }}
        />
        <SegmentedControl
          label="Filter by subject"
          name="place-link-subject"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(next) => {
            if (!isKindFilter(next)) return;
            setLoading(true);
            setKind(next);
          }}
        />
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
          Loading place links…
        </p>
      ) : listing === null ? (
        /* Not "the record shows no place links". The request failed, so this
          screen does not know what the record shows — and `none-exist` is the
          strongest claim `Absence` can make. Stating it on a failed fetch is
          the exact substitution that grammar of nothing exists to refuse. */
        <Absence reason="request-failed" subject="The place-link queue" />
      ) : items.length === 0 ? (
        <Absence reason="none-exist" subject={EMPTY_SUBJECT[status]} />
      ) : (
        <div className="mt-8 space-y-6">
          {items.map((item) => {
            const link = item.link;
            const linkId = link.id;
            const held = link.status === "held";
            const inferred = link.confidence === "inferred";

            return (
              <PressroomCard key={linkId}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="label-sm">{item.place.label}</span>
                  <span className="label-sm">{item.place.kind.replace(/_/g, " ")}</span>
                  <span className="label-sm">{statusLabel(link.status)}</span>
                  {inferred && (
                    <span
                      data-testid={`inferred-${linkId}`}
                      className="text-[11px] font-semibold uppercase tracking-label text-accent"
                    >
                      Inferred · never public
                    </span>
                  )}
                </div>

                <p className="mt-2 label-sm">
                  {item.place.jurisdiction_name ?? "No jurisdiction"} ·{" "}
                  {subjectKindLabel(link.subject_kind)} · {link.relation.replace(/_/g, " ")} ·{" "}
                  {link.confidence} · extracted {formatStamp(link.created_at)}
                </p>

                <p className="mt-2 max-w-prose text-sm text-ink">
                  <span className="label-sm">Attached to</span>{" "}
                  {item.subject.label ?? "a record that no longer exists"}
                  {item.subject.meeting_id !== null && (
                    <>
                      {" · "}
                      <Link
                        to={`/admin/meetings/${item.subject.meeting_id}`}
                        className={`underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
                      >
                        Open the meeting record
                      </Link>
                    </>
                  )}
                </p>

                <SubjectPublicity item={item} />

                <Coordinate
                  lat={item.place.lat}
                  lon={item.place.lon}
                  precision={item.place.precision}
                  precisionMeaning={item.place.precision_meaning}
                  linkId={linkId}
                />

                <p className="mt-1 text-xs text-muted">
                  Geocoded by{" "}
                  <span className="font-mono">{item.place.geocoder ?? "no geocoder recorded"}</span>
                  {item.place.geocoded_at !== null && <> on {formatStamp(item.place.geocoded_at)}</>}
                  {item.place.external_source !== null && (
                    <>
                      {" · "}
                      <span className="font-mono">{item.place.external_source}</span>
                      {item.place.external_ref !== null && (
                        <>
                          {" "}
                          <span className="font-mono">{item.place.external_ref}</span>
                        </>
                      )}
                    </>
                  )}
                </p>

                <Evidence item={item} />

                {held ? (
                  <div className="mt-6 space-y-3">
                    <label className="block">
                      <span className="label-sm">Reason</span>
                      <textarea
                        rows={2}
                        value={reasonById[linkId] ?? ""}
                        onChange={(event) =>
                          setReasonById((current) => ({
                            ...current,
                            [linkId]: event.target.value,
                          }))
                        }
                        className={`${fieldClass} ${focusRing}`}
                        aria-label={`Reason for ${linkId}`}
                      />
                    </label>

                    {/* One button per link, and nothing that acts on a
                      selection. See the header. */}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy === linkId || !item.decision.approvable}
                        onClick={() => void decide(item, "approve")}
                        className={`${buttonClass} ${focusRing}`}
                      >
                        Approve and place
                      </button>
                      {/* Live even for an inferred link: approving one is
                        meaningless, refusing one is not. */}
                      <button
                        type="button"
                        disabled={busy === linkId}
                        onClick={() => void decide(item, "reject")}
                        className={`${secondaryButtonClass} ${focusRing}`}
                      >
                        Reject
                      </button>
                    </div>

                    {/* In place, in the API's words, never in a tooltip: a
                      disabled button with its reason one hover away is a
                      disabled button with no reason. */}
                    {item.decision.blocked_reason && (
                      <p
                        data-testid={`blocked-${linkId}`}
                        className="border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
                      >
                        This link cannot be approved: {item.decision.blocked_reason}. It can still be
                        rejected.
                      </p>
                    )}
                  </div>
                ) : (
                  <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="label-sm">Decided</dt>
                      <dd className="mt-1 text-sm text-ink tabular">
                        {formatStamp(link.updated_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="label-sm">Where the reason is</dt>
                      {/* `place_links` holds no reason column — the decision and
                        its stated reason are one row in `record_corrections`,
                        which is append-only and is the log. Rendering "Not
                        recorded" here would say a reason was never given. */}
                      <dd className="mt-1 text-sm text-ink">
                        In the correction log, with the operator who wrote it.
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
  );
}
