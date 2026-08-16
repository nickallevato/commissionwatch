import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  FlagBar,
  FOCUS_RING,
  KeyValues,
  LogTail,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
  type Severity,
} from "@/components/PressroomUI";
import { formatTimestamp } from "@/lib/dates";
import type { IngestionRunStatus, ReparseResult, RunDetail } from "@/types";

/**
 * `/admin/runs/:id` — one ingestion run, and what it did or failed to do.
 * Screen 03 of the approved mockup.
 *
 * **Partial stays green with a red row.** A run that parsed 34 of 37 documents
 * is a success with a footnote; collapsing it to "failed" trains the operator
 * to ignore the status, and then the real failure goes unread. So the headline
 * keeps the `pass` treatment and says "Partial", the stage table shows one red
 * row against five green ones, and every failed job is reproduced verbatim.
 *
 * **Re-parse is not a sweep.** The button here replays the bytes already
 * stored against this run's artifacts. The `parse` stage cannot dereference a
 * URL, so no request reaches the county's server — that is a property of the
 * queue's target validation, not a promise made by this page.
 *
 * **The provenance panel says "Not recorded" rather than guessing.** The
 * mockup shows a robots check, a rate limit, a user agent, an artifact count
 * and a deploy sha. `GET /pressroom/runs/:id` carries the adapter and nothing
 * else, and a transparency project that invents its own operational figures
 * has nothing left to stand on. The rows stay, empty and labelled.
 */

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

/**
 * How far along a sweep is, and — while it runs — how much longer.
 *
 * A sweep fetches at the crawl-delay we publish, so it is slow on purpose and a
 * screen with no progress on it is indistinguishable from a screen with a stuck
 * job on it. Bozeman's first run made this concrete: 89 documents in 15 minutes,
 * 339 still queued, and nothing anywhere said so until the run had already
 * ended and written it into an error string.
 *
 * The rate is **observed**, computed from this run's own elapsed time and its
 * own completed jobs, rather than assumed from a configured delay. A configured
 * number would keep saying "10s per document" while the source throttled us to
 * thirty, and the estimate would get more confident as it got more wrong.
 */
function SweepProgress({ detail, readAt }: { detail: RunDetail; readAt: number }) {
  const { by_status: byStatus, total } = detail.jobs;
  const done = byStatus.done;
  const outstanding = byStatus.pending + byStatus.running;
  const running = detail.run.status === "running";

  if (total === 0) return null;

  // `readAt` is stamped when the payload arrived, not read during render:
  // `Date.now()` here is impure and the lint rule that says so is a CI gate.
  // It is also the more correct number — the elapsed time belongs to the data
  // on screen, not to whenever React last decided to paint.
  const elapsedMs =
    (detail.run.finished_at === null ? readAt : new Date(detail.run.finished_at).getTime()) -
    new Date(detail.run.started_at).getTime();
  const perJobMs = done > 0 && elapsedMs > 0 ? elapsedMs / done : null;
  const etaMs = running && perJobMs !== null ? perJobMs * outstanding : null;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section
      className="border border-rule bg-paper-sunk px-4 py-3"
      aria-label="Sweep progress"
      data-testid="sweep-progress"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="label-sm">
          {running ? "Sweeping" : "Progress"} · {done} of {total} jobs
        </span>
        <span className="font-mono text-[12px] tabular text-ink-soft">
          {percent}%
          {outstanding > 0 && ` · ${outstanding} queued`}
        </span>
      </div>

      <div
        className="mt-2 h-2 w-full border border-rule bg-paper"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Jobs completed"
      >
        <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
      </div>

      <p className="mt-2 max-w-prose text-[11.5px] leading-relaxed text-muted">
        {running ? (
          <>
            Refreshing every 5 seconds.
            {perJobMs !== null && (
              <>
                {" "}
                Observed rate <b className="font-mono tabular">{(perJobMs / 1000).toFixed(1)}s</b> per
                job
                {etaMs !== null && (
                  <>
                    {" "}
                    — about <b className="font-mono tabular">{humanDuration(etaMs)}</b> of work left
                    at that rate.
                  </>
                )}
              </>
            )}
          </>
        ) : outstanding > 0 ? (
          <>
            This run stopped with <b className="font-mono tabular">{outstanding}</b> job
            {outstanding === 1 ? "" : "s"} still queued — it reached its time limit rather than
            failing. Nothing is lost: queued work is claimed oldest-first, so the next sweep
            continues where this one stopped. Stored bytes are parsed continuously and need no
            sweep at all.
          </>
        ) : (
          <>Every job in this run reached a terminal state.</>
        )}
      </p>
    </section>
  );
}

/** Rounded to the largest useful unit. An ETA to the second is false precision. */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** A stage row's pill. Only `failed` and `blocked` are red. */
function stageTone(status: string): Severity | "plain" {
  if (status === "failed") return "bad";
  if (status === "blocked") return "warn";
  if (status === "done") return "ok";
  if (status === "running") return "plain";
  return "idle";
}

type LoadResult = { ok: true; detail: RunDetail } | { ok: false };

function formatStamp(value: string | null): string {
  if (!value) return "—";
  return formatTimestamp(value);
}

function duration(started: string, finished: string | null): string {
  if (!finished) return "still running";
  const seconds = (new Date(finished).getTime() - new Date(started).getTime()) / 1000;
  return `${seconds.toFixed(1)}s`;
}

export function AdminRunDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  /** When the payload on screen arrived. Stamped on apply, never in render. */
  const [readAt, setReadAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reparsing, setReparsing] = useState(false);
  const [sweeping, setSweeping] = useState(false);
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
      setReadAt(Date.now());
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

  /**
   * While a run is running, this screen is a monitor.
   *
   * A sweep at a published crawl-delay is slow by design — Bozeman's first one
   * took 89 documents at 10 seconds each — so a static page is a page an
   * operator reloads by hand while wondering whether anything is happening.
   * Polling stops the moment the run reaches a terminal status, so a finished
   * run costs nothing.
   *
   * Five seconds: fast enough that the tallies visibly move at a ten-second
   * fetch rate, slow enough that watching a long sweep is not a request per
   * second for an hour.
   */
  const isRunning = detail?.run.status === "running";
  useEffect(() => {
    if (!isRunning) return;
    let ignore = false;
    const timer = setInterval(() => {
      void (async () => {
        const result = await fetchRun();
        if (ignore) return;
        applyResult(result);
      })();
    }, 5000);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [isRunning, applyResult, fetchRun]);

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

  /** Goes out to the source. The one action on this screen that does. */
  async function handleSweep(sourceId: string, adapterKey: string) {
    setSweeping(true);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/sources/${sourceId}/sweep`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 409) {
        setNotice(`A sweep of ${adapterKey} is already in flight.`);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? `${adapterKey} could not be swept.`);
        return;
      }
      const body = (await res.json()) as { outcome: { kind: string } };
      setNotice(`Sweep of ${adapterKey} started — ${body.outcome.kind}.`);
    } catch {
      setNotice("The sweep request could not be sent.");
    } finally {
      setSweeping(false);
    }
  }

  return (
    <>
      <WorkTitle
        title={detail ? `${detail.source.adapter_key} — sweep` : "Ingestion run"}
        stamp={
          detail
            ? `${detail.run.id} · started ${formatStamp(detail.run.started_at)} · ${duration(
                detail.run.started_at,
                detail.run.finished_at,
              )}`
            : undefined
        }
      />

      {error && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          {error}
        </p>
      )}

      {loading ? (
        <p className="label-sm" role="status">
          Loading run…
        </p>
      ) : detail === null ? null : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <p
              data-testid="run-headline"
              data-headline={detail.outcome.headline}
              className={`font-display text-3xl font-semibold ${HEADLINE_CLASS[detail.outcome.headline]}`}
            >
              {HEADLINE_LABEL[detail.outcome.headline]}
            </p>
            <p className="label-sm">
              {detail.source.jurisdiction_name} ·{" "}
              <Link
                to="/admin/sources"
                className={`underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-accent ${FOCUS_RING}`}
              >
                All sources
              </Link>
            </p>
          </div>

          <SweepProgress detail={detail} readAt={readAt} />

          {detail.outcome.headline === "partial" && detail.outcome.failures > 0 && (
            <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
              A partial run is a success with a footnote. What it did keep is
              real; the failures are listed below and nothing has been rounded
              away in either direction.
            </p>
          )}

          {/* The action row. Two of these four have no endpoint, so they render
              disabled with the reason stated — the same honesty the sign-in
              page's SSO buttons use. A button that silently does nothing is
              worse than one that says it cannot yet. */}
          <div className={ACTION_ROW}>
            <button
              type="button"
              onClick={() => void handleSweep(detail.run.source_id, detail.source.adapter_key)}
              disabled={sweeping}
              className={`${ACTION_PRIMARY} ${FOCUS_RING}`}
            >
              {sweeping ? "Sweeping…" : "Run sweep now"}
            </button>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="No retry endpoint exists yet. Re-parse replays the whole run's stored bytes."
              className={ACTION}
            >
              Retry {detail.outcome.failures} failed job
              {detail.outcome.failures === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="No backfill endpoint exists yet."
              className={ACTION}
            >
              Backfill date range…
            </button>
            <button
              type="button"
              onClick={() => void handleReparse()}
              disabled={reparsing}
              className={`${ACTION_QUIET} ${FOCUS_RING}`}
            >
              {reparsing ? "Re-parsing…" : "Re-parse stored bytes"}
            </button>
          </div>
          <p className="max-w-prose text-[11.5px] leading-relaxed text-muted">
            Retry and backfill are drawn because they are the shape of this row
            and are not wired to anything — there is no endpoint behind either.
            Re-parse replays this run&rsquo;s stored artifacts through the parser.{" "}
            <strong className="font-semibold text-ink">
              No request is made to the source.
            </strong>{" "}
            The bytes are already hashed and held, so the result is reproducible
            and the county&rsquo;s server never hears about it.
          </p>

          {notice && (
            <p role="status" className="border-l-2 border-ink bg-paper-sunk px-4 py-3 text-sm text-ink-soft">
              {notice}
            </p>
          )}

          <Tiles>
            <Tile label="Records" value={detail.outcome.records} />
            <Tile
              label="Failures"
              value={detail.outcome.failures}
              tone={detail.outcome.failures > 0 ? "bad" : "plain"}
            />
            <Tile label="Jobs" value={detail.jobs.total} sub="in this run" />
            <Tile
              label="Finished"
              value={detail.run.finished_at ? duration(detail.run.started_at, detail.run.finished_at) : "—"}
              small
              sub={detail.run.finished_at ? formatStamp(detail.run.finished_at) : "still running"}
            />
          </Tiles>

          {detail.run.error && (
            <p className="border-l-2 border-accent bg-accent-50 px-4 py-2 text-sm text-accent">
              {detail.run.error}
            </p>
          )}

          {/* The split: the job ledger on paper, the provenance on the sunk
              ground beside it. */}
          <div className="grid grid-cols-1 border border-rule lg:grid-cols-[1.35fr_1fr]">
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <span className="label-sm">Jobs</span>
              {detail.jobs.by_stage.length === 0 ? (
                <p className="text-sm text-muted">No job was enqueued in this run.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[22rem] border-collapse text-left text-[13px]">
                    <caption className="sr-only">Jobs by stage and status</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="label-sm border-b border-rule py-2 pr-3">Stage</th>
                        <th scope="col" className="label-sm border-b border-rule py-2 pr-3">State</th>
                        <th scope="col" className="label-sm border-b border-rule py-2 text-right">Items</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.jobs.by_stage.map((row) => (
                        <tr
                          key={`${row.stage}:${row.status}`}
                          className={`border-b border-rule last:border-b-0 ${
                            row.status === "failed" ? "bg-accent-50" : row.status === "blocked" ? "bg-paper-sunk" : ""
                          }`}
                        >
                          <td className="py-2 pr-3 text-ink">{row.stage}</td>
                          <td className="py-2 pr-3">
                            <StatusPill tone={stageTone(row.status)}>{row.status}</StatusPill>
                          </td>
                          <td className="py-2 text-right figure text-ink">{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-rule bg-paper-sunk px-4 py-3.5 lg:border-l lg:border-t-0">
              <span className="label-sm">Provenance</span>
              <KeyValues
                testId="provenance"
                items={[
                  { key: "Adapter", value: detail.source.adapter_key },
                  { key: "Jurisdiction", value: detail.source.jurisdiction_name },
                  { key: "Run id", value: detail.run.id },
                  { key: "Robots", value: "Not recorded on the run" },
                  { key: "Rate limit", value: "Not recorded on the run" },
                  { key: "User-agent", value: "Not recorded on the run" },
                  { key: "Artifacts", value: "Not recorded on the run" },
                  { key: "Triggered by", value: "Not recorded on the run" },
                  { key: "Deploy sha", value: "Not recorded on the run" },
                ]}
              />
              <p className="max-w-prose text-[11px] leading-relaxed text-muted">
                Six of these are shown in the design and are not stored against a
                run. They are listed empty rather than filled with a plausible
                default, because a fabricated provenance line is worse than a
                missing one.
              </p>

              <span className="label-sm mt-1">Tail</span>
              <LogTail testId="log-tail">
                {detail.failures.length === 0
                  ? `${detail.run.id}  ${HEADLINE_LABEL[
                      detail.outcome.headline
                    ].toLowerCase()}  ${detail.outcome.records} records · 0 failures\nNo job in this run failed.`
                  : detail.failures
                      .map(
                        (failure) =>
                          `${failure.stage}  ERROR  ${failure.last_error ?? "No error text was recorded."}`,
                      )
                      .join("\n")}
              </LogTail>
              <p className="max-w-prose text-[11px] leading-relaxed text-muted">
                There is no log stream behind this console. What is above is the
                failed jobs&rsquo; own error text, verbatim — the only real log the
                run kept.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 border border-rule px-4 py-3.5">
            <span className="label-sm">Failed jobs</span>
            {detail.failures.length === 0 ? (
              <p className="text-sm text-muted">No job in this run failed.</p>
            ) : (
              <ul className="divide-y divide-rule border-y border-rule">
                {detail.failures.map((failure) => (
                  <li key={failure.id} className="py-3">
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
          </div>

          <FlagBar label="Nothing published" tone={detail.outcome.failures > 0 ? "warn" : "idle"}>
            An ingestion run publishes nothing on its own. A finding that names a
            person is written held and waits in the{" "}
            <Link
              to="/admin/review"
              className={`font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${FOCUS_RING}`}
            >
              review queue
            </Link>
            ; a meeting record stays a candidate until an operator publishes it,
            giving a reason.
          </FlagBar>
        </>
      )}
    </>
  );
}
