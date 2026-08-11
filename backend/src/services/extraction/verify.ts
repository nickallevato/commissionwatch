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
  "not-an-official",
] as const;

/**
 * Offices whose holders this project records.
 *
 * The gate exists because the first real extraction produced a claim about
 * `Mark Campanelli`, a member of the public who spoke at public comment, with
 * his neighbourhood quoted alongside his name. Public comment is a public
 * record, but a watchdog that accumulates a searchable file on private
 * residents who show up to speak is a different and much worse thing than one
 * that holds elected officials to account. The minutes make no distinction;
 * this does.
 *
 * Matched on the office as the minutes print it, because there is no roster to
 * match against. Bozeman's own site answers 403 to everything (Akamai, wall not
 * bot detection) and Granicus publishes no member list, so the only attestation
 * of who holds an office is the record itself — which prints "Deputy Mayor
 * Fischer" and "Commissioner Bode" consistently, and prints members of the
 * public without any office at all. That difference is the signal.
 *
 * Staff — City Manager, City Attorney, Clerk — are deliberately NOT here. They
 * are public officials and including them would be defensible, but they are not
 * members of the commission and this list is the narrower claim.
 */
export const RECORDED_OFFICES = ["mayor", "deputy mayor", "commissioner"] as const;

/**
 * Does this subject hold an office the project records?
 *
 * Requires the office to lead the name, so "Commissioner Bode" qualifies and
 * "a resident who used to be a commissioner" does not.
 */
export function namesAnOfficial(subject: string): boolean {
  const lower = subject.trim().toLowerCase();
  return RECORDED_OFFICES.some(
    (office) => lower === office || lower.startsWith(`${office} `),
  );
}

/**
 * How far from its citation a matter may be found in the document.
 *
 * `matter` was the one field nothing checked, and it was wrong in production on
 * 2026-08-11: a verified quotation, "Deputy Mayor Fischer – Aye" at offset
 * 5748, inside the consent-agenda vote — carrying a matter about a parking
 * amendment recorded five thousand characters later. Right person, right
 * action, verbatim citation, invented context. That is the same failure shape
 * as a misattributed quote, and the subject check did not cover it.
 *
 * An unlocatable matter drops to null rather than rejecting the claim: losing
 * the context of a true fact is a small harm, and asserting the wrong context
 * is a large one.
 */
export const MATTER_WINDOW = 2000;

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
/**
 * The matter, if the document supports it near the citation — otherwise null.
 *
 * Held to the same standard as the quote, because it makes the same kind of
 * assertion: it says what the person's action was *about*. Proximity is part of
 * the test, not just presence — the wrong matter in production was real text
 * from the same document, simply describing a different agenda item. Finding it
 * somewhere in a 22-page record proves nothing about which vote it belongs to.
 */
export function verifiedMatter(
  documentText: string,
  matter: string,
  quoteOffset: number,
): string | null {
  if (matter === "") return null;

  const at = locateQuote(documentText, matter);
  if (at === null) return null;
  return Math.abs(at - quoteOffset) <= MATTER_WINDOW ? matter : null;
}

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
    if (!namesAnOfficial(subject)) {
      // Checked before the quotation is even located: a member of the public
      // is not a cheaper claim to store, it is one this project does not make.
      rejected.push({
        reason: "not-an-official",
        detail: `'${subject}' holds none of: ${RECORDED_OFFICES.join(", ")}`,
        raw,
      });
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
      matter: verifiedMatter(documentText, matter, offset),
      // The document's own text at that offset, not the model's rendering of
      // it. If they differ by whitespace, the record is what the record says.
      quote: documentText.slice(offset, offset + normaliseQuery(quote).length),
      quote_offset: offset,
    });
  }

  return { verified, rejected };
}
