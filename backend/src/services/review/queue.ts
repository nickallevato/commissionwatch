import type { Knex } from "knex";
import { MATCH_POLICY, type MatchPolicy } from "../finance/correlation";
import {
  loadEntityDecisions,
  pairForEvidence,
  pairKey,
  recordEntityDecision,
  type EntityDecision,
  type StoredEntityDecision,
} from "../finance/entity-resolution";
import { parseVoteDonorEvidence, type VoteDonorEvidence } from "../finance/evidence";
import { MATCH_BANDS, type MatchBand } from "../finance/name-match";
import {
  emitEvent,
  subjectIsPublic,
  EVENT_SEVERITIES,
  type EventSeverity,
} from "../events";
import { appendCorrectionRow } from "../pressroom/corrections";
import { resolveCitations, type Citation } from "./evidence";
import { motiveTerms } from "./language";
import {
  isSeverity,
  loadPolicy,
  type ReviewPolicy,
  type Severity,
} from "./policy";

/**
 * The operator review queue — B-a.
 *
 * Every held finding, what it rests on, and the three things an operator can do
 * with it: approve, reject, or edit with a stated reason. Approval is the only
 * thing in this product that sets `anomaly_flags.review_state` to `published`.
 *
 * Four rules the code below enforces rather than assumes:
 *
 *  1. **A finding with no citation cannot be approved.** `resolveCitations`
 *     decides, and an empty result is a 409. "No unsourced claim reaches the
 *     public site" is not advice.
 *  2. **Rejection leaves the finding held.** There is no `rejected` review
 *     state and there does not need to be: the wall keys on `published`, so a
 *     rejected finding is unpublishable by the same rule that keeps an
 *     unreviewed one unpublishable. One rule, one failure mode.
 *  3. **Every decision is appended to `record_corrections`** through the same
 *     writer publication and correction use. One audit log.
 *  4. **Overdue is derived, never written.** See migration 038's header: a
 *     terminal status set by a clock is indistinguishable, in the log, from a
 *     decision a person made.
 *  5. **Approval emits `finding.published` into `events`**, in the same
 *     transaction, and that row is the only thing any delivery channel reads.
 *     See `services/events/emit.ts`: consumers read events instead of tables so
 *     the publication wall is asserted once rather than once per consumer.
 */

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export type RequestStatus = "pending_review" | "approved" | "rejected";

export interface ReviewActor {
  id: string | null;
  email: string | null;
}

export interface QueueItem {
  request: {
    id: string;
    status: RequestStatus;
    severity: string;
    reviewer_operator_id: string | null;
    reviewer_email: string | null;
    review_comment: string | null;
    reviewed_at: string | null;
    expires_at: string;
    created_at: string;
    /** Derived from `expires_at` at read time. Never a status. */
    overdue: boolean;
  };
  finding: {
    id: string;
    flag_type: string;
    severity: string;
    description: string;
    review_state: string;
    source: string;
    meeting_id: string | null;
    agenda_item_id: string | null;
    artifact_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  };
  context: {
    meeting_date: string | null;
    meeting_published_at: string | null;
    commission_name: string | null;
    jurisdiction_name: string | null;
  };
  /** What the claim rests on. Empty means it cannot be approved. */
  citations: Citation[];
  /**
   * The stored name match and its evidence, parsed — `null` for a finding that
   * is not a `vote_donor_conflict`, or whose metadata does not parse.
   *
   * Parsed here rather than in the browser on purpose. `evidence.ts` says every
   * reader comes back through `parseVoteDonorEvidence`, and the operator console
   * is not the reader that gets to be the exception: a second parser written
   * against `jsonb` in a component is a second thing that can disagree about
   * what a stored finding says, on the one screen where that matters most.
   */
  evidence: VoteDonorEvidence | null;
  /**
   * The operator judgement in force on this finding's donor/subject pair **now**
   * — which is not necessarily the one the finding was raised under. The one it
   * was raised under is inside `evidence`, frozen. The difference is the point:
   * an operator who has changed their mind should be able to see both.
   */
  entity_decision: StoredEntityDecision | null;
}

/**
 * How the queue is ordered.
 *
 * `default` is overdue first then oldest first — the two orderings an operator
 * working a backlog wants, and deliberately not severity, which would bury the
 * low-severity findings forever.
 *
 * `weakest_first` is for working the queue by how much the claim rests on. It
 * puts the most ambiguous name matches at the top so they can be read
 * deliberately rather than met at random halfway down a list. Findings with no
 * band at all sort last under it — they are not "least ambiguous", they are a
 * different kind of thing, and putting them first would hide the findings this
 * sort exists to surface.
 */
export type QueueSort = "default" | "weakest_first";

export const QUEUE_SORTS: readonly QueueSort[] = ["default", "weakest_first"];

export function isQueueSort(value: unknown): value is QueueSort {
  return typeof value === "string" && (QUEUE_SORTS as readonly string[]).includes(value);
}

export function isMatchBand(value: unknown): value is MatchBand {
  return typeof value === "string" && (MATCH_BANDS as readonly string[]).includes(value);
}

export interface QueueFilters {
  status?: RequestStatus;
  severity?: Severity;
  /**
   * The stored donor-match band, read straight out of `metadata` in SQL. Not
   * recomputed: the band on a finding is the band it was raised under, and
   * filtering on today's answer would show an operator a different queue from
   * the one the findings actually describe.
   */
  band?: MatchBand;
  sort?: QueueSort;
  limit?: number;
  offset?: number;
}

/** Where the stored band lives in `anomaly_flags.metadata`. */
const BAND_EXPR = "anomaly_flags.metadata #>> '{donorMatch,band}'";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRequestStatus(value: unknown): RequestStatus {
  return value === "approved" || value === "rejected" ? value : "pending_review";
}

/**
 * Creates the missing requests for every held finding.
 *
 * Called from detection, from the records upload path, and again whenever the
 * queue is read. Three callers rather than one on purpose: a finding held by
 * code that predates this queue — or by code written after it that forgets —
 * still appears, because the queue derives its contents from `review_state`
 * rather than from anyone having remembered to enqueue. `ON CONFLICT DO
 * NOTHING` on the unique `anomaly_flag_id` is what makes calling it three times
 * cost nothing.
 *
 * The window runs from when the finding was raised, not from when someone first
 * opened the queue — otherwise a finding nobody looked at for a month would
 * report as fresh the moment it was noticed.
 */
export async function ensureApprovalRequests(
  db: Knex,
  policy?: Pick<ReviewPolicy, "review_window_hours">,
): Promise<number> {
  const window = policy ?? (await loadPolicy(db));
  const result = await db.raw(
    `
    INSERT INTO approval_requests (anomaly_flag_id, meeting_id, severity, expires_at)
    SELECT f.id, f.meeting_id, f.severity::text,
           f.created_at + (? || ' hours')::interval
    FROM anomaly_flags f
    LEFT JOIN approval_requests r ON r.anomaly_flag_id = f.id
    WHERE f.review_state = 'held' AND r.id IS NULL
    ON CONFLICT (anomaly_flag_id) DO NOTHING
    `,
    [String(window.review_window_hours)],
  );
  const rowCount = (result as { rowCount?: number }).rowCount;
  return typeof rowCount === "number" ? rowCount : 0;
}

interface JoinedRow extends Record<string, unknown> {
  request_id: string;
}

function toQueueItem(
  row: JoinedRow,
  citations: Citation[],
  now: Date,
  entityDecisions: ReadonlyMap<string, StoredEntityDecision>,
): QueueItem {
  const expiresAt = asIso(row.expires_at);
  const status = asRequestStatus(row.status);
  const evidence = parseVoteDonorEvidence(row.metadata);
  const pair = evidence === null ? null : pairForEvidence(evidence);
  return {
    request: {
      id: row.request_id,
      status,
      severity: text(row.request_severity),
      reviewer_operator_id: textOrNull(row.reviewer_operator_id),
      reviewer_email: textOrNull(row.reviewer_email),
      review_comment: textOrNull(row.review_comment),
      reviewed_at: asIsoOrNull(row.reviewed_at),
      expires_at: expiresAt,
      created_at: asIso(row.request_created_at),
      // Derived. A pending request past its window is overdue; a decided one
      // never is, because the window measured how long nobody had looked.
      overdue: status === "pending_review" && new Date(expiresAt).getTime() < now.getTime(),
    },
    finding: {
      id: text(row.flag_id),
      flag_type: text(row.flag_type),
      severity: text(row.severity),
      description: text(row.description),
      review_state: text(row.review_state),
      source: text(row.source),
      meeting_id: textOrNull(row.meeting_id),
      agenda_item_id: textOrNull(row.agenda_item_id),
      artifact_id: textOrNull(row.artifact_id),
      metadata: isRecord(row.metadata) ? row.metadata : null,
      created_at: asIso(row.flag_created_at),
    },
    context: {
      meeting_date: asIsoOrNull(row.meeting_date),
      meeting_published_at: asIsoOrNull(row.meeting_published_at),
      commission_name: textOrNull(row.commission_name),
      jurisdiction_name: textOrNull(row.jurisdiction_name),
    },
    citations,
    evidence,
    entity_decision: pair === null ? null : (entityDecisions.get(pairKey(pair)) ?? null),
  };
}

const QUEUE_COLUMNS = [
  "approval_requests.id as request_id",
  "approval_requests.status as status",
  "approval_requests.severity as request_severity",
  "approval_requests.reviewer_operator_id",
  "approval_requests.reviewer_email",
  "approval_requests.review_comment",
  "approval_requests.reviewed_at",
  "approval_requests.expires_at",
  "approval_requests.created_at as request_created_at",
  "anomaly_flags.id as flag_id",
  "anomaly_flags.flag_type",
  "anomaly_flags.severity",
  "anomaly_flags.description",
  "anomaly_flags.review_state",
  "anomaly_flags.source",
  "anomaly_flags.meeting_id",
  "anomaly_flags.agenda_item_id",
  "anomaly_flags.artifact_id",
  "anomaly_flags.metadata",
  "anomaly_flags.created_at as flag_created_at",
  "meetings.date as meeting_date",
  "meetings.published_at as meeting_published_at",
  "commissions.name as commission_name",
  "jurisdictions.name as jurisdiction_name",
];

function queueQuery(db: Knex): Knex.QueryBuilder {
  return db("approval_requests")
    .join("anomaly_flags", "anomaly_flags.id", "approval_requests.anomaly_flag_id")
    .leftJoin("meetings", "meetings.id", "anomaly_flags.meeting_id")
    .leftJoin("commissions", "commissions.id", "meetings.commission_id")
    .leftJoin("jurisdictions", "jurisdictions.id", "commissions.jurisdiction_id");
}

export interface QueueListing {
  data: QueueItem[];
  total: number;
  policy: ReviewPolicy;
  counts: { pending: number; overdue: number; approved: number; rejected: number };
  /**
   * The name-match policy, served so the console renders the project's own
   * words rather than its own paraphrase of them. See `MATCH_POLICY`.
   */
  match_policy: MatchPolicy;
  /**
   * Pending findings by stored donor-match band, so an operator can see how much
   * of the queue rests on an ambiguous match before opening any of it.
   * `unbanded` is every pending finding that is not a name-match finding at all.
   */
  band_counts: Record<MatchBand | "unbanded", number>;
}

/**
 * The queue. Overdue first, then oldest first — the two orderings an operator
 * working through a backlog actually wants, and neither is severity: sorting by
 * severity would quietly bury the low-severity findings forever.
 */
export async function listQueue(db: Knex, filters: QueueFilters = {}): Promise<QueueListing> {
  const policy = await loadPolicy(db);
  await ensureApprovalRequests(db, policy);

  const now = new Date();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const base = queueQuery(db);
  if (filters.status !== undefined) base.where("approval_requests.status", filters.status);
  if (filters.severity !== undefined) base.where("anomaly_flags.severity", filters.severity);
  if (filters.band !== undefined) base.whereRaw(`${BAND_EXPR} = ?`, [filters.band]);

  const countRow = await base.clone().count("* as total").first<{ total?: string } | undefined>();
  const total = Number(countRow?.total ?? 0);

  const listQuery = base.clone().select<JoinedRow[]>(QUEUE_COLUMNS);
  if (filters.sort === "weakest_first") {
    // Weakest band first; findings with no band last. `array_position` over the
    // band list is what makes this an ordering rather than an alphabetisation —
    // "moderate" < "strong" < "weak" alphabetically, which is close to exactly
    // wrong.
    listQuery.orderByRaw(
      `COALESCE(array_position(ARRAY[${MATCH_BANDS.map(() => "?").join(", ")}]::text[], ${BAND_EXPR}), ${
        MATCH_BANDS.length + 1
      }) ASC`,
      [...MATCH_BANDS],
    );
  } else {
    listQuery.orderByRaw(
      "(approval_requests.status = 'pending_review' AND approval_requests.expires_at < now()) DESC",
    );
  }
  const rows = await listQuery
    .orderBy("approval_requests.created_at", "asc")
    .limit(limit)
    .offset(offset);

  const entityDecisions = await loadEntityDecisions(db);

  const data: QueueItem[] = [];
  for (const row of rows) {
    const citations = await resolveCitations(db, {
      id: text(row.flag_id),
      meeting_id: textOrNull(row.meeting_id),
      artifact_id: textOrNull(row.artifact_id),
      metadata: row.metadata,
    });
    data.push(toQueueItem(row, citations, now, entityDecisions));
  }

  const tallies = await queueQuery(db)
    .select<Array<{ status: string; overdue: boolean; count: string }>>([
      "approval_requests.status as status",
      db.raw(
        "(approval_requests.status = 'pending_review' AND approval_requests.expires_at < now()) as overdue",
      ),
      db.raw("count(*) as count"),
    ])
    .groupBy("approval_requests.status", "overdue");

  const counts = { pending: 0, overdue: 0, approved: 0, rejected: 0 };
  for (const row of tallies) {
    const n = Number(row.count);
    if (row.status === "approved") counts.approved += n;
    else if (row.status === "rejected") counts.rejected += n;
    else {
      counts.pending += n;
      if (row.overdue) counts.overdue += n;
    }
  }

  // Band tallies over the pending queue, unfiltered by whatever band the
  // operator is currently looking at — the point of the row is to say what is
  // waiting, and a count that changed when you filtered would answer a question
  // nobody asked.
  const bandRows = await queueQuery(db)
    .where("approval_requests.status", "pending_review")
    .select<Array<{ band: string | null; count: string }>>([
      db.raw(`${BAND_EXPR} as band`),
      db.raw("count(*) as count"),
    ])
    .groupByRaw(BAND_EXPR);

  const band_counts: Record<MatchBand | "unbanded", number> = {
    weak: 0,
    moderate: 0,
    strong: 0,
    unbanded: 0,
  };
  for (const row of bandRows) {
    const n = Number(row.count);
    if (isMatchBand(row.band)) band_counts[row.band] += n;
    else band_counts.unbanded += n;
  }

  return { data, total, policy, counts, match_policy: MATCH_POLICY, band_counts };
}

/** One queue item by the finding's id, or `null`. */
export async function getQueueItem(db: Knex, flagId: string): Promise<QueueItem | null> {
  await ensureApprovalRequests(db);
  const row = await queueQuery(db)
    .where("anomaly_flags.id", flagId)
    .select<JoinedRow[]>(QUEUE_COLUMNS)
    .first();
  if (row === undefined) return null;
  const citations = await resolveCitations(db, {
    id: text(row.flag_id),
    meeting_id: textOrNull(row.meeting_id),
    artifact_id: textOrNull(row.artifact_id),
    metadata: row.metadata,
  });
  return toQueueItem(row, citations, new Date(), await loadEntityDecisions(db));
}

/**
 * Record an operator's entity-resolution judgement from the queue.
 *
 * The pair is derived from the finding's own stored evidence rather than taken
 * from the request body: an operator judges what is on the card in front of
 * them, and letting a caller name an arbitrary pair would make the judgement
 * separable from the thing that prompted it.
 *
 * **This publishes nothing, in either direction.** `same_entity` annotates the
 * pair and leaves the finding exactly as held as it was; approval is still a
 * separate, explicit, reasoned act on the same screen. `different_entity` stops
 * the pair being raised on later sweeps and leaves *this* finding held too — an
 * operator who thinks it is a coincidence should still reject it, and say so,
 * so the log holds both facts.
 */
export async function decideEntityResolution(
  db: Knex,
  input: { flagId: string; decision: EntityDecision; reason: string; actor: ReviewActor },
): Promise<QueueItem> {
  const item = await getQueueItem(db, input.flagId);
  if (item === null) throw new ReviewError("No finding with that id", 404);
  if (item.evidence === null) {
    throw new ReviewError(
      "That finding carries no name match, so there is no pair of names to judge",
      409,
    );
  }
  const pair = pairForEvidence(item.evidence);
  if (pair === null) {
    throw new ReviewError(
      "That finding's stored match names no distinctive term, so there is no pair to judge",
      409,
    );
  }

  await recordEntityDecision(db, {
    pair,
    decision: input.decision,
    reason: input.reason,
    actor: input.actor,
  });

  const updated = await getQueueItem(db, input.flagId);
  if (updated === null) throw new ReviewError("No finding with that id", 404);
  return updated;
}

interface DecisionInput {
  flagId: string;
  reason: string;
  actor: ReviewActor;
}

interface LoadedForDecision {
  flag: Record<string, unknown>;
  request: Record<string, unknown>;
}

async function loadForDecision(
  trx: Knex.Transaction,
  flagId: string,
): Promise<LoadedForDecision> {
  const flag: unknown = await trx("anomaly_flags").where({ id: flagId }).forUpdate().first();
  if (!isRecord(flag)) throw new ReviewError("No finding with that id", 404);

  const request: unknown = await trx("approval_requests")
    .where({ anomaly_flag_id: flagId })
    .forUpdate()
    .first();
  if (!isRecord(request)) {
    throw new ReviewError(
      "That finding has no review request — it is not held, so there is nothing to decide",
      409,
    );
  }
  return { flag, request };
}

/**
 * The severity ladder `events` and `channel_routes` share, or null.
 *
 * `anomaly_flags.severity` is its own enum and the two happen to line up today.
 * Filtering rather than casting is what keeps a future value added to one and
 * not the other from becoming a CHECK violation that rolls back an operator's
 * approval.
 */
function asEventSeverity(value: unknown): EventSeverity | null {
  const found = EVENT_SEVERITIES.filter((severity) => severity === value);
  return found[0] ?? null;
}

/** The jurisdiction a finding belongs to, for routing. Null for a records-derived flag. */
async function findingJurisdictionId(
  trx: Knex.Transaction,
  meetingId: string | null,
): Promise<string | null> {
  if (meetingId === null) return null;
  const row = await trx("meetings")
    .join("commissions", "commissions.id", "meetings.commission_id")
    .where("meetings.id", meetingId)
    .first<{ jurisdiction_id: string | null } | undefined>(
      "commissions.jurisdiction_id as jurisdiction_id",
    );
  return row?.jurisdiction_id ?? null;
}

function requirePending(request: Record<string, unknown>): void {
  const status = asRequestStatus(request.status);
  if (status !== "pending_review") {
    throw new ReviewError(`That finding was already ${status}`, 409);
  }
}

function requireReason(reason: string): void {
  if (reason.trim() === "") {
    throw new ReviewError(
      "reason is required: a decision without one is not a decision anyone can review",
      400,
    );
  }
}

/**
 * Approval — the one thing that makes a finding public.
 *
 * Refuses a finding with no citation. That refusal is the sourcing invariant,
 * and it is here rather than in the console so it holds for any caller.
 */
export async function approveFinding(db: Knex, input: DecisionInput): Promise<QueueItem> {
  requireReason(input.reason);

  await ensureApprovalRequests(db);

  await db.transaction(async (trx) => {
    const { flag, request } = await loadForDecision(trx, input.flagId);
    requirePending(request);

    if (flag.review_state !== "held") {
      throw new ReviewError("That finding is not held, so there is nothing to approve", 409);
    }

    const citations = await resolveCitations(trx, {
      id: input.flagId,
      meeting_id: textOrNull(flag.meeting_id),
      artifact_id: textOrNull(flag.artifact_id),
      metadata: flag.metadata,
    });
    if (citations.length === 0) {
      throw new ReviewError(
        "That finding cites no stored artifact, so it cannot be approved. " +
          "No unsourced claim reaches the public site.",
        409,
      );
    }

    await appendCorrectionRow(trx, {
      targetTable: "anomaly_flags",
      targetId: input.flagId,
      field: "review_state",
      oldValue: "held",
      newValue: "published",
      reason: input.reason,
      actor: input.actor,
    });

    // No `updated_at`: anomaly_flags has never had one. See migration 011.
    await trx("anomaly_flags").where({ id: input.flagId }).update({ review_state: "published" });

    await trx("approval_requests")
      .where({ anomaly_flag_id: input.flagId })
      .update({
        status: "approved",
        reviewer_operator_id: input.actor.id,
        reviewer_email: input.actor.email,
        review_comment: input.reason,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

    // The event spine. Written inside this transaction on purpose: an event
    // committed while its approval rolled back would announce a finding no
    // reader can see.
    //
    // The guard is here rather than a weakening of `emitEvent`. Approving a
    // finding whose meeting is still unpublished is a legitimate act — the
    // queue decides the finding, not the meeting — but such a finding is not
    // public, and an emitter that refuses it is doing its job. What announces
    // it is the meeting publish path, when the meeting goes out. So: emit only
    // what a reader can already see, and let the wall stay a wall.
    if (await subjectIsPublic(trx, "finding", input.flagId)) {
      await emitEvent(trx, {
        event_type: "finding.published",
        subject_kind: "finding",
        subject_id: input.flagId,
        jurisdiction_id: await findingJurisdictionId(trx, textOrNull(flag.meeting_id)),
        severity: asEventSeverity(flag.severity),
        payload: {
          title: text(flag.flag_type),
          description: text(flag.description),
          finding_id: input.flagId,
          meeting_id: textOrNull(flag.meeting_id),
        },
      });
    }
  });

  const item = await getQueueItem(db, input.flagId);
  if (item === null) throw new ReviewError("No finding with that id", 404);
  return item;
}

/**
 * Rejection. The finding stays `held` — see the header, rule 2.
 *
 * The audit row's field is `review_decision` rather than `review_state`,
 * because no column changed and claiming one did would make the log describe a
 * write that never happened.
 */
export async function rejectFinding(db: Knex, input: DecisionInput): Promise<QueueItem> {
  requireReason(input.reason);

  await ensureApprovalRequests(db);

  await db.transaction(async (trx) => {
    const { request } = await loadForDecision(trx, input.flagId);
    requirePending(request);

    await appendCorrectionRow(trx, {
      targetTable: "anomaly_flags",
      targetId: input.flagId,
      field: "review_decision",
      oldValue: "pending_review",
      newValue: "rejected",
      reason: input.reason,
      actor: input.actor,
    });

    await trx("approval_requests")
      .where({ anomaly_flag_id: input.flagId })
      .update({
        status: "rejected",
        reviewer_operator_id: input.actor.id,
        reviewer_email: input.actor.email,
        review_comment: input.reason,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
  });

  const item = await getQueueItem(db, input.flagId);
  if (item === null) throw new ReviewError("No finding with that id", 404);
  return item;
}

/** What an operator may rewrite before approving. Not identity, not evidence. */
export const EDITABLE_FINDING_FIELDS = ["description", "severity"] as const;

export type EditableFindingField = (typeof EDITABLE_FINDING_FIELDS)[number];

export interface EditInput extends DecisionInput {
  field: string;
  newValue: string;
}

/**
 * Edit-with-reason, while the finding is still held.
 *
 * Only two fields. `metadata` is the evidence the detector recorded and is not
 * an operator's to rewrite; `meeting_id`, `artifact_id` and `flag_type` are
 * identity. Editing after approval is deliberately not offered here — a
 * published finding is a public record, and correcting one is the corrections
 * path, not the queue.
 */
export async function editFinding(db: Knex, input: EditInput): Promise<QueueItem> {
  requireReason(input.reason);

  if (!(EDITABLE_FINDING_FIELDS as readonly string[]).includes(input.field)) {
    throw new ReviewError(
      `${input.field} is not editable; editable fields are ${EDITABLE_FINDING_FIELDS.join(", ")}`,
      400,
    );
  }
  if (input.field === "severity" && !isSeverity(input.newValue)) {
    throw new ReviewError("severity must be one of low, medium, high, critical", 400);
  }
  if (input.field === "description") {
    if (input.newValue.trim() === "") {
      throw new ReviewError("description cannot be emptied", 400);
    }
    const terms = motiveTerms(input.newValue);
    if (terms.length > 0) {
      throw new ReviewError(
        `A finding describes the record, never the motive. Remove: ${terms.join(", ")}`,
        400,
      );
    }
  }

  await ensureApprovalRequests(db);

  await db.transaction(async (trx) => {
    const { flag, request } = await loadForDecision(trx, input.flagId);
    requirePending(request);
    if (flag.review_state !== "held") {
      throw new ReviewError("That finding is not held, so the queue cannot edit it", 409);
    }

    await appendCorrectionRow(trx, {
      targetTable: "anomaly_flags",
      targetId: input.flagId,
      field: input.field,
      oldValue: textOrNull(flag[input.field]),
      newValue: input.newValue,
      reason: input.reason,
      actor: input.actor,
    });

    await trx("anomaly_flags")
      .where({ id: input.flagId })
      .update({ [input.field]: input.newValue });

    // The request's severity is a fact about why it was queued and is left
    // alone, so an operator downgrading a finding cannot rewrite the threshold
    // that held it.
  });

  const item = await getQueueItem(db, input.flagId);
  if (item === null) throw new ReviewError("No finding with that id", 404);
  return item;
}
