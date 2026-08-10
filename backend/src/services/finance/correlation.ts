import type { Knex } from "knex";
import { FEDERAL_ONLY_CAVEAT } from "./coverage";
import {
  fecDocumentUrl,
  isCitable,
  serializeVoteDonorEvidence,
  type CitedContribution,
  type StoredNameMatch,
  type VoteDonorEvidence,
} from "./evidence";
import { bandAtLeast, matchNameInText, matchNames, type MatchBand } from "./name-match";

/**
 * Donor-to-vote correlation — the rule that raises `vote_donor_conflict`.
 *
 * `vote_donor_conflict` has been a legal `anomaly_flag_type` since migration
 * 020 and nothing has ever raised it. This is the thing that raises it, and it
 * is the most dangerous rule in the product, so the constraints are worth
 * stating before the code.
 *
 * ## It describes the record and nothing else
 *
 * The claim this rule is permitted to make is arithmetic and provenance:
 * *this official cast this vote on this agenda item; the federal filing record
 * lists these contributions from a donor whose filed name matches text in that
 * item.* It may not say the vote was influenced, bought, returned, rewarded or
 * explained by the contribution. It may not say the official knew. It may not
 * order the two events rhetorically — the archive's version of this rule wrote
 * "voted yes … **after receiving** a contribution from", which asserts a
 * sequence the reader is invited to complete, and that phrasing is gone.
 *
 * `describeFinding` is a pure function for exactly this reason: the sentence
 * can be asserted character by character in a test, and `correlation.test.ts`
 * scans it against the review lexicon rather than trusting review.
 *
 * ## It cannot see who the donor is
 *
 * Every entity-class word — `llc`, `union`, `pac`, `foundation`, `association`,
 * `developers` and the rest — is stripped in `name-match.ts` before this rule
 * runs, so a nonprofit, a union, a trade association, a developer and a
 * corporation with the same distinctive name produce byte-identical output.
 * There is no branch on entity type here because there is no entity type here.
 *
 * ## It refuses an uncitable record
 *
 * A contribution that carries neither the filing system's identifier nor a
 * document image number is dropped before it can become part of a claim. A
 * finding built only from such records is not raised at all. "No unsourced
 * claim reaches the public site" means a locator somebody else can follow.
 *
 * ## It always holds
 *
 * Every finding this rule produces names a living person, so every draft it
 * returns sets `review_state: "held"` and reaches the public only when an
 * operator approves it in the review queue. The severity threshold in
 * `review/policy.ts` can add holds and can never release this one.
 */

/**
 * The weakest name match that may enter a finding. `weak` is a single common
 * term and is not evidence of anything — a donor called "Anderson Ridge" must
 * not be linked to an agenda item because both contain the word "Anderson".
 */
export const MINIMUM_MATCH_BAND: MatchBand = "moderate";

export interface CorrelationVote {
  vote_id: string;
  member_id: string;
  member_name: string;
  vote: string;
  agenda_item_id: string;
  agenda_item_number: number;
  agenda_item_title: string;
  agenda_item_description: string | null;
}

export interface CorrelationContribution {
  id: string;
  source_system: string;
  donor_name: string;
  recipient_name: string;
  committee_name: string | null;
  amount: number;
  contribution_date: string;
  external_id: string | null;
  image_number: string | null;
  source_url: string;
}

export interface CorrelationInput {
  meetingId: string;
  votes: readonly CorrelationVote[];
  contributions: readonly CorrelationContribution[];
  /**
   * Words to treat as non-distinctive on top of the standing list — the
   * jurisdiction's own name, which appears in most of its own agenda items.
   */
  extraGenericTerms?: readonly string[];
}

export interface VoteDonorDraft {
  meeting_id: string;
  flag_type: "vote_donor_conflict";
  description: string;
  severity: "medium" | "high";
  agenda_item_id: string;
  review_state: "held";
  metadata: Record<string, unknown>;
}

/**
 * A `moderate` name match is a possibility and a `strong` one is a good match;
 * neither is an identification. The severity difference is how much of a
 * reviewer's attention the finding is asking for, not how true it is.
 */
function severityFor(donor: MatchBand, recipient: MatchBand): "medium" | "high" {
  return donor === "strong" && recipient === "strong" ? "high" : "medium";
}

/**
 * The published sentence.
 *
 * Pure, and separated from everything else in this file so that the one thing
 * a reader will actually read can be tested as a string. Three sentences, in a
 * fixed order: what the official did, what the filing record lists, and what
 * the link between them is worth.
 */
export function describeFinding(evidence: VoteDonorEvidence): string {
  const money = formatUsd(evidence.totalAmount);
  const gifts =
    evidence.contributionCount === 1
      ? "1 contribution"
      : `${evidence.contributionCount} contributions`;
  const window =
    evidence.earliestContributionDate === evidence.latestContributionDate
      ? `on ${evidence.earliestContributionDate}`
      : `between ${evidence.earliestContributionDate} and ${evidence.latestContributionDate}`;

  return (
    `${evidence.memberName} voted ${evidence.votePosition} on agenda item ` +
    `${evidence.agendaItemNumber}, "${evidence.agendaItemTitle}". ` +
    `The federal campaign finance record lists ${gifts} totalling ${money} ${window} ` +
    `from a donor filed as "${evidence.donorName}", to a recipient filed as ` +
    `"${evidence.contributions[0].recipientName}". ` +
    `The donor name and the agenda item share the term${plural(evidence.donorMatch.matchedTerms)} ` +
    `${quoteList(evidence.donorMatch.matchedTerms)}; this is a name match, not a verified identity, ` +
    `and no relationship between the donor and this item is established by it.`
  );
}

/**
 * The rule, as a pure function over rows.
 *
 * Takes votes and contributions and returns drafts. No database handle, no
 * clock, no environment — which is what lets the uniform-treatment test feed it
 * five entity classes and compare the outputs directly rather than through a
 * fixture.
 */
export function correlateVoteDonors(input: CorrelationInput): VoteDonorDraft[] {
  const citable = input.contributions.filter(isCitable);
  if (citable.length === 0) return [];

  const drafts: VoteDonorDraft[] = [];

  for (const vote of input.votes) {
    // An official who was not present did not vote on the item. Recording a
    // correlation against an absence would be describing something that did
    // not happen.
    if (vote.vote === "absent") continue;

    const itemText = [vote.agenda_item_title, vote.agenda_item_description ?? ""].join(" ");

    /** Grouped by donor, so one donor's three gifts are one finding, not three. */
    const byDonor = new Map<
      string,
      { donorName: string; donorMatch: StoredNameMatch; recipientMatch: StoredNameMatch; rows: CorrelationContribution[] }
    >();

    for (const contribution of citable) {
      const recipientMatch = matchNames(vote.member_name, contribution.recipient_name, {
        extraGenericTerms: input.extraGenericTerms,
      });
      if (!recipientMatch || !bandAtLeast(recipientMatch.band, MINIMUM_MATCH_BAND)) continue;

      const donorMatch = matchNameInText(contribution.donor_name, itemText, {
        extraGenericTerms: input.extraGenericTerms,
      });
      if (!donorMatch || !bandAtLeast(donorMatch.band, MINIMUM_MATCH_BAND)) continue;

      const key = donorMatch.matchedTerms.join(" ");
      const bucket = byDonor.get(key);
      if (bucket) {
        bucket.rows.push(contribution);
      } else {
        byDonor.set(key, {
          donorName: contribution.donor_name,
          donorMatch,
          recipientMatch,
          rows: [contribution],
        });
      }
    }

    for (const bucket of byDonor.values()) {
      const contributions = bucket.rows.map(toCitation);
      const dates = contributions.map((row) => row.contributionDate).sort();
      const evidence: VoteDonorEvidence = {
        memberId: vote.member_id,
        memberName: vote.member_name,
        voteId: vote.vote_id,
        votePosition: vote.vote,
        agendaItemId: vote.agenda_item_id,
        agendaItemNumber: vote.agenda_item_number,
        agendaItemTitle: vote.agenda_item_title,
        donorName: bucket.donorName,
        contributionCount: contributions.length,
        totalAmount: round2(contributions.reduce((sum, row) => sum + row.amount, 0)),
        earliestContributionDate: dates[0],
        latestContributionDate: dates[dates.length - 1],
        donorMatch: bucket.donorMatch,
        recipientMatch: bucket.recipientMatch,
        contributions,
        coverageNote: FEDERAL_ONLY_CAVEAT,
      };

      drafts.push({
        meeting_id: input.meetingId,
        flag_type: "vote_donor_conflict",
        description: describeFinding(evidence),
        severity: severityFor(bucket.donorMatch.band, bucket.recipientMatch.band),
        agenda_item_id: vote.agenda_item_id,
        // Names a person. Held, always, regardless of severity or threshold.
        review_state: "held",
        metadata: serializeVoteDonorEvidence(evidence),
      });
    }
  }

  return drafts;
}

/**
 * The database adapter `anomaly-detection.ts` calls.
 *
 * Kept apart from the rule so the rule stays pure. Everything this does is
 * load rows and hand them over.
 */
export async function checkVoteDonorConflict(
  db: Knex,
  meeting: { id: string; commission_id: string },
): Promise<VoteDonorDraft[]> {
  const votes = (await db("votes as v")
    .join("members as m", "v.member_id", "m.id")
    .join("agenda_items as ai", "v.agenda_item_id", "ai.id")
    .where("v.meeting_id", meeting.id)
    .select(
      "v.id as vote_id",
      "v.member_id",
      "m.name as member_name",
      "v.vote",
      "v.agenda_item_id",
      "ai.item_number as agenda_item_number",
      "ai.title as agenda_item_title",
      "ai.description as agenda_item_description",
    )) as CorrelationVote[];

  if (votes.length === 0) return [];

  const jurisdiction = (await db("commissions")
    .join("jurisdictions as j", "commissions.jurisdiction_id", "j.id")
    .where("commissions.id", meeting.commission_id)
    .first("j.id as id", "j.name as name")) as { id: string; name: string } | undefined;

  if (!jurisdiction) return [];

  // Every filing held for this jurisdiction's roster, from every source system
  // we have ingested. Nothing here names OpenFEC: when a second system lands,
  // its rows are already in scope.
  const contributions = (await db("campaign_contributions")
    .where({ jurisdiction_id: jurisdiction.id })
    .select(
      "id",
      "source_system",
      "donor_name",
      "recipient_name",
      "committee_name",
      "amount",
      "contribution_date",
      "external_id",
      "image_number",
      "source_url",
    )) as Array<CorrelationContribution & { amount: string | number; contribution_date: string | Date }>;

  if (contributions.length === 0) return [];

  return correlateVoteDonors({
    meetingId: meeting.id,
    votes,
    contributions: contributions.map((row) => ({
      ...row,
      amount: Number(row.amount),
      contribution_date: isoDate(row.contribution_date),
    })),
    extraGenericTerms: [jurisdiction.name],
  });
}

/* ------------------------------------------------------------------------- */

function toCitation(row: CorrelationContribution): CitedContribution {
  return {
    contributionId: row.id,
    sourceSystem: row.source_system,
    donorName: row.donor_name,
    recipientName: row.recipient_name,
    committeeName: row.committee_name,
    amount: round2(Number(row.amount)),
    contributionDate: row.contribution_date,
    externalId: row.external_id,
    imageNumber: row.image_number,
    sourceUrl: row.source_url,
    documentUrl: fecDocumentUrl(row.image_number),
  };
}

function isoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value;
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function plural(terms: readonly string[]): string {
  return terms.length === 1 ? "" : "s";
}

function quoteList(terms: readonly string[]): string {
  const quoted = terms.map((term) => `"${term}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
