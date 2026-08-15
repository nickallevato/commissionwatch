import type { Knex } from "knex";
import {
  VERDICT_CONFIDENCES,
  type GovernorVerdict,
  type ReliedSpan,
  type VerdictConfidence,
} from "./verdict";

/**
 * Storing a verdict, reading the current one, and counting the backlog.
 *
 * Three things, and the third is the one that is easy to leave out. A silently
 * growing pile of unjudged claims looks exactly like a system with nothing to
 * judge, so `governorBacklog` exists before anything reads it and the number is
 * a query rather than a counter somebody has to remember to increment.
 */

export interface RecordVerdictInput {
  claimId: string;
  /**
   * The model that actually answered, not the id that was requested.
   *
   * `minute_claims.model` follows the same rule and for the same reason: behind
   * a router the served model differs per call, and recording the request would
   * put one label on rows several different models wrote. `claim_verdicts.model`
   * is part of the unique key, so this is also what decides whether a re-run is
   * a no-op.
   */
  model: string;
  promptVersion: string;
  verdict: GovernorVerdict;
  windowSha256: string;
  /** Verbatim reply. See migration 093. */
  raw: string;
}

/**
 * Insert a verdict, or leave the one already there alone.
 *
 * `ignore()`, never `merge()`. The unique key is (claim, model, prompt version,
 * window) — every input to the judgement — so a row that already matches it was
 * produced by the same question asked of the same model about the same bytes.
 * Overwriting it would replace one measurement with another and destroy the
 * evidence that they agreed. Returns whether a row was written, because "the
 * governor ran and changed nothing" and "the governor did not run" are different
 * facts about a backlog.
 */
export async function recordVerdict(db: Knex, input: RecordVerdictInput): Promise<boolean> {
  const inserted: unknown = await db("claim_verdicts")
    .insert({
      claim_id: input.claimId,
      model: input.model,
      prompt_version: input.promptVersion,
      supported: input.verdict.supported,
      unsupported_fragments: JSON.stringify(input.verdict.unsupported_fragments),
      relied_on: JSON.stringify(input.verdict.relied_on),
      confidence: input.verdict.confidence,
      window_sha256: input.windowSha256,
      raw_response: input.raw,
    })
    .onConflict(["claim_id", "model", "prompt_version", "window_sha256"])
    .ignore()
    .returning("id");
  return Array.isArray(inserted) && inserted.length > 0;
}

/** Does a verdict already exist for exactly this question? */
export async function verdictExists(
  db: Knex,
  key: { claimId: string; model: string; promptVersion: string; windowSha256: string },
): Promise<boolean> {
  const row: unknown = await db("claim_verdicts")
    .where({
      claim_id: key.claimId,
      model: key.model,
      prompt_version: key.promptVersion,
      window_sha256: key.windowSha256,
    })
    .first("id");
  return typeof row === "object" && row !== null;
}

/**
 * The verdict as anything outside this module sees it.
 *
 * `governor_rejected` is a label, not a claim status. `minute_claims.status`
 * stays `held` — the governor cannot approve and it cannot reject; it changes
 * the order and the annotation of human review and nothing else.
 */
export type GovernorState = "supported" | "governor_rejected" | "unchecked";

export interface ClaimVerdict {
  state: Exclude<GovernorState, "unchecked">;
  supported: boolean;
  unsupported_fragments: string[];
  relied_on: ReliedSpan[];
  confidence: VerdictConfidence;
  model: string;
  prompt_version: string;
  /** The bytes judged. A verdict whose window no longer matches is stale. */
  window_sha256: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** jsonb, which arrives as an object or as a string depending on the driver. */
function readJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readFragments(value: unknown): string[] {
  const parsed = readJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function readSpans(value: unknown): ReliedSpan[] {
  const parsed = readJson(value);
  if (!Array.isArray(parsed)) return [];
  const spans: ReliedSpan[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const { start, end } = entry;
    if (typeof start !== "number" || typeof end !== "number") continue;
    spans.push({ start, end });
  }
  return spans;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/**
 * A joined verdict row as a `ClaimVerdict`, or null when there is no verdict.
 *
 * Takes the already-selected columns rather than querying, so the queue can
 * fetch each claim's newest verdict in the same statement as the claim and no
 * listing turns into one query per row.
 */
export function toClaimVerdict(row: Record<string, unknown>): ClaimVerdict | null {
  if (typeof row.governor_supported !== "boolean") return null;
  const confidence =
    VERDICT_CONFIDENCES.find((value) => value === row.governor_confidence) ?? "low";
  return {
    state: row.governor_supported ? "supported" : "governor_rejected",
    supported: row.governor_supported,
    unsupported_fragments: readFragments(row.governor_unsupported_fragments),
    relied_on: readSpans(row.governor_relied_on),
    confidence,
    model: typeof row.governor_model === "string" ? row.governor_model : "",
    prompt_version:
      typeof row.governor_prompt_version === "string" ? row.governor_prompt_version : "",
    window_sha256: typeof row.governor_window_sha256 === "string" ? row.governor_window_sha256 : "",
    created_at: asIso(row.governor_created_at),
  };
}

/**
 * Held claims nobody has judged.
 *
 * The one number that must be visible. A governor that stops running produces
 * no error and no missing page — it produces a queue that slowly fills with
 * claims labelled *not checked*, which is indistinguishable from a quiet week
 * unless somebody is counting. Retracted claims are excluded because they are
 * off the site already and judging them would tell nobody anything.
 */
export async function governorBacklog(db: Knex): Promise<number> {
  const row = await db("minute_claims")
    .where("minute_claims.status", "held")
    .whereNull("minute_claims.retracted_at")
    .whereNotExists(
      db("claim_verdicts").whereRaw("claim_verdicts.claim_id = minute_claims.id"),
    )
    .count("* as total")
    .first<{ total?: string } | undefined>();
  return Number(row?.total ?? 0);
}
