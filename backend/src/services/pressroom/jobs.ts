import type { Knex } from "knex";
import { IngestionQueue } from "../ingestion/queue";

/**
 * The queue's individual jobs, so "976 pending" can be opened and read.
 *
 * The console could show how *many* jobs were waiting and never what any of
 * them was. That is the difference between knowing a queue is deep and knowing
 * whether it is deep for a good reason — 972 fetches of a county's document
 * archive and 4 discovers is a healthy backlog; 972 retries of one broken URL is
 * an outage wearing a backlog's clothes, and the two are indistinguishable from
 * a count.
 *
 * ## What a job "is"
 *
 * Every stage carries a different target key, because each stage addresses its
 * work differently — and that is deliberate: only `discover` and `fetch` hold a
 * URL, and every stage after them holds a **content address**, which is the
 * structural reason a post-fetch stage cannot reach the network. `describe()`
 * below reads whichever key the stage uses so the operator sees the thing
 * itself rather than a row of opaque ids.
 */

/** Stages, with the target key each addresses its work by. */
const TARGET_KEY: Readonly<Record<string, string>> = {
  discover: "since",
  fetch: "url",
  parse: "sha256",
  analyze: "sha256",
  extract: "meetingId",
  locate: "meetingId",
  govern: "meetingId",
};

export const JOB_STATUSES = ["pending", "running", "done", "failed", "blocked"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOBS_PAGE_MAX = 200;

/**
 * Returns blocked jobs to the queue, attempts reset.
 *
 * Delegates to `IngestionQueue.unblock` rather than reimplementing the update:
 * that method owns what unblocking means — including that resetting attempts is
 * a human saying the cause is gone — and a second copy here would drift from it
 * the first time either changed.
 *
 * Takes a `Knex` rather than a live ingestion stack because unblocking is a
 * database fact. The worker discovers the change by polling, so this works on a
 * process that never built a stack, which is the same reason the source toggle
 * does not require one.
 */
export function unblockJobs(db: Knex, ids: string[]): Promise<number> {
  return new IngestionQueue(db).unblock(ids);
}

export interface QueuedJob {
  id: string;
  adapter_key: string;
  run_id: string;
  stage: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string | null;
  /**
   * What this job is about, read from whichever target key its stage uses.
   *
   * Null when the target does not carry the expected key — which is itself
   * worth seeing, because it means a job was enqueued in a shape its handler
   * cannot read.
   */
  subject: string | null;
  /** Verbatim. A paraphrased error is a second bug to debug. */
  last_error: string | null;
}

export interface JobsPage {
  data: QueuedJob[];
  total: number;
  /** Counts across the whole filtered set, not just this page. */
  counts: Record<string, number>;
}

export interface JobsQuery {
  status?: string;
  stage?: string;
  /** `ingestion_sources.id`. */
  sourceId?: string;
  limit: number;
  offset: number;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The target's meaningful identifier for this stage, or null if absent. */
export function describe(stage: string, target: unknown): string | null {
  const key = TARGET_KEY[stage];
  if (key === undefined) return null;

  let source: unknown = target;
  if (typeof target === "string") {
    try {
      source = JSON.parse(target);
    } catch {
      return null;
    }
  }
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One page of jobs, newest-queued first, with the counts for the whole filter.
 *
 * Ordered by `next_attempt_at` **descending** rather than the claim's ascending
 * order: the claim wants the oldest first because that is what it runs next, but
 * an operator opening this list is asking "what has just been queued", and the
 * head of the claim order is already reported by the queue endpoint.
 */
export async function listJobs(db: Knex, query: JobsQuery): Promise<JobsPage> {
  const base = () => {
    const q = db("ingestion_jobs as j")
      .join("ingestion_runs as r", "r.id", "j.run_id")
      .join("ingestion_sources as s", "s.id", "r.source_id");
    if (query.status !== undefined) q.where("j.status", query.status);
    if (query.stage !== undefined) q.where("j.stage", query.stage);
    if (query.sourceId !== undefined) q.where("s.id", query.sourceId);
    return q;
  };

  const rows = await base()
    .orderBy([
      { column: "j.next_attempt_at", order: "desc" },
      { column: "j.id", order: "desc" },
    ])
    .limit(query.limit)
    .offset(query.offset)
    .select<
      Array<{
        id: unknown;
        adapter_key: unknown;
        run_id: unknown;
        stage: unknown;
        status: unknown;
        attempts: unknown;
        next_attempt_at: unknown;
        created_at: unknown;
        target: unknown;
        last_error: unknown;
      }>
    >(
      "j.id",
      "s.adapter_key",
      "j.run_id",
      "j.stage",
      "j.status",
      "j.attempts",
      "j.next_attempt_at",
      "j.created_at",
      "j.target",
      "j.last_error",
    );

  const totalRow = await base().count<Array<{ total: unknown }>>({ total: "j.id" }).first();

  // Counts across the filtered set, so the tabs above a filtered list do not
  // report the whole table.
  const statusRows = await base()
    .groupBy("j.status")
    .select<Array<{ status: unknown; n: unknown }>>("j.status", db.raw("count(*) as n"));

  const counts: Record<string, number> = {};
  for (const status of JOB_STATUSES) counts[status] = 0;
  for (const row of statusRows) counts[String(row.status)] = asCount(row.n);

  return {
    data: rows.map((row) => ({
      id: String(row.id),
      adapter_key: String(row.adapter_key),
      run_id: String(row.run_id),
      stage: String(row.stage),
      status: String(row.status),
      attempts: asCount(row.attempts),
      next_attempt_at: asString(row.next_attempt_at),
      created_at: asString(row.created_at),
      subject: describe(String(row.stage), row.target),
      last_error: asString(row.last_error),
    })),
    total: asCount(totalRow?.total),
    counts,
  };
}
