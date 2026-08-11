import type { Knex } from "knex";
import { OpenRouterClient, OpenRouterError, type CompletionResult } from "./openrouter";
import {
  CLAIM_ACTIONS,
  verifyClaims,
  type RawClaim,
  type VerificationResult,
  type VerifiedClaim,
} from "./verify";

/**
 * Minutes in, checked claims out.
 *
 * The pipeline is deliberately three separable steps — prompt, parse, verify —
 * because only the third one is trusted. The model is asked for structure, its
 * reply is read defensively, and every claim then has to survive
 * `verifyClaims`, which goes and finds the quotation in the document. What
 * reaches the database is the intersection of what the model said and what the
 * document actually contains.
 *
 * Chunked because free models carry small context windows, and because a
 * 40-page set of minutes would otherwise be summarised rather than read. Each
 * chunk carries its own offset into the full text, so a quote located inside
 * chunk 7 is stored with its position in the whole document — the citation
 * points at the record, not at our slicing of it.
 */

/** Bumped whenever the instructions change, and stored on every row. */
export const PROMPT_VERSION = "2026-08-11.1";

const SYSTEM_PROMPT = `You extract facts from the official minutes of a public meeting.

You return ONLY a JSON array. No prose, no markdown fences, no explanation.

Each element must be an object with these keys:
  "subject_name": the person named in the minutes, exactly as printed
  "action": one of ${CLAIM_ACTIONS.join(", ")}
  "matter": what the action concerned, as the minutes describe it, or null
  "quote": a VERBATIM sentence copied from the minutes that shows this

Rules you must follow:
- The "quote" MUST be copied character-for-character from the text given to
  you. Do not paraphrase, tidy, shorten or correct it. A quote that is not
  present in the text will be discarded and the fact will be lost.
- The quote must itself name the person in "subject_name".
- Only record what the minutes state. Never record why someone acted, what they
  wanted, what they believed, or what the effect was. No motive, no
  characterisation, no inference.
- If the text does not clearly support a fact, leave it out. A short, correct
  list is the goal. There is no penalty for returning [].`;

export interface ExtractionInput {
  documentText: string;
  /** Characters per chunk. Free models are small; this is not a guess to tune blindly. */
  chunkSize?: number;
}

/** A verified claim plus the model that actually produced it. */
export type AttributedClaim = VerifiedClaim & { model: string };

export interface ExtractionOutcome {
  /** The model that was REQUESTED. May be a router id, which serves others. */
  model: string;
  /** Every model that actually answered a chunk. One entry for a pinned model. */
  served_models: string[];
  prompt_version: string;
  chunks: number;
  /** Claims the model produced, before verification. */
  proposed: number;
  result: VerificationResult;
  /** The survivors, each carrying its own model. What gets persisted. */
  verified: AttributedClaim[];
  /** Chunks whose call failed. Reported, never treated as "no claims here". */
  failedChunks: Array<{ index: number; error: string }>;
}

const DEFAULT_CHUNK_SIZE = 6000;
/** Overlap so a sentence split across a boundary is still wholly inside one chunk. */
const CHUNK_OVERLAP = 400;

export interface Chunk {
  text: string;
  offset: number;
}

/** Exported for its own test: an off-by-one here silently drops evidence. */
export function chunkText(text: string, size = DEFAULT_CHUNK_SIZE): Chunk[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [{ text, offset: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push({ text: text.slice(start, end), offset: start });
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * The model's reply as claims, or an empty list.
 *
 * Free models add prose around JSON however firmly they are told not to, so the
 * array is located rather than assumed. Everything that is not a well-formed
 * array of objects yields nothing — a reply we cannot read is not evidence of
 * anything, and guessing at its meaning is exactly the behaviour this whole
 * module exists to prevent.
 */
export function readClaims(reply: string): RawClaim[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (entry): entry is RawClaim =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

export async function extractClaims(
  client: OpenRouterClient,
  input: ExtractionInput,
): Promise<ExtractionOutcome> {
  const chunks = chunkText(input.documentText, input.chunkSize);
  const failedChunks: Array<{ index: number; error: string }> = [];
  const verified: AttributedClaim[] = [];
  const rejected: VerificationResult["rejected"] = [];
  const servedModels = new Set<string>();
  let proposed = 0;

  for (const [index, chunk] of chunks.entries()) {
    let reply: CompletionResult;
    try {
      reply = await client.complete({
        system: SYSTEM_PROMPT,
        user: `Minutes text:\n\n${chunk.text}`,
      });
    } catch (error) {
      // A rate-limited chunk is not an empty chunk. Recording the difference is
      // what stops a throttled run from reading as "this meeting had no votes".
      failedChunks.push({
        index,
        error: error instanceof OpenRouterError ? error.message : String(error),
      });
      continue;
    }

    servedModels.add(reply.servedModel);
    const claims = readClaims(reply.text);
    proposed += claims.length;

    // Verified against the WHOLE document, not the chunk it came from: the
    // offset stored has to be a position in the record itself. Verification is
    // per chunk only so each surviving claim keeps the id of the model that
    // actually answered — behind a router that is a different model each call,
    // and one run-wide label would attribute every claim to an id that wrote
    // none of them.
    const outcome = verifyClaims(input.documentText, claims);
    for (const claim of outcome.verified) {
      verified.push({ ...claim, model: reply.servedModel });
    }
    rejected.push(...outcome.rejected);
  }

  return {
    model: client.model,
    served_models: [...servedModels].sort(),
    prompt_version: PROMPT_VERSION,
    chunks: chunks.length,
    proposed,
    // `AttributedClaim` is a `VerifiedClaim` with one extra field, so it
    // satisfies the older shape as-is. No copy, and callers that only counted
    // verified claims keep working unchanged.
    result: { verified, rejected },
    verified,
    failedChunks,
  };
}

export interface PersistOptions {
  meetingId: string;
  artifactSha256: string;
}

/**
 * Store what survived. Held, always.
 *
 * `onConflict(...).merge()` rather than `ignore()`: re-running the extractor
 * over the same bytes should revise a claim, not add a second copy of it — the
 * unique index in migration 072 is on (meeting, artifact, subject, action,
 * offset), so a merge here updates the matter and the model that produced it
 * while leaving an operator's review decision alone.
 */
export async function persistClaims(
  db: Knex,
  outcome: ExtractionOutcome,
  options: PersistOptions,
): Promise<number> {
  const rows = outcome.verified.map((claim) => ({
    meeting_id: options.meetingId,
    artifact_sha256: options.artifactSha256,
    subject_name: claim.subject_name,
    action: claim.action,
    matter: claim.matter,
    quote: claim.quote,
    quote_offset: claim.quote_offset,
    // The model that produced THIS claim, not the id the run requested.
    model: claim.model,
    prompt_version: outcome.prompt_version,
    status: "held",
  }));
  if (rows.length === 0) return 0;

  await db("minute_claims")
    .insert(rows)
    .onConflict(["meeting_id", "artifact_sha256", "subject_name", "action", "quote_offset"])
    .merge(["matter", "quote", "model", "prompt_version", "updated_at"]);

  return rows.length;
}
