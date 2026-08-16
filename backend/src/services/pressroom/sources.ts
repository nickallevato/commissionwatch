import type { Knex } from "knex";
import { FAILURE_KEYS, SUCCESS_KEYS } from "../ingestion/scheduler";
import { CorrectionError, type CorrectionActor } from "./corrections";

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

/**
 * **Two axes, because one word was answering two questions and getting one of
 * them wrong.**
 *
 * On 2026-08-16 `gallatin-civicplus` read `healthy` while holding zero records —
 * ever. Both halves of that were true of different things: the machinery had
 * completed a run, and the dataset was empty. A single verdict has to pick one,
 * and it picked the flattering one.
 *
 * So the pipeline verdict answers *"does the machinery work?"* and the
 * collection verdict answers *"is there anything in the archive?"*. A source can
 * be `healthy`/`empty` — running perfectly, collecting nothing, which is the
 * worst case to render as one green word — or `failing`/`collecting`, a corpus
 * that exists and a scraper that has since broken. Those want different
 * responses from an operator, so they get different words.
 */
export type PipelineVerdict = "disabled" | "never_run" | "failing" | "suspect" | "healthy";

/**
 * What the archive holds, independent of whether tonight's run worked.
 *
 * `empty` is deliberately not called "healthy with no records". This project's
 * whole premise is the published corpus, and a source that has never landed a
 * record is not a source — it is a configuration that has never done its job,
 * however cleanly it exits.
 */
export type CollectionVerdict = "disabled" | "empty" | "stalled" | "collecting";

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
  /** Does the machinery work? */
  pipeline: PipelineVerdict;
  /** Is there anything in the archive, and did it grow recently? */
  collection: {
    verdict: CollectionVerdict;
    /** When a run last landed a record, not when one last exited cleanly. */
    last_record_at: string | null;
    hours_since_record: number | null;
  };
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
 * opposite direction. "Never succeeded" is reported by `pipeline` as
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

export interface PipelineInput {
  enabled: boolean;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  latestRunStatus: RunStatusValue | null;
  silence: SilenceVerdict;
}

export interface CollectionInput {
  enabled: boolean;
  lifetimeRecords: number;
  lastRecordAt: Date | null;
  expectedIntervalHours: number | null;
  now: Date;
}

/**
 * What the archive holds.
 *
 * Note what this deliberately does **not** consult: `last_success_at`. A run
 * that succeeded at collecting nothing moves that column and tells us nothing
 * about the corpus, and letting it in here would rebuild the exact conflation
 * this second axis exists to break.
 *
 * `stalled` needs a stated interval, and without one the answer is
 * `collecting` rather than an invented deadline — the same refusal
 * `assessSilence` makes, for the same reason. The pipeline axis is where an
 * unstated expectation shows up, as `unknown` silence.
 */
export function assessCollection(input: CollectionInput): CollectionVerdict {
  if (!input.enabled) return "disabled";
  if (input.lifetimeRecords <= 0 || input.lastRecordAt === null) return "empty";
  const { expectedIntervalHours } = input;
  if (expectedIntervalHours === null || expectedIntervalHours <= 0) return "collecting";
  const hours = (input.now.getTime() - input.lastRecordAt.getTime()) / 3_600_000;
  return hours > expectedIntervalHours ? "stalled" : "collecting";
}

/**
 * One word for whether the machinery runs. **Not for whether it collects
 * anything** — that is `assessCollection`, and keeping the two apart is the
 * point.
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
export function assessPipeline(input: PipelineInput): PipelineVerdict {
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
    // `started_at` comes along because the collection axis needs to know when a
    // record last landed, which is a different date from when a run last
    // exited cleanly.
    db("ingestion_runs").whereIn("source_id", ids).select("source_id", "counts", "started_at"),
    db("ingestion_runs")
      .whereIn("source_id", ids)
      .select("id", "source_id", "status", "started_at", "finished_at", "counts", "error")
      .orderBy([
        { column: "source_id", order: "asc" },
        { column: "started_at", order: "desc" },
      ]),
  ]);

  const lifetime = new Map<string, number>();
  const lastRecord = new Map<string, Date>();
  for (const raw of Array.isArray(runRows) ? runRows : []) {
    if (!isRecord(raw)) continue;
    const sourceId = asString(raw.source_id);
    const records = recordsIn(readCounts(raw.counts));
    lifetime.set(sourceId, (lifetime.get(sourceId) ?? 0) + records);
    if (records <= 0) continue;
    const startedAt = asIsoOrNull(raw.started_at);
    if (startedAt === null) continue;
    const at = new Date(startedAt);
    const previous = lastRecord.get(sourceId);
    if (previous === undefined || at > previous) lastRecord.set(sourceId, at);
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
    const lastRecordAt = lastRecord.get(id) ?? null;
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
      pipeline: assessPipeline({
        enabled,
        lastSuccessAt: usableLastSuccess,
        consecutiveFailures: asNumber(row.consecutive_failures, 0),
        latestRunStatus: latestRun === null ? null : latestRun.status,
        silence: silence.verdict,
      }),
      collection: {
        verdict: assessCollection({
          enabled,
          lifetimeRecords: lifetime.get(id) ?? 0,
          lastRecordAt: lastRecordAt,
          expectedIntervalHours,
          now,
        }),
        last_record_at: lastRecordAt === null ? null : lastRecordAt.toISOString(),
        hours_since_record:
          lastRecordAt === null
            ? null
            : Math.max(0, Math.round(((now.getTime() - lastRecordAt.getTime()) / 3_600_000) * 10) / 10),
      },
      latest_run: latestRun,
    };
  });
}

// ---------------------------------------------------------------------------
// Turning a source on and off
// ---------------------------------------------------------------------------

/**
 * The one write on this screen.
 *
 * Every source registers disabled — `registration.ts` says why, and the default
 * is right: a source that begins sweeping the moment it is deployed is a source
 * nobody chose. But until this existed, nothing in the running system could
 * undo it. The only code that flipped `enabled` was `src/scripts/sweep.ts`, and
 * `backend/Dockerfile` copies `dist/` and `migrations/` and never `src/`, so
 * that script does not exist inside the production image. Going live meant
 * hand-written SQL against the host — the precise thing registration was built
 * to replace — and the console's own **Sweep now** button was a no-op, because
 * `runSweep` skips a disabled source before it does anything else.
 *
 * Logged to `operator_actions`, not to `record_corrections`. That was not the
 * first choice — reusing the corrections log looked tidier — and the database
 * refused it: migration 031 CHECKs `target_table` against the three record
 * tables. The refusal is a distinction worth keeping. `record_corrections` is
 * published as the public corrections log, and a configuration change listed
 * there would read as a correction to the record. Nobody's agenda was misstated
 * because a source was off. See migration 071.
 */
export interface SetSourceEnabledInput {
  enabled: boolean;
  reason: string;
  actor: CorrectionActor;
}

export interface OperatorActionRow {
  id: string;
  action: string;
  target_table: string;
  target_id: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  operator_id: string | null;
  operator_email: string | null;
  created_at: string;
}

export interface SourceToggleResult {
  id: string;
  enabled: boolean;
  disabled_reason: string | null;
  action: OperatorActionRow;
}

export async function setSourceEnabled(
  db: Knex,
  sourceId: string,
  input: SetSourceEnabledInput,
): Promise<SourceToggleResult> {
  if (input.reason.trim() === "") {
    throw new CorrectionError(
      "reason is required: enabling a source is a decision, and a decision has a reason",
      400,
    );
  }

  return db.transaction(async (trx) => {
    const current: unknown = await trx("ingestion_sources").where({ id: sourceId }).first();
    if (!isSourceRow(current)) {
      throw new CorrectionError("Source not found", 404);
    }

    const was = current.enabled === true;

    // The reason a source *was* disabled is not the reason it is now enabled.
    // Carrying the old text onto an enabled row makes the console say a live
    // source is blocked; dropping it when disabling would break decision 3,
    // which is that a disabled source stays listed with the reason it is off.
    const disabledReason = input.enabled ? null : input.reason;

    const inserted: unknown = await trx("operator_actions")
      .insert({
        action: input.enabled ? "source.enabled" : "source.disabled",
        target_table: "ingestion_sources",
        target_id: sourceId,
        old_value: was ? "true" : "false",
        new_value: input.enabled ? "true" : "false",
        reason: input.reason,
        operator_id: input.actor.id,
        // Snapshotted, not joined — the log must still name who acted after the
        // operator row is gone, and migration 071 has no foreign key to keep it
        // honest.
        operator_email: input.actor.email,
      })
      .returning("*");

    await trx("ingestion_sources")
      .where({ id: sourceId })
      .update({
        enabled: input.enabled,
        disabled_reason: disabledReason,
        updated_at: trx.fn.now(),
      });

    return {
      id: sourceId,
      enabled: input.enabled,
      disabled_reason: disabledReason,
      action: toOperatorAction(Array.isArray(inserted) ? inserted[0] : undefined),
    };
  });
}

function isSourceRow(value: unknown): value is { enabled: unknown } {
  return typeof value === "object" && value !== null && "enabled" in value;
}

function toOperatorAction(row: unknown): OperatorActionRow {
  if (typeof row !== "object" || row === null) {
    throw new Error("operator_actions: insert returned no row");
  }
  const value = row as Record<string, unknown>;
  const createdAt = value.created_at;
  return {
    id: asString(value.id),
    action: asString(value.action),
    target_table: asString(value.target_table),
    target_id: asString(value.target_id),
    old_value: typeof value.old_value === "string" ? value.old_value : null,
    new_value: typeof value.new_value === "string" ? value.new_value : null,
    reason: asString(value.reason),
    operator_id: typeof value.operator_id === "string" ? value.operator_id : null,
    operator_email: typeof value.operator_email === "string" ? value.operator_email : null,
    created_at: createdAt instanceof Date ? createdAt.toISOString() : asString(createdAt),
  };
}

/** One source's decision history, newest first. */
export async function listSourceActions(
  db: Knex,
  sourceId: string,
): Promise<OperatorActionRow[]> {
  const rows: unknown = await db("operator_actions")
    .where({ target_table: "ingestion_sources", target_id: sourceId })
    .orderBy("created_at", "desc")
    .limit(50)
    .select("*");
  return (Array.isArray(rows) ? rows : []).map(toOperatorAction);
}
