import type { Knex } from "knex";

/**
 * What the shared ingestion queue looks like right now.
 *
 * ## Why this exists
 *
 * `ingestion_jobs` is claimed **globally, oldest-first**, with no per-source
 * share — `CLAIM_SQL` orders by `next_attempt_at` and filters on nothing else.
 * That is deliberate: it is what makes a large archive finish across runs. It
 * also means the queue, not the source, is the unit that behaves, and until this
 * module existed **nothing** in the product could see the queue at all.
 *
 * The cost of that blind spot was paid in production. On 2026-08-16 the console
 * showed `gallatin-civicplus` as **Healthy** while it had ingested zero records
 * in its entire life: every sweep it ran spent its whole fifteen-minute budget
 * draining `bozeman-granicus`'s older backlog, and its own single `discover` job
 * — the newest row in the queue — was never reached. Three consecutive sweeps
 * recorded byte-identical counts, `{processed: 90, outstanding: 1}`, and the
 * per-source screen could not show why, because starvation is a property of the
 * queue and that screen only ever showed sources.
 *
 * So the figures here are deliberately queue-shaped: depth, the age of the head,
 * and the per-source share of what is waiting. A source holding 1,411 of 1,412
 * pending jobs is the explanation, and it is only visible when you count the
 * queue.
 *
 * ## What it does not do
 *
 * It reports and judges nothing. There is no `starved: true` field, because
 * "starved" is a threshold somebody has to choose and a threshold buried in an
 * API is a decision nobody can see. The console composes that word from
 * `pending`, `oldest_pending_at` and `completed_lifetime`, where a reader can
 * check it.
 */

export interface QueueStageStat {
  stage: string;
  pending: number;
}

export interface QueueSourceStat {
  source_id: string;
  adapter_key: string;
  enabled: boolean;
  /** Jobs of this source's runs still waiting. */
  pending: number;
  /** When the oldest of them became eligible. Null when none are waiting. */
  oldest_pending_at: string | null;
  /** Jobs of this source's runs that have ever completed. */
  completed_lifetime: number;
}

export interface QueueStats {
  /** Pending jobs across every source. The number the claim walks. */
  depth: number;
  /**
   * `next_attempt_at` of the oldest pending job, across all sources.
   *
   * This is the head of the queue, and therefore what everything newer is
   * waiting behind. It is the single most diagnostic figure here.
   */
  oldest_pending_at: string | null;
  /**
   * Jobs that reached `done` in the last hour.
   *
   * Measured from `updated_at`, which is the completion time for a done job.
   * **Approximate on purpose**: `updated_at` is touched by any write, so a job
   * that completed after retries is counted at its last write. Good enough to
   * answer "is the queue moving", not precise enough to bill anyone for.
   */
  drained_last_hour: number;
  by_stage: QueueStageStat[];
  by_source: QueueSourceStat[];
  /** When these figures were read, so a stale console can say so. */
  read_at: string;
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asStamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

/** Read the queue's current shape. One round trip per question, no joins in JS. */
export async function readQueueStats(db: Knex): Promise<QueueStats> {
  const overall = await db("ingestion_jobs")
    .where({ status: "pending" })
    .select<Array<{ depth: unknown; oldest: unknown }>>(
      db.raw("count(*) as depth"),
      db.raw("min(next_attempt_at) as oldest"),
    )
    .first();

  const drained = await db("ingestion_jobs")
    .where({ status: "done" })
    .andWhere("updated_at", ">=", db.raw("now() - interval '1 hour'"))
    .select<Array<{ total: unknown }>>(db.raw("count(*) as total"))
    .first();

  const stages = await db("ingestion_jobs")
    .where({ status: "pending" })
    .groupBy("stage")
    .orderBy("stage")
    .select<Array<{ stage: unknown; pending: unknown }>>(
      "stage",
      db.raw("count(*) as pending"),
    );

  // Every registered source appears, including ones with nothing queued — a
  // source absent from this list would read as a source that does not exist,
  // which is the confusion the console is for.
  const sources = await db("ingestion_sources as s")
    .leftJoin("ingestion_runs as r", "r.source_id", "s.id")
    .leftJoin("ingestion_jobs as j", "j.run_id", "r.id")
    .groupBy("s.id", "s.adapter_key", "s.enabled")
    .orderBy("s.adapter_key")
    .select<
      Array<{
        source_id: unknown;
        adapter_key: unknown;
        enabled: unknown;
        pending: unknown;
        oldest_pending_at: unknown;
        completed_lifetime: unknown;
      }>
    >(
      "s.id as source_id",
      "s.adapter_key",
      "s.enabled",
      db.raw("count(j.id) filter (where j.status = 'pending') as pending"),
      db.raw(
        "min(j.next_attempt_at) filter (where j.status = 'pending') as oldest_pending_at",
      ),
      db.raw("count(j.id) filter (where j.status = 'done') as completed_lifetime"),
    );

  return {
    depth: asCount(overall?.depth),
    oldest_pending_at: asStamp(overall?.oldest),
    drained_last_hour: asCount(drained?.total),
    by_stage: stages.map((row) => ({
      stage: String(row.stage),
      pending: asCount(row.pending),
    })),
    by_source: sources.map((row) => ({
      source_id: String(row.source_id),
      adapter_key: String(row.adapter_key),
      enabled: row.enabled === true,
      pending: asCount(row.pending),
      oldest_pending_at: asStamp(row.oldest_pending_at),
      completed_lifetime: asCount(row.completed_lifetime),
    })),
    read_at: new Date().toISOString(),
  };
}

export interface RecentRun {
  run_id: string;
  adapter_key: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  /** Jobs of this run that completed — the sweep's own work. */
  own_completed: number;
  /** Jobs of this run still queued when it stopped. */
  own_outstanding: number;
  /**
   * Jobs the sweep finished that belonged to some *other* run.
   *
   * `counts.processed` minus its own completions. This is the column that makes
   * starvation visible across time: five consecutive sweeps reading own 0 /
   * others 90 is a queue nobody's own work ever reaches, and no per-source view
   * can show it.
   */
  others_completed: number;
}

/**
 * The most recent sweeps across every source, newest first.
 *
 * Exists because the console could show one run per source and no history, so a
 * pattern repeating across sweeps — the shape of the 2026-08-16 starvation bug —
 * had nowhere to appear.
 */
export async function listRecentRuns(db: Knex, limit: number): Promise<RecentRun[]> {
  const rows = await db("ingestion_runs as r")
    .join("ingestion_sources as s", "s.id", "r.source_id")
    .leftJoin("ingestion_jobs as j", "j.run_id", "r.id")
    .groupBy("r.id", "s.adapter_key")
    .orderBy("r.started_at", "desc")
    .limit(limit)
    .select<
      Array<{
        run_id: unknown;
        adapter_key: unknown;
        status: unknown;
        started_at: unknown;
        finished_at: unknown;
        counts: unknown;
        own_completed: unknown;
        own_outstanding: unknown;
      }>
    >(
      "r.id as run_id",
      "s.adapter_key",
      "r.status",
      "r.started_at",
      "r.finished_at",
      "r.counts",
      db.raw("count(j.id) filter (where j.status = 'done') as own_completed"),
      db.raw(
        "count(j.id) filter (where j.status in ('pending','running')) as own_outstanding",
      ),
    );

  return rows.map((row) => {
    const own = asCount(row.own_completed);
    const processed = processedOf(row.counts);
    return {
      run_id: String(row.run_id),
      adapter_key: String(row.adapter_key),
      status: String(row.status),
      started_at: asStamp(row.started_at),
      finished_at: asStamp(row.finished_at),
      own_completed: own,
      own_outstanding: asCount(row.own_outstanding),
      // Never negative: a sweep can complete fewer jobs than its own run owns
      // when an earlier sweep already drained some of them.
      others_completed: Math.max(0, processed - own),
    };
  });
}

/** `counts.processed`, however the driver hands the jsonb column back. */
function processedOf(counts: unknown): number {
  const source =
    typeof counts === "string"
      ? ((): unknown => {
          try {
            return JSON.parse(counts);
          } catch {
            return null;
          }
        })()
      : counts;
  if (typeof source !== "object" || source === null) return 0;
  const value = (source as Record<string, unknown>).processed;
  return asCount(value);
}

export interface RunWork {
  /** Jobs belonging to this run that completed. */
  own_completed: number;
  /** Jobs belonging to this run still waiting. */
  own_pending: number;
}

/**
 * How much of a sweep's labour was its own.
 *
 * The figure the console could not show. A run's `counts.processed` is *every*
 * job the sweep completed, whichever run enqueued it — so a sweep that drained
 * an older source's backlog reports a healthy `processed` and no work of its
 * own. Subtracting `own_completed` from `processed` gives the split, and a
 * sweep whose own work is zero every time is a sweep that never started its
 * source.
 */
export async function readRunWork(db: Knex, runId: string): Promise<RunWork> {
  const row = await db("ingestion_jobs")
    .where({ run_id: runId })
    .select<Array<{ own_completed: unknown; own_pending: unknown }>>(
      db.raw("count(*) filter (where status = 'done') as own_completed"),
      db.raw("count(*) filter (where status in ('pending','running')) as own_pending"),
    )
    .first();

  return {
    own_completed: asCount(row?.own_completed),
    own_pending: asCount(row?.own_pending),
  };
}
