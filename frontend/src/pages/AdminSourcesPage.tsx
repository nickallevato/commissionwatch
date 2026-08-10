import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PressroomCard, PressroomShell } from "@/components/PressroomShell";
import type { PressroomSource, SweepOutcome } from "@/types";

/**
 * `/admin/sources` — every registered ingestion source, healthy or not.
 *
 * Three of the console's design decisions live on this screen:
 *
 * 1. **Zero is a failure state.** A lifetime record count of 0 renders in the
 *    accent colour with a sentence saying so, not as a tidy empty cell. The
 *    number that has been true for the product's whole life should look wrong,
 *    because it is.
 * 2. **Silence watch.** A source past its expected interval since its last
 *    success reads `Suspect`, with the hours and the expectation side by side.
 *    Without that, a dead scraper and a quiet month at City Hall produce
 *    identical screens.
 * 3. **Disabled sources stay listed** with their reason, so why `bozemanmt.gov`
 *    is off lives in the console rather than in somebody's memory.
 *
 * The action here is **Sweep now** — it goes out to the source. Replaying
 * stored bytes is a different verb and lives on the run and meeting screens.
 */

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonClass =
  "border border-ink bg-ink px-3 py-2 text-[11px] font-semibold uppercase tracking-label text-paper hover:bg-ink-soft disabled:opacity-50";

const VERDICT_LABEL: Record<PressroomSource["verdict"], string> = {
  disabled: "Disabled",
  never_run: "Never run",
  failing: "Failing",
  suspect: "Suspect",
  healthy: "Healthy",
};

/** Only `healthy` gets the green. Everything else is either red or plain ink. */
const VERDICT_CLASS: Record<PressroomSource["verdict"], string> = {
  disabled: "text-muted",
  never_run: "text-accent",
  failing: "text-accent",
  suspect: "text-accent",
  healthy: "text-pass",
};

type LoadResult = { ok: true; sources: PressroomSource[] } | { ok: false };

function formatStamp(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function AdminSourcesPage() {
  const [sources, setSources] = useState<PressroomSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sweeping, setSweeping] = useState("");
  const [notice, setNotice] = useState("");

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

  const zeroCount = sources.filter((source) => source.lifetime_records === 0).length;

  return (
    <PressroomShell>
      <p className="kicker">Pressroom</p>
      <h1 className="headline text-3xl sm:text-4xl mt-1">Ingestion sources</h1>
      <div className="rule-hi mt-4" role="presentation" />

      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-soft">
        Every registered source, including the ones that are switched off. A
        source that has never produced a record is shown as a failure, not as an
        empty row, and a source that has gone quiet past its own expected
        interval is shown as suspect rather than as calm.
      </p>

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
          Loading sources…
        </p>
      ) : sources.length === 0 ? (
        <PressroomCard className="mt-8">
          <p className="text-sm text-ink">No ingestion source is registered.</p>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-accent">
            Nothing is being watched. That is a configuration gap, not a quiet week.
          </p>
        </PressroomCard>
      ) : (
        <>
          {zeroCount > 0 && (
            <p className="mt-8 border-l-2 border-accent bg-paper px-4 py-3 text-sm text-accent">
              {zeroCount} of {sources.length} sources have never ingested a record.
            </p>
          )}

          {/* Wide table, narrow phone. The scroll lives on the table's own
              container so the page itself never scrolls sideways. */}
          <div className="mt-6 overflow-x-auto border border-rule bg-paper">
            <table className="w-full min-w-[56rem] border-collapse text-left">
              <caption className="sr-only">
                Registered ingestion sources, their verdict, lifetime record count and silence watch
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" className="label-sm px-4 py-3">Source</th>
                  <th scope="col" className="label-sm px-4 py-3">Verdict</th>
                  <th scope="col" className="label-sm px-4 py-3">Lifetime records</th>
                  <th scope="col" className="label-sm px-4 py-3">Last success</th>
                  <th scope="col" className="label-sm px-4 py-3">Silence watch</th>
                  <th scope="col" className="label-sm px-4 py-3">Latest run</th>
                  <th scope="col" className="label-sm px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
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
        </>
      )}
    </PressroomShell>
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

  return (
    <tr className="align-top">
      <th scope="row" className="px-4 py-4 text-left font-normal">
        <span className="block text-sm font-semibold text-ink">{source.adapter_key}</span>
        <span className="block text-xs text-muted">
          {source.jurisdiction.name}, {source.jurisdiction.state} · {source.cron_expression}
        </span>
        {!source.enabled && (
          // Decision 3: a disabled source is never filtered out, and the reason
          // travels with it. `<details>` keeps the row scannable while leaving
          // the text in the document for anyone — or anything — reading it.
          <details className="mt-2">
            <summary
              className={`cursor-pointer text-[11px] font-semibold uppercase tracking-label text-accent ${focusRing}`}
            >
              Why disabled
            </summary>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-soft">
              {source.disabled_reason ?? "No reason was recorded, which is itself a defect."}
            </p>
          </details>
        )}
      </th>

      <td className="px-4 py-4">
        <span className={`text-sm font-semibold ${VERDICT_CLASS[source.verdict]}`}>
          {VERDICT_LABEL[source.verdict]}
        </span>
        {source.consecutive_failures > 0 && (
          <span className="mt-1 block text-xs text-accent tabular">
            {source.consecutive_failures} consecutive failure
            {source.consecutive_failures === 1 ? "" : "s"}
          </span>
        )}
      </td>

      <td className="px-4 py-4">
        {/* Decision 1. `data-zero` is the marker the test asserts on; the accent
            colour and the sentence below it are what an operator actually sees. */}
        <span
          data-zero={zero ? "true" : "false"}
          data-testid={`lifetime-records-${source.id}`}
          className={`figure text-base ${zero ? "font-semibold text-accent" : "text-ink"}`}
        >
          {source.lifetime_records}
        </span>
        {zero && (
          <span className="mt-1 block max-w-[18rem] text-xs leading-relaxed text-accent">
            No record has ever been ingested from this source.
          </span>
        )}
      </td>

      <td className="px-4 py-4 text-sm text-ink tabular">{formatStamp(source.last_success_at)}</td>

      <td className="px-4 py-4" data-testid={`silence-${source.id}`}>
        <SilenceCell source={source} />
      </td>

      <td className="px-4 py-4">
        {source.latest_run ? (
          <>
            <Link
              to={`/admin/runs/${source.latest_run.id}`}
              className={`text-sm font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-accent ${focusRing}`}
            >
              {source.latest_run.status}
            </Link>
            <span className="mt-1 block text-xs text-muted tabular">
              {formatStamp(source.latest_run.started_at)}
            </span>
            {source.latest_run.error && (
              <span className="mt-1 block max-w-[18rem] text-xs leading-relaxed text-accent">
                {source.latest_run.error}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm text-accent">Never run</span>
        )}
      </td>

      <td className="px-4 py-4">
        <button
          type="button"
          onClick={onSweep}
          disabled={sweeping}
          className={`${buttonClass} ${focusRing}`}
          aria-label={`Sweep now: ${source.adapter_key}`}
        >
          {sweeping ? "Sweeping…" : "Sweep now"}
        </button>
        <span className="mt-1.5 block max-w-[12rem] text-xs leading-relaxed text-muted">
          Goes out to the source.
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

  if (verdict === "suspect") {
    return (
      <>
        <span className="text-sm font-semibold text-accent">Suspect</span>
        <span className="mt-1 block text-xs text-ink-soft tabular">
          {hours_since_success === null
            ? "No successful sweep on record"
            : `${hours_since_success} h since last success`}
          {expected_interval_hours !== null && ` · expected every ${expected_interval_hours} h`}
        </span>
      </>
    );
  }

  if (verdict === "ok") {
    return (
      <>
        <span className="text-sm text-pass">Within interval</span>
        <span className="mt-1 block text-xs text-muted tabular">
          {hours_since_success === null
            ? "No successful sweep on record"
            : `${hours_since_success} h since last success`}
          {expected_interval_hours !== null && ` · expected every ${expected_interval_hours} h`}
        </span>
      </>
    );
  }

  return (
    <>
      <span className="text-sm text-muted">Unknown</span>
      <span className="mt-1 block max-w-[14rem] text-xs leading-relaxed text-muted">
        No expected interval is set, so silence here means nothing either way.
      </span>
    </>
  );
}
