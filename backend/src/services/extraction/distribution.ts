import type { Knex } from "knex";
import type { ChunkFailureReason } from "./extractor";
import { asReason, type ExtractionRunStatus } from "./runs";

/**
 * The one query the design of record asked for.
 *
 * `docs/superpowers/specs/2026-08-14-extraction-throughput-design.md` §1 ends
 * with "run the existing corpus and **read the distribution before changing
 * anything else**", and `docs/STATUS.md` has carried "the extraction failure
 * distribution is unmeasured" ever since. `failed_chunks` was widened to record
 * a structured reason per chunk, and then nothing added the reasons up: the
 * tally existed per run, inside `summariseFailures`, and there was no way to ask
 * it of the corpus.
 *
 * That is what this module is. It reads `extraction_runs` and nothing else, it
 * writes nothing, and it takes no view about what should be done with the
 * answer — the fix follows the data, and a module that recommended a fix would
 * be a second place for the recommendation to go stale.
 *
 * **Aggregated in SQL, not in Node.** The Granicus archive is 1,135 meetings
 * and a run row carries every failed chunk's verbatim error text. Pulling the
 * corpus into the process to count it would work today, at five rows, and stop
 * working exactly when the number becomes interesting.
 *
 * **`running` rows are excluded everywhere.** A run in flight has a
 * `failed_chunks` of `[]` and a `chunks` of 0 because `finishRun` has not
 * written them yet, so counting it would report an unread fraction of zero for
 * work that has not happened — the same "0 claims means the meeting was quiet"
 * error one layer up.
 */

/** Guards a `jsonb` column that is *supposed* to be an array. */
const FAILED_CHUNKS_IS_ARRAY = "jsonb_typeof(failed_chunks) = 'array'";

/** Every finished run, whatever it concluded. */
const FINISHED = "status <> 'running'";

export type DistributionReason = ChunkFailureReason | "unclassified";

export interface ReasonTally {
  reason: DistributionReason;
  /** Chunks that failed for this reason, across the corpus. */
  chunks: number;
  /** Runs in which it happened at least once. */
  runs: number;
  /**
   * Claims salvaged out of those chunks anyway.
   *
   * Only the two truncation reasons can be non-zero: a reply that arrived, was
   * cut off, and had complete claims read out of the part before the cut. It is
   * the difference between "a third of the corpus went unread" and "a third of
   * the corpus was cut short after yielding most of what it had", and the fix
   * those two want is not the same.
   *
   * Distinct claims, as of 2026-08-15. `repetition-truncated` rows recovered
   * dozens of *objects* and a handful of *claims*, and reporting the objects
   * flattered the corpus by a factor of twenty.
   */
  recovered: number;
}

export interface ExtractionDistribution {
  /** Finished runs considered. Every attempt, not one per meeting. */
  runs: number;
  /** Distinct meetings those runs cover. */
  meetings: number;
  /** Chunks attempted across them. */
  chunks: number;
  /** Chunks that went unread. */
  unread: number;
  /** `unread / chunks`, to three decimals. 0 when nothing has been attempted. */
  unread_fraction: number;
  /** Claims salvaged out of unread chunks. Summed from `by_reason`. */
  recovered: number;
  by_status: Record<ExtractionRunStatus, number>;
  /** Descending by chunk count, so the dominant failure reads first. */
  by_reason: ReasonTally[];
  /** Runs where every chunk failed — the document was not read at all. */
  runs_wholly_unread: number;
  /** Runs carrying at least one `refused` chunk: a content filter, not a limit. */
  runs_refused: number;
  /**
   * Meetings with at least one run that read *something*.
   *
   * §5's falsifiable bar is "every published meeting has an extraction run that
   * is not `failed`", and this is the numerator of it.
   */
  meetings_read: number;
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStatus(value: unknown): ExtractionRunStatus | null {
  switch (value) {
    case "running":
    case "succeeded":
    case "partial":
    case "failed":
      return value;
    default:
      return null;
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows: unknown = isRecord(result) && "rows" in result ? result.rows : result;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord);
}

/**
 * The corpus-wide failure distribution.
 *
 * Three queries rather than one join, because they aggregate at three different
 * grains — runs, statuses, and the chunks inside a `jsonb` array — and a single
 * statement doing all three would multiply the run-level sums by the number of
 * failed chunks in each run. That is precisely the arithmetic error this project
 * exists to catch other people making.
 */
export async function extractionDistribution(db: Knex): Promise<ExtractionDistribution> {
  const totals = rowsOf(
    await db.raw(
      `select count(*) as runs,
              count(distinct meeting_id) as meetings,
              coalesce(sum(chunks), 0) as chunks,
              coalesce(sum(case when ${FAILED_CHUNKS_IS_ARRAY}
                                then jsonb_array_length(failed_chunks) else 0 end), 0) as unread,
              count(*) filter (
                where chunks > 0
                  and ${FAILED_CHUNKS_IS_ARRAY}
                  and jsonb_array_length(failed_chunks) >= chunks
              ) as runs_wholly_unread,
              count(*) filter (
                where ${FAILED_CHUNKS_IS_ARRAY}
                  and failed_chunks @> '[{"reason": "refused"}]'
              ) as runs_refused,
              count(distinct meeting_id) filter (
                where status in ('succeeded', 'partial')
              ) as meetings_read
         from extraction_runs
        where ${FINISHED}`,
    ),
  )[0];

  const byStatus: Record<ExtractionRunStatus, number> = {
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
  };
  for (const row of rowsOf(
    await db.raw(
      `select status, count(*) as runs from extraction_runs where ${FINISHED} group by status`,
    ),
  )) {
    const status = asStatus(row.status);
    if (status !== null) byStatus[status] = toInt(row.runs);
  }

  // `jsonb_array_elements` on a scalar raises, so the guard is in the WHERE and
  // the lateral join reads the column only for rows that passed it.
  const reasons = rowsOf(
    await db.raw(
      `select coalesce(chunk ->> 'reason', 'unclassified') as reason,
              count(*) as chunks,
              count(distinct r.id) as runs,
              coalesce(sum(case when jsonb_typeof(chunk -> 'recovered') = 'number'
                                then (chunk ->> 'recovered')::int else 0 end), 0) as recovered
         from extraction_runs r,
              lateral jsonb_array_elements(r.failed_chunks) as chunk
        where r.${FINISHED}
          and ${FAILED_CHUNKS_IS_ARRAY}
        group by 1
        order by 2 desc, 1 asc`,
    ),
  ).map((row): ReasonTally => {
    const raw: unknown = row.reason;
    // A reason string this version does not know reads as `unclassified`, the
    // same as a row written before the taxonomy existed. Both mean "we cannot
    // say why", and inventing a category for the difference would be a claim.
    const known = asReason(raw);
    return {
      reason: known ?? "unclassified",
      chunks: toInt(row.chunks),
      runs: toInt(row.runs),
      recovered: toInt(row.recovered),
    };
  });

  // Two unknown strings collapse to one `unclassified` bucket, so the mapped
  // list can carry the key twice.
  const merged = new Map<DistributionReason, ReasonTally>();
  for (const tally of reasons) {
    const existing = merged.get(tally.reason);
    if (existing === undefined) merged.set(tally.reason, { ...tally });
    else {
      existing.chunks += tally.chunks;
      existing.runs += tally.runs;
      existing.recovered += tally.recovered;
    }
  }

  const chunks = toInt(totals?.chunks);
  const unread = toInt(totals?.unread);
  const byReason = [...merged.values()].sort(
    (a, b) => b.chunks - a.chunks || a.reason.localeCompare(b.reason),
  );
  return {
    runs: toInt(totals?.runs),
    meetings: toInt(totals?.meetings),
    chunks,
    unread,
    unread_fraction: chunks > 0 ? Math.round((unread / chunks) * 1000) / 1000 : 0,
    recovered: byReason.reduce((total, tally) => total + tally.recovered, 0),
    by_status: byStatus,
    by_reason: byReason,
    runs_wholly_unread: toInt(totals?.runs_wholly_unread),
    runs_refused: toInt(totals?.runs_refused),
    meetings_read: toInt(totals?.meetings_read),
  };
}

export interface ExtractionBacklog {
  /** Meetings whose minutes are stored, so extraction is possible at all. */
  eligible: number;
  /** Of those, meetings with a run that read something. */
  read: number;
  /** Of those, meetings with no such run. The backlog depth. */
  unread: number;
  /** `extract` jobs waiting or in flight. */
  queued: number;
  /** `extract` jobs the worker refused to retry — no key, a scan, not a PDF. */
  blocked: number;
  /** `extract` jobs that exhausted their attempts. */
  failed: number;
}

/**
 * A meeting whose minutes are stored and unread.
 *
 * `sha256` is carried so the caller can see *which* bytes it would be reading,
 * and `source_id` because an `extract` job needs an `ingestion_runs` row and a
 * run needs a source. Both come from the `parse` job that captured the bytes,
 * which is the same path `findMinutesArtifact` walks — a second answer derived
 * from the jurisdiction could disagree with it.
 */
export interface UnextractedMeeting {
  meeting_id: string;
  sha256: string;
  published: boolean;
}

/**
 * The minutes this pipeline is able to read, as a subquery.
 *
 * Deliberately the same join `findMinutesArtifact` uses: a `parse` job whose
 * target names a meeting and a documentType of minutes, resolved to the stored
 * artifact by content address. Anything else — the newest artifact for the
 * meeting, a URL match on `meeting_documents` — is a *different* set of bytes
 * from the one extraction would actually run against, and a backlog counted
 * over one set and worked off another is a backlog that never empties.
 */
const ELIGIBLE_MINUTES = `
  select distinct on (j.target ->> 'meetingId')
         (j.target ->> 'meetingId') as meeting_id,
         a.sha256 as sha256
    from ingestion_jobs j
    join artifacts a on a.sha256 = j.target ->> 'sha256'
   where j.stage = 'parse'
     and j.target ->> 'meetingId' is not null
     and lower(coalesce(j.target ->> 'documentType', '')) = 'minutes'
   order by j.target ->> 'meetingId', j.created_at desc
`;

/** Counts for the console and the status page: how much of the corpus is unread. */
export async function extractionBacklog(db: Knex): Promise<ExtractionBacklog> {
  const totals = rowsOf(
    await db.raw(
      `with eligible as (${ELIGIBLE_MINUTES})
       select count(*) as eligible,
              count(*) filter (
                where exists (
                  select 1 from extraction_runs r
                   where r.meeting_id::text = eligible.meeting_id
                     and r.status in ('succeeded', 'partial')
                )
              ) as read
         from eligible`,
    ),
  )[0];

  const jobs = rowsOf(
    await db.raw(
      `select status, count(*) as jobs
         from ingestion_jobs
        where stage = 'extract'
        group by status`,
    ),
  );
  const byStatus = new Map<string, number>();
  for (const row of jobs) {
    if (typeof row.status === "string") byStatus.set(row.status, toInt(row.jobs));
  }

  const eligible = toInt(totals?.eligible);
  const read = toInt(totals?.read);
  return {
    eligible,
    read,
    unread: eligible - read,
    queued: (byStatus.get("pending") ?? 0) + (byStatus.get("running") ?? 0),
    blocked: byStatus.get("blocked") ?? 0,
    failed: byStatus.get("failed") ?? 0,
  };
}

export interface UnextractedOptions {
  limit?: number;
  /**
   * Only meetings an operator has published.
   *
   * Off by default: the backlog is *our* work queue, and an unpublished meeting
   * is exactly the one whose claims a reviewer has not seen yet. The flag
   * exists because §5's bar is stated over published meetings.
   */
  publishedOnly?: boolean;
}

/**
 * Meetings with stored minutes and no reading of them.
 *
 * Excludes anything already queued: enqueueing a second `extract` job for a
 * meeting is refused by `enqueueExtraction` with a 409, and a backfill that
 * spends its limit collecting 409s is a backfill that never reaches the work.
 */
export async function listUnextractedMeetings(
  db: Knex,
  options: UnextractedOptions = {},
): Promise<UnextractedMeeting[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const rows = rowsOf(
    await db.raw(
      `with eligible as (${ELIGIBLE_MINUTES})
       select e.meeting_id, e.sha256, (m.published_at is not null) as published
         from eligible e
         join meetings m on m.id::text = e.meeting_id
        where not exists (
                select 1 from extraction_runs r
                 where r.meeting_id = m.id and r.status in ('succeeded', 'partial')
              )
          and not exists (
                select 1 from ingestion_jobs j
                 where j.stage = 'extract'
                   and j.status in ('pending', 'running')
                   and j.target ->> 'meetingId' = e.meeting_id
              )
          ${options.publishedOnly === true ? "and m.published_at is not null" : ""}
        order by m.date desc nulls last
        limit ?`,
      [limit],
    ),
  );

  const meetings: UnextractedMeeting[] = [];
  for (const row of rows) {
    if (typeof row.meeting_id !== "string" || typeof row.sha256 !== "string") continue;
    meetings.push({
      meeting_id: row.meeting_id,
      sha256: row.sha256,
      published: row.published === true,
    });
  }
  return meetings;
}
