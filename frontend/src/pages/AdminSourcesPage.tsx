import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  FOCUS_RING,
  StatusPill,
  WorkTitle,
  type Severity,
} from "@/components/PressroomUI";
import { formatTimestamp } from "@/lib/dates";
import { outstandingIn, processedIn } from "@/lib/ingestion-counts";
import type { PressroomSource, QueueStats, RecentRun, SweepOutcome } from "@/types";

/**
 * `/admin/sources` — the single most important screen in the product.
 *
 * Rebuilt to the approved mockup (2026-08-16), which replaced the previous
 * tile grid / fourteen-bar sparkline / verdict-pill layout the operator called
 * "messy and confusing." The removal of that ornament *is* the change; this
 * file does not bring any of it back.
 *
 * The mockup reads top to bottom in a deliberate order, because the order is
 * the diagnosis: what is happening **right now** (the live block), what the
 * **shared queue** looks like (the thing that actually decides whose jobs run,
 * since `ingestion_jobs` is claimed globally and oldest-first — see
 * `backend/src/services/pressroom/queue-stats.ts`), each **source**, then the
 * **history** that shows a pattern repeating across sweeps. A per-source view
 * alone could not show `gallatin-civicplus` reading healthy for days while its
 * own queue was starved by `bozeman-granicus`'s older backlog — that bug is a
 * property of the queue and the history, not of any one row.
 *
 * Three decisions from the previous layout are load-bearing and are
 * re-expressed here, not dropped:
 *
 * 1. **Zero is a failure state.** `lifetime_records` of 0 still renders in the
 *    failure colour, as the facts line's `collected` item.
 * 2. **Silence watch.** A source past its own expected interval since its last
 *    success still reads as a concern, in both the state line and the facts
 *    line — and the expected interval travels with it, because a bare
 *    "22 h ago" is not checkable without it.
 * 3. **Disabled sources stay listed**, with the reason they are off.
 *
 * Two figures the mockup drew do not exist and are not faked here: a
 * jobs/minute rate (nothing measures it) and a "Stop sweep" control (nothing
 * can do it). `drained_last_hour` is real and stands in its place. The
 * mockup's per-row "next HH:MM" is also not shown — the API returns a cron
 * expression, not a computed next-fire time, and inventing one would be
 * exactly the failure this project exists to report on; the cron expression
 * is shown instead, which is the real fact behind it.
 */

const SWEEP_BUDGET_MS = 15 * 60 * 1000; // backend/src/services/ingestion/scheduler.ts `sweepTimeoutMs` default

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A relative age, computed from real timestamps only — never from a bare
 * `Locale*` call (that guard lives in `lib/dates.test.ts`) and never a new
 * shared formatter (`lib/dates.ts` has none for durations; this is arithmetic
 * on an instant, not a calendar rendering, so it stays local to this page).
 */
function agoLabel(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const ms = Math.max(0, nowMs - then);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return pluralize(minutes, "min");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

/** `MM:SS`, for the live block's elapsed-vs-budget clock. */
function clockLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** A thin, accessible split bar. Decorative to the a11y tree; `label` carries the figures in words. */
function SplitBar({
  segments,
  label,
  testId,
}: {
  segments: Array<{ pct: number; className: string }>;
  label: string;
  testId?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testId}
      className="flex h-3 w-full overflow-hidden border border-rule-strong bg-paper-sunk"
    >
      {segments.map((segment, index) => (
        <i key={index} aria-hidden="true" className={`block h-full ${segment.className}`} style={{ width: `${segment.pct}%` }} />
      ))}
    </span>
  );
}

type LoadResult<T> = { ok: true; data: T } | { ok: false };

async function fetchJson<T>(url: string): Promise<LoadResult<T>> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return { ok: false };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false };
  }
}

export function AdminSourcesPage() {
  const [sources, setSources] = useState<PressroomSource[]>([]);
  const [sourcesError, setSourcesError] = useState(false);
  const [loading, setLoading] = useState(true);

  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [queueError, setQueueError] = useState(false);

  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [runsError, setRunsError] = useState(false);

  const [sweeping, setSweeping] = useState("");
  /** The source whose enable/disable form is open, if any. */
  const [toggling, setToggling] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /**
   * When this round of data was read. Doubles as "now" for every relative
   * figure on the page (elapsed, ago, oldest-job age) so those figures never
   * drift against each other mid-render, and as the freshness ticker beside
   * the title — the one spot this page is allow-listed in `lib/dates.test.ts`
   * for a bare `toLocaleTimeString`, because that is a live local-clock
   * reading, not a stored record's timestamp.
   */
  const [readAt, setReadAt] = useState<number | null>(null);

  /**
   * The three fetches, with no side effects of their own — so the mount
   * effect below can await it without a synchronous `setState` in the effect
   * body, which the lint rule `react-hooks/set-state-in-effect` refuses.
   */
  const fetchAll = useCallback(async () => {
    const [sourcesResult, queueResult, runsResult] = await Promise.all([
      fetchJson<{ data: PressroomSource[]; total: number }>("/api/admin/pressroom/sources"),
      fetchJson<QueueStats>("/api/admin/pressroom/queue"),
      fetchJson<{ data: RecentRun[]; total: number }>("/api/admin/pressroom/runs?limit=5"),
    ]);
    return { sourcesResult, queueResult, runsResult };
  }, []);

  const applyAll = useCallback(
    (results: Awaited<ReturnType<typeof fetchAll>>) => {
      const { sourcesResult, queueResult, runsResult } = results;

      if (sourcesResult.ok) {
        setSources(sourcesResult.data.data);
        setSourcesError(false);
      } else {
        setSourcesError(true);
      }

      if (queueResult.ok) {
        setQueue(queueResult.data);
        setQueueError(false);
      } else {
        setQueue(null);
        setQueueError(true);
      }

      if (runsResult.ok) {
        setRuns(runsResult.data.data);
        setRunsError(false);
      } else {
        setRuns([]);
        setRunsError(true);
      }

      setReadAt(Date.now());
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    // `loading` already starts true, so nothing needs setting on the way in —
    // setting it here would be the synchronous effect-body `setState` the
    // lint rule above exists to catch.
    let cancelled = false;
    void (async () => {
      const results = await fetchAll();
      if (cancelled) return;
      applyAll(results);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAll, applyAll]);

  /** Re-fetch after a write. Setting `loading` here is a response to a click, not an effect. */
  const reload = useCallback(async () => {
    setLoading(true);
    applyAll(await fetchAll());
  }, [fetchAll, applyAll]);

  // `readAt` is set in the same call that clears `loading`, so by the time any
  // of the sections below render, it is never null — the fallback here is
  // only to keep this a pure expression rather than a `Date.now()` call
  // during render, which the purity lint rule also refuses.
  const nowMs = readAt ?? 0;

  async function handleToggle(source: PressroomSource, reason: string) {
    setToggleBusy(true);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/sources/${source.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !source.enabled, reason }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? `${source.adapter_key} could not be changed.`);
        return;
      }

      setToggling("");
      setNotice(
        source.enabled
          ? `${source.adapter_key} is disabled. It will not sweep, and the reason is on its row.`
          : `${source.adapter_key} is enabled. It sweeps on its own cadence — use Sweep now for a first run.`,
      );
      await reload();
    } catch {
      setNotice("The change could not be sent.");
    } finally {
      setToggleBusy(false);
    }
  }

  async function handleSweep(source: PressroomSource) {
    setSweeping(source.id);
    setNotice("");
    try {
      const res = await fetch(`/api/admin/pressroom/sources/${source.id}/sweep`, {
        method: "POST",
        credentials: "same-origin",
      });

      if (res.status === 409) {
        setNotice(`A sweep of ${source.adapter_key} is already in flight.`);
        return;
      }
      if (res.status === 503) {
        setNotice("No ingestion stack is registered on this deployment, so nothing was swept.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice(body?.error ?? `${source.adapter_key} could not be swept.`);
        return;
      }

      const body = (await res.json()) as { outcome: SweepOutcome };
      setNotice(`Sweep of ${source.adapter_key} started — ${body.outcome.kind}.`);
      await reload();
    } catch {
      setNotice("The sweep request could not be sent.");
    } finally {
      setSweeping("");
    }
  }

  const enabledCount = useMemo(() => sources.filter((s) => s.enabled).length, [sources]);

  /** The run driving the live block, if any sweep is running right now. */
  const liveRun = useMemo(() => runs.find((run) => run.status === "running") ?? null, [runs]);

  return (
    <>
      <WorkTitle
        title="Sources"
        stamp={
          loading
            ? "loading…"
            : `${sources.length} registered · ${enabledCount} enabled · read ${
                readAt === null ? "—" : new Date(readAt).toLocaleTimeString()
              }`
        }
      />

      {sourcesError && (
        <p role="alert" className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-ink-soft">
          Ingestion sources could not be loaded.
        </p>
      )}

      {notice && (
        <p
          role="status"
          data-testid="notice"
          className="border-l-2 border-ink bg-paper-sunk px-4 py-3 text-sm text-ink-soft"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <p className="label-sm" role="status">
          Loading sources…
        </p>
      ) : (
        <>
          <LiveBlock run={liveRun} nowMs={nowMs} />

          <QueueSection queue={queue} queueError={queueError} />

          {sources.length === 0 ? (
            <p className="text-sm text-ink">No ingestion source is registered.</p>
          ) : (
            <section aria-label="All sources" className="flex flex-col border-t border-rule pt-5">
              {sources.map((source) => (
                <SourceItem
                  key={source.id}
                  source={source}
                  queue={queue}
                  queueError={queueError}
                  nowMs={nowMs}
                  sweeping={sweeping === source.id}
                  onSweep={() => void handleSweep(source)}
                  toggleOpen={toggling === source.id}
                  onToggleClick={() => {
                    setNotice("");
                    setToggling(toggling === source.id ? "" : source.id);
                  }}
                  toggleBusy={toggleBusy}
                  onToggleCancel={() => setToggling("")}
                  onToggleConfirm={(reason) => void handleToggle(source, reason)}
                />
              ))}
            </section>
          )}

          <HistoryTable runs={runs} runsError={runsError} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The live block
// ---------------------------------------------------------------------------

function LiveBlock({ run, nowMs }: { run: RecentRun | null; nowMs: number }) {
  if (run === null) {
    return (
      <p
        role="status"
        aria-live="polite"
        data-testid="live-idle"
        className="border-t border-rule pt-5 text-lg text-ink"
      >
        Nothing is sweeping.
      </p>
    );
  }

  const own = run.own_completed;
  const others = run.others_completed;
  const total = own + others;
  const ownPct = total === 0 ? 0 : Math.round((own / total) * 100);
  const othersPct = total === 0 ? 0 : 100 - ownPct;
  const elapsedMs = run.started_at === null ? 0 : Math.max(0, nowMs - new Date(run.started_at).getTime());

  return (
    <section
      aria-label="Currently sweeping"
      aria-live="polite"
      data-testid="live-block"
      className="flex flex-col gap-3 border-t border-rule pt-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="label-sm text-pass">Sweeping</span>
        <span className="font-mono text-xl font-semibold text-ink">{run.adapter_key}</span>
        <span className="ml-auto font-mono text-sm tabular text-muted" data-testid="live-clock">
          {clockLabel(elapsedMs)} / {clockLabel(SWEEP_BUDGET_MS)}
        </span>
      </div>

      <SplitBar
        testId="live-bar"
        label={`Of ${total} job${total === 1 ? "" : "s"} done so far, ${own} belong${own === 1 ? "s" : ""} to this source and ${others} belong${others === 1 ? "s" : ""} to other sources.`}
        segments={[
          { pct: ownPct, className: "bg-pass" },
          { pct: othersPct, className: "bg-rule-strong" },
        ]}
      />

      <p className="text-base text-ink-soft">
        <b
          data-testid="live-own"
          data-zero={own === 0 ? "true" : "false"}
          className={`figure ${own === 0 ? "font-semibold text-accent" : "text-ink"}`}
        >
          {own}
        </b>{" "}
        of its own jobs · <b className="figure text-ink">{others}</b> for other sources&rsquo; jobs
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const STAGE_COLORS = ["bg-ink-soft", "bg-pass", "bg-sev3", "bg-muted", "bg-accent"];

function QueueSection({ queue, queueError }: { queue: QueueStats | null; queueError: boolean }) {
  if (queueError) {
    return (
      <p
        role="alert"
        data-testid="queue-error"
        className="border-t border-rule px-0 pt-5 text-sm text-accent"
      >
        The queue could not be read. Source rows below still reflect the sources listing.
      </p>
    );
  }

  if (queue === null) {
    return null;
  }

  const stageTotal = queue.by_stage.reduce((total, stage) => total + stage.pending, 0);

  return (
    <section aria-label="The shared queue" className="flex flex-col gap-3 border-t border-rule pt-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="figure text-2xl font-semibold text-ink" data-testid="queue-depth">
          {queue.depth}
        </span>
        <span className="text-sm text-muted">jobs queued, claimed oldest-first across every source</span>
        {queue.oldest_pending_at !== null && (
          <span className="ml-auto text-sm font-semibold text-accent" data-testid="queue-oldest">
            oldest {formatTimestamp(queue.oldest_pending_at)}
          </span>
        )}
      </div>

      {queue.by_stage.length > 0 && (
        <>
          <SplitBar
            testId="queue-stage-bar"
            label={queue.by_stage
              .map((stage) => `${stage.pending} ${stage.stage} job${stage.pending === 1 ? "" : "s"} queued`)
              .join(", ")}
            segments={queue.by_stage.map((stage, index) => ({
              pct: stageTotal === 0 ? 0 : (stage.pending / stageTotal) * 100,
              className: STAGE_COLORS[index % STAGE_COLORS.length],
            }))}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular text-muted">
            {queue.by_stage.map((stage, index) => (
              <span key={stage.stage}>
                <i
                  aria-hidden="true"
                  className={`mr-1 inline-block h-2.5 w-2.5 ${STAGE_COLORS[index % STAGE_COLORS.length]}`}
                />
                {stage.stage} {stage.pending}
              </span>
            ))}
            <span>
              drained last hour <b className="text-ink">{queue.drained_last_hour}</b>
            </span>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Each source
// ---------------------------------------------------------------------------

function sourceState(source: PressroomSource): { text: string; tone: Severity | "plain" } {
  if (!source.enabled) return { text: "Off", tone: "idle" };
  if (source.latest_run?.status === "running") return { text: "Sweeping", tone: "ok" };

  const bits: string[] = [];
  if (source.silence.verdict === "suspect") bits.push("Suspect");
  if (source.consecutive_failures > 0) {
    bits.push(pluralize(source.consecutive_failures, "consecutive failure"));
  }
  return bits.length > 0
    ? { text: `Idle · ${bits.join(" · ")}`, tone: "warn" }
    : { text: "Idle", tone: "plain" };
}

/**
 * The archive, as its own pill.
 *
 * `sourceState` above is entirely about the machinery — Off, Sweeping, Idle,
 * how many consecutive failures. None of it can say the archive is empty, and
 * on 2026-08-16 a source sat at "Sweeping" and "0 collected, ever" with nothing
 * in the status line connecting those two facts.
 *
 * `null` for a disabled source: the Off pill has already said it, and two pills
 * saying the same thing is how an operator learns to stop reading pills.
 */
function collectionState(
  source: PressroomSource,
): { text: string; tone: Severity | "plain" } | null {
  switch (source.collection.verdict) {
    case "disabled":
      return null;
    case "empty":
      return { text: "No records", tone: "bad" };
    case "stalled":
      return { text: "No new records", tone: "warn" };
    case "collecting":
      return { text: "Collecting", tone: "ok" };
  }
}

function SourceItem({
  source,
  queue,
  queueError,
  nowMs,
  sweeping,
  onSweep,
  toggleOpen,
  onToggleClick,
  toggleBusy,
  onToggleCancel,
  onToggleConfirm,
}: {
  source: PressroomSource;
  queue: QueueStats | null;
  queueError: boolean;
  nowMs: number;
  sweeping: boolean;
  onSweep: () => void;
  toggleOpen: boolean;
  onToggleClick: () => void;
  toggleBusy: boolean;
  onToggleCancel: () => void;
  onToggleConfirm: (reason: string) => void;
}) {
  const state = sourceState(source);
  const archive = collectionState(source);
  const zero = source.lifetime_records === 0;
  const queueStat = queue?.by_source.find((s) => s.adapter_key === source.adapter_key) ?? null;

  const neverSwept = source.latest_run === null && source.last_success_at === null && zero;

  const oldestJobAge = queueStat !== null ? agoLabel(queueStat.oldest_pending_at, nowMs) : null;

  return (
    <div className="border-b border-rule py-4 first:pt-0 last:border-b-0" data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-base font-semibold text-ink">{source.adapter_key}</span>
        <StatusPill tone={state.tone} testId={`state-${source.id}`}>
          {state.text}
        </StatusPill>
        {archive !== null && (
          <StatusPill tone={archive.tone} testId={`archive-${source.id}`}>
            {archive.text}
          </StatusPill>
        )}
        <span className="ml-auto font-mono text-[12px] tabular text-muted" data-testid={`cron-${source.id}`}>
          {source.jurisdiction.name}, {source.jurisdiction.state} · cron {source.cron_expression}
        </span>
      </div>

      <p className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] tabular text-ink-soft" data-testid={`facts-${source.id}`}>
        {neverSwept ? (
          <span>never swept</span>
        ) : (
          <>
            {!queueError && queueStat !== null && (
              <span>
                <b className="text-ink">{queueStat.pending}</b> queued
              </span>
            )}
            <span
              data-testid={`collected-${source.id}`}
              data-zero={zero ? "true" : "false"}
              className={zero ? "font-semibold text-accent" : ""}
            >
              {zero ? "0 collected, ever" : (
                <>
                  <b className="text-ink">{source.lifetime_records}</b> collected
                </>
              )}
            </span>
            <span>
              {source.silence.hours_since_success === null
                ? "no successful sweep on record"
                : `last sweep ${source.silence.hours_since_success} h ago`}
              {source.latest_run && source.latest_run.status !== "running" && ` · ${source.latest_run.status}`}
            </span>
            {source.collection.hours_since_record !== null && (
              <span data-testid={`last-record-${source.id}`}>
                last record {source.collection.hours_since_record} h ago
              </span>
            )}
            {source.expected_interval_hours !== null && <span>expected every {source.expected_interval_hours} h</span>}
            {!queueError && oldestJobAge !== null && <span>oldest job {oldestJobAge}</span>}
            {queueError && source.latest_run && (
              <span>
                last known: {processedIn(source.latest_run.counts)} processed, {outstandingIn(source.latest_run.counts)} left
              </span>
            )}
          </>
        )}
      </p>

      {!source.enabled && (
        <p className="mt-1.5 max-w-prose text-[12.5px] leading-relaxed text-muted">
          {source.disabled_reason ?? "No reason was recorded, which is itself a defect."}
        </p>
      )}

      <div className={`mt-2 ${ACTION_ROW}`}>
        <button
          type="button"
          onClick={onSweep}
          disabled={sweeping}
          className={`${source.pipeline === "never_run" ? ACTION_PRIMARY : ACTION} ${ACTION_SMALL} ${FOCUS_RING}`}
          aria-label={`Sweep now: ${source.adapter_key}`}
        >
          {sweeping ? "Sweeping…" : "Sweep now"}
        </button>
        {source.latest_run ? (
          <a
            href={`/admin/runs/${source.latest_run.id}`}
            className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING} no-underline`}
            aria-label={`Runs: ${source.adapter_key}`}
          >
            Runs
          </a>
        ) : (
          <span className={`${ACTION_QUIET} ${ACTION_SMALL} cursor-not-allowed opacity-40`}>Runs</span>
        )}
        <button
          type="button"
          onClick={onToggleClick}
          aria-expanded={toggleOpen}
          className={`${source.enabled ? ACTION_QUIET : ACTION_PRIMARY} ${ACTION_SMALL} ${FOCUS_RING}`}
          aria-label={`${source.enabled ? "Disable" : "Enable"}: ${source.adapter_key}`}
          data-testid={`toggle-${source.id}`}
        >
          {source.enabled ? "Disable" : "Enable"}
        </button>
        <a
          href={`/admin/sources/${source.id}/meetings`}
          className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING} no-underline`}
          aria-label={`Review ingested meetings: ${source.adapter_key}`}
        >
          Review
        </a>
      </div>

      {toggleOpen && (
        <ToggleForm
          source={source}
          busy={toggleBusy}
          onCancel={onToggleCancel}
          onConfirm={onToggleConfirm}
        />
      )}
    </div>
  );
}

/**
 * The reason form. A required reason stays disabled-until-typed, so the
 * requirement is visible before a click rather than a 400 that arrives after.
 */
function ToggleForm({
  source,
  busy,
  onCancel,
  onConfirm,
}: {
  source: PressroomSource;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const turningOn = !source.enabled;
  const fieldId = `toggle-reason-${source.id}`;

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 border-t border-rule bg-paper-sunk px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() !== "" && !busy) onConfirm(reason);
      }}
    >
      <span className="block grow">
        <label htmlFor={fieldId} className="label-sm block">
          {turningOn
            ? `Why is ${source.adapter_key} being enabled?`
            : `Why is ${source.adapter_key} being disabled?`}
        </label>
        <input
          id={fieldId}
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={
            turningOn
              ? "Adapter reviewed; authorised for live sweeps."
              : "Custodian asked us to pause while they migrate the portal."
          }
          className={`mt-1 w-full border border-rule bg-paper px-3 py-2 text-[13px] text-ink ${FOCUS_RING}`}
        />
      </span>
      <span className={ACTION_ROW}>
        <button
          type="submit"
          disabled={busy || reason.trim() === ""}
          className={`${ACTION_PRIMARY} ${ACTION_SMALL} ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {busy ? "Saving…" : turningOn ? "Enable source" : "Disable source"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING}`}>
          Cancel
        </button>
      </span>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sweep history
// ---------------------------------------------------------------------------

function HistoryTable({ runs, runsError }: { runs: RecentRun[]; runsError: boolean }) {
  if (runsError) {
    return (
      <p role="alert" data-testid="history-error" className="border-t border-rule pt-5 text-sm text-accent">
        Sweep history could not be loaded.
      </p>
    );
  }

  return (
    <section aria-label="Recent sweeps" className="flex flex-col gap-2 border-t border-rule pt-5">
      <p className="label-sm">Last five sweeps</p>
      {runs.length === 0 ? (
        <p className="text-sm text-muted">No sweep is on record.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-[13px] tabular" data-testid="sweep-history">
            <thead>
              <tr>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Source</th>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Finished</th>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Outcome</th>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Own</th>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Others&rsquo;</th>
                <th scope="col" className="label-sm border-b border-rule-strong px-3 py-2">Left</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id} className="border-b border-rule last:border-b-0" data-testid={`history-row-${run.run_id}`}>
                  <th scope="row" className="px-3 py-2 font-mono font-medium text-ink">{run.adapter_key}</th>
                  <td className="px-3 py-2">{run.finished_at === null ? "running" : formatTimestamp(run.finished_at)}</td>
                  <td className="px-3 py-2">{run.status === "running" ? "—" : run.status}</td>
                  <td
                    className={`px-3 py-2 ${run.own_completed === 0 ? "font-semibold text-accent" : ""}`}
                    data-testid={`history-own-${run.run_id}`}
                  >
                    {run.own_completed}
                  </td>
                  <td className="px-3 py-2">{run.others_completed}</td>
                  <td className="px-3 py-2">{run.own_outstanding}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
