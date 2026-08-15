import type { Knex } from "knex";
import {
  EmptyCompletionError,
  OpenRouterClient,
  OpenRouterError,
  type CompletionResult,
  type EmptyCompletionReason,
} from "./openrouter";
import {
  CLAIM_ACTIONS,
  namesAnOfficial,
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
export const PROMPT_VERSION = "2026-08-11.2";

export const SYSTEM_PROMPT = `You extract facts from the official minutes of a public meeting.

You return ONLY a JSON array. No prose, no markdown fences, no explanation.

Each element must be an object with these keys:
  "subject_name": the official named in the minutes, exactly as printed,
    INCLUDING their office — "Commissioner Bode", "Deputy Mayor Fischer",
    "Mayor Morrison"
  "action": one of ${CLAIM_ACTIONS.join(", ")}
  "matter": what the action concerned, copied VERBATIM from the text near the
    quote, or null
  "quote": a VERBATIM sentence copied from the minutes that shows this

Rules you must follow:
- The "quote" MUST be copied character-for-character from the text given to
  you. Do not paraphrase, tidy, shorten or correct it. A quote that is not
  present in the text will be discarded and the fact will be lost.
- The quote must itself name the person in "subject_name".
- ONLY record members of the commission — those the minutes give an office:
  Mayor, Deputy Mayor, Commissioner. Never a member of the public, a person
  giving public comment, a staff member, or a consultant. If the minutes do not
  give the person an office, leave them out entirely.
- "matter" must also be copied from the text, and from NEAR the quote — the
  agenda item that quote belongs to. A matter taken from a different item will
  be discarded.
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

/**
 * Every way a chunk can go unread, in one closed set.
 *
 * The empty-completion members come from the model's own reply and are
 * classified in `openrouter.ts`; the three below are ours:
 *
 *   request-failed    the call never returned a reply — throttled, unreachable,
 *                     no key, a model that stopped being free.
 *   unreadable-reply  a reply arrived and contained no readable claim array.
 *   truncated-reply   a reply arrived, complete claims were salvaged from it,
 *                     and the tail of the chunk was still never read.
 *   repetition-truncated
 *                     a reply arrived and was cut off, and the run of claims
 *                     immediately before the cut introduced nothing new — the
 *                     model had locked into repeating claims it had already
 *                     made. Split out from `truncated-reply` on 2026-08-15
 *                     because they call for different responses and, more
 *                     importantly, support different statements about the
 *                     record. See `repetitionShape` for what is and is not
 *                     established by this label.
 *
 * Closed because the point of the exercise is a tally. "A fifth of every
 * document goes unread" was only ever knowable by reading logs, and prose
 * error strings cannot be counted.
 */
export type ChunkFailureReason =
  | EmptyCompletionReason
  | "request-failed"
  | "unreadable-reply"
  | "truncated-reply"
  | "repetition-truncated";

export interface FailedChunk {
  index: number;
  /** Verbatim, as before. A summarised error is an error nobody can act on. */
  error: string;
  /** Null only for rows written before this taxonomy existed. */
  reason: ChunkFailureReason | null;
  /** `choices[0].finish_reason`, when the failure came with one. */
  finish_reason: string | null;
  /** `choices[0].native_finish_reason` — provider-specific, often more precise. */
  native_finish_reason: string | null;
  /**
   * Claims salvaged from this chunk before it failed.
   *
   * Zero for every reason except `truncated-reply`, where a reply arrived, was
   * cut off, and complete objects were recovered from what came before the cut.
   * Null for rows written before this field existed.
   *
   * It is here because the first real measurement of the corpus (2026-08-15, 10
   * stored minutes documents, 12 chunks) found **every** failed chunk was a
   * `truncated-reply`, and three of the four had recovered dozens of claims. So
   * the operative question about a failed chunk on this corpus is not "why did
   * it fail" — that is answered and unanimous — it is "did we get anything
   * anyway", and nothing recorded it. `failed_chunks` is jsonb, so widening it
   * again needs no migration, exactly as the reason field did not.
   *
   * Counted **after** de-duplication as of 2026-08-15, so it is distinct claims
   * salvaged rather than objects emitted. `proposed` below keeps the raw count.
   */
  recovered: number | null;
  /**
   * Objects the model emitted for this chunk, before de-duplication.
   *
   * Kept beside `recovered` because the ratio is the diagnosis: 95 proposed and 4
   * recovered is a loop, 95 and 95 is a dense document, and one number cannot say
   * which. Optional, because no row written before 2026-08-15 has it and a
   * missing value must read as "not recorded" rather than as zero.
   */
  proposed?: number;
  /** Objects dropped as repeats of one already seen in this chunk. */
  repeats?: number;
  /**
   * How many claims at the end of the reply introduced nothing new.
   *
   * The number that separates the two truncation reasons. Stored rather than
   * recomputed because the reply itself is not kept, so this is the only surviving
   * evidence for the label on the row.
   */
  repeated_tail?: number;
}

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
  failedChunks: FailedChunk[];
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
 * A reply we could read, or a statement that we could not.
 *
 * The distinction is the whole point. Returning `[]` for an unreadable reply
 * makes "the model found nothing in this chunk" and "we could not understand
 * what the model said" identical, and this project cannot tell the difference
 * between those two and still claim a meeting had no votes.
 */
export type ReadClaimsResult =
  | { ok: true; claims: RawClaim[]; truncated: boolean }
  | { ok: false; reason: string; sample: string };

/**
 * The complete objects at the start of a possibly-truncated JSON array.
 *
 * A reply cut off by the token ceiling is not garbage: everything before the
 * cut is intact, correctly-formed evidence, and discarding it loses real votes
 * for a reason that has nothing to do with the record. Observed 2026-08-11 —
 * three of nine chunks were cut mid-string, and each had already emitted
 * several complete claims.
 *
 * Salvaged claims are not trusted any more than whole ones: they still have to
 * survive `verifyClaims` against the document. The only thing recovered here is
 * the parsing, never the checking.
 */
export function salvageObjects(fragment: string): RawClaim[] {
  const claims: RawClaim[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(fragment.slice(start, i + 1));
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            claims.push(parsed as RawClaim);
          }
        } catch {
          // One malformed object does not condemn its neighbours.
        }
        start = -1;
      }
    }
  }
  return claims;
}

/* ---------------------------------------------------------------------------
   Repetition
   --------------------------------------------------------------------------- */

/**
 * What makes two proposed claims the same claim.
 *
 * All four fields, because they are the whole of what a claim asserts: who,
 * what, about which matter, on the evidence of which sentence. Two objects
 * agreeing on all four say the same thing and only one of them can be stored —
 * they collapse into one row at the unique index anyway, so the only question is
 * whether the verifier wastes a rejection on each copy first.
 *
 * Normalised on whitespace and case. A model that re-emits the same claim with a
 * line break moved has still re-emitted the same claim, and the quote's verbatim
 * bytes are checked by `verifyClaims` against the document — this function
 * decides identity, never admissibility, and a claim that survives here is not
 * thereby trusted.
 *
 * Non-string fields fold to a marker rather than throwing: a malformed object is
 * still a duplicate of the next identically malformed object, and the verifier is
 * the thing that refuses it.
 */
function signatureField(value: unknown): string {
  if (typeof value !== "string") return ` ${typeof value}`;
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function claimSignature(claim: RawClaim): string {
  return [
    signatureField(claim.subject_name),
    signatureField(claim.action),
    signatureField(claim.matter),
    signatureField(claim.quote),
  ].join("");
}

export interface RepetitionShape {
  /** The claims in first-seen order, each signature once. */
  distinct: RawClaim[];
  /** How many claims were dropped as repeats of one already in `distinct`. */
  repeats: number;
  /**
   * How many claims at the very end of the reply introduced nothing new.
   *
   * The load-bearing number. A reply cut off while still producing new claims has
   * a tail of 0 and may genuinely have lost content; a reply whose last ninety
   * claims were all repeats was not producing anything when the ceiling stopped
   * it. Those are different events and the ledger should not spell them the same
   * way.
   */
  tail: number;
}

/**
 * Claims deduplicated by signature, plus the shape of whatever repeated.
 *
 * Runs **before** the verifier. On 2026-08-15 one reply proposed 95 claims of
 * which 4 were distinct, so the verifier was handed 91 copies to reject one at a
 * time and the rejection tally recorded 91 problems with the record where there
 * was one problem with the model. De-duplicating first is correct regardless of
 * what else is done about the loop: a repeat is not evidence.
 *
 * First occurrence wins, and order is preserved, so quote offsets and the
 * verifier's own ordering are unaffected.
 */
export function dedupeRawClaims(claims: RawClaim[]): RepetitionShape {
  const seen = new Set<string>();
  const distinct: RawClaim[] = [];
  let lastNovelIndex = -1;

  for (const [index, claim] of claims.entries()) {
    const signature = claimSignature(claim);
    if (seen.has(signature)) continue;
    seen.add(signature);
    distinct.push(claim);
    lastNovelIndex = index;
  }

  return {
    distinct,
    repeats: claims.length - distinct.length,
    tail: claims.length === 0 ? 0 : claims.length - 1 - lastNovelIndex,
  };
}

/**
 * How long a trailing run of nothing-new has to be before it is called a loop.
 *
 * Five, which is well clear of coincidence and well below anything observed. A
 * document can legitimately produce a couple of adjacent duplicate proposals —
 * the same sentence read twice at a chunk overlap, say — and calling that a
 * repetition loop would be the same over-claiming this taxonomy exists to stop.
 * The two loops measured on 2026-08-15 had tails of 91 and 95.
 */
export const REPETITION_TAIL_THRESHOLD = 5;

/** How much of an unreadable reply to keep for diagnosis. */
export const REPLY_SAMPLE_LENGTH = 500;

/**
 * The model's reply as claims.
 *
 * Free models add prose around JSON however firmly they are told not to, so the
 * array is located rather than assumed. But a reply with no array in it is
 * **not** an empty result — it is a failure, and it is reported as one.
 *
 * This was not hypothetical. On 2026-08-11 the configured model was a reasoning
 * model: it spent its whole token budget thinking aloud, was cut off mid-word
 * before emitting any JSON, and did that on all nine chunks of a real set of
 * minutes. The run recorded nine successful chunks, zero proposed claims, and
 * a status of "succeeded" — a document full of recorded votes reported as a
 * meeting where nothing happened. Nothing in the pipeline was lying; every
 * layer just passed an empty list along.
 */
export function readClaims(reply: string): ReadClaimsResult {
  const sample = reply.trim().slice(0, REPLY_SAMPLE_LENGTH);
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1) {
    return {
      ok: false,
      reason:
        "the reply contained no JSON array — the model answered in prose, or was " +
        "cut off before it emitted one",
      sample,
    };
  }
  if (end === -1 || end < start) {
    // The array opened and never closed: cut off by the token ceiling. What
    // came before the cut is intact and is recovered.
    const salvaged = salvageObjects(reply.slice(start));
    if (salvaged.length === 0) {
      return {
        ok: false,
        reason: "the JSON array was cut off before a single complete claim",
        sample,
      };
    }
    return { ok: true, claims: salvaged, truncated: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch (error) {
    // Malformed rather than truncated — but complete objects inside it are
    // still readable, and the same argument applies.
    const salvaged = salvageObjects(reply.slice(start));
    if (salvaged.length > 0) return { ok: true, claims: salvaged, truncated: true };
    return { ok: false, reason: `the JSON array did not parse: ${String(error)}`, sample };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "the parsed JSON was not an array", sample };
  }

  return {
    ok: true,
    truncated: false,
    claims: parsed.filter(
      (entry): entry is RawClaim =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    ),
  };
}

export async function extractClaims(
  client: OpenRouterClient,
  input: ExtractionInput,
): Promise<ExtractionOutcome> {
  const chunks = chunkText(input.documentText, input.chunkSize);
  const failedChunks: FailedChunk[] = [];
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
      //
      // An empty completion carries its own diagnosis, and it is kept
      // structurally rather than embedded in the message: "the model refused
      // this document" and "the ceiling was too small" both used to arrive here
      // as the single string "OpenRouter returned no message content".
      if (error instanceof EmptyCompletionError) {
        failedChunks.push({
          index,
          error: error.message,
          reason: error.diagnosis.reason,
          finish_reason: error.diagnosis.finishReason,
          native_finish_reason: error.diagnosis.nativeFinishReason,
          recovered: 0,
        });
        continue;
      }
      failedChunks.push({
        index,
        error: error instanceof OpenRouterError ? error.message : String(error),
        reason: "request-failed",
        finish_reason: null,
        native_finish_reason: null,
        recovered: 0,
      });
      continue;
    }

    servedModels.add(reply.servedModel);

    const read = readClaims(reply.text);
    if (!read.ok) {
      // An unreadable reply is a failed chunk, not an empty one. The sample is
      // kept because "answered in prose" and "was truncated mid-sentence" need
      // different fixes, and the count alone distinguishes neither.
      failedChunks.push({
        index,
        error: `Unreadable reply from ${reply.servedModel}: ${read.reason}. First ${REPLY_SAMPLE_LENGTH} characters: ${read.sample}`,
        reason: "unreadable-reply",
        finish_reason: null,
        native_finish_reason: null,
        recovered: 0,
      });
      continue;
    }
    // Before anything else looks at them. A repeat is not evidence, and handing
    // ninety-one copies of one claim to the verifier produces ninety-one
    // rejections that describe the model rather than the record.
    const shape = dedupeRawClaims(read.claims);
    const claims = shape.distinct;

    if (read.truncated) {
      // Recorded as a failed chunk either way. What changes is the label, and
      // the label is a claim about the record, so it is made carefully.
      //
      // **`repetition-truncated` says what was observed, not what was lost.**
      // What is established is that the run of claims immediately before the cut
      // introduced nothing new — the model was repeating itself when the ceiling
      // stopped it, so the tokens the cut cost were being spent on repeats. What
      // is NOT established is that nothing further would have been said: this
      // build cannot know what a reply that never arrived would have contained.
      // The chunk therefore still counts as unread, and the honest way to find
      // out whether anything was actually lost is to compare the distinct claims
      // across several runs of the same chunk — which is a measurement, not a
      // label, and it does not belong in here.
      //
      // The ceiling is deliberately not raised and chunks are deliberately not
      // split. It has been raised twice already (2048 → 3000 → 8000) and a larger
      // budget buys more repetition; splitting a chunk that loops gives two
      // chunks that loop.
      const looped = shape.tail >= REPETITION_TAIL_THRESHOLD;
      failedChunks.push({
        index,
        error: looped
          ? `Repetition-truncated reply from ${reply.servedModel}: ${read.claims.length} claim(s) ` +
            `proposed from ${chunk.text.length} characters, of which ${claims.length} were ` +
            `distinct; the last ${shape.tail} introduced nothing new before the cut. The model ` +
            "looped rather than ran out of document. Raising the ceiling buys more repetition, " +
            "and whether any distinct claim fell after the cut is a question for a re-measurement " +
            "over the same chunk, not for this line."
          : `Truncated reply from ${reply.servedModel}: recovered ${claims.length} complete ` +
            `claim(s) from ${chunk.text.length} characters before the cut; the rest of this chunk ` +
            "was not read. The reply was still producing new claims when it was cut.",
        reason: looped ? "repetition-truncated" : "truncated-reply",
        finish_reason: null,
        native_finish_reason: null,
        recovered: claims.length,
        proposed: read.claims.length,
        repeats: shape.repeats,
        repeated_tail: shape.tail,
      });
    }
    // Counted after de-duplication. `proposed` feeds the operator console, and a
    // number inflated by repeats says the model found ninety-five facts in a
    // passage containing four.
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
/**
 * Collapse claims that share the unique key, keeping the first.
 *
 * Required, not defensive. `CHUNK_OVERLAP` exists so a sentence spanning a
 * chunk boundary is wholly inside one chunk — which guarantees the overlapping
 * region is read twice, and a claim found in it is proposed twice at the SAME
 * offset, because verification resolves offsets against the whole document
 * rather than the chunk. That is two identical keys in one INSERT, and Postgres
 * refuses it outright: "ON CONFLICT DO UPDATE command cannot affect row a
 * second time". The unique index in migration 072 dedupes across runs; nothing
 * dedupes within a single statement except this.
 *
 * Observed in production 2026-08-11: the model produced claims correctly and
 * every one of them was lost at the insert.
 */
export function dedupeClaims(claims: AttributedClaim[]): AttributedClaim[] {
  const seen = new Set<string>();
  const kept: AttributedClaim[] = [];
  for (const claim of claims) {
    // The unique index's key, minus the two columns constant within a call.
    const key = `${claim.subject_name} ${claim.action} ${claim.quote_offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(claim);
  }
  return kept;
}

/**
 * Remove held claims this policy no longer allows.
 *
 * Re-extracting the same bytes revises claims through `onConflict().merge()`,
 * but a merge can only touch keys the new run produced again. A claim the rules
 * now forbid is simply never re-proposed, so without this it survives forever —
 * which is how the claim about a member of the public would have outlived the
 * decision to stop recording members of the public.
 *
 * **Only `held` rows.** An approved or rejected claim carries an operator's
 * decision, and deleting that would be erasing a human judgement to tidy up
 * after a policy change.
 */
export async function pruneDisallowedClaims(
  db: Knex,
  options: PersistOptions,
): Promise<number> {
  const rows: unknown = await db("minute_claims")
    .where({ meeting_id: options.meetingId, artifact_sha256: options.artifactSha256, status: "held" })
    .select("id", "subject_name");
  if (!Array.isArray(rows)) return 0;

  const doomed = rows
    .filter((row): row is { id: string; subject_name: string } =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as { id?: unknown }).id === "string" &&
      typeof (row as { subject_name?: unknown }).subject_name === "string")
    .filter((row) => !namesAnOfficial(row.subject_name))
    .map((row) => row.id);

  if (doomed.length === 0) return 0;
  await db("minute_claims").whereIn("id", doomed).del();
  return doomed.length;
}

export async function persistClaims(
  db: Knex,
  outcome: ExtractionOutcome,
  options: PersistOptions,
): Promise<number> {
  const rows = dedupeClaims(outcome.verified).map((claim) => ({
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
