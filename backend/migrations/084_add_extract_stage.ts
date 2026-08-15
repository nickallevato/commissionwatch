import type { Knex } from 'knex';

/**
 * `extract` becomes a queue stage.
 *
 * Extraction used to be `void runExtraction(...)` in a request handler
 * (`routes/admin/pressroom.ts`). An unawaited promise owns no row: a deploy or
 * a restart mid-run lost the work and left `extraction_runs` `running` forever,
 * which its own `CHECK ((status = 'running') = (finished_at IS NULL))` then
 * made permanent. There was also no concurrency control against a per-minute
 * rate-limited free tier and no queue depth to look at, so "how much of the
 * corpus is unread" had no answer.
 *
 * The stage sits after `parse` and obeys the post-`fetch` invariant the queue's
 * header states: its target carries a content address and no URL, and it reads
 * bytes the fetch stage already captured. The one network call it makes is to
 * OpenRouter, which is not a source.
 *
 * `transaction: false` because Postgres refuses to use an enum value added in
 * the same transaction that added it. Nothing here uses it, but a migration
 * that only works because of statement ordering inside a transaction is a trap
 * for whoever edits it next.
 */

export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TYPE ingestion_job_stage ADD VALUE IF NOT EXISTS 'extract'`);
}

export async function down(): Promise<void> {
  // Postgres cannot remove a value from an enum, and rewriting the type would
  // mean rewriting every ingestion_jobs row to drop a stage nobody used. The
  // rollback path that works is migration 018's, which drops the type outright.
}
