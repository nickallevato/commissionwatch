import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ACTION,
  ACTION_PRIMARY,
  ACTION_QUIET,
  ACTION_ROW,
  ACTION_SMALL,
  FlagBar,
  FOCUS_RING,
  Sparkline,
  SeverityStripe,
  StatusPill,
  Tile,
  Tiles,
  WorkTitle,
  type Severity,
  type SparkBar,
} from "@/components/PressroomUI";
import type { PressroomSource, SweepOutcome } from "@/types";

/**
 * `/admin/sources` — the single most important screen in the product.
 *
 * A stalled scraper and a quiet month at City Hall produce identical public
 * sites. This screen makes them look nothing alike, and screen 02 of the
 * approved mockup is its specification.
 *
 * Three of the console's design decisions live here:
 *
 * 1. **Zero is a failure state.** A lifetime record count of 0 renders in the
 *    failure colour, in the tile and in the row, not as a tidy empty cell. The
 *    number that has been true for the product's whole life should look wrong,
 *    because it is.
 * 2. **Silence watch.** A source past its expected interval since its last
 *    success reads `Suspect`, with the hours and the expectation side by side,
 *    and the bar at the foot of the screen names the cadence being watched.
 * 3. **Disabled sources stay listed** with their reason, so why `bozemanmt.gov`
 *    is off lives in the console rather than in somebody's memory.
 *
 * The action here is **Sweep now** — it goes out to the source. Replaying
 * stored bytes is a different verb and lives on the run and meeting screens.
 */

const VERDICT_LABEL: Record<PressroomSource["verdict"], string> = {
  disabled: "Disabled",
  never_run: "Never run",
  failing: "Failing",
  suspect: "Suspect",
  healthy: "Healthy",
};

/** Only `healthy` gets the green. Everything else is red, amber or idle. */
const VERDICT_TONE: Record<PressroomSource["verdict"], Severity | "plain"> = {
  disabled: "idle",
  never_run: "bad",
  failing: "bad",
  suspect: "warn",
  healthy: "ok",
};

/** The row's stripe and its tint come from the same verdict as its pill. */
const VERDICT_STRIPE: Record<PressroomSource["verdict"], Severity> = {
  disabled: "idle",
  never_run: "bad",
  failing: "bad",
  suspect: "warn",
  healthy: "ok",
};

const ROW_TINT: Record<PressroomSource["verdict"], string> = {
  disabled: "",
  never_run: "bg-accent-50",
  failing: "bg-accent-50",
  suspect: "bg-paper-sunk",
  healthy: "",
};

const SPARK_SLOTS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

type LoadResult = { ok: true; sources: PressroomSource[] } | { ok: false };

function formatStamp(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function countRecords(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/**
 * The fourteen-bar strip, built only from sweeps that are actually on record.
 *
 * The mockup draws fourteen real sweeps. `GET /pressroom/sources` returns
 * `latest_run` and no history, and inventing thirteen more bars on a
 * transparency project would be exactly the failure this product exists to
 * report on — so the unknown slots render grey, meaning **no sweep**, and the
 * screen-reader sentence says how many sweeps the console actually holds.
 */
function sweepBars(source: PressroomSource): { bars: SparkBar[]; label: string } {
  const bars: SparkBar[] = Array.from({ length: SPARK_SLOTS }, () => ({
    kind: "none" as const,
    height: 3,
  }));

  const run = source.latest_run;
  if (!run) {
    return {
      bars,
      label: `${source.adapter_key}: no sweep is on record. All ${SPARK_SLOTS} slots are empty.`,
    };
  }

  const records = countRecords(run.counts);
  bars[SPARK_SLOTS - 1] = {
    kind: run.status === "failed" ? "bad" : run.status === "partial" ? "warn" : "ok",
    // 6px floor so a zero-record sweep is still visibly a sweep, and not
    // mistakable for the grey nothing beside it.
    height: Math.max(6, Math.min(20, 6 + records)),
  };

  return {
    bars,
    label:
      `${source.adapter_key}: one sweep on record — ${run.status}, ${records} record` +
      `${records === 1 ? "" : "s"}. The other ${SPARK_SLOTS - 1} slots hold no sweep, because ` +
      `no earlier run is kept on this screen.`,
  };
}

export function AdminSourcesPage() {
  const [sources, setSources] = useState<PressroomSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sweeping, setSweeping] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * When the listing was read, captured in the effect rather than in render.
   * "Swept in the last 24 hours" is measured against the moment the data
   * arrived, not against whenever React last happened to re-render — the
   * second is unstable and would make the tile flicker between values.
   */
  const [readAt, setReadAt] = useState<number | null>(null);

  // Fetching and applying are separated so the effect below can await the
  // request and touch state only in the continuation. An effect body that calls
  // setState synchronously causes a cascading render, and — worse here — a fast
  // unmount would set state on a component that is already gone.
  const fetchSources = useCallback(async (): Promise<LoadResult> => {
    try {
      const res = await fetch("/api/admin/pressroom/sources", {
        credentials: "same-origin",
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { data: PressroomSource[]; total: number };
      return { ok: true, sources: body.data };
    } catch {
      return { ok: false };
    }
  }, []);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setSources(result.sources);
      setReadAt(Date.now());
      setError("");
    } else {
      setError("Ingestion sources could not be loaded.");
    }
    setLoading(false);
  }, []);

  /** Reload after a write. Showing the spinner here is a response to a click. */
  const load = useCallback(async () => {
    setLoading(true);
    applyResult(await fetchSources());
  }, [applyResult, fetchSources]);

  useEffect(() => {
    // `loading` already starts true, so nothing needs setting on the way in.
    let ignore = false;
    void (async () => {
      const result = await fetchSources();
      if (ignore) return;
      applyResult(result);
    })();
    return () => {
      ignore = true;
    };
  }, [applyResult, fetchSources]);

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
      await load();
    } catch {
      setNotice("The sweep request could not be sent.");
    } finally {
      setSweeping("");
    }
  }

  /**
   * The four tiles, every one of them derived from the listing rather than
   * from a second endpoint, so the figures and the rows can never disagree.
   */
  const summary = useMemo(() => {
    const enabled = sources.filter((source) => source.enabled);
    const now = readAt ?? 0;
    const sweptIn24h = enabled.filter(
      (source) =>
        source.last_success_at !== null && now - new Date(source.last_success_at).getTime() < DAY_MS,
    ).length;

    const records = sources.reduce((total, source) => total + source.lifetime_records, 0);

    // A source that has never succeeded has been silent for the whole life of
    // the product. That is not a large number of hours, it is an unbounded
    // one, and rounding it to the largest known figure would hide the worst
    // case behind a plausible one.
    const neverSucceeded = sources.filter((source) => source.last_success_at === null);
    const silences = sources
      .map((source) => ({ source, hours: source.silence.hours_since_success }))
      .filter((entry): entry is { source: PressroomSource; hours: number } => entry.hours !== null);
    const worst = silences.reduce<{ source: PressroomSource; hours: number } | null>(
      (found, entry) => (found === null || entry.hours > found.hours ? entry : found),
      null,
    );

    return {
      enabled: enabled.length,
      sweptIn24h,
      records,
      neverSucceeded,
      worst,
      zeroCount: sources.filter((source) => source.lifetime_records === 0).length,
      cadenced: sources.filter((source) => source.expected_interval_hours !== null),
    };
  }, [sources, readAt]);

  return (
    <>
      <WorkTitle
        title="Sources"
        stamp={
          loading
            ? "loading…"
            : `${sources.length} registered · ${summary.enabled} enabled · read ${
                readAt === null ? "—" : new Date(readAt).toLocaleTimeString()
              }`
        }
      />

      <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
        Every registered source, including the ones that are switched off. A
        source that has never produced a record is shown as a failure, not as an
        empty row, and a source that has gone quiet past its own expected
        interval is shown as suspect rather than as calm.
      </p>

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
          Loading sources…
        </p>
      ) : sources.length === 0 ? (
        <>
          <Tiles>
            <Tile label="Sources configured" value={0} tone="bad" sub="nothing is watched" />
            <Tile label="Swept in last 24h" value={0} tone="bad" sub="of 0 enabled" />
            <Tile
              label="Records ingested"
              value={0}
              tone="bad"
              sub="lifetime"
              testId="tile-lifetime-records"
            />
            <Tile label="Longest silence" value="∞" tone="bad" sub="no source to be silent" />
          </Tiles>
          <p className="text-sm text-ink">No ingestion source is registered.</p>
          <p className="max-w-prose text-sm leading-relaxed text-accent">
            Nothing is being watched. That is a configuration gap, not a quiet week.
          </p>
        </>
      ) : (
        <>
          <Tiles>
            <Tile
              label="Sources configured"
              value={sources.length}
              sub={`${summary.enabled} enabled`}
            />
            <Tile
              label="Swept in last 24h"
              value={summary.sweptIn24h}
              tone={
                summary.enabled === 0
                  ? "bad"
                  : summary.sweptIn24h === 0
                    ? "bad"
                    : summary.sweptIn24h < summary.enabled
                      ? "warn"
                      : "good"
              }
              sub={`of ${summary.enabled} enabled`}
            />
            {/* Decision 1, at the top of the screen. */}
            <Tile
              label="Records ingested"
              value={summary.records}
              tone={summary.records === 0 ? "bad" : "plain"}
              sub="lifetime"
              testId="tile-lifetime-records"
            />
            <Tile
              label="Longest silence"
              value={
                summary.neverSucceeded.length > 0 ? "∞" : summary.worst ? `${summary.worst.hours} h` : "—"
              }
              tone={
                summary.neverSucceeded.length > 0
                  ? "bad"
                  : summary.worst && summary.worst.source.silence.verdict === "suspect"
                    ? "warn"
                    : "plain"
              }
              sub={
                summary.neverSucceeded.length > 0
                  ? `${summary.neverSucceeded[0].adapter_key}, never succeeded`
                  : summary.worst
                    ? `${summary.worst.source.adapter_key}, since last success`
                    : "no success is on record"
              }
            />
          </Tiles>

          {summary.zeroCount > 0 && (
            <p className="border-l-2 border-accent bg-accent-50 px-4 py-3 text-sm text-accent">
              {summary.zeroCount} of {sources.length} sources have never ingested a record.
            </p>
          )}

          {/* Wide table, narrow phone. The scroll lives on the table's own
              container so the page itself never scrolls sideways. */}
          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[60rem] border-collapse text-left text-[13px]">
              <caption className="sr-only">
                Registered ingestion sources, their verdict, recent sweeps, lifetime record count and
                silence watch
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Source</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Status</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Last 14 sweeps</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Last success</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2 text-right">Lifetime</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Silence watch</th>
                  <th scope="col" className="label-sm border-b border-rule px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    sweeping={sweeping === source.id}
                    onSweep={() => void handleSweep(source)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Decision 2, said in words at the foot of the screen. */}
          <FlagBar label="Silence watch" testId="silence-watch">
            {summary.cadenced.length === 0 ? (
              <>
                Not one source carries an expected cadence, so silence here means
                nothing either way. Until an interval is recorded, a dead scraper
                is invisible by construction.
              </>
            ) : (
              <>
                {summary.cadenced.map((source, index) => (
                  <span key={source.id}>
                    {index > 0 && " · "}
                    <b className="font-semibold text-ink">{source.adapter_key}</b> every{" "}
                    <b className="font-mono tabular">{source.expected_interval_hours} h</b>
                  </span>
                ))}
                . Past its own interval a source is marked <b>Suspect</b> — silence
                is treated as a failure until proven otherwise.
              </>
            )}
          </FlagBar>
        </>
      )}
    </>
  );
}

function SourceRow({
  source,
  sweeping,
  onSweep,
}: {
  source: PressroomSource;
  sweeping: boolean;
  onSweep: () => void;
}) {
  const zero = source.lifetime_records === 0;
  const spark = sweepBars(source);

  return (
    <tr className={`border-b border-rule align-middle last:border-b-0 ${ROW_TINT[source.verdict]}`}>
      <th scope="row" className="px-3 py-2.5 text-left font-normal">
        <span className="flex items-stretch gap-2">
          <SeverityStripe severity={VERDICT_STRIPE[source.verdict]} />
          <span className="block">
            <span className="block font-semibold text-ink">{source.adapter_key}</span>
            <span className="block font-mono text-[11.5px] text-muted">
              {source.jurisdiction.name}, {source.jurisdiction.state} · {source.cron_expression}
            </span>
            {!source.enabled && (
              // Decision 3: a disabled source is never filtered out, and the
              // reason travels with it. `<details>` keeps the row scannable
              // while leaving the text in the document for anyone — or
              // anything — reading it.
              <details className="mt-1.5">
                <summary
                  className={`cursor-pointer text-[10px] font-semibold uppercase tracking-label text-accent ${FOCUS_RING}`}
                >
                  Why disabled
                </summary>
                <span className="mt-1 block max-w-prose text-[11.5px] leading-relaxed text-ink-soft">
                  {source.disabled_reason ?? "No reason was recorded, which is itself a defect."}
                </span>
              </details>
            )}
          </span>
        </span>
      </th>

      <td className="px-3 py-2.5">
        <StatusPill tone={VERDICT_TONE[source.verdict]} testId={`verdict-${source.id}`}>
          {VERDICT_LABEL[source.verdict]}
        </StatusPill>
        {source.consecutive_failures > 0 && (
          <span className="mt-1 block text-[11.5px] text-accent tabular">
            {source.consecutive_failures} consecutive failure
            {source.consecutive_failures === 1 ? "" : "s"}
          </span>
        )}
      </td>

      <td className="px-3 py-2.5" data-testid={`sweeps-${source.id}`}>
        <Sparkline bars={spark.bars} label={spark.label} />
      </td>

      <td className="px-3 py-2.5 font-mono text-[12px] tabular">
        {source.last_success_at === null ? (
          <span className="text-accent">never</span>
        ) : (
          <span className="text-ink">{formatStamp(source.last_success_at)}</span>
        )}
        {source.latest_run && (
          <Link
            to={`/admin/runs/${source.latest_run.id}`}
            className={`mt-1 block text-[11px] text-muted underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-accent ${FOCUS_RING}`}
          >
            latest run · {source.latest_run.status}
          </Link>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {/* Decision 1, in the row. `data-zero` is the marker the test asserts
            on; the failure colour and the sentence are what an operator sees. */}
        <span
          data-zero={zero ? "true" : "false"}
          data-testid={`lifetime-records-${source.id}`}
          className={`figure text-base ${zero ? "font-semibold text-accent" : "text-ink"}`}
        >
          {source.lifetime_records}
        </span>
        {zero && (
          <span className="mt-1 block max-w-[14rem] text-[11px] leading-relaxed text-accent">
            No record has ever been ingested from this source.
          </span>
        )}
      </td>

      <td className="px-3 py-2.5" data-testid={`silence-${source.id}`}>
        <SilenceCell source={source} />
      </td>

      <td className="px-3 py-2.5">
        <div className={ACTION_ROW}>
          <button
            type="button"
            onClick={onSweep}
            disabled={sweeping}
            className={`${source.verdict === "never_run" ? ACTION_PRIMARY : ACTION} ${ACTION_SMALL} ${FOCUS_RING}`}
            aria-label={`Sweep now: ${source.adapter_key}`}
          >
            {sweeping ? "Sweeping…" : "Sweep now"}
          </button>
          {source.latest_run ? (
            <Link
              to={`/admin/runs/${source.latest_run.id}`}
              className={`${ACTION_QUIET} ${ACTION_SMALL} ${FOCUS_RING} no-underline`}
              aria-label={`Latest run: ${source.adapter_key}`}
            >
              Log
            </Link>
          ) : (
            <span className={`${ACTION_QUIET} ${ACTION_SMALL} cursor-not-allowed opacity-40`}>
              No log
            </span>
          )}
        </div>
        <span className="mt-1 block max-w-[11rem] text-[11px] leading-relaxed text-muted">
          Sweeping goes out to the source.
        </span>
      </td>
    </tr>
  );
}

/**
 * Decision 2. `suspect` says the word, and says both numbers that produced it —
 * an operator should be able to disagree with the verdict without leaving the
 * page.
 */
function SilenceCell({ source }: { source: PressroomSource }) {
  const { verdict, hours_since_success, expected_interval_hours } = source.silence;

  const figures = (
    <span className="mt-1 block text-[11.5px] tabular">
      {hours_since_success === null
        ? "No successful sweep on record"
        : `${hours_since_success} h since last success`}
      {expected_interval_hours !== null && ` · expected every ${expected_interval_hours} h`}
    </span>
  );

  if (verdict === "suspect") {
    return (
      <span className="block text-accent">
        <StatusPill tone="warn">Suspect</StatusPill>
        {figures}
      </span>
    );
  }

  if (verdict === "ok") {
    return (
      <span className="block text-muted">
        <StatusPill tone="ok">Within interval</StatusPill>
        {figures}
      </span>
    );
  }

  return (
    <span className="block text-muted">
      <StatusPill tone="plain">Unknown</StatusPill>
      <span className="mt-1 block max-w-[13rem] text-[11px] leading-relaxed">
        No expected interval is set, so silence here means nothing either way.
      </span>
    </span>
  );
}
