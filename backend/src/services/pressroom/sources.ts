import type { Knex } from "knex";
import { FAILURE_KEYS, SUCCESS_KEYS } from "../ingestion/scheduler";

/**
 * The sources screen: every ingestion source, including the ones that are off.
 *
 * Three of P2's decisions live in this file, and all three are about refusing
 * to let an absence look like a normal state:
 *
 *  - **Zero is a failure state.** `lifetime_records` is computed, and the
 *    console renders 0 in the failure colour. The number that has been true for
 *    this product's whole life should look wrong, because it is.
 *  - **Silence is watched.** A source past `expected_interval_hours` since its
 *    last success is *Suspect*. Without that, a dead scraper and a quiet month
 *    at City Hall render identically, and the operator learns nothing from
 *    either.
 *  - **Disabled sources stay listed**, with the reason they are off. Filtering
 *    them out is how "bozemanmt.gov is a blanket Akamai deny" stops being
 *    written down anywhere and becomes something somebody remembers.
 */

export type SilenceVerdict = "ok" | "suspect" | "unknown";

export type SourceVerdict = "disabled" | "never_run" | "failing" | "suspect" | "healthy";

export type RunStatusValue = "running" | "succeeded" | "partial" | "failed";

export interface LatestRun {
  id: string;
  status: RunStatusValue;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  error: string | null;
}

export interface PressroomSource {
  id: string;
  adapter_key: string;
  enabled: boolean;
  disabled_reason: string | null;
  health_status: string;
  cron_expression: string;
  expected_interval_hours: number | null;
  consecutive_failures: number;
  jurisdiction: { id: string; name: string; state: string };
  last_success_at: string | null;
  lifetime_records: number;
  silence: {
    verdict: SilenceVerdict;
    hours_since_success: number | null;
    expected_interval_hours: number | null;
  };
  verdict: SourceVerdict;
  latest_run: LatestRun | null;
}

// ---------------------------------------------------------------------------
// Row reading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // pg returns bigint and numeric as strings. A count that silently became
  // NaN would render as an empty cell, which reads as "nothing here" —
  // the one thing this screen must never say by accident.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * `ingestion_runs.counts` as numbers.
 *
 * jsonb arrives as an object from pg, and as a string from some driver
 * configurations. Both are handled rather than assumed, because the failure
 * mode of assuming is a screen that says zero.
 */
export function readCounts(value: unknown): Record<string, number> {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!isRecord(source)) return {};
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const parsed = asNumber(raw, Number.NaN);
    if (Number.isFinite(parsed)) counts[key] = parsed;
  }
  return counts;
}

/** Records this run landed in the database. */
export function recordsIn(counts: Record<string, number>): number {
  return SUCCESS_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

/** Failures this run recorded. */
export function failuresIn(counts: Record<string, number>): number {
  return FAILURE_KEYS.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

// ---------------------------------------------------------------------------
// The two judgements
// ---------------------------------------------------------------------------

export interface SilenceInput {
  lastSuccessAt: Date | null;
  expectedIntervalHours: number | null;
  now: Date;
}

/**
 * Has this source been quiet longer than it said it would be?
 *
 * `unknown` when no expectation was stated, or when nothing has ever succeeded.
 * An absent expectation is not an expectation of zero, and claiming a source is
 * fine because nobody said what fine meant would be the same error in the
 * opposite direction. "Never succeeded" is reported by `verdict` as
 * `never_run`, which is louder than `suspect` and should be.
 */
export function assessSilence(input: SilenceInput): PressroomSource["silence"] {
  const { lastSuccessAt, expectedIntervalHours, now } = input;
  if (lastSuccessAt === null) {
    return {
      verdict: "unknown",
      hours_since_success: null,
      expected_interval_hours: expectedIntervalHours,
    };
  }

  const hours = (now.getTime() - lastSuccessAt.getTime()) / 3_600_000;
  const rounded = Math.max(0, Math.round(hours * 10) / 10);

  if (expectedIntervalHours === null || expectedIntervalHours <= 0) {
    return {
      verdict: "unknown",
      hours_since_success: rounded,
      expected_interval_hours: expectedIntervalHours,
    };
  }

  return {
    verdict: hours > expectedIntervalHours ? "suspect" : "ok",
    hours_since_success: rounded,
    expected_interval_hours: expectedIntervalHours,
  };
}

export interface VerdictInput {
  enabled: boolean;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  latestRunStatus: RunStatusValue | null;
  silence: SilenceVerdict;
}

/**
 * One word for the state of a source.
 *
 * Precedence is deliberate and ordered by how much it tells the operator:
 *
 *   disabled → never_run → failing → suspect → healthy
 *
 * `failing` outranks `suspect` because a named failure — an error string in a
 * run row — is more useful than an inference drawn from silence. `never_run`
 * outranks both because a source that has never succeeded is not degraded, it
 * has never worked, and those want different responses.
 */
export function assessVerdict(input: VerdictInput): SourceVerdict {
  if (!input.enabled) return "disabled";
  if (input.lastSuccessAt === null) return "never_run";
  if (input.latestRunStatus === "failed" || input.consecutiveFailures > 0) return "failing";
  if (input.silence === "suspect") return "suspect";
  return "healthy";
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

const RUN_STATUSES: readonly RunStatusValue[] = ["running", "succeeded", "partial", "failed"];

function asRunStatus(value: unknown): RunStatusValue | null {
  return RUN_STATUSES.find((status) => status === value) ?? null;
}

/**
 * Every source, disabled ones included, newest-first by jurisdiction then key.
 *
 * Three queries rather than one clever join: the run tallies are per-source
 * aggregates and the latest run is a per-source top-1, and expressing both in
 * one statement produces SQL nobody will edit correctly later. There are two
 * sources.
 */
export async function listSources(db: Knex, now: Date = new Date()): Promise<PressroomSource[]> {
  const rows: unknown = await db("ingestion_sources as s")
    .join("jurisdictions as j", "s.jurisdiction_id", "j.id")
    .select(
      "s.id as id",
      "s.adapter_key as adapter_key",
      "s.enabled as enabled",
      "s.disabled_reason as disabled_reason",
      "s.health_status as health_status",
      "s.cron_expression as cron_expression",
      "s.expected_interval_hours as expected_interval_hours",
      "s.consecutive_failures as consecutive_failures",
      "s.last_success_at as last_success_at",
      "j.id as jurisdiction_id",
      "j.name as jurisdiction_name",
      "j.state as jurisdiction_state",
    )
    .orderBy([
      { column: "j.name", order: "asc" },
      { column: "s.adapter_key", order: "asc" },
    ]);

  const sourceRows = (Array.isArray(rows) ? rows : []).filter(isRecord);
  const ids = sourceRows.map((row) => asString(row.id)).filter((id) => id !== "");
  if (ids.length === 0) return [];

  const [runRows, latestRows] = await Promise.all([
    db("ingestion_runs").whereIn("source_id", ids).select("source_id", "counts"),
    db("ingestion_runs")
      .whereIn("source_id", ids)
      .select("id", "source_id", "status", "started_at", "finished_at", "counts", "error")
      .orderBy([
        { column: "source_id", order: "asc" },
        { column: "started_at", order: "desc" },
      ]),
  ]);

  const lifetime = new Map<string, number>();
  for (const raw of Array.isArray(runRows) ? runRows : []) {
    if (!isRecord(raw)) continue;
    const sourceId = asString(raw.source_id);
    lifetime.set(sourceId, (lifetime.get(sourceId) ?? 0) + recordsIn(readCounts(raw.counts)));
  }

  const latest = new Map<string, LatestRun>();
  for (const raw of Array.isArray(latestRows) ? latestRows : []) {
    if (!isRecord(raw)) continue;
    const sourceId = asString(raw.source_id);
    // Ordered newest-first per source, so the first one wins.
    if (latest.has(sourceId)) continue;
    const startedAt = asIsoOrNull(raw.started_at);
    if (startedAt === null) continue;
    latest.set(sourceId, {
      id: asString(raw.id),
      status: asRunStatus(raw.status) ?? "failed",
      started_at: startedAt,
      finished_at: asIsoOrNull(raw.finished_at),
      counts: readCounts(raw.counts),
      error: typeof raw.error === "string" ? raw.error : null,
    });
  }

  return sourceRows.map((row): PressroomSource => {
    const id = asString(row.id);
    const lastSuccessRaw = row.last_success_at;
    const lastSuccessAt =
      lastSuccessRaw instanceof Date
        ? lastSuccessRaw
        : typeof lastSuccessRaw === "string" && lastSuccessRaw !== ""
          ? new Date(lastSuccessRaw)
          : null;
    const usableLastSuccess =
      lastSuccessAt !== null && !Number.isNaN(lastSuccessAt.getTime()) ? lastSuccessAt : null;

    const expectedIntervalHours =
      row.expected_interval_hours === null || row.expected_interval_hours === undefined
        ? null
        : asNumber(row.expected_interval_hours, 0) || null;

    const silence = assessSilence({
      lastSuccessAt: usableLastSuccess,
      expectedIntervalHours,
      now,
    });

    const latestRun = latest.get(id) ?? null;
    const enabled = row.enabled === true;

    return {
      id,
      adapter_key: asString(row.adapter_key),
      enabled,
      disabled_reason: typeof row.disabled_reason === "string" ? row.disabled_reason : null,
      health_status: asString(row.health_status, "healthy"),
      cron_expression: asString(row.cron_expression),
      expected_interval_hours: expectedIntervalHours,
      consecutive_failures: asNumber(row.consecutive_failures, 0),
      jurisdiction: {
        id: asString(row.jurisdiction_id),
        name: asString(row.jurisdiction_name),
        state: asString(row.jurisdiction_state),
      },
      last_success_at: usableLastSuccess === null ? null : usableLastSuccess.toISOString(),
      lifetime_records: lifetime.get(id) ?? 0,
      silence,
      verdict: assessVerdict({
        enabled,
        lastSuccessAt: usableLastSuccess,
        consecutiveFailures: asNumber(row.consecutive_failures, 0),
        latestRunStatus: latestRun === null ? null : latestRun.status,
        silence: silence.verdict,
      }),
      latest_run: latestRun,
    };
  });
}
