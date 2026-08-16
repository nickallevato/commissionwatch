import type { Knex } from "knex";
import {
  extractionBacklog,
  extractionDistribution,
  type DistributionReason,
} from "./extraction/distribution";
import {
  failuresIn,
  listSources,
  recordsIn,
  type PressroomSource,
  type RunStatusValue,
  type SilenceVerdict,
  type PipelineVerdict,
  type CollectionVerdict,
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
  /** Does the machinery work? */
  pipeline: PipelineVerdict;
  /** Is there anything in the archive? Published because an empty archive is a
   * fact about the public record, not an embarrassment to hide behind a green
   * pipeline. */
  collection: {
    verdict: CollectionVerdict;
    last_record_at: string | null;
    hours_since_record: number | null;
  };
  latest_run: PublicStatusRun | null;
}

/**
 * One reason chunks went unread, as a figure.
 *
 * The reason is a value from this project's own closed taxonomy — see
 * `extraction/extractor.ts` — never the verbatim error string beside it in
 * `failed_chunks`. That string is written by whatever threw and carries the same
 * hazard as `ingestion_runs.error`: it can quote a document belonging to a
 * meeting no operator has published. Counts are ours to publish; content is not.
 */
export interface PublicExtractionReason {
  reason: DistributionReason;
  chunks: number;
  /** Claims salvaged from those chunks anyway. Only truncation can be non-zero. */
  recovered: number;
}

/**
 * How well the minutes that *have* been read were read — or that nobody knows.
 *
 * The two branches are the whole point of this type. `extraction_runs` was empty
 * until 2026-08-15, and an unread fraction computed over zero chunks is 0 —
 * which renders as "0% of chunks went unread", the most flattering sentence
 * available resting on no evidence at all. **Unmeasured is not zero**, and a
 * shape that cannot tell the two apart will eventually be read as though it
 * could, so the distinction is carried in the type rather than left to the
 * reader of a `0`.
 */
export type PublicExtractionReading =
  | {
      measured: false;
      /** Finished runs on record. Normally 0 here; see `buildPublicExtraction`. */
      runs: number;
    }
  | {
      measured: true;
      runs: number;
      /** Distinct meetings those runs covered. */
      meetings: number;
      chunks: number;
      chunks_unread: number;
      /** `chunks_unread / chunks`, to three decimals. */
      unread_fraction: number;
      /** Claims salvaged out of unread chunks. */
      claims_recovered: number;
      /** Descending by chunk count, so the dominant failure reads first. */
      reasons: PublicExtractionReason[];
    };

/**
 * The extraction backlog, in public.
 *
 * `docs/superpowers/specs/2026-08-14-extraction-throughput-design.md` §5 asks
 * the status page to state the depth, and the reason is the same one the rest of
 * this page is built on: a corpus that has been collected and not read looks
 * exactly like a corpus with nothing in it. Only the backlog numbers tell them
 * apart.
 *
 * Counts only. `listUnextractedMeetings` returns meeting ids and content
 * addresses and is deliberately **not** called from here: which meetings have
 * been collected and withheld is precisely what the publication wall exists to
 * keep unenumerable, and an unread backlog is mostly unpublished meetings.
 */
export interface PublicExtraction {
  /** Meetings whose minutes are stored, so reading them is possible at all. */
  eligible: number;
  /** Of those, meetings a run has read something out of. */
  read: number;
  /** Of those, meetings nothing has read. The backlog depth. */
  unread: number;
  /** Reading jobs waiting or in flight. */
  queued: number;
  /** Reading jobs the worker refused to retry. */
  blocked: number;
  /** Reading jobs that exhausted their attempts. */
  failed: number;
  reading: PublicExtractionReading;
}

/**
 * Backlog and distribution, narrowed for a reader.
 *
 * Pure, so the "unmeasured is not zero" rule can be proved against a
 * hand-built distribution rather than against whatever the test database
 * happens to hold — which is the one thing a fixture cannot reliably arrange,
 * since another suite's rows are indistinguishable from ours here.
 *
 * `measured` requires a chunk to have been attempted, not merely a run to have
 * finished: a run that failed before it chunked anything contributes no
 * denominator, and dividing by it would be the same confident zero one layer
 * up. `runs` is carried on both branches so a reader can see that runs happened
 * and still produced nothing to measure.
 */
export function toPublicExtraction(
  backlog: Awaited<ReturnType<typeof extractionBacklog>>,
  distribution: Awaited<ReturnType<typeof extractionDistribution>>,
): PublicExtraction {
  const measurable = distribution.runs > 0 && distribution.chunks > 0;
  return {
    eligible: backlog.eligible,
    read: backlog.read,
    unread: backlog.unread,
    queued: backlog.queued,
    blocked: backlog.blocked,
    failed: backlog.failed,
    reading: measurable
      ? {
          measured: true,
          runs: distribution.runs,
          meetings: distribution.meetings,
          chunks: distribution.chunks,
          chunks_unread: distribution.unread,
          unread_fraction: distribution.unread_fraction,
          claims_recovered: distribution.recovered,
          reasons: distribution.by_reason.map((tally) => ({
            reason: tally.reason,
            chunks: tally.chunks,
            recovered: tally.recovered,
          })),
        }
      : { measured: false, runs: distribution.runs },
  };
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
  /**
   * How much of what has been collected has actually been read.
   *
   * Sourced from `extraction_runs` and the `extract` queue rather than from the
   * sweep rows above, because collecting a document and reading it are separate
   * stages that fail separately — a page reporting only the first would call a
   * pipeline healthy while a fifth of every document went unread.
   */
  extraction: PublicExtraction;
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
    pipeline: source.pipeline,
    collection: source.collection,
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
  const [rawSources, backlog, distribution] = await Promise.all([
    listSources(db, now),
    extractionBacklog(db),
    extractionDistribution(db),
  ]);
  const sources = rawSources.map(toPublicSource);

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
    extraction: toPublicExtraction(backlog, distribution),
  };
}
