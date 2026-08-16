import type { Knex } from "knex";

/**
 * The tally, and the one check it buys.
 *
 * **This module is unwired.** Nothing in `src/` imports it — no route, no
 * ingestion handler, no extraction stage. `backend/test/vote-events.test.ts`
 * exercises every function here directly, so the logic is real and tested,
 * but nothing in the running system ever calls `recordVoteEvent`,
 * `linkClaimsToVoteEvent`, `approveVoteEvent`, or `listPublishedVoteEvents`.
 * The `vote_events` table it reads and writes (migration 085) is live in the
 * sense that matters — `services/metrics.ts` counts it directly with its
 * own `db("vote_events")` queries for `QualityMetrics.vote_events_total` /
 * `vote_events_approved` — but that is a raw count, not a caller of this
 * module. No extraction or ingestion stage ever calls `recordVoteEvent`, so
 * nothing currently populates the table from a live sweep, and no route
 * calls `approveVoteEvent` / `rejectVoteEvent`, so there is no operator
 * review surface for a tally even if one existed. This is the only
 * implementation of the feature described below — an unbuilt feature, not a
 * duplicate of anything live — so it is kept, not deleted, on the same
 * theory the review queue was kept before it was wired: the logic is the
 * expensive part and it already has tests holding it to its own contract.
 * Wiring it up (an extraction stage that calls `recordVoteEvent`, and a
 * pressroom route that calls `approveVoteEvent/rejectVoteEvent`) is a
 * separate, deliberate change.
 *
 * `minute_claims` records what one named person did. Five of those on the same
 * motion imply "2–3", but nothing held that sentence, so the site could say
 * "Sample voted no" and could not say "the motion failed 2–3" — the sentence a
 * reader wants and the one that makes the individual votes mean anything.
 * Migration 085 gives the tally a row; this module is what makes the row
 * trustworthy.
 *
 * **The sum of the linked claims per option must equal `counts`.** A mismatch is
 * never reconciled — not by adjusting the tally to fit the claims, and not the
 * other way round. It means the extractor missed a member or invented one, and
 * a tally that disagrees with its own votes is the loudest available signal
 * that a document was read badly. Before this the system could not notice it at
 * all. So the mismatch is reported as a discrepancy and it blocks approval:
 * `approveVoteEvent` refuses, because publishing "failed 2–3" over four votes
 * would be publishing a number nobody can check against the record.
 *
 * **What is deliberately not checked here:** whether `result` follows from
 * `counts`. Whether 3–3 passes depends on a body's own rules — a tie-breaking
 * chair, a supermajority requirement, an absent quorum — and inferring the
 * outcome from the arithmetic would be this project asserting a rule it has not
 * read. The minutes state the result; we cite them for it.
 *
 * Schema of record: `backend/migrations/085_create_vote_events.ts`. The
 * constants below restate it rather than importing it, for the reason
 * `migrations-selfcontained.test.ts` guards in the other direction: migrations
 * ship in the production image and `src/` does not, and the two must not depend
 * on each other in either direction.
 */

export const VOTE_OPTIONS = ["yes", "no", "abstain", "absent"] as const;
export type VoteOption = (typeof VOTE_OPTIONS)[number];
export type VoteCounts = Record<VoteOption, number>;

export const VOTE_RESULTS = ["pass", "fail", "tabled", "withdrawn", "unrecorded"] as const;
export type VoteResult = (typeof VOTE_RESULTS)[number];

export const VOTE_EVENT_STATUSES = ["held", "approved", "rejected"] as const;
export type VoteEventStatus = (typeof VOTE_EVENT_STATUSES)[number];

/**
 * Which claim action counts toward which option.
 *
 * `moved`, `seconded`, `spoke` and `recused` are absent on purpose: they are
 * real things a member did on this motion and are worth linking to it, but they
 * are not votes and must not move the arithmetic. They are reported separately
 * as `non_voting` so a reviewer can see the link exists.
 */
const ACTION_OPTIONS: Record<string, VoteOption> = {
  voted_yes: "yes",
  voted_no: "no",
  abstained: "abstain",
  absent: "absent",
};

export class VoteEventError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "VoteEventError";
  }
}

export interface VoteEvent {
  id: string;
  meeting_id: string;
  agenda_item_id: string | null;
  motion_text: string;
  result: VoteResult;
  counts: VoteCounts;
  artifact_sha256: string;
  quote: string;
  quote_offset: number;
  model: string;
  prompt_version: string;
  status: VoteEventStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroCounts(): VoteCounts {
  return { yes: 0, no: 0, abstain: 0, absent: 0 };
}

/**
 * `counts` as stored, validated rather than asserted.
 *
 * The column is `jsonb` with a CHECK requiring all four options as numbers, so
 * anything else means the row was written by something that is not this
 * application. That is not a case to guess at: it throws, and the caller
 * surfaces it, rather than silently reading a missing option as zero and
 * reporting a tally that agrees with nothing.
 */
export function readCounts(value: unknown): VoteCounts {
  if (!isRecord(value)) {
    throw new VoteEventError("vote_events.counts: expected an object", 500);
  }
  const counts = zeroCounts();
  for (const option of VOTE_OPTIONS) {
    const raw = value[option];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new VoteEventError(
        `vote_events.counts.${option}: expected a non-negative integer`,
        500,
      );
    }
    counts[option] = raw;
  }
  return counts;
}

function asResult(value: unknown): VoteResult {
  const found = VOTE_RESULTS.find((result) => result === value);
  if (found === undefined) {
    throw new VoteEventError(`vote_events.result: unknown result ${String(value)}`, 500);
  }
  return found;
}

function asStatus(value: unknown): VoteEventStatus {
  const found = VOTE_EVENT_STATUSES.find((status) => status === value);
  if (found === undefined) {
    throw new VoteEventError(`vote_events.status: unknown status ${String(value)}`, 500);
  }
  return found;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new VoteEventError(`vote_events.${field}: expected string`, 500);
  }
  return value;
}

export function toVoteEvent(raw: unknown): VoteEvent {
  if (!isRecord(raw)) {
    throw new VoteEventError("vote_events: expected a row object", 500);
  }
  const offset = Number(raw.quote_offset);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new VoteEventError("vote_events.quote_offset: expected a non-negative integer", 500);
  }
  return {
    id: asString(raw.id, "id"),
    meeting_id: asString(raw.meeting_id, "meeting_id"),
    agenda_item_id: typeof raw.agenda_item_id === "string" ? raw.agenda_item_id : null,
    motion_text: asString(raw.motion_text, "motion_text"),
    result: asResult(raw.result),
    counts: readCounts(raw.counts),
    artifact_sha256: asString(raw.artifact_sha256, "artifact_sha256"),
    quote: asString(raw.quote, "quote"),
    quote_offset: offset,
    model: asString(raw.model, "model"),
    prompt_version: asString(raw.prompt_version, "prompt_version"),
    status: asStatus(raw.status),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RecordVoteEventInput {
  meetingId: string;
  agendaItemId?: string | null;
  motionText: string;
  result: VoteResult;
  counts: VoteCounts;
  artifactSha256: string;
  quote: string;
  /** Where the quote was FOUND in the artifact. Never where it was claimed to be. */
  quoteOffset: number;
  model: string;
  promptVersion: string;
}

/**
 * Store a tally. Held, always.
 *
 * `onConflict(...).merge()` on the unique key from migration 085, for migration
 * 072's reason: re-reading the same bytes must revise a tally rather than add a
 * second copy of it, and the merge leaves `status` alone so an operator's
 * decision survives a re-run.
 *
 * The quote and its offset are required by the column definitions, not by this
 * function — the database is where "a vote event cannot exist without a
 * verified citation" is enforced, because a rule enforced only in application
 * code is a rule the next writer does not know about.
 */
export async function recordVoteEvent(db: Knex, input: RecordVoteEventInput): Promise<string> {
  const rows: unknown = await db("vote_events")
    .insert({
      meeting_id: input.meetingId,
      agenda_item_id: input.agendaItemId ?? null,
      motion_text: input.motionText,
      result: input.result,
      counts: JSON.stringify(input.counts),
      artifact_sha256: input.artifactSha256,
      quote: input.quote,
      quote_offset: input.quoteOffset,
      model: input.model,
      prompt_version: input.promptVersion,
      status: "held",
    })
    .onConflict(["meeting_id", "artifact_sha256", "quote_offset"])
    .merge([
      "agenda_item_id",
      "motion_text",
      "result",
      "counts",
      "quote",
      "model",
      "prompt_version",
      "updated_at",
    ])
    .returning("id");
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (!isRecord(row) || typeof row.id !== "string") {
    throw new VoteEventError("vote_events insert returned no id", 500);
  }
  return row.id;
}

/**
 * Link personal claims to the tally they compose.
 *
 * Scoped to the meeting: a claim can only join a tally from the same meeting,
 * so a wrong id links nothing instead of attaching a Bozeman vote to a Gallatin
 * motion. Returns how many rows were actually linked, which is how a caller
 * notices the difference.
 */
export async function linkClaimsToVoteEvent(
  db: Knex,
  voteEventId: string,
  claimIds: string[],
): Promise<number> {
  if (claimIds.length === 0) return 0;
  const event: unknown = await db("vote_events").where({ id: voteEventId }).first("meeting_id");
  if (!isRecord(event) || typeof event.meeting_id !== "string") {
    throw new VoteEventError("vote event not found", 404);
  }
  return db("minute_claims")
    .whereIn("id", claimIds)
    .where({ meeting_id: event.meeting_id })
    .update({ vote_event_id: voteEventId, updated_at: db.fn.now() });
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface VoteTallyDifference {
  option: VoteOption;
  /** What the tally says. */
  stated: number;
  /** How many linked claims say it. */
  linked: number;
}

export interface VoteTallyCheck {
  vote_event_id: string;
  meeting_id: string;
  status: VoteEventStatus;
  counts: VoteCounts;
  linked: VoteCounts;
  /** Empty when the tally and its votes agree. */
  differences: VoteTallyDifference[];
  /** Linked claims that are not votes — moved, seconded, spoke, recused. */
  non_voting: number;
  agrees: boolean;
}

/**
 * Compare a tally against the claims linked to it.
 *
 * **Rejected claims are excluded.** A rejection is an operator saying that
 * claim is not in the record, and counting it would let a discarded claim keep
 * propping up a tally. Held and approved claims both count: a held claim is
 * unreviewed, not disbelieved, and waiting for review before checking the
 * arithmetic would mean the discrepancy surfaced last instead of first.
 */
export async function checkVoteTally(
  db: Knex,
  voteEventId: string,
): Promise<VoteTallyCheck | null> {
  const raw: unknown = await db("vote_events").where({ id: voteEventId }).first();
  if (!isRecord(raw)) return null;
  const event = toVoteEvent(raw);

  const rows: unknown = await db("minute_claims")
    .where({ vote_event_id: voteEventId })
    .whereNot({ status: "rejected" })
    .select("action");

  const linked = zeroCounts();
  let nonVoting = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row) || typeof row.action !== "string") continue;
    const option = ACTION_OPTIONS[row.action];
    if (option === undefined) {
      nonVoting += 1;
      continue;
    }
    linked[option] += 1;
  }

  const differences = VOTE_OPTIONS.filter(
    (option) => event.counts[option] !== linked[option],
  ).map((option) => ({ option, stated: event.counts[option], linked: linked[option] }));

  return {
    vote_event_id: event.id,
    meeting_id: event.meeting_id,
    status: event.status,
    counts: event.counts,
    linked,
    differences,
    non_voting: nonVoting,
    agrees: differences.length === 0,
  };
}

/**
 * Every tally in a meeting that disagrees with its own votes.
 *
 * The list a review screen would show. Reported per meeting rather than
 * globally because a document is read as a whole, and one badly-read set of
 * minutes usually produces several of these at once.
 */
export async function findTallyDiscrepancies(
  db: Knex,
  meetingId: string,
): Promise<VoteTallyCheck[]> {
  const rows: unknown = await db("vote_events").where({ meeting_id: meetingId }).select("id");
  const checks: VoteTallyCheck[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const check = await checkVoteTally(db, row.id);
    if (check !== null && !check.agrees) checks.push(check);
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface VoteEventReview {
  reviewedBy?: string | null;
  reason: string;
}

/**
 * Approve a tally, if it survives its own arithmetic.
 *
 * The refusal is the feature. "The motion failed 2–3" over four linked votes is
 * a sentence nobody can check against the record, and the review queue exists
 * precisely so that a statement naming people is checked before it is public.
 * The error names the difference, because "it does not add up" without saying
 * where is not actionable.
 */
export async function approveVoteEvent(
  db: Knex,
  voteEventId: string,
  review: VoteEventReview,
): Promise<VoteTallyCheck> {
  if (review.reason.trim() === "") {
    throw new VoteEventError("reason is required: approval is a decision, and a decision has a reason", 400);
  }
  const check = await checkVoteTally(db, voteEventId);
  if (check === null) throw new VoteEventError("vote event not found", 404);
  if (!check.agrees) {
    const detail = check.differences
      .map((difference) => `${difference.option}: says ${difference.stated}, ${difference.linked} linked`)
      .join("; ");
    throw new VoteEventError(
      `This tally disagrees with the votes linked to it (${detail}). That means a member was ` +
        "missed or invented when the document was read, so it cannot be approved until the " +
        "claims and the tally agree.",
      409,
    );
  }

  await db("vote_events").where({ id: voteEventId }).update({
    status: "approved",
    reviewed_by: review.reviewedBy ?? null,
    review_reason: review.reason,
    reviewed_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
  return { ...check, status: "approved" };
}

export async function rejectVoteEvent(
  db: Knex,
  voteEventId: string,
  review: VoteEventReview,
): Promise<void> {
  if (review.reason.trim() === "") {
    throw new VoteEventError("reason is required: rejection is a decision, and a decision has a reason", 400);
  }
  const affected = await db("vote_events").where({ id: voteEventId }).update({
    status: "rejected",
    reviewed_by: review.reviewedBy ?? null,
    review_reason: review.reason,
    reviewed_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
  if (affected === 0) throw new VoteEventError("vote event not found", 404);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The tallies a public page may state, with their member votes nested.
 *
 * Two gates, both required. The vote event must be `approved` — it names people
 * by composition and is a stronger statement than any single claim — and its
 * meeting must be published, because an approved tally on an unpublished
 * meeting is still a record nobody has released. Either gate alone would leak:
 * approving a tally is not a decision to publish the meeting, and publishing a
 * meeting is not a decision to publish everything a model wrote about it.
 *
 * The nested member votes are `approved` claims only, for the same reason.
 */
export interface PublishedVoteEvent extends VoteEvent {
  votes: Array<{ subject_name: string; action: string; quote: string; quote_offset: number }>;
}

export async function listPublishedVoteEvents(
  db: Knex,
  meetingId: string,
): Promise<PublishedVoteEvent[]> {
  const meeting: unknown = await db("meetings").where({ id: meetingId }).first("published_at");
  if (!isRecord(meeting) || meeting.published_at === null || meeting.published_at === undefined) {
    return [];
  }

  const rows: unknown = await db("vote_events")
    .where({ meeting_id: meetingId, status: "approved" })
    .orderBy("quote_offset", "asc");

  const events: PublishedVoteEvent[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const event = toVoteEvent(row);
    const claims: unknown = await db("minute_claims")
      .where({ vote_event_id: event.id, status: "approved" })
      .orderBy("quote_offset", "asc")
      .select("subject_name", "action", "quote", "quote_offset");
    const votes = (Array.isArray(claims) ? claims : [])
      .filter(isRecord)
      .map((claim) => ({
        subject_name: asString(claim.subject_name, "subject_name"),
        action: asString(claim.action, "action"),
        quote: asString(claim.quote, "quote"),
        quote_offset: Number(claim.quote_offset),
      }));
    events.push({ ...event, votes });
  }
  return events;
}
