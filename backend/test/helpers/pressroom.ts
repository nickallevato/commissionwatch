import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/app";
import db from "../../src/config/database";
import { OperatorAuthService } from "../../src/services/auth/operators";
import { TEST_SCRYPT_PARAMS } from "../../src/services/auth/password";

/**
 * Fixtures for the Pressroom console suites.
 *
 * Every row these build is tagged with a per-suite prefix and torn down by
 * prefix, because the console reads whole tables — `listSources` returns every
 * source there is — and a suite that assumed it owned the database would pass
 * alone and fail beside the seed.
 *
 * `record_corrections` is the exception and is never cleaned up: migration 031
 * forbids DELETE on it, which is the property the corrections suite exists to
 * prove. Those tests therefore assert against target ids they generated, never
 * against a table-wide count.
 */

export interface PressroomFixture {
  jurisdictionId: string;
  commissionId: string;
  sourceId: string;
}

/** A jurisdiction, a commission and an ingestion source, all suite-owned. */
export async function createSource(
  prefix: string,
  options: {
    enabled?: boolean;
    disabledReason?: string | null;
    expectedIntervalHours?: number | null;
    lastSuccessAt?: Date | null;
    consecutiveFailures?: number;
    adapterKey?: string;
  } = {},
): Promise<PressroomFixture> {
  const [jurisdiction] = await db("jurisdictions")
    .insert({ name: `${prefix} County`, state: "MT", type: "county" })
    .returning<Array<{ id: string }>>("id");
  const [commission] = await db("commissions")
    .insert({ jurisdiction_id: jurisdiction.id, name: `${prefix} Commission` })
    .returning<Array<{ id: string }>>("id");
  const [source] = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdiction.id,
      adapter_key: options.adapterKey ?? `${prefix}-adapter`,
      enabled: options.enabled ?? false,
      disabled_reason: options.disabledReason ?? null,
      expected_interval_hours: options.expectedIntervalHours ?? null,
      last_success_at: options.lastSuccessAt ?? null,
      consecutive_failures: options.consecutiveFailures ?? 0,
    })
    .returning<Array<{ id: string }>>("id");

  return { jurisdictionId: jurisdiction.id, commissionId: commission.id, sourceId: source.id };
}

/** One `ingestion_runs` row. `finished_at` is required for a terminal status. */
export async function createRun(
  sourceId: string,
  options: {
    status?: "running" | "succeeded" | "partial" | "failed";
    counts?: Record<string, number>;
    error?: string | null;
    startedAt?: Date;
  } = {},
): Promise<string> {
  const status = options.status ?? "succeeded";
  const startedAt = options.startedAt ?? new Date();
  const [row] = await db("ingestion_runs")
    .insert({
      source_id: sourceId,
      status,
      started_at: startedAt,
      finished_at: status === "running" ? null : new Date(startedAt.getTime() + 1000),
      counts: JSON.stringify(options.counts ?? {}),
      error: options.error ?? null,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

export async function createJob(
  runId: string,
  stage: "discover" | "fetch" | "parse" | "analyze",
  target: Record<string, unknown>,
  options: {
    status?: "pending" | "running" | "done" | "failed" | "blocked";
    lastError?: string | null;
    attempts?: number;
  } = {},
): Promise<string> {
  const [row] = await db("ingestion_jobs")
    .insert({
      run_id: runId,
      stage,
      target: JSON.stringify(target),
      status: options.status ?? "done",
      attempts: options.attempts ?? 1,
      last_error: options.lastError ?? null,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

export async function createMeeting(
  commissionId: string,
  options: { publishedAt?: Date | null; date?: string; location?: string } = {},
): Promise<string> {
  const [row] = await db("meetings")
    .insert({
      commission_id: commissionId,
      date: options.date ?? "2026-08-04",
      status: "completed",
      location: options.location ?? "City Hall",
      published_at: options.publishedAt ?? null,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

/**
 * A 64-hex content address, stable for a given seed.
 *
 * The real thing, from `node:crypto`. A hand-rolled stand-in collided on seeds
 * sharing a prefix — "pressroom-runs-a" and "pressroom-runs-b" produced the
 * same address — and `artifacts.sha256` is unique, so the fixtures failed to
 * build. A content address that is not a content address is not a shortcut.
 */
export function sha256Of(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export async function createArtifact(sha256: string, sourceUrl: string): Promise<string> {
  const [row] = await db("artifacts")
    .insert({
      sha256,
      storage_key: `artifacts/${sha256.slice(0, 2)}/${sha256}`,
      content_type: "application/pdf",
      source_url: sourceUrl,
      byte_size: 1234,
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

/**
 * Removes everything a suite created, in dependency order.
 *
 * `record_corrections` is deliberately absent — the trigger would refuse, and
 * that refusal is the feature.
 */
export async function cleanupByPrefix(prefix: string): Promise<void> {
  const jurisdictions = await db("jurisdictions")
    .where("name", "like", `${prefix}%`)
    .select<Array<{ id: string }>>("id");
  const jurisdictionIds = jurisdictions.map((row) => row.id);
  if (jurisdictionIds.length === 0) return;

  const sources = await db("ingestion_sources")
    .whereIn("jurisdiction_id", jurisdictionIds)
    .select<Array<{ id: string }>>("id");
  const sourceIds = sources.map((row) => row.id);
  if (sourceIds.length > 0) {
    // ingestion_jobs cascades from ingestion_runs, which cascades from sources.
    await db("ingestion_runs").whereIn("source_id", sourceIds).del();
    await db("ingestion_sources").whereIn("id", sourceIds).del();
  }

  const commissions = await db("commissions")
    .whereIn("jurisdiction_id", jurisdictionIds)
    .select<Array<{ id: string }>>("id");
  const commissionIds = commissions.map((row) => row.id);
  if (commissionIds.length > 0) {
    await db("meetings").whereIn("commission_id", commissionIds).del();
    await db("commissions").whereIn("id", commissionIds).del();
  }
  await db("jurisdictions").whereIn("id", jurisdictionIds).del();
}

export async function deleteArtifacts(hashes: string[]): Promise<void> {
  if (hashes.length > 0) await db("artifacts").whereIn("sha256", hashes).del();
}

/** Signs in a suite-owned operator and returns its session cookie. */
export async function signInOperator(email: string, name: string): Promise<string> {
  const auth = new OperatorAuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, log: () => {} });
  const password = `pressroom-${randomUUID()}`;
  await db("operators").where({ email }).del();
  await auth.createOperator({ email, password, name });
  const res = await request(app).post("/api/admin/session").send({ email, password }).expect(200);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies.find((value: string) => value.startsWith("cw_session="));
  assert.ok(cookie, "sign-in returned no session cookie");
  return cookie.split(";")[0];
}
