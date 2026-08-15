import {
  EmptyCompletionError,
  OpenRouterError,
  type CompletionResult,
  type OpenRouterClient,
} from "../extraction/openrouter";
import {
  parseGovernorVerdict,
  type GovernorInput,
  type GovernorVerdict,
  type VoidReason,
} from "./verdict";

/**
 * One question, asked once, of a model that knows nothing else.
 *
 * The governor is a judge and never an author. It cannot propose a claim,
 * correct one, rewrite a quote or reach a reader — the published sentence is a
 * template fill in `services/review/claims.ts`, so there is no channel through
 * which anything written here could become the text on the page. What it emits
 * is metadata for an operator's queue.
 *
 * The prompt asks for verbatim citation for the same reason pass 1 does: a
 * sentence that is not in the window cannot be found in the window, and that is
 * the only check available that a model cannot talk its way past. It is not
 * asked whether the person exists — `namesAnOfficial` and `officialMentions`
 * answer that mechanically against the roster, and asking a model to confirm a
 * human being is real is how a hallucination becomes a citation.
 */

/**
 * Bumped whenever the instructions change, and stored on every verdict.
 *
 * A claim carries the pair (model, prompt_version), and changing either makes a
 * new verdict rather than revising the old one — the unique index in migration
 * 093 is on both. Existing claims are **not** re-judged automatically when this
 * changes: re-judging is an operator action with a recorded reason, for the same
 * reason replay is in the event spine.
 */
export const GOVERNOR_PROMPT_VERSION = "2026-08-15.1";

export const GOVERNOR_SYSTEM_PROMPT = `You judge whether a passage of official meeting minutes supports one attribution.

You are given a WINDOW of text copied from the minutes, and a CLAIM that says a
named official performed one action. Decide only this: does the window's own
wording attribute that action to that person?

You return ONLY a JSON object. No prose, no markdown fences, no explanation.

{
  "supported": true or false,
  "unsupported_fragments": ["..."],
  "relied_on": ["..."],
  "confidence": "low" or "medium" or "high"
}

Rules you must follow:
- "relied_on" must contain at least one sentence copied VERBATIM from the
  window, character for character. It is the wording you based the decision on.
  A sentence that is not present in the window will void your answer.
- When "supported" is false, "unsupported_fragments" must name the part of the
  claim the window does not support - the person, the action, or the matter -
  in a few words. An empty list voids your answer.
- When "supported" is true, "unsupported_fragments" must be empty.
- Judge the wording only. Do not consider whether the person exists, whether
  the action was wise, or what anyone intended.
- If the window names several officials, decide which one the action's own
  wording attaches to. A person named in a sentence has not necessarily done
  everything the sentence describes.`;

/**
 * The claim as the judge is shown it, and nothing else.
 *
 * Built from `GovernorInput`, whose field list is the enforcement of "it never
 * sees pass 1's reasoning". Nothing is added here that is not in that struct.
 */
export function renderGovernorUser(input: GovernorInput): string {
  return `WINDOW:
"""
${input.window}
"""

CLAIM:
  subject: ${input.subject_name}
  action: ${input.action}
  matter: ${input.matter ?? "(none given)"}
  quote: ${input.quote}`;
}

/**
 * Reply ceiling.
 *
 * A verdict is four short fields. 1200 is generous for that and deliberately
 * far below the extractor's 8000: the failure this guards is a model that
 * narrates instead of answering, and a small ceiling turns that into a visible
 * truncation rather than a long, expensive paragraph that still parses to
 * nothing.
 */
export const GOVERNOR_MAX_TOKENS = 1200;

/**
 * What one judgement produced.
 *
 * Three outcomes, and the last two are both "un-judged" while being different
 * facts about why:
 *
 *   judged     a verdict, already checked against the window.
 *   void       a reply arrived and was not a verdict. Discarded, nothing stored.
 *   unreached  no reply arrived — no key, throttled, the model stopped being
 *              free. Retrying may fix it; the claim is queued normally meanwhile.
 *
 * Neither of the last two is a rejection, and neither is an approval. That
 * distinction is the whole of rule 6: a claim nobody could check is labelled
 * *not checked by the governor*, not quietly ranked as though it had been.
 */
export type JudgeOutcome =
  | {
      state: "judged";
      verdict: GovernorVerdict;
      /** Verbatim, for migration 093's `raw_response`. */
      raw: string;
      servedModel: string;
    }
  | { state: "void"; reason: VoidReason; detail: string; raw: string; servedModel: string }
  | { state: "unreached"; detail: string; retryable: boolean };

export async function judgeClaim(
  client: OpenRouterClient,
  input: GovernorInput,
): Promise<JudgeOutcome> {
  let reply: CompletionResult;
  try {
    reply = await client.complete({
      system: GOVERNOR_SYSTEM_PROMPT,
      user: renderGovernorUser(input),
      maxTokens: GOVERNOR_MAX_TOKENS,
    });
  } catch (error) {
    // A throttled claim is not an unsupported claim. Recording the difference is
    // what stops a rate-limited run from reading as a batch of doubtful
    // attributions.
    if (error instanceof EmptyCompletionError) {
      return {
        state: "unreached",
        detail: error.message,
        retryable: error.diagnosis.retryable,
      };
    }
    if (error instanceof OpenRouterError) {
      return { state: "unreached", detail: error.message, retryable: error.retryable };
    }
    return { state: "unreached", detail: String(error), retryable: false };
  }

  const parsed = parseGovernorVerdict(reply.text, input.window);
  if (!parsed.ok) {
    return {
      state: "void",
      reason: parsed.reason,
      detail: parsed.detail,
      raw: reply.text,
      servedModel: reply.servedModel,
    };
  }
  return {
    state: "judged",
    verdict: parsed.verdict,
    raw: reply.text,
    servedModel: reply.servedModel,
  };
}
