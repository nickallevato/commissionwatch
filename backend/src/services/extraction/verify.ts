import { motiveTerms } from "../review/language";

/**
 * The gate between what a language model said and what this project will store.
 *
 * Nothing here trusts the model. A claim arrives asserting that a named person
 * did something, and carrying a quotation it says supports that. This module
 * goes and looks: it finds the quotation in the stored document or it rejects
 * the claim. There is no third outcome, and no "low confidence" bucket that
 * quietly keeps the row.
 *
 * That is not defensive coding, it is the feature. A hallucinated attribution
 * of a vote to a named official is the worst thing CommissionWatch could
 * publish, and prompt quality is not a defence against it — the same prompt
 * that works a hundred times invents a name on the hundred-and-first. Locating
 * the quote in the bytes is a defence, because a sentence that is not in the
 * document cannot be found in the document.
 *
 * It is also what makes a **free** model acceptable here. A weaker model
 * fabricates more often; it does not fabricate text that then turns out to be
 * present. The verification cost is the same either way, so the failure mode of
 * a cheap model is a lower yield, not a wrong record.
 */

export const REJECTION_REASONS = [
  "quote-not-found",
  "quote-too-short",
  "empty-subject",
  "unknown-action",
  "asserts-motive",
  "subject-not-in-quote",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Actions a claim may assert. Mirrors migration 072's CHECK. */
export const CLAIM_ACTIONS = [
  "voted_yes",
  "voted_no",
  "abstained",
  "absent",
  "moved",
  "seconded",
  "spoke",
  "recused",
] as const;

export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

/** What the model emitted, before anything has been checked. */
export interface RawClaim {
  subject_name: unknown;
  action: unknown;
  matter?: unknown;
  quote: unknown;
}

/** A claim that survived. `quote` is the document's text, not the model's. */
export interface VerifiedClaim {
  subject_name: string;
  action: ClaimAction;
  matter: string | null;
  quote: string;
  quote_offset: number;
}

export interface RejectedClaim {
  reason: RejectionReason;
  detail: string;
  raw: RawClaim;
}

export interface VerificationResult {
  verified: VerifiedClaim[];
  rejected: RejectedClaim[];
}

/**
 * A quotation shorter than this is not a citation.
 *
 * "Yes." appears in a set of minutes several hundred times, so locating it
 * proves nothing about which vote it belongs to. The offset would be real and
 * the citation still useless — the failure mode where a check passes and means
 * nothing, which is worse than no check.
 */
export const MIN_QUOTE_LENGTH = 24;

/**
 * Whitespace-insensitive matching, because PDF text extraction is not.
 *
 * `pdf-text.ts` reconstructs a line from positioned glyph runs, so a phrase
 * that reads as one sentence can arrive with a newline or a double space where
 * the model saw a single one. Requiring byte equality would reject true
 * citations for typography. Everything else — every character, in order — must
 * match exactly.
 *
 * The returned offset is into the ORIGINAL text, not the normalised copy, so
 * what is stored points at the real document.
 */
function buildNormalisedIndex(source: string): { normalised: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (previousWasSpace) continue;
      chars.push(" ");
      offsets.push(index);
      previousWasSpace = true;
      continue;
    }
    chars.push(char);
    offsets.push(index);
    previousWasSpace = false;
  }

  return { normalised: chars.join(""), offsets };
}

function normaliseQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Where this quotation actually appears, or null.
 *
 * Exported because it is the single assertion the whole feature rests on, and
 * a claim that deserves its own test deserves its own function.
 */
export function locateQuote(documentText: string, quote: string): number | null {
  const needle = normaliseQuery(quote);
  if (needle === "") return null;

  const { normalised, offsets } = buildNormalisedIndex(documentText);
  const found = normalised.indexOf(needle);
  if (found === -1) return null;
  return offsets[found] ?? null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Does the quotation actually name the person the claim is about?
 *
 * Without this a model can cite a real sentence from the document and attach it
 * to a commissioner the sentence never mentions — a verified quote supporting a
 * fabricated attribution, which is the most dangerous shape this feature can
 * produce because it survives the check that looks most convincing.
 *
 * Matched on surname, since minutes vary between "Commissioner Jane Smith",
 * "Cmr. Smith" and "Smith". A subject whose surname is absent from its own
 * citation is rejected.
 */
function quoteNamesSubject(quote: string, subject: string): boolean {
  const parts = subject
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 2);
  if (parts.length === 0) return false;
  const surname = parts[parts.length - 1].toLowerCase();
  return quote.toLowerCase().includes(surname);
}

/**
 * Check every claim against the document it says it came from.
 *
 * Rejections are returned, not discarded, so the extractor can record how much
 * of a model's output failed. A model that is wrong nine times in ten is
 * information an operator needs, and silently keeping the tenth would hide it.
 */
export function verifyClaims(documentText: string, claims: RawClaim[]): VerificationResult {
  const verified: VerifiedClaim[] = [];
  const rejected: RejectedClaim[] = [];

  for (const raw of claims) {
    const subject = asText(raw.subject_name);
    const quote = asText(raw.quote);
    const action = asText(raw.action);
    const matter = asText(raw.matter);

    if (subject === "") {
      rejected.push({ reason: "empty-subject", detail: "no subject named", raw });
      continue;
    }
    if (!(CLAIM_ACTIONS as readonly string[]).includes(action)) {
      rejected.push({ reason: "unknown-action", detail: `action '${action}'`, raw });
      continue;
    }
    if (normaliseQuery(quote).length < MIN_QUOTE_LENGTH) {
      rejected.push({
        reason: "quote-too-short",
        detail: `quotation is ${normaliseQuery(quote).length} characters`,
        raw,
      });
      continue;
    }

    const offset = locateQuote(documentText, quote);
    if (offset === null) {
      // The important one. The model produced a sentence the document does not
      // contain, which is the definition of the failure this exists to catch.
      rejected.push({ reason: "quote-not-found", detail: "not present in the artifact", raw });
      continue;
    }

    if (!quoteNamesSubject(quote, subject)) {
      rejected.push({
        reason: "subject-not-in-quote",
        detail: `the citation does not name ${subject}`,
        raw,
      });
      continue;
    }

    // The project's oldest rule, applied to generated text: describe the
    // record, never the motive.
    const motive = motiveTerms(`${matter} ${quote}`);
    if (motive.length > 0) {
      rejected.push({
        reason: "asserts-motive",
        detail: `motive language: ${motive.join(", ")}`,
        raw,
      });
      continue;
    }

    verified.push({
      subject_name: subject,
      action: action as ClaimAction,
      matter: matter === "" ? null : matter,
      // The document's own text at that offset, not the model's rendering of
      // it. If they differ by whitespace, the record is what the record says.
      quote: documentText.slice(offset, offset + normaliseQuery(quote).length),
      quote_offset: offset,
    });
  }

  return { verified, rejected };
}
