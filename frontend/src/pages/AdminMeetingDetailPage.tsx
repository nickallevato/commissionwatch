import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { PressroomCard, PressroomShell } from "@/components/PressroomShell";
import type {
  ConfidenceLevel,
  CorrectionTargetTable,
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
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fieldClass =
  "mt-1.5 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink hover:border-ink";

const buttonClass =
  "border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

/** low is the accent because low is the one that needs a human. */
const LEVEL_CLASS: Record<ConfidenceLevel, string> = {
  high: "text-pass",
  medium: "text-ink-soft",
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

  const selectedTarget = targets.find((target) => target.key === targetKey) ?? targets[0];
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

  return (
    <PressroomShell>
      <p className="kicker">Pressroom</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Meeting record</h1>
      <div className="rule-hi mt-4" role="presentation" />

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
          Loading meeting…
        </p>
      ) : detail === null ? null : (
        <>
          <PressroomCard className="mt-8">
            <p className="label-sm">
              {detail.jurisdiction.name}, {detail.jurisdiction.state} · {detail.commission.name}
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink tabular">
              {formatStamp(detail.meeting.date)}
            </h2>

            <dl className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="label-sm">Status</dt>
                <dd className="mt-1 text-sm text-ink">{detail.meeting.status}</dd>
              </div>
              <div>
                <dt className="label-sm">Location</dt>
                <dd className="mt-1 text-sm text-ink">{detail.meeting.location ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt className="label-sm">External id</dt>
                <dd className="mt-1 text-sm text-ink break-words">
                  {detail.meeting.external_id ?? "None"}
                </dd>
              </div>
            </dl>
          </PressroomCard>

          {/* Decision 8. */}
          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Publication</h2>
            {detail.meeting.published_at === null ? (
              <>
                <p data-testid="publication-state" className="mt-2 text-sm font-semibold text-accent">
                  Ingested, not published
                </p>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                  This record exists here and nowhere else. Ingestion produced a
                  candidate; publishing it is a decision, and the reason you give
                  is kept with it. Publishing over a known defect is allowed —
                  say so in the reason.
                </p>
              </>
            ) : (
              <>
                <p data-testid="publication-state" className="mt-2 text-sm font-semibold text-pass">
                  Published {new Date(detail.meeting.published_at).toLocaleString()}
                </p>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                  Live on the public site. Withdrawing it removes it from every
                  public response; the record and its history stay here.
                </p>
              </>
            )}

            <div className="mt-4 max-w-lg">
              <label htmlFor="publication-reason" className="label-sm">
                Publication reason
              </label>
              <input
                id="publication-reason"
                value={publishReason}
                onChange={(event) => setPublishReason(event.target.value)}
                className={`${fieldClass} ${focusRing}`}
              />
              <p className="mt-1 text-xs text-muted">
                Required. It is written to the correction log against{" "}
                <code>published_at</code>.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                void handlePublication(
                  detail.meeting.published_at === null ? "publish" : "unpublish",
                )
              }
              disabled={publishing || publishReason.trim() === ""}
              className={`mt-4 ${buttonClass} ${focusRing}`}
            >
              {detail.meeting.published_at === null ? "Publish" : "Unpublish"}
            </button>
          </PressroomCard>

          {/* Decision 6. */}
          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Agenda items</h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              Confidence is marked field by field. There is no score for an item
              and none for the meeting, because one mangled title says nothing
              about the six items either side of it.
            </p>

            {detail.agenda_items.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No agenda item was extracted.</p>
            ) : (
              <ul className="mt-4 divide-y divide-rule border-y border-rule">
                {detail.agenda_items.map((item) => {
                  const marks = Object.entries(item.field_confidence);
                  return (
                    <li key={item.id} className="py-4">
                      <p className="text-sm font-semibold text-ink">
                        <span className="figure">{item.item_number}</span> · {item.title}
                      </p>
                      {item.description && (
                        <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
                          {item.description}
                        </p>
                      )}
                      {marks.length === 0 ? (
                        <p className="mt-2 text-xs text-muted">
                          No confidence was recorded for any field of this item.
                        </p>
                      ) : (
                        <ul className="mt-3 flex flex-wrap gap-2">
                          {marks.map(([fieldName, mark]) => (
                            <li
                              key={fieldName}
                              data-testid={`confidence-${item.id}-${fieldName}`}
                              data-field={fieldName}
                              data-level={mark.level}
                              className="cite max-w-full"
                              title={`${fieldName}: ${mark.level} — ${mark.reason}`}
                            >
                              <span className="font-semibold text-ink">{fieldName}</span>
                              <span className={LEVEL_CLASS[mark.level]}>{mark.level}</span>
                              <span className="text-muted">{mark.reason}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </PressroomCard>

          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Documents and artifacts</h2>
            {detail.documents.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No document is linked to this meeting.</p>
            ) : (
              <ul className="mt-3 divide-y divide-rule border-y border-rule">
                {detail.documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                    <span className="text-sm text-ink">{doc.title}</span>
                    <a
                      href={doc.url}
                      className={`cite ${focusRing}`}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {doc.document_type}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {detail.artifacts.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No artifact bytes are stored for this meeting.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[32rem] border-collapse text-left">
                  <caption className="sr-only">Stored artifacts backing this meeting</caption>
                  <thead>
                    <tr className="border-b border-rule">
                      <th scope="col" className="label-sm py-2 pr-4">SHA-256</th>
                      <th scope="col" className="label-sm py-2 pr-4">Type</th>
                      <th scope="col" className="label-sm py-2 pr-4">Bytes</th>
                      <th scope="col" className="label-sm py-2">Fetched</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {detail.artifacts.map((artifact) => (
                      <tr key={artifact.id}>
                        <td className="py-2 pr-4 font-mono text-xs text-ink-soft">
                          {artifact.sha256.slice(0, 12)}…
                        </td>
                        <td className="py-2 pr-4 text-sm text-ink-soft">
                          {artifact.content_type ?? "unknown"}
                        </td>
                        <td className="py-2 pr-4 figure text-sm text-ink">{artifact.byte_size}</td>
                        <td className="py-2 text-sm text-ink tabular">
                          {formatStamp(artifact.fetched_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
              Re-parsing replays these stored bytes.{" "}
              <strong className="font-semibold text-ink">No request is made to the source.</strong>{" "}
              The artifact itself is never rewritten — a correction changes the
              parsed record and leaves the evidence alone.
            </p>
            <button
              type="button"
              onClick={() => void handleReparse()}
              disabled={reparsing}
              className={`mt-4 ${buttonClass} ${focusRing}`}
            >
              {reparsing ? "Re-parsing…" : "Re-parse stored bytes"}
            </button>
          </PressroomCard>

          {/* Decision 7. */}
          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Record a correction</h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              A correction appends. The old value, the new one and your reason
              are kept forever; the stored artifact is not touched, because a
              transparency project that edits its own evidence has nothing left
              to stand on.
            </p>

            <form onSubmit={handleCorrection} className="mt-4 max-w-lg space-y-5">
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
                  className={`${fieldClass} ${focusRing}`}
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
                  className={`${fieldClass} ${focusRing}`}
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
                  className={`${fieldClass} ${focusRing}`}
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
                  className={`${fieldClass} ${focusRing}`}
                />
                <p className="mt-1 text-xs text-muted">
                  Required. A change with no stated reason is indistinguishable
                  from tampering.
                </p>
              </div>

              <button
                type="submit"
                disabled={correcting || correctionReason.trim() === ""}
                className={`${buttonClass} ${focusRing}`}
              >
                {correcting ? "Recording…" : "Record correction"}
              </button>
            </form>
          </PressroomCard>

          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Corrections</h2>
            {corrections.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing on this record has been corrected.</p>
            ) : (
              // Text only. There is no edit control because there is no edit
              // path: the database raises on UPDATE and DELETE of these rows.
              <ol
                data-testid="corrections-history"
                className="mt-4 divide-y divide-rule border-y border-rule"
              >
                {corrections.map((correction) => (
                  <li key={correction.id} className="py-4">
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
                  </li>
                ))}
              </ol>
            )}
          </PressroomCard>
        </>
      )}
    </PressroomShell>
  );
}
