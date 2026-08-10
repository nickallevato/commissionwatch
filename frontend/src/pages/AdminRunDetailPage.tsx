import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PressroomCard, PressroomShell } from "@/components/PressroomShell";
import type {
  IngestionJobStatus,
  IngestionRunStatus,
  ReparseResult,
  RunDetail,
} from "@/types";

/**
 * `/admin/runs/:id` — one ingestion run, and what it did or failed to do.
 *
 * **Partial stays green with a red row.** A run that parsed 34 of 37 documents
 * is a success with a footnote; collapsing it to "failed" trains the operator
 * to ignore the status, and then the real failure goes unread. So the headline
 * keeps the `pass` treatment and says "Partial", and every failed job is listed
 * underneath in accent with its error text reproduced verbatim.
 *
 * **Re-parse is not a sweep.** The button here replays the bytes already
 * stored against this run's artifacts. The `parse` stage cannot dereference a
 * URL, so no request reaches the county's server — that is a property of the
 * queue's target validation, not a promise made by this page.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonClass =
  "border border-ink bg-ink px-4 py-2.5 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const HEADLINE_LABEL: Record<IngestionRunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
};

/**
 * `partial` shares `succeeded`'s green deliberately. `text-accent` — the
 * failure treatment — belongs to `failed` alone.
 */
const HEADLINE_CLASS: Record<IngestionRunStatus, string> = {
  running: "text-ink",
  succeeded: "text-pass",
  partial: "text-pass",
  failed: "text-accent",
};

const JOB_STATUSES: readonly IngestionJobStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
];

type LoadResult = { ok: true; detail: RunDetail } | { ok: false };

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function AdminRunDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reparsing, setReparsing] = useState(false);
  const [notice, setNotice] = useState("");

  // Fetching and applying are separated so the effect below can await the
  // request and touch state only in the continuation. An effect body that calls
  // setState synchronously causes a cascading render, and — worse here — a fast
  // unmount would set state on a component that is already gone.
  const fetchRun = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch(`/api/admin/pressroom/runs/${id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as RunDetail;
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
      setError("That run could not be loaded.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const result = await fetchRun();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchRun]);

  async function handleReparse() {
    setReparsing(true);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/runs/${id}/reparse`, {
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
      <h1 className="headline text-3xl sm:text-4xl mt-1">Ingestion run</h1>
      <div className="rule-hi mt-4" role="presentation" />

      {error && (
        <p
          role="alert"
          className="mt-6 border-l-2 border-accent bg-paper px-4 py-3 text-sm text-ink-soft"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 label-sm" role="status">
          Loading run…
        </p>
      ) : detail === null ? null : (
        <>
          <PressroomCard className="mt-8">
            <p className="label-sm">
              {detail.source.adapter_key} · {detail.source.jurisdiction_name}
            </p>
            <p
              data-testid="run-headline"
              data-headline={detail.outcome.headline}
              className={`mt-2 font-display text-3xl font-semibold ${HEADLINE_CLASS[detail.outcome.headline]}`}
            >
              {HEADLINE_LABEL[detail.outcome.headline]}
            </p>

            {detail.outcome.headline === "partial" && (
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
                A partial run is a success with a footnote. What it did keep is
                real; the failures are listed below and nothing has been rounded
                away in either direction.
              </p>
            )}

            <dl className="mt-6 grid gap-4 sm:grid-cols-4">
              <div>
                <dt className="label-sm">Records</dt>
                <dd className="mt-1 figure text-lg text-ink">{detail.outcome.records}</dd>
              </div>
              <div>
                <dt className="label-sm">Failures</dt>
                <dd
                  className={`mt-1 figure text-lg ${
                    detail.outcome.failures > 0 ? "text-accent" : "text-ink"
                  }`}
                >
                  {detail.outcome.failures}
                </dd>
              </div>
              <div>
                <dt className="label-sm">Started</dt>
                <dd className="mt-1 text-sm text-ink tabular">{formatStamp(detail.run.started_at)}</dd>
              </div>
              <div>
                <dt className="label-sm">Finished</dt>
                <dd className="mt-1 text-sm text-ink tabular">{formatStamp(detail.run.finished_at)}</dd>
              </div>
            </dl>

            {detail.run.error && (
              <p className="mt-5 border-l-2 border-accent px-4 py-2 text-sm text-accent">
                {detail.run.error}
              </p>
            )}

            <p className="mt-6">
              <Link
                to="/admin/sources"
                className={`text-sm text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
              >
                All ingestion sources
              </Link>
            </p>
          </PressroomCard>

          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Jobs</h2>
            <p className="mt-1 label-sm">{detail.jobs.total} in this run</p>

            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
              {JOB_STATUSES.map((status) => (
                <div key={status}>
                  <dt className="label-sm">{status}</dt>
                  <dd
                    className={`mt-1 figure text-lg ${
                      (status === "failed" || status === "blocked") &&
                      (detail.jobs.by_status[status] ?? 0) > 0
                        ? "text-accent"
                        : "text-ink"
                    }`}
                  >
                    {detail.jobs.by_status[status] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>

            {detail.jobs.by_stage.length > 0 && (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[24rem] border-collapse text-left">
                  <caption className="sr-only">Jobs by stage and status</caption>
                  <thead>
                    <tr className="border-b border-rule">
                      <th scope="col" className="label-sm py-2 pr-4">Stage</th>
                      <th scope="col" className="label-sm py-2 pr-4">Status</th>
                      <th scope="col" className="label-sm py-2">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {detail.jobs.by_stage.map((row) => (
                      <tr key={`${row.stage}:${row.status}`}>
                        <td className="py-2 pr-4 text-sm text-ink">{row.stage}</td>
                        <td className="py-2 pr-4 text-sm text-ink-soft">{row.status}</td>
                        <td className="py-2 figure text-sm text-ink">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PressroomCard>

          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Failed jobs</h2>
            {detail.failures.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No job in this run failed.</p>
            ) : (
              <ul className="mt-4 divide-y divide-rule border-y border-rule">
                {detail.failures.map((failure) => (
                  <li key={failure.id} className="py-4">
                    <p className="text-sm font-semibold text-accent">
                      {failure.stage} · {failure.status}
                    </p>
                    <p className="mt-1 label-sm">
                      {failure.attempts} attempt{failure.attempts === 1 ? "" : "s"} · next{" "}
                      {formatStamp(failure.next_attempt_at)}
                    </p>
                    {/* Verbatim. A paraphrased error is a second bug to debug. */}
                    <p className="mt-2 max-w-prose whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-accent">
                      {failure.last_error ?? "No error text was recorded."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </PressroomCard>

          <PressroomCard className="mt-6">
            <h2 className="font-display text-xl font-semibold text-ink">Re-parse</h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
              Replays this run&rsquo;s stored artifacts through the parser.{" "}
              <strong className="font-semibold text-ink">
                No request is made to the source.
              </strong>{" "}
              The bytes are already hashed and held, so the result is reproducible
              and the county&rsquo;s server never hears about it. To go back out to
              the source, use Sweep now on the sources screen.
            </p>

            <button
              type="button"
              onClick={() => void handleReparse()}
              disabled={reparsing}
              className={`mt-4 ${buttonClass} ${focusRing}`}
            >
              {reparsing ? "Re-parsing…" : "Re-parse stored bytes"}
            </button>

            {notice && (
              <p role="status" className="mt-4 border-l-2 border-ink px-4 py-2 text-sm text-ink-soft">
                {notice}
              </p>
            )}
          </PressroomCard>
        </>
      )}
    </PressroomShell>
  );
}
