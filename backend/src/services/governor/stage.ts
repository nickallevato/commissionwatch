import type { Knex } from "knex";
import { CLAIM_ACTIONS, type ClaimAction } from "../extraction/verify";
import { ExtractionUnavailable, findMinutesArtifact } from "../extraction/run";
import type { OpenRouterClient } from "../extraction/openrouter";
import { extractPdfText, looksLikePdf } from "../ingestion/pdf-text";
import { BlockedError, type IngestionQueue } from "../ingestion/queue";
import type { GovernContext, StageResult } from "../ingestion/worker";
import { GOVERNOR_PROMPT_VERSION, judgeClaim } from "./judge";
import { recordVerdict, verdictExists } from "./store";
import { buildGovernorInput, windowSha256 } from "./verdict";

/**
 * The governor as a queue stage, after extraction, at its own rate.
 *
 * Not a loop inside the extraction handler, and not an unawaited promise in a
 * route. Extraction learned both lessons already: an unawaited promise owns no
 * row, so a deploy mid-run loses the work and leaves a ledger row that says
 * "running" forever; and a second model called inline doubles the time an
 * extract job holds its claim against a rate limit that is counted per minute.
 * `ingestion_jobs` gives restart safety, retry with backoff, a visible `blocked`
 * state and an error string the status page already reads.
 *
 * The stage judges every held claim cut from one artifact. Nothing it writes
 * touches `minute_claims`: a verdict changes the order and the annotation of an
 * operator's queue and nothing else. There is no path from here to
 * `status = 'approved'`.
 */

/**
 * How many govern jobs may be in flight at once.
 *
 * One, for `EXTRACT_CONCURRENCY`'s reason and one more of its own. The free tier
 * is rate-limited per minute and a meeting's minutes yield tens of claims, so
 * two concurrent govern jobs do not go twice as fast — they take turns being
 * throttled, and a throttled judgement is recorded as *un-judged*, which is the
 * number this stage exists to drive down. The second reason is that the governor
 * shares a rate limit with extraction only if they share a model, and they must
 * not; but they do share this project's single API key, and a governor that
 * saturates it starves the extractor that feeds it.
 */
export const GOVERN_CONCURRENCY = 1;

/** A held claim as the governor reads it. Column names, not a view. */
interface HeldClaim {
  id: string;
  subject_name: string;
  action: ClaimAction;
  matter: string | null;
  quote: string;
  quote_offset: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asClaimAction(value: unknown): ClaimAction | null {
  return CLAIM_ACTIONS.find((action) => action === value) ?? null;
}

/**
 * The claims this artifact produced that an operator has not yet decided.
 *
 * `held` only. An approved or rejected claim carries a human judgement, and a
 * model's second opinion about a decision a person already made is noise at
 * best — at worst it is an invitation to reopen it.
 */
export async function heldClaimsFor(
  db: Knex,
  meetingId: string,
  artifactSha256: string,
): Promise<HeldClaim[]> {
  const rows: unknown = await db("minute_claims")
    .where({ meeting_id: meetingId, artifact_sha256: artifactSha256, status: "held" })
    .orderBy("quote_offset", "asc")
    .select("id", "subject_name", "action", "matter", "quote", "quote_offset");

  const claims: HeldClaim[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    const action = asClaimAction(row.action);
    if (
      typeof row.id !== "string" ||
      typeof row.subject_name !== "string" ||
      typeof row.quote !== "string" ||
      typeof row.quote_offset !== "number" ||
      action === null
    ) {
      // A row the database permits and this code cannot read is worth skipping
      // loudly rather than judging on guessed values.
      continue;
    }
    claims.push({
      id: row.id,
      subject_name: row.subject_name,
      action,
      matter: typeof row.matter === "string" ? row.matter : null,
      quote: row.quote,
      quote_offset: row.quote_offset,
    });
  }
  return claims;
}

export interface GovernTally {
  /** Held claims found for this artifact. */
  claims: number;
  /** Verdicts written. */
  judged: number;
  /** Of those, verdicts that refused the attribution. */
  unsupported: number;
  /** Already judged on this model, prompt and window. Re-running is a no-op. */
  unchanged: number;
  /** Replies that were not verdicts. Discarded; the claim stays un-judged. */
  voided: number;
  /** Claims no reply arrived for. Un-judged, and retryable. */
  unreached: number;
}

export interface GovernHandlerDeps {
  client: OpenRouterClient;
}

/**
 * The `govern` stage handler.
 *
 * What it refuses, and why each refusal is `blocked` rather than a failure:
 *
 *  - **no API key** — five attempts do not conjure one, and "attempts exhausted"
 *    hides the reason behind a retry count.
 *  - **the artifact is not a PDF, or carries no text layer** — there is no
 *    window to judge. That is a fact about the document, not a transient error.
 *
 * A run where **every** claim went unreached is thrown, so the queue retries it
 * with backoff — that is the throttled case, and retrying is what fixes it. A
 * partial run completes: the verdicts written are real, and the claims that went
 * unjudged are counted rather than lost, because failing the job would re-ask
 * questions that have already been answered.
 */
export function createGovernHandler(
  deps: GovernHandlerDeps,
): (ctx: GovernContext) => Promise<StageResult> {
  return async (ctx) => {
    if (!deps.client.configured) {
      throw new BlockedError(
        "OPENROUTER_API_KEY is not set on this deployment, so no claim was checked.",
      );
    }
    if (!looksLikePdf(ctx.content)) {
      throw new BlockedError(
        `The stored artifact is not a PDF (content type ${ctx.artifact.contentType ?? "unknown"}), ` +
          "so there is no text to judge a claim against.",
      );
    }

    const { lines } = await extractPdfText(ctx.content);
    // Rejoined exactly as `run.ts` does, because the claims' offsets index into
    // this text. A different join would move every window by a character per
    // line and the governor would judge the wrong sentences while looking right.
    const documentText = lines.join("\n");
    if (documentText.trim() === "") {
      throw new BlockedError(
        "The stored artifact carries no extractable text layer, so there is no window to judge.",
      );
    }

    const tally = await governArtifact(ctx.db, deps.client, {
      documentText,
      meetingId: ctx.target.meetingId,
      artifactSha256: ctx.artifact.sha256,
    });

    if (tally.claims > 0 && tally.unreached === tally.claims) {
      throw new Error(
        `The governor reached the model for none of ${tally.claims} claim(s) on meeting ` +
          `${ctx.target.meetingId}. Free models are rate-limited; nothing was judged.`,
      );
    }

    return {
      counts: {
        governor_judged: tally.judged,
        governor_unsupported: tally.unsupported,
        governor_unjudged: tally.voided + tally.unreached,
      },
    };
  };
}

export interface GovernArtifactInput {
  documentText: string;
  meetingId: string;
  artifactSha256: string;
}

/**
 * Judge every held claim cut from one artifact.
 *
 * Sequential on purpose. The calls are per-claim and the limit is per-minute, so
 * firing them together converts a slow, complete pass into a fast, mostly
 * throttled one — and a throttled claim is recorded as un-judged, which is
 * precisely the outcome worth avoiding.
 *
 * The window is hashed before the call, and a claim already judged on this
 * model, this prompt and these exact bytes is skipped without asking. That is
 * what makes re-running the governor cheap enough to be an operator action.
 */
export async function governArtifact(
  db: Knex,
  client: OpenRouterClient,
  input: GovernArtifactInput,
): Promise<GovernTally> {
  const claims = await heldClaimsFor(db, input.meetingId, input.artifactSha256);
  const tally: GovernTally = {
    claims: claims.length,
    judged: 0,
    unsupported: 0,
    unchanged: 0,
    voided: 0,
    unreached: 0,
  };

  for (const claim of claims) {
    const governorInput = buildGovernorInput(input.documentText, claim);
    const sha = windowSha256(governorInput.window);

    if (
      await verdictExists(db, {
        claimId: claim.id,
        model: client.model,
        promptVersion: GOVERNOR_PROMPT_VERSION,
        windowSha256: sha,
      })
    ) {
      tally.unchanged += 1;
      continue;
    }

    const outcome = await judgeClaim(client, governorInput);
    if (outcome.state === "unreached") {
      // Not a verdict and not a failure of the claim. Counted, and left for the
      // next run — `blocked` is not `pass`, and it is not `fail` either.
      tally.unreached += 1;
      continue;
    }
    if (outcome.state === "void") {
      // A judge that cannot say what is wrong has not judged. Nothing is
      // stored, so the claim reads as un-judged rather than as doubted.
      console.warn(
        `Governor: discarded a reply about claim ${claim.id} (${outcome.reason}) — ${outcome.detail}`,
      );
      tally.voided += 1;
      continue;
    }

    const written = await recordVerdict(db, {
      claimId: claim.id,
      // The model that answered, which behind a router is not the id requested.
      model: outcome.servedModel,
      promptVersion: GOVERNOR_PROMPT_VERSION,
      verdict: outcome.verdict,
      windowSha256: sha,
      raw: outcome.raw,
    });
    if (written) tally.judged += 1;
    else tally.unchanged += 1;
    if (!outcome.verdict.supported) tally.unsupported += 1;
  }

  return tally;
}

export interface EnqueuedGovernance {
  job_id: string;
  /** The `ingestion_runs` row the job belongs to — the work ledger. */
  run_id: string;
  meeting_id: string;
  artifact_sha256: string;
}

/** The govern job already queued or running for this meeting, if there is one. */
export async function queuedGovernance(db: Knex, meetingId: string): Promise<string | null> {
  const row: unknown = await db("ingestion_jobs")
    .where("stage", "govern")
    .whereIn("status", ["pending", "running"])
    .whereRaw("target ->> 'meetingId' = ?", [meetingId])
    .first("id");
  if (!isRecord(row) || typeof row.id !== "string") return null;
  return row.id;
}

/**
 * Queue this meeting's held claims for a second opinion.
 *
 * A fresh `ingestion_runs` row per request, for `enqueueExtraction`'s reason:
 * the original run records what happened on a date, and reopening it to say
 * something else about that date is the mutation this project refuses
 * everywhere else. `ExtractionUnavailable` is reused rather than duplicated —
 * it carries the status code the console needs and means exactly what it says
 * here, that the artifact this stage would read has not been fetched.
 */
export async function enqueueGovernance(
  db: Knex,
  queue: IngestionQueue,
  meetingId: string,
): Promise<EnqueuedGovernance> {
  const artifact = await findMinutesArtifact(db, meetingId);
  if (artifact === null) {
    throw new ExtractionUnavailable(
      "No minutes document has been fetched for this meeting, so there is nothing to check " +
        "a claim against.",
      404,
    );
  }

  const queued = await queuedGovernance(db, meetingId);
  if (queued !== null) {
    throw new ExtractionUnavailable(
      `A governor pass over this meeting is already queued (job ${queued}).`,
      409,
    );
  }

  const inserted: unknown = await db("ingestion_runs")
    .insert({
      source_id: artifact.source_id,
      status: "running",
      counts: JSON.stringify({ govern_queued: 1 }),
    })
    .returning("id");
  const row: unknown = Array.isArray(inserted) ? inserted[0] : undefined;
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new ExtractionUnavailable("Could not open a run for the governor pass", 500);
  }

  const jobId = await queue.enqueue("govern", { sha256: artifact.sha256, meetingId }, row.id);

  return {
    job_id: jobId,
    run_id: row.id,
    meeting_id: meetingId,
    artifact_sha256: artifact.sha256,
  };
}
