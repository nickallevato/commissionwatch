import type { MatchBand, MatchMethod } from "./name-match";

/**
 * The shape a `vote_donor_conflict` finding carries in `anomaly_flags.metadata`.
 *
 * `metadata` is `jsonb`, so nothing in the database constrains it. This module
 * is the constraint: the detector writes through `serializeVoteDonorEvidence`
 * and every reader — the public API, the officials page, the review console —
 * comes back through `parseVoteDonorEvidence`. A finding whose metadata does
 * not parse is not rendered as a partial finding; it is not rendered at all.
 *
 * ## What "evidence" has to mean here
 *
 * The project's sourcing invariant is that no unsourced claim reaches the
 * public site, and a dollar figure is not a source. Every `CitedContribution`
 * therefore carries the filing system's own identifiers — `externalId`
 * (OpenFEC's `sub_id`) and `imageNumber` (the FEC's scanned-document number,
 * which opens on `docquery.fec.gov` without an account) — plus the exact
 * request URL that returned it. `requireCitable` is what the detector uses to
 * throw away a record that carries neither identifier, before it can become
 * part of a claim.
 *
 * ## What the match is, stated in the data
 *
 * `donorMatch` and `recipientMatch` are `NameMatch` values, not booleans, and
 * they are stored rather than recomputed. A reader six months from now must be
 * able to see that the link was a name overlap on two terms, which two, and how
 * confident the rule was at the time — not the answer today's lexicon would
 * give. That is also why `matchedTerms` is stored rather than derived: the
 * generic-term list will grow, and a stored finding must keep meaning what it
 * meant when a human approved it.
 */

export interface StoredNameMatch {
  method: MatchMethod;
  band: MatchBand;
  score: number;
  matchedTerms: string[];
  unmatchedTerms: string[];
  discardedTerms: string[];
}

export interface CitedContribution {
  contributionId: string;
  sourceSystem: string;
  donorName: string;
  recipientName: string;
  committeeName: string | null;
  amount: number;
  contributionDate: string;
  externalId: string | null;
  imageNumber: string | null;
  sourceUrl: string;
  /** A page a reader can open, when the filing system publishes one. */
  documentUrl: string | null;
}

export interface VoteDonorEvidence {
  memberId: string;
  memberName: string;
  voteId: string;
  votePosition: string;
  agendaItemId: string;
  agendaItemNumber: number;
  agendaItemTitle: string;
  /** As filed, before any normalisation, so the reader sees the source string. */
  donorName: string;
  contributionCount: number;
  totalAmount: number;
  earliestContributionDate: string;
  latestContributionDate: string;
  donorMatch: StoredNameMatch;
  recipientMatch: StoredNameMatch;
  contributions: CitedContribution[];
  /** Mirrors `coverage.ts`; stored so an archived finding keeps its caveat. */
  coverageNote: string;
}

/**
 * The FEC publishes every filed image at a stable, public, credential-free URL.
 * Returning `null` rather than a guessed link is deliberate: a citation chip
 * that 404s is worse than no chip, because it looks checked.
 */
export function fecDocumentUrl(imageNumber: string | null): string | null {
  if (!imageNumber) return null;
  if (!/^\d{5,}$/.test(imageNumber)) return null;
  return `https://docquery.fec.gov/cgi-bin/fecimg/?${imageNumber}`;
}

/** A contribution may be cited only if somebody else can look it up. */
export function isCitable(contribution: {
  external_id: string | null;
  image_number: string | null;
}): boolean {
  return Boolean(contribution.external_id ?? contribution.image_number);
}

export function serializeVoteDonorEvidence(
  evidence: VoteDonorEvidence,
): Record<string, unknown> {
  return { ...evidence } as unknown as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseMatch(value: unknown): StoredNameMatch | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const band = row.band;
  if (band !== "weak" && band !== "moderate" && band !== "strong") return null;
  if (row.method !== "distinctive_term_overlap") return null;
  return {
    method: row.method,
    band,
    score: typeof row.score === "number" ? row.score : 0,
    matchedTerms: asStringArray(row.matchedTerms),
    unmatchedTerms: asStringArray(row.unmatchedTerms),
    discardedTerms: asStringArray(row.discardedTerms),
  };
}

function parseContribution(value: unknown): CitedContribution | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const contributionId = asString(row.contributionId);
  const donorName = asString(row.donorName);
  const recipientName = asString(row.recipientName);
  const contributionDate = asString(row.contributionDate);
  const sourceUrl = asString(row.sourceUrl);
  const sourceSystem = asString(row.sourceSystem);
  const externalId = asString(row.externalId);
  const imageNumber = asString(row.imageNumber);

  if (!contributionId || !donorName || !recipientName || !contributionDate || !sourceUrl) {
    return null;
  }
  // The sourcing invariant, enforced on the way out as well as on the way in.
  // A stored row that lost its identifiers is not shown as an uncited figure.
  if (!externalId && !imageNumber) return null;

  return {
    contributionId,
    sourceSystem: sourceSystem ?? "openfec",
    donorName,
    recipientName,
    committeeName: asString(row.committeeName),
    amount: typeof row.amount === "number" ? row.amount : Number(row.amount ?? 0),
    contributionDate,
    externalId,
    imageNumber,
    sourceUrl,
    documentUrl: asString(row.documentUrl) ?? fecDocumentUrl(imageNumber),
  };
}

/** `null` when the metadata is not a complete, citable finding. */
export function parseVoteDonorEvidence(value: unknown): VoteDonorEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;

  const memberId = asString(row.memberId);
  const memberName = asString(row.memberName);
  const voteId = asString(row.voteId);
  const agendaItemId = asString(row.agendaItemId);
  const donorName = asString(row.donorName);
  const donorMatch = parseMatch(row.donorMatch);
  const recipientMatch = parseMatch(row.recipientMatch);
  const contributions = Array.isArray(row.contributions)
    ? row.contributions.map(parseContribution).filter((item): item is CitedContribution => item !== null)
    : [];

  if (
    !memberId ||
    !memberName ||
    !voteId ||
    !agendaItemId ||
    !donorName ||
    !donorMatch ||
    !recipientMatch ||
    contributions.length === 0
  ) {
    return null;
  }

  const dates = contributions.map((contribution) => contribution.contributionDate).sort();

  return {
    memberId,
    memberName,
    voteId,
    votePosition: asString(row.votePosition) ?? "",
    agendaItemId,
    agendaItemNumber: typeof row.agendaItemNumber === "number" ? row.agendaItemNumber : 0,
    agendaItemTitle: asString(row.agendaItemTitle) ?? "",
    donorName,
    contributionCount:
      typeof row.contributionCount === "number" ? row.contributionCount : contributions.length,
    totalAmount:
      typeof row.totalAmount === "number"
        ? row.totalAmount
        : contributions.reduce((sum, item) => sum + item.amount, 0),
    earliestContributionDate: asString(row.earliestContributionDate) ?? dates[0],
    latestContributionDate: asString(row.latestContributionDate) ?? dates[dates.length - 1],
    donorMatch,
    recipientMatch,
    contributions,
    coverageNote: asString(row.coverageNote) ?? "",
  };
}
