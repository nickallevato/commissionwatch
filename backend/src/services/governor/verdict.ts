import { createHash } from "node:crypto";
import { MATTER_WINDOW, locateQuote, type ClaimAction } from "../extraction/verify";

/**
 * What the governor is allowed to know, and what it is allowed to say.
 *
 * The input type is the enforcement, not a comment. A judge shown the
 * advocate's argument agrees with it, so the governor must never see pass 1's
 * reasoning — no chain of thought, no confidence, no "the extractor thought".
 * `GovernorInput` therefore has exactly seven fields, all of them either the
 * document's own bytes or the assertion under test, and there is no field a
 * rationale could be smuggled through. `GOVERNOR_INPUT_KEYS` is the list, a test
 * enumerates it, and adding an eighth field fails that test until someone says
 * out loud what it is for.
 *
 * The output side follows the project's oldest rule: **we do not trust the
 * extraction, we test it against the bytes.** That applies to the judge too. It
 * must point rather than opine, so a verdict names the wording it relied on, and
 * that wording is located in the window here — by `locateQuote`, the same
 * function that locates a claim's quote in the artifact — rather than believed.
 * A reply whose cited sentence is not in the window is void, and a void reply
 * leaves the claim un-judged. `blocked` is not `pass`, and it is not `fail`.
 */

/**
 * The window the judge reads, in characters either side of the citation.
 *
 * `MATTER_WINDOW` at exactly this value already answers the same question for
 * `verifiedMatter` — how far from its citation may context be found and still
 * belong to it — and the governor is asking about the same neighbourhood. One
 * constant, because two would eventually disagree and nobody would notice.
 */
export const GOVERNOR_WINDOW = MATTER_WINDOW;

/** Confidences a verdict may carry. Mirrors migration 093's CHECK. */
export const VERDICT_CONFIDENCES = ["low", "medium", "high"] as const;

export type VerdictConfidence = (typeof VERDICT_CONFIDENCES)[number];

/** A span of the window, as offsets we located rather than offsets we were told. */
export interface ReliedSpan {
  start: number;
  end: number;
}

export interface GovernorVerdict {
  supported: boolean;
  /** Spans of the claim the window does not support. Required when refusing. */
  unsupported_fragments: string[];
  /** Which wording of the window the judge relied on. */
  relied_on: ReliedSpan[];
  confidence: VerdictConfidence;
}

/**
 * Everything the judge is given. Seven fields, and this list is the contract.
 *
 * Ordered as the prompt uses them. `window_offset` is here so a verdict's spans
 * can be related back to the whole document; it tells the judge nothing about
 * what pass 1 believed.
 */
export const GOVERNOR_INPUT_KEYS = [
  "window",
  "window_offset",
  "subject_name",
  "action",
  "matter",
  "quote",
  "quote_offset",
] as const;

export interface GovernorInput {
  /** The ±GOVERNOR_WINDOW characters of document text, already sliced. */
  window: string;
  /** Where that slice begins in the whole document. */
  window_offset: number;
  subject_name: string;
  action: ClaimAction;
  matter: string | null;
  quote: string;
  /** Where the citation begins in the whole document. */
  quote_offset: number;
}

export interface ClaimUnderTest {
  subject_name: string;
  action: ClaimAction;
  matter: string | null;
  quote: string;
  quote_offset: number;
}

/**
 * The window around a claim's citation, and the claim, in the only shape the
 * judge ever sees.
 *
 * Built by a function rather than assembled at each call site so there is one
 * place the field list lives and one place a well-meaning future edit would have
 * to add a `reasoning` field to.
 */
export function buildGovernorInput(documentText: string, claim: ClaimUnderTest): GovernorInput {
  const start = Math.max(0, claim.quote_offset - GOVERNOR_WINDOW);
  const end = Math.min(
    documentText.length,
    claim.quote_offset + claim.quote.length + GOVERNOR_WINDOW,
  );
  return {
    window: documentText.slice(start, end),
    window_offset: start,
    subject_name: claim.subject_name,
    action: claim.action,
    matter: claim.matter,
    quote: claim.quote,
    quote_offset: claim.quote_offset,
  };
}

/** The address of the exact text judged. Migration 093 stores it per verdict. */
export function windowSha256(window: string): string {
  return createHash("sha256").update(window, "utf8").digest("hex");
}

/**
 * Every way a reply can fail to be a verdict, in one closed set.
 *
 * Closed for `ChunkFailureReason`'s reason: the point of the exercise is a
 * tally. "How often does the governor produce nothing usable, and why" has to be
 * answerable by counting rather than by grepping prose.
 *
 *   no-json                  the reply contained no JSON object at all.
 *   malformed                an object arrived and did not parse, or is not one.
 *   bad-supported            `supported` absent or not a boolean.
 *   bad-confidence           `confidence` is not one of the three.
 *   no-unsupported-fragments `supported: false` with nothing named. A judge that
 *                            cannot say *what* is wrong has not judged, so this
 *                            is void rather than a rejection — the distinction
 *                            the whole feature turns on.
 *   fragments-with-support   `supported: true` while still naming unsupported
 *                            fragments. The reply contradicts itself.
 *   no-relied-on             nothing cited. Pointing is the requirement.
 *   relied-on-not-in-window  a cited sentence is not in the bytes it claims to
 *                            come from. Same failure as a hallucinated quote,
 *                            one layer up.
 */
export const VOID_REASONS = [
  "no-json",
  "malformed",
  "bad-supported",
  "bad-confidence",
  "no-unsupported-fragments",
  "fragments-with-support",
  "no-relied-on",
  "relied-on-not-in-window",
] as const;

export type VoidReason = (typeof VOID_REASONS)[number];

export type ParsedVerdict =
  | { ok: true; verdict: GovernorVerdict }
  | { ok: false; reason: VoidReason; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed strings only. An empty fragment names nothing. */
function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Where a cited sentence ends in the window, walked rather than added.
 *
 * `start + text.length` is wrong whenever the window's whitespace differs from
 * the model's rendering of it, which for PDF-extracted text is most of the time:
 * a line break where the reply has a space drifts the span by a character per
 * line. Both strings are walked, skipping whitespace on either side, so the span
 * covers the wording actually present in the document.
 */
function spanEnd(window: string, start: number, text: string): number {
  let index = start;
  let cursor = 0;
  while (index < window.length && cursor < text.length) {
    if (/\s/.test(text[cursor])) {
      cursor += 1;
      continue;
    }
    if (/\s/.test(window[index])) {
      index += 1;
      continue;
    }
    index += 1;
    cursor += 1;
  }
  return index;
}

/**
 * A cited sentence resolved to a span of the window, or null.
 *
 * Whitespace-insensitive, by `locateQuote`, for the reason `verify.ts` gives:
 * `pdf-text.ts` reconstructs lines from positioned glyph runs, so requiring byte
 * equality would void true citations for typography.
 */
export function locateInWindow(window: string, text: string): ReliedSpan | null {
  const start = locateQuote(window, text);
  if (start === null) return null;
  const end = spanEnd(window, start, text);
  return end > start ? { start, end } : null;
}

/**
 * The model's reply as a verdict, or a statement of why it is not one.
 *
 * The asymmetry is deliberate and it is the feature: a reply that fails any
 * check here is **void**, which leaves the claim un-judged and queued normally.
 * It is never read as a rejection. The alternative — treating a malformed
 * refusal as a refusal — would let a model that lost the plot bury true claims
 * at the bottom of the queue while saying nothing an operator could argue with.
 */
export function parseGovernorVerdict(reply: string, window: string): ParsedVerdict {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) {
    return {
      ok: false,
      reason: "no-json",
      detail: "the reply contained no JSON object — the model answered in prose, or was cut off",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch (error) {
    return { ok: false, reason: "malformed", detail: `the JSON did not parse: ${String(error)}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "malformed", detail: "the parsed JSON was not an object" };
  }

  const supported = parsed.supported;
  if (typeof supported !== "boolean") {
    return {
      ok: false,
      reason: "bad-supported",
      detail: `'supported' was ${JSON.stringify(supported)}, not a boolean`,
    };
  }

  const confidence = VERDICT_CONFIDENCES.find((value) => value === parsed.confidence);
  if (confidence === undefined) {
    return {
      ok: false,
      reason: "bad-confidence",
      detail: `'confidence' was ${JSON.stringify(parsed.confidence)}`,
    };
  }

  const fragments = readStrings(parsed.unsupported_fragments);
  if (!supported && fragments.length === 0) {
    return {
      ok: false,
      reason: "no-unsupported-fragments",
      detail:
        "the reply refused the claim without naming what the window does not support, " +
        "so it has not judged it",
    };
  }
  if (supported && fragments.length > 0) {
    return {
      ok: false,
      reason: "fragments-with-support",
      detail: `the reply supported the claim while naming ${fragments.length} unsupported fragment(s)`,
    };
  }

  const cited = readStrings(parsed.relied_on);
  if (cited.length === 0) {
    return {
      ok: false,
      reason: "no-relied-on",
      detail: "the reply cited no wording from the window, so there is nothing to check it against",
    };
  }

  const relied: ReliedSpan[] = [];
  for (const text of cited) {
    const span = locateInWindow(window, text);
    if (span === null) {
      return {
        ok: false,
        reason: "relied-on-not-in-window",
        detail: `the reply relied on wording that is not in the window: ${JSON.stringify(text.slice(0, 120))}`,
      };
    }
    relied.push(span);
  }

  return {
    ok: true,
    verdict: { supported, unsupported_fragments: fragments, relied_on: relied, confidence },
  };
}
