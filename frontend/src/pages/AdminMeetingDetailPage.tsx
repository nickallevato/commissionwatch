import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  FIELD,
  FlagBar,
  FOCUS_RING,
  KeyValues,
  LogTail,
  StatusPill,
  WorkTitle,
  type Severity,
} from "@/components/PressroomUI";
import type {
  ConfidenceLevel,
  CorrectionTargetTable,
  DisputeItem,
  MeetingDetailPayload,
  ReparseResult,
} from "@/types";

/**
 * `/admin/meetings/:id` — one ingested meeting, as the machine has it.
 *
 * Four of the console's design decisions live here:
 *
 * 6. **Confidence is per field.** Each agenda item carries a mark for each
 *    field the extractor touched, with the reason next to it. There is
 *    deliberately no single score for an item and none for the meeting: seven
 *    good items and one mangled one is not a low-confidence meeting.
 * 7. **Corrections are append-only.** The form below writes a
 *    `record_corrections` row — who, when, field, old, new, why — and then
 *    updates the live row. The stored artifact is never touched. The history is
 *    rendered as text with no control on it, because there is no edit path: the
 *    database raises on `UPDATE` and `DELETE` of a correction.
 * 8. **Ingested is not published.** A meeting arrives as a candidate. An
 *    operator, giving a reason, turns it into a publication. Publishing over a
 *    known defect is permitted — and recorded as such by the same audit trail.
 *
 * Re-parse here means the same thing it means on the run screen: replay the
 * bytes already stored. No request goes back out to the source.
 *
 * **`?dispute=<id>` carries a contest through from the Disputes tab.** Upholding
 * a dispute changes nothing; the correction that follows is a separate act, and
 * `record_corrections.dispute_id` is what joins the two. Making the operator
 * retype a reference into a free-text box would mean the join exists only when
 * somebody remembers it — so the link travels in the URL, the page shows what it
 * resolved to before anything is submitted, and the id goes in the request body.
 * A dispute that cannot be loaded is said out loud and the correction goes
 * ahead unlinked, because refusing to correct a record over a broken query
 * string would be the worse failure.
 */

/**
 * The mockup's three marks. `low` is the one that needs a human, so it is the
 * one that reads Fix and takes the failure colour.
 */
const LEVEL_MARK: Record<ConfidenceLevel, { label: string; tone: Severity }> = {
  high: { label: "OK", tone: "ok" },
  medium: { label: "Check", tone: "warn" },
  low: { label: "Fix", tone: "bad" },
};

const MARK_TEXT: Record<ConfidenceLevel, string> = {
  high: "text-pass",
  medium: "text-sev3",
  low: "text-accent",
};

interface CorrectionTarget {
  key: string;
  table: CorrectionTargetTable;
  id: string;
  label: string;
  fields: readonly string[];
}

type LoadResult = { ok: true; detail: MeetingDetailPayload } | { ok: false };

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function AdminMeetingDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const disputeId = searchParams.get("dispute") ?? "";
  // Keyed on the id it was fetched for, so "no dispute in the URL" and "the
  // dispute in the URL has not resolved yet" are told apart by reading state
  // rather than by an effect that clears it.
  const [resolved, setResolved] = useState<{ id: string; item: DisputeItem | null } | null>(
    null,
  );
  const [linkDispute, setLinkDispute] = useState(true);
  const [detail, setDetail] = useState<MeetingDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [publishReason, setPublishReason] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState("");

  const [targetKey, setTargetKey] = useState("");
  const [field, setField] = useState("");
  const [newValue, setNewValue] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [formError, setFormError] = useState("");

  const [reparsing, setReparsing] = useState(false);

  // Fetching and applying are separated so the effect below can await the
  // request and touch state only in the continuation. An effect body that calls
  // setState synchronously causes a cascading render, and — worse here — a fast
  // unmount would set state on a component that is already gone.
  const fetchDetail = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch(`/api/admin/pressroom/meetings/${id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as MeetingDetailPayload;
      return { ok: true, detail: body };
    } catch {
      return { ok: false };
    }
  }, [id]);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setDetail(result.detail);
      setError("");
    } else {
      setError("That meeting could not be loaded.");
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    applyResult(await fetchDetail());
  }, [applyResult, fetchDetail]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchDetail();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchDetail]);

  useEffect(() => {
    if (disputeId === "") return;
    let ignore = false;
    void (async () => {
      const item = await (async (): Promise<DisputeItem | null> => {
        try {
          const res = await fetch(`/api/admin/review/disputes/${disputeId}`, {
            credentials: "same-origin",
          });
          if (!res.ok) return null;
          return (await res.json()) as DisputeItem;
        } catch {
          return null;
        }
      })();
      if (ignore) return;
      setResolved({ id: disputeId, item });
    })();
    return () => {
      ignore = true;
    };
  }, [disputeId]);

  const dispute = disputeId !== "" && resolved?.id === disputeId ? resolved.item : null;
  const disputeError =
    disputeId !== "" && resolved?.id === disputeId && resolved.item === null
      ? "That dispute could not be loaded. This correction will be recorded without a link to one."
      : "";

  const targets = useMemo<CorrectionTarget[]>(() => {
    if (!detail) return [];
    return [
      {
        key: `meetings:${detail.meeting.id}`,
        table: "meetings",
        id: detail.meeting.id,
        label: "The meeting",
        fields: ["date", "time", "location", "status", "agenda_url", "minutes_url"],
      },
      ...detail.agenda_items.map((item) => ({
        key: `agenda_items:${item.id}`,
        table: "agenda_items" as const,
        id: item.id,
        label: `Agenda item ${item.item_number}`,
        fields: ["title", "description", "category"] as const,
      })),
      ...detail.documents.map((doc) => ({
        key: `meeting_documents:${doc.id}`,
        table: "meeting_documents" as const,
        id: doc.id,
        label: `Document — ${doc.title}`,
        fields: ["title", "document_type", "url"] as const,
      })),
    ];
  }, [detail]);

  /**
   * A dispute names the exact row it contests, so the form opens on that row
   * rather than on the meeting. An operator who has to re-find the agenda item
   * a stranger quoted is an operator who will occasionally correct the wrong
   * one. If the contested row is not on this page — the dispute points at
   * another meeting — nothing is preselected and the banner says so.
   */
  const contestedKey =
    dispute === null ? "" : `${dispute.dispute.target_table}:${dispute.dispute.target_id}`;
  const contestedOnThisPage = targets.some((target) => target.key === contestedKey);

  // Derived rather than written into state by an effect: the operator's own
  // choice wins as soon as they make one, and until then the contested row is
  // the default. Pushing it through `setTargetKey` would race the fetch that
  // resolves the dispute and would fight any selection made before it landed.
  const effectiveTargetKey =
    targetKey !== "" ? targetKey : contestedOnThisPage ? contestedKey : "";
  const selectedTarget =
    targets.find((target) => target.key === effectiveTargetKey) ?? targets[0];
  const selectedField = selectedTarget?.fields.includes(field)
    ? field
    : (selectedTarget?.fields[0] ?? "");

  /** Newest first. A correction log read oldest-first buries the current state. */
  const corrections = useMemo(() => {
    if (!detail) return [];
    return [...detail.corrections].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [detail]);

  async function handlePublication(action: "publish" | "unpublish") {
    setPublishing(true);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/meetings/${id}/${action}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: publishReason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? "That publication change was refused.");
        return;
      }
      const body = (await res.json()) as { published_at: string | null };
      setNotice(
        body.published_at === null
          ? "Withdrawn from the public site. The record stays here."
          : `Published ${new Date(body.published_at).toLocaleString()}.`,
      );
      setPublishReason("");
      await reload();
    } catch {
      setNotice("The publication request could not be sent.");
    } finally {
      setPublishing(false);
    }
  }

  async function handleCorrection(event: FormEvent) {
    event.preventDefault();
    if (!selectedTarget) return;
    setFormError("");
    setCorrecting(true);
    try {
      const res = await fetch("/api/admin/pressroom/corrections", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_table: selectedTarget.table,
          target_id: selectedTarget.id,
          field: selectedField,
          new_value: newValue,
          reason: correctionReason,
          // Omitted rather than sent as null when there is nothing to link, so
          // the request says what it means: no dispute prompted this.
          ...(dispute !== null && linkDispute ? { dispute_id: dispute.dispute.id } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? "That correction could not be recorded.");
        return;
      }
      setNewValue("");
      setCorrectionReason("");
      await reload();
    } catch {
      setFormError("The correction could not be sent.");
    } finally {
      setCorrecting(false);
    }
  }

  async function handleReparse() {
    setReparsing(true);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/meetings/${id}/reparse`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? "The re-parse could not be started.");
        return;
      }
      const body = (await res.json()) as ReparseResult;
      setNotice(
        `Re-parse run ${body.run_id} enqueued ${body.enqueued} parse job${
          body.enqueued === 1 ? "" : "s"
        } against stored bytes.`,
      );
    } catch {
      setNotice("The re-parse request could not be sent.");
    } finally {
      setReparsing(false);
    }
  }

  /**
   * Decision 8's gate, computed rather than asserted. An item with any field
   * marked `low` is an item somebody has to look at, and publishing over one
   * is permitted — it is just never silent.
   */
  const defects = (detail?.agenda_items ?? []).filter((item) =>
    Object.values(item.field_confidence).some((mark) => mark.level === "low"),
  );

  /** The first artifact is the document the record was parsed out of. */
  const artifact = detail?.artifacts[0] ?? null;
  const sourceDocument = detail?.documents[0] ?? null;

  /**
   * The value the parser produced for the item most in need of a look. The raw
   * page text is not returned by the API, and inventing it would be worse than
   * showing the thing a correction would actually replace.
   */
  const extractedText = (() => {
    const items = detail?.agenda_items ?? [];
    const worst = items.find((item) =>
      Object.values(item.field_confidence).some((mark) => mark.level === "low"),
    );
    const chosen = worst ?? items[0];
    if (!chosen) return "Nothing was extracted from this document.";
    return chosen.description
      ? `${chosen.item_number}.  ${chosen.title}\n    ${chosen.description}`
      : `${chosen.item_number}.  ${chosen.title}`;
  })();

  return (
    <>
      <WorkTitle
        title={
          detail
            ? `${detail.commission.name} — ${new Date(detail.meeting.date).toLocaleDateString()}`
            : "Meeting record"
        }
        stamp={
          detail ? (
            <>
              {detail.meeting.id} ·{" "}
              {detail.meeting.published_at === null ? (
                <StatusPill tone="plain" testId="publication-pill">
                  Not published
                </StatusPill>
              ) : (
                <StatusPill tone="ok" testId="publication-pill">
                  Published
                </StatusPill>
              )}
            </>
          ) : undefined
        }
      />

      {error && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          {error}
        </p>
      )}

      {notice && (
        <p role="status" className="border-l-2 border-ink bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="label-sm" role="status">
          Loading meeting…
        </p>
      ) : detail === null ? null : (
        <>
          <KeyValues
            testId="meeting-facts"
            items={[
              {
                key: "Jurisdiction",
                value: `${detail.jurisdiction.name}, ${detail.jurisdiction.state}`,
              },
              { key: "Status", value: detail.meeting.status },
              { key: "Location", value: detail.meeting.location ?? "Not recorded" },
              { key: "External id", value: detail.meeting.external_id ?? "None" },
            ]}
          />

          {/* Decision 8. Publishing is a decision with a reason attached, not a
              default that happens because ingestion succeeded. */}
          <div className={ACTION_ROW}>
            <button
              type="button"
              onClick={() =>
                void handlePublication(
                  detail.meeting.published_at === null ? "publish" : "unpublish",
                )
              }
              disabled={publishing || publishReason.trim() === ""}
              className={`${ACTION_PRIMARY} ${FOCUS_RING}`}
            >
              {detail.meeting.published_at === null ? "Publish" : "Unpublish"}
            </button>
            <a href="#record-a-correction" className={`${ACTION} ${FOCUS_RING} no-underline`}>
              Edit fields
            </a>
            {sourceDocument ? (
              <a
                href={sourceDocument.url}
                target="_blank"
                rel="noreferrer noopener"
                className={`${ACTION} ${FOCUS_RING} no-underline`}
              >
                Open source document
              </a>
            ) : (
              <span className={`${ACTION} cursor-not-allowed opacity-40`}>No source document</span>
            )}
            <button
              type="button"
              onClick={() => void handleReparse()}
              disabled={reparsing}
              className={`${ACTION_QUIET} ${FOCUS_RING}`}
            >
              {reparsing ? "Re-parsing…" : "Re-parse stored bytes"}
            </button>
          </div>

          <div className="max-w-lg">
            <label htmlFor="publication-reason" className="label-sm">
              Publication reason
            </label>
            <input
              id="publication-reason"
              value={publishReason}
              onChange={(event) => setPublishReason(event.target.value)}
              className={`${FIELD} ${FOCUS_RING}`}
            />
            <p className="mt-1 text-xs text-muted">
              Required. It is written to the correction log against <code>published_at</code>.
            </p>
          </div>

          <p
            data-testid="publication-state"
            className={`text-sm font-semibold ${
              detail.meeting.published_at === null ? "text-accent" : "text-pass"
            }`}
          >
            {detail.meeting.published_at === null
              ? "Ingested, not published"
              : `Published ${new Date(detail.meeting.published_at).toLocaleString()}`}
          </p>
          <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
            {detail.meeting.published_at === null
              ? "This record exists here and nowhere else. Ingestion produced a candidate; publishing it is a decision, and the reason you give is kept with it."
              : "Live on the public site. Withdrawing it removes it from every public response; the record and its history stay here."}
          </p>

          {/* The split. The parsed record on paper, the document it came from
              on the sunk ground beside it. */}
          <div className="grid grid-cols-1 border border-rule lg:grid-cols-[1.35fr_1fr]">
            {/* Decision 6. */}
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <span className="label-sm">
                Agenda items — {detail.agenda_items.length} extracted
              </span>
              {detail.agenda_items.length === 0 ? (
                <p className="text-sm text-muted">No agenda item was extracted.</p>
              ) : (
                <ul className="flex flex-col">
                  {detail.agenda_items.map((item) => {
                    const marks = Object.entries(item.field_confidence);
                    const worst: ConfidenceLevel = marks.some(([, mark]) => mark.level === "low")
                      ? "low"
                      : marks.some(([, mark]) => mark.level === "medium")
                        ? "medium"
                        : "high";
                    return (
                      <li
                        key={item.id}
                        className="grid grid-cols-[2.5rem_1fr_max-content] items-baseline gap-3 border-b border-rule py-2.5 text-[13px] last:border-b-0"
                      >
                        <span className="figure text-[11.5px] text-muted">{item.item_number}.</span>
                        <span className="min-w-0 leading-snug">
                          <span className="block text-ink">{item.title}</span>
                          {item.description && (
                            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                              {item.description}
                            </span>
                          )}
                          {marks.length === 0 ? (
                            <span className="mt-1 block text-[11.5px] text-muted">
                              No confidence was recorded for any field of this item.
                            </span>
                          ) : (
                            <span className="mt-1.5 flex flex-wrap gap-1.5">
                              {marks.map(([fieldName, mark]) => (
                                <span
                                  key={fieldName}
                                  data-testid={`confidence-${item.id}-${fieldName}`}
                                  data-field={fieldName}
                                  data-level={mark.level}
                                  className="inline-flex max-w-full items-baseline gap-1.5 border border-rule px-1.5 py-0.5 text-[10.5px]"
                                >
                                  <b className="font-semibold text-ink">{fieldName}</b>
                                  <b
                                    className={`font-bold uppercase tracking-label ${MARK_TEXT[mark.level]}`}
                                  >
                                    {LEVEL_MARK[mark.level].label}
                                  </b>
                                  <span className="text-muted">{mark.reason}</span>
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                        <StatusPill tone={LEVEL_MARK[worst].tone} testId={`item-mark-${item.id}`}>
                          {LEVEL_MARK[worst].label}
                        </StatusPill>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
                Confidence is marked field by field. There is no score for an item
                and none for the meeting, because one mangled title says nothing
                about the six items either side of it — the pill at the end of a
                row is the worst mark on it, not an average of them.
              </p>
            </div>

            <div className="flex flex-col gap-3 border-t border-rule bg-paper-sunk px-4 py-3.5 lg:border-l lg:border-t-0">
              <span className="label-sm">Source artifact</span>
              {artifact === null ? (
                <p className="text-sm text-muted">No artifact bytes are stored for this meeting.</p>
              ) : (
                <KeyValues
                  testId="artifact-facts"
                  items={[
                    { key: "File", value: artifact.storage_key },
                    { key: "Fetched", value: formatStamp(artifact.fetched_at) },
                    { key: "From", value: artifact.source_url ?? "records request (no URL)" },
                    {
                      key: "sha256",
                      value: `${artifact.sha256.slice(0, 4)}…${artifact.sha256.slice(-4)}`,
                    },
                    { key: "Pages", value: "Not recorded" },
                    { key: "Size", value: `${artifact.byte_size} bytes` },
                    { key: "Type", value: artifact.content_type ?? "unknown" },
                  ]}
                />
              )}

              {detail.artifacts.length > 1 && (
                <p className="text-[11px] leading-relaxed text-muted">
                  {detail.artifacts.length} artifacts back this record. The one above is the
                  earliest returned.
                </p>
              )}

              <span className="label-sm mt-1">Extracted text — as parsed</span>
              <LogTail testId="extracted-text">{extractedText}</LogTail>
              <p className="max-w-prose text-[11px] leading-relaxed text-muted">
                The raw page text is not returned by the API. What is above is the
                value the parser produced for the item most in need of a look — the
                thing a correction would replace.
              </p>

              <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
                A manual correction is recorded as an edit with your name, the old
                value, the new value and a reason. It never overwrites the artifact.
              </p>
            </div>
          </div>

          {/* Decision 8's gate, said plainly. */}
          {defects.length > 0 ? (
            <FlagBar label="Publish gate" tone="bad" testId="publish-gate">
              This meeting has{" "}
              <b className="font-semibold text-ink">
                {defects.length} item{defects.length === 1 ? "" : "s"} marked Fix
              </b>
              . Publishing is allowed and will be logged as publishing over a known
              defect — say so in the reason, because the log will show you knew.
            </FlagBar>
          ) : (
            <FlagBar label="Publish gate" tone="ok" testId="publish-gate">
              No field on this record is marked Fix. Publishing is still a decision
              with a reason attached; it is just not one made over a known defect.
            </FlagBar>
          )}

          <div className="flex flex-col gap-3 border border-rule px-4 py-3.5">
            <span className="label-sm">Documents</span>
            {detail.documents.length === 0 ? (
              <p className="text-sm text-muted">No document is linked to this meeting.</p>
            ) : (
              <ul className="divide-y divide-rule border-y border-rule">
                {detail.documents.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex flex-wrap items-baseline justify-between gap-3 py-2.5"
                  >
                    <span className="text-sm text-ink">{doc.title}</span>
                    <a
                      href={doc.url}
                      className={`cite ${FOCUS_RING}`}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {doc.document_type}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {detail.artifacts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] border-collapse text-left text-[13px]">
                  <caption className="sr-only">Stored artifacts backing this meeting</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="label-sm border-b border-rule py-2 pr-3">
                        sha256
                      </th>
                      <th scope="col" className="label-sm border-b border-rule py-2 pr-3">
                        Type
                      </th>
                      <th scope="col" className="label-sm border-b border-rule py-2 pr-3 text-right">
                        Bytes
                      </th>
                      <th scope="col" className="label-sm border-b border-rule py-2">
                        Fetched
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.artifacts.map((row) => (
                      <tr key={row.id} className="border-b border-rule last:border-b-0">
                        <td className="py-2 pr-3 font-mono text-xs text-ink-soft">
                          {row.sha256.slice(0, 12)}…
                        </td>
                        <td className="py-2 pr-3 text-ink-soft">{row.content_type ?? "unknown"}</td>
                        <td className="py-2 pr-3 text-right figure text-ink">{row.byte_size}</td>
                        <td className="py-2 tabular text-ink">{formatStamp(row.fetched_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
              Re-parsing replays these stored bytes.{" "}
              <strong className="font-semibold text-ink">No request is made to the source.</strong>{" "}
              The artifact itself is never rewritten — a correction changes the parsed record and
              leaves the evidence alone.
            </p>
          </div>

          {/* Decision 7. */}
          <div
            id="record-a-correction"
            className="flex flex-col gap-3 border border-rule px-4 py-3.5"
          >
            <span className="label-sm">Record a correction</span>
            <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
              A correction appends. The old value, the new one and your reason are kept forever; the
              stored artifact is not touched, because a transparency project that edits its own
              evidence has nothing left to stand on.
            </p>

            {disputeError && (
              <p
                role="alert"
                data-testid="dispute-link-error"
                className="max-w-prose border-l-2 border-accent px-4 py-2 text-sm text-ink-soft"
              >
                {disputeError}
              </p>
            )}

            {dispute && (
              <div
                data-testid="dispute-link"
                className="max-w-prose border-l-2 border-ink bg-paper-sunk px-4 py-3"
              >
                <p className="label-sm">
                  Prompted by dispute{" "}
                  <span className="figure text-accent">{dispute.dispute.reference}</span> ·{" "}
                  {dispute.dispute.status}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink">
                  {dispute.dispute.contested}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {contestedOnThisPage
                    ? `The contested row — ${dispute.context.record_summary} — is selected below.`
                    : `The contested row is ${dispute.context.record_summary}, which is not on this page. Choose the target yourself.`}
                </p>
                <label className="mt-3 flex items-center gap-2 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={linkDispute}
                    onChange={(event) => setLinkDispute(event.target.checked)}
                    className={FOCUS_RING}
                  />
                  Record this correction against the dispute
                </label>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  The link is written to <code>record_corrections.dispute_id</code> and the public
                  log names the reference. Nothing the contester wrote is published.
                </p>
              </div>
            )}

            <form onSubmit={handleCorrection} className="max-w-lg space-y-4">
              {formError && (
                <p role="alert" className="border-l-2 border-accent px-4 py-2 text-sm text-ink-soft">
                  {formError}
                </p>
              )}

              <div>
                <label htmlFor="correction-target" className="label-sm">
                  Target
                </label>
                <select
                  id="correction-target"
                  value={selectedTarget?.key ?? ""}
                  onChange={(event) => {
                    setTargetKey(event.target.value);
                    setField("");
                  }}
                  className={`${FIELD} ${FOCUS_RING}`}
                >
                  {targets.map((target) => (
                    <option key={target.key} value={target.key}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="correction-field" className="label-sm">
                  Field
                </label>
                <select
                  id="correction-field"
                  value={selectedField}
                  onChange={(event) => setField(event.target.value)}
                  className={`${FIELD} ${FOCUS_RING}`}
                >
                  {(selectedTarget?.fields ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="correction-value" className="label-sm">
                  New value
                </label>
                <input
                  id="correction-value"
                  value={newValue}
                  onChange={(event) => setNewValue(event.target.value)}
                  className={`${FIELD} ${FOCUS_RING}`}
                />
              </div>

              <div>
                <label htmlFor="correction-reason" className="label-sm">
                  Correction reason
                </label>
                <textarea
                  id="correction-reason"
                  required
                  rows={3}
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  className={`${FIELD} ${FOCUS_RING}`}
                />
                <p className="mt-1 text-xs text-muted">
                  Required. A change with no stated reason is indistinguishable from tampering.
                </p>
              </div>

              <button
                type="submit"
                disabled={correcting || correctionReason.trim() === ""}
                className={`${ACTION_PRIMARY} ${FOCUS_RING}`}
              >
                {correcting ? "Recording…" : "Record correction"}
              </button>
            </form>
          </div>

          <div className="flex flex-col gap-3 border border-rule px-4 py-3.5">
            <span className="label-sm">Corrections</span>
            {corrections.length === 0 ? (
              <p className="text-sm text-muted">Nothing on this record has been corrected.</p>
            ) : (
              // Text only. There is no edit control because there is no edit
              // path: the database raises on UPDATE and DELETE of these rows.
              <ol data-testid="corrections-history" className="divide-y divide-rule border-y border-rule">
                {corrections.map((correction) => (
                  <li key={correction.id} className="py-3">
                    <p className="label-sm">
                      {formatStamp(correction.created_at)} ·{" "}
                      {correction.operator_email ?? "operator removed"}
                    </p>
                    <p className="mt-1 text-sm text-ink">
                      <span className="font-semibold">
                        {correction.target_table}.{correction.field}
                      </span>{" "}
                      — {correction.old_value ?? "∅"} → {correction.new_value ?? "∅"}
                    </p>
                    <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
                      {correction.reason}
                    </p>
                    {correction.dispute_id !== null && (
                      // The reference is shown only when this page already
                      // resolved that dispute. Fetching one per row to print a
                      // label would be a query per line of an audit log.
                      <p
                        data-testid={`correction-dispute-${correction.id}`}
                        className="label-sm mt-1"
                      >
                        Prompted by dispute
                        {dispute !== null && dispute.dispute.id === correction.dispute_id
                          ? ` ${dispute.dispute.reference}`
                          : ""}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </>
  );
}
