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
  "wrong-role-in-quote",
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
/**
 * Every official the minutes name inside a passage, with where they appear.
 *
 * Offices are the anchor, because that is how minutes print members and it is
 * the same signal `namesAnOfficial` uses.
 */
const OFFICIAL_MENTION = /\b(?:Deputy Mayor|Mayor|Commissioner)\s+([A-Z][\w'’-]+)/g;

export interface OfficialMention {
  surname: string;
  index: number;
  end: number;
}

export function officialMentions(passage: string): OfficialMention[] {
  const found: OfficialMention[] = [];
  for (const match of passage.matchAll(OFFICIAL_MENTION)) {
    if (match.index === undefined) continue;
    found.push({
      surname: match[1].toLowerCase(),
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * A phrase marking an action, and which side of it the actor stands on.
 *
 * The side is load-bearing, not decoration. A roll call reads
 * "Deputy Mayor Fischer – Aye; Commissioner Bode – Aye", where each vote belongs
 * to the name BEFORE it — and the next commissioner's name begins two
 * characters after that "Aye" while Fischer's ends three before it. Nearest-by-
 * distance alone therefore hands Fischer's vote to Bode, and every vote in the
 * roll call shifts by one person. Minutes are consistent about direction, so
 * direction is what we use.
 */
type CueSide = "before" | "after";
interface ActionCue {
  pattern: RegExp;
  /** Where the actor stands relative to the cue. */
  side: CueSide;
}

const ACTION_CUES: Record<ClaimAction, ActionCue[]> = {
  // "Commissioner Bode moved..." but also "...was made by Deputy Mayor Fischer".
  moved: [
    { pattern: /\bmoved\b/gi, side: "before" },
    { pattern: /\bmade the motion\b/gi, side: "before" },
    { pattern: /\bwas made by\b/gi, side: "after" },
    { pattern: /\bmotion by\b/gi, side: "after" },
  ],
  seconded: [
    { pattern: /\bseconded by\b/gi, side: "after" },
    // "Commissioner Bode seconded the motion." The lookahead keeps this from
    // also matching "seconded BY Commissioner Bode", where the actor stands on
    // the other side — without it, the sentence resolves to whoever moved.
    { pattern: /\bsecond(?:ed|s)?\b(?!\s+by\b)/gi, side: "before" },
  ],
  voted_yes: [
    { pattern: /\b(?:aye|yes|in favou?r)\b/gi, side: "before" },
    { pattern: /\bvoted (?:yes|aye)\b/gi, side: "before" },
  ],
  voted_no: [{ pattern: /\b(?:nay|no|opposed|against)\b/gi, side: "before" }],
  abstained: [{ pattern: /\babstain(?:ed|s|ing)?\b/gi, side: "before" }],
  absent: [{ pattern: /\b(?:absent|excused)\b/gi, side: "before" }],
  recused: [{ pattern: /\brecus(?:ed|es|ing|al)\b/gi, side: "before" }],
  // Open-ended by nature — there is no closed list of ways minutes report
  // speech. Handled by the leading-subject rule instead.
  spoke: [],
};

/** The official standing on the cue's side of it, nearest to it. */
function actorFor(mentions: OfficialMention[], cue: number, side: CueSide): OfficialMention | null {
  const candidates =
    side === "before"
      ? mentions.filter((mention) => mention.end <= cue)
      : mentions.filter((mention) => mention.index >= cue);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, mention) => {
    const distance = side === "before" ? cue - mention.end : mention.index - cue;
    const bestDistance = side === "before" ? cue - best.end : best.index - cue;
    return distance < bestDistance ? mention : best;
  });
}

/**
 * Did THIS subject perform THIS action, given a sentence naming several people?
 *
 * The gap this closes, found in production 2026-08-11. The minutes' canonical
 * sentence is:
 *
 *   "Motion to approve Consent Items F.1 through F.22 as presented was made by
 *    Deputy Mayor Fischer and seconded by Commissioner Bode."
 *
 * Fischer moved and Bode seconded, but a claim saying *Fischer seconded* passed
 * every check: the quotation is verbatim, the person is real, and the sentence
 * does name Fischer. `quoteNamesSubject` asks whether the subject appears, and
 * when two officials appear in two different roles, that question cannot
 * separate them. The stored claims contained both the true second and the false
 * one, equally well cited.
 *
 * The rule is proximity to the action's own cue: of the officials named, the
 * one nearest the word marking the action is the one who performed it. So
 * "seconded" resolves to Bode and the Fischer claim dies. A quote with no cue
 * for the claimed action fails outright — which also rejects
 * `Fischer [seconded]` cited to "Deputy Mayor Fischer – Aye", a vote line
 * carrying no second at all.
 *
 * `spoke` has no closed cue list, so it takes the leading-subject rule instead:
 * minutes report speech as "Commissioner Bode asked about X", subject first.
 *
 * A sentence naming only one official is left alone — there is nothing to
 * confuse, and `quoteNamesSubject` has already established they are in it.
 */
export function subjectPerformedAction(
  quote: string,
  subject: string,
  action: ClaimAction,
): boolean {
  const surname = subjectSurname(subject);
  if (surname === null) return false;

  const mentions = officialMentions(quote);
  const distinct = new Set(mentions.map((m) => m.surname));
  if (distinct.size <= 1) return true;

  if (action === "spoke") {
    return mentions.length > 0 && mentions[0].surname === surname;
  }

  for (const cue of ACTION_CUES[action]) {
    for (const match of quote.matchAll(cue.pattern)) {
      if (match.index === undefined) continue;
      // "before" measures from the END of the cue word, so "Fischer – Aye"
      // looks left from after "Aye" and finds Fischer, not the next name.
      const from = cue.side === "before" ? match.index : match.index + match[0].length;
      const actor = actorFor(mentions, from, cue.side);
      if (actor !== null && actor.surname === surname) return true;
    }
  }
  // Either no cue for this action anywhere in the citation, or every cue
  // resolved to somebody else. Both mean the sentence does not say this subject
  // did this thing, whoever else it names.
  return false;
}

/** The surname a subject is matched on, or null if there is nothing usable. */
function subjectSurname(subject: string): string | null {
  const parts = subject
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 2);
  if (parts.length === 0) return null;
  return parts[parts.length - 1].toLowerCase();
}

function quoteNamesSubject(quote: string, subject: string): boolean {
  const surname = subjectSurname(subject);
  if (surname === null) return false;
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

    if (!subjectPerformedAction(quote, subject, action as ClaimAction)) {
      // Names the subject, but another official in the sentence performed this
      // action. Equally well cited and simply untrue.
      rejected.push({
        reason: "wrong-role-in-quote",
        detail: `the citation names ${subject} but does not attribute '${action}' to them`,
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
