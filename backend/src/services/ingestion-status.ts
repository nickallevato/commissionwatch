import type { Knex } from "knex";
import {
  failuresIn,
  listSources,
  recordsIn,
  type PressroomSource,
  type RunStatusValue,
  type SilenceVerdict,
  type SourceVerdict,
} from "./pressroom/sources";

/**
 * The public projection of the operator's Sources screen.
 *
 * A site that reports on other people's record-keeping owes its readers the
 * same account of its own. P2 built the judgements — the silence watch, the
 * verdict ladder, "zero is a failure state" — for the operator. This narrows
 * them for anyone.
 *
 * Two things make this file worth existing rather than being a second query:
 *
 * **It reuses `listSources`.** The silence watch and the verdict ladder are
 * judgements, and a judgement implemented twice is a judgement that will
 * disagree with itself after the next change. The public page and the console
 * must never render different verdicts for the same source, so there is one
 * reader and one set of rules, and this is a pure narrowing over its output.
 *
 * **It drops the run's error text and every run id.** `ingestion_runs.error` is
 * free text written by whatever threw, and it routinely carries a URL — a
 * Granicus URL carries a meeting title in its query string. Publishing it would
 * publish an uncontrolled string on a page whose whole rule is that nothing
 * from an unpublished meeting appears. So the public row carries the *figures*:
 * status, timestamps, records landed, failures recorded. It says a run recorded
 * three failures; it does not reproduce what they said. Counts are fine;
 * content is not. The console keeps the full text, because the operator is the
 * person who has to act on it.
 *
 * The run id goes for a duller reason: the public page has no run-detail
 * destination, and an id that only opens a route which 401s teaches nobody
 * anything.
 *
 * Nothing here touches `meetings`, so the publication wall is not in play for
 * run metadata. `test/public-status.test.ts` asserts that anyway, in the
 * direction that matters: an unpublished meeting's location, its agenda item
 * text and an error string quoting all of them are absent from the response.
 */

export interface PublicStatusRun {
  status: RunStatusValue;
  started_at: string;
  finished_at: string | null;
  /** Records this run landed in the database. */
  records: number;
  /** Failures this run recorded. The count, never the text. */
  failures: number;
}

export interface PublicStatusSource {
  adapter_key: string;
  jurisdiction: { name: string; state: string };
  enabled: boolean;
  /**
   * Why a source is off, in the operator's own words.
   *
   * Kept public deliberately. That `bozemanmt.gov` is a blanket Akamai deny is
   * a fact about the public record's accessibility, and a reader wondering why
   * a city is missing deserves the answer rather than the folklore.
   */
  disabled_reason: string | null;
  cron_expression: string;
  expected_interval_hours: number | null;
  last_success_at: string | null;
  lifetime_records: number;
  silence: {
    verdict: SilenceVerdict;
    hours_since_success: number | null;
    expected_interval_hours: number | null;
  };
  verdict: SourceVerdict;
  latest_run: PublicStatusRun | null;
}

export interface PublicStatus {
  /** When these figures were read. Every one of them is a query, not a constant. */
  generated_at: string;
  /**
   * The newest finish of any run that landed work, across every source.
   *
   * Read from the same rows the masthead's `/api/ingestion/status` reads, so
   * the headline figure on this page and the one in the masthead cannot
   * disagree.
   */
  last_successful_sweep_at: string | null;
  sources: PublicStatusSource[];
}

/**
 * One console row, narrowed to what a reader may see.
 *
 * Exported and pure so the leak test can hand it a hostile `PressroomSource` —
 * one whose run error quotes an unpublished meeting — and assert on the result
 * without a database.
 */
export function toPublicSource(source: PressroomSource): PublicStatusSource {
  const run = source.latest_run;
  return {
    adapter_key: source.adapter_key,
    jurisdiction: { name: source.jurisdiction.name, state: source.jurisdiction.state },
    enabled: source.enabled,
    disabled_reason: source.disabled_reason,
    cron_expression: source.cron_expression,
    expected_interval_hours: source.expected_interval_hours,
    last_success_at: source.last_success_at,
    lifetime_records: source.lifetime_records,
    silence: source.silence,
    verdict: source.verdict,
    latest_run:
      run === null
        ? null
        : {
            status: run.status,
            started_at: run.started_at,
            finished_at: run.finished_at,
            records: recordsIn(run.counts),
            failures: failuresIn(run.counts),
          },
  };
}

/**
 * Every source, disabled and never-run ones included.
 *
 * Nothing is filtered. A source omitted because it has never worked is exactly
 * the failure this page exists to prevent: an absence you can see is a
 * commitment, an absence you cannot is a quiet failure.
 */
export async function buildPublicStatus(db: Knex, now: Date = new Date()): Promise<PublicStatus> {
  const sources = (await listSources(db, now)).map(toPublicSource);

  // The newest `ingestion_sources.last_success_at`, derived from the rows this
  // page has already rendered rather than fetched by a second query. A second
  // query could observe a run finishing between the two, and the page would
  // then report a sweep above a table that still called the source never-run.
  //
  // `last_success_at` is written by `SourceScheduler.updateSourceHealth` on
  // exactly the statuses `/api/ingestion/status` counts as a sweep — succeeded
  // and partial — which is what keeps this figure and the masthead's from
  // disagreeing. Comparison is lexical because every value here came out of
  // `Date.toISOString()`, which is fixed-width and always UTC.
  let lastSuccessfulSweepAt: string | null = null;
  for (const source of sources) {
    const candidate = source.last_success_at;
    if (candidate === null) continue;
    if (lastSuccessfulSweepAt === null || candidate > lastSuccessfulSweepAt) {
      lastSuccessfulSweepAt = candidate;
    }
  }

  return {
    generated_at: now.toISOString(),
    last_successful_sweep_at: lastSuccessfulSweepAt,
    sources,
  };
}
