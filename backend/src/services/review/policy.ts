import type { Knex } from "knex";
import { appendCorrectionRow } from "../pressroom/corrections";

/**
 * The review threshold — B-b's replacement, in full.
 *
 * The archive shipped `execution_policies`: per detection type and severity, an
 * ordered list of stages a finding must clear, some automatic, some manual with
 * a required role. Two tables, a JSONB stage validator, a run-state machine and
 * a management page. Its entire value is expressing *variation* in who approves
 * what, and this project has one operator, so every manual stage resolves to the
 * same person and every route through the graph to the same path.
 *
 * What replaces it is one row and one comparison. A flag is held when a detector
 * held it explicitly — it names a person, or it came out of a records document —
 * **or** when its severity is at or above the threshold. The threshold can only
 * add holds. It can never release one a person-naming rule made, which is what
 * keeps "nothing naming a person auto-publishes" true regardless of how the
 * threshold is configured.
 */

export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

export type ReviewState = "published" | "held";

export interface ReviewPolicy {
  id: string;
  hold_at_or_above: Severity;
  review_window_hours: number;
  updated_by: string | null;
  updated_by_email: string | null;
  updated_at: string;
}

export class ReviewPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReviewPolicyError";
  }
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITY_ORDER as readonly string[]).includes(value);
}

/**
 * Rank, for the comparison. An unrecognised severity ranks below every real one
 * rather than throwing — a flag type nobody anticipated must not be able to
 * crash the queue — but see `severityAtOrAbove`, which refuses to treat it as
 * meeting a threshold.
 */
export function severityRank(value: string): number {
  return (SEVERITY_ORDER as readonly string[]).indexOf(value);
}

/** Whether `severity` is at or above `threshold`. An unknown severity is not. */
export function severityAtOrAbove(severity: string, threshold: Severity): boolean {
  const rank = severityRank(severity);
  if (rank === -1) return false;
  return rank >= severityRank(threshold);
}

function toPolicy(raw: unknown): ReviewPolicy {
  if (typeof raw !== "object" || raw === null) {
    throw new ReviewPolicyError("review_policy holds no row", 500);
  }
  const row = raw as Record<string, unknown>;
  const threshold = row.hold_at_or_above;
  const updatedAt = row.updated_at;
  return {
    id: typeof row.id === "string" ? row.id : "",
    // A value outside the enum cannot come back from a `anomaly_severity`
    // column, but narrowing it here is what makes the type honest rather than
    // asserted.
    hold_at_or_above: isSeverity(threshold) ? threshold : "high",
    review_window_hours: Number(row.review_window_hours ?? 72),
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_by_email: typeof row.updated_by_email === "string" ? row.updated_by_email : null,
    updated_at:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : typeof updatedAt === "string"
          ? updatedAt
          : new Date(0).toISOString(),
  };
}

/** The policy in force. Migration 038 inserts the row, so there is always one. */
export async function loadPolicy(db: Knex): Promise<ReviewPolicy> {
  const row: unknown = await db("review_policy").where({ singleton: true }).first();
  return toPolicy(row);
}

export interface PolicyActor {
  id: string | null;
  email: string | null;
}

export interface PolicyUpdate {
  holdAtOrAbove?: Severity;
  reviewWindowHours?: number;
}

/**
 * Changes the threshold, and logs the change.
 *
 * The threshold decides what publishes without a person looking at it, so
 * changing it is at least as consequential as any single correction. It gets
 * the same audit row, in the same table, through the same writer — one field
 * per row, so "who widened it, and why" is answerable from the log alone.
 */
export async function updatePolicy(
  db: Knex,
  update: PolicyUpdate,
  reason: string,
  actor: PolicyActor,
): Promise<ReviewPolicy> {
  if (reason.trim() === "") {
    throw new ReviewPolicyError(
      "reason is required: the threshold decides what publishes without a person looking",
      400,
    );
  }
  if (update.holdAtOrAbove === undefined && update.reviewWindowHours === undefined) {
    throw new ReviewPolicyError("nothing to change", 400);
  }
  if (
    update.reviewWindowHours !== undefined &&
    (!Number.isInteger(update.reviewWindowHours) || update.reviewWindowHours <= 0)
  ) {
    throw new ReviewPolicyError("review_window_hours must be a positive whole number", 400);
  }

  return db.transaction(async (trx) => {
    const current = toPolicy(await trx("review_policy").where({ singleton: true }).first());

    if (update.holdAtOrAbove !== undefined && update.holdAtOrAbove !== current.hold_at_or_above) {
      await appendCorrectionRow(trx, {
        targetTable: "review_policy",
        targetId: current.id,
        field: "hold_at_or_above",
        oldValue: current.hold_at_or_above,
        newValue: update.holdAtOrAbove,
        reason,
        actor,
      });
    }
    if (
      update.reviewWindowHours !== undefined &&
      update.reviewWindowHours !== current.review_window_hours
    ) {
      await appendCorrectionRow(trx, {
        targetTable: "review_policy",
        targetId: current.id,
        field: "review_window_hours",
        oldValue: String(current.review_window_hours),
        newValue: String(update.reviewWindowHours),
        reason,
        actor,
      });
    }

    await trx("review_policy")
      .where({ id: current.id })
      .update({
        ...(update.holdAtOrAbove === undefined ? {} : { hold_at_or_above: update.holdAtOrAbove }),
        ...(update.reviewWindowHours === undefined
          ? {}
          : { review_window_hours: update.reviewWindowHours }),
        updated_by: actor.id,
        updated_by_email: actor.email,
        updated_at: trx.fn.now(),
      });

    return toPolicy(await trx("review_policy").where({ id: current.id }).first());
  });
}

/**
 * The whole engine.
 *
 * `alwaysHold` is what a detector already decided — a changed agenda item that
 * names someone on the roster, a flag raised from a records document. It wins,
 * always, in the holding direction.
 */
export function resolveReviewState(
  input: { severity: string; alwaysHold: boolean },
  policy: Pick<ReviewPolicy, "hold_at_or_above">,
): ReviewState {
  if (input.alwaysHold) return "held";
  return severityAtOrAbove(input.severity, policy.hold_at_or_above) ? "held" : "published";
}
