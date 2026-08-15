import type { Knex } from "knex";
import type { EventPayload } from "../delivery/dispatcher";
import { findPublicFinding, findPublishedMeeting, whereClaimPublic } from "../publication";

/**
 * The one emitter, and the one place the publication wall is asserted for
 * anything that leaves this system.
 *
 * **The invariant: `emitEvent` refuses to write an event whose subject is not
 * public, and the refusal is a thrown error, not a silent skip.**
 *
 * The check is not "the caller promises". It is a re-read of the subject
 * through the *existing* helpers in `services/publication.ts`, inside the
 * caller's transaction, immediately before the insert. That deliberately
 * re-runs the query the caller has just satisfied, and the redundancy is the
 * entire point: the wall is asserted by code with no other job, so a caller who
 * forgets — or a caller written in six months by someone who has not read
 * `publication.ts` — cannot produce a public event. It costs one indexed
 * primary-key lookup per publish, and publishes are rare.
 *
 * Three kinds of subject sit outside that rule, and all three are a *different*
 * check rather than an exemption from checking:
 *
 *  - **`ops`.** A sweep failing or a source going stale is a fact about the
 *    machinery, not about a record, so there is no publication state to read.
 *    Ops events must never reach a public consumer, and that is enforced on the
 *    consumer side by `whereEventPublic` in `./index.ts` — asserted by a test,
 *    not left to convention.
 *  - **`*.retracted`.** A retraction exists precisely to announce that
 *    something is no longer public, so the publication check is inverted: the
 *    subject is *required* to be non-public. Emitting a retraction for a
 *    still-public subject would tell readers a falsehood, so it throws.
 *  - **`dispute`.** The inverse again, and for a stronger reason than a
 *    retraction's. Migration 039's CHECK permits exactly one `review_state`, so
 *    a dispute is *never* public and an event that required its subject to be
 *    public could never be written at all. The check that replaces it is not
 *    "skip it": the dispute must exist, and it must still be non-public. A
 *    dispute event announces a reply owed to one person, never a record, and
 *    `resolveRoutes` refuses to hand it to anything but a `direct` channel.
 *
 * `emitEvent` takes `Knex | Knex.Transaction` and callers **must** pass the
 * transaction that performed the publish. An event committed while its publish
 * rolled back announces something that did not happen.
 */

/** Anything a knex query or transaction can run against. */
export type EventExecutor = Knex | Knex.Transaction;

export const EVENT_SUBJECT_KINDS = [
  "meeting",
  "finding",
  "claim",
  "document",
  "ops",
  "dispute",
] as const;

export type EventSubjectKind = (typeof EVENT_SUBJECT_KINDS)[number];

/** Subject kinds that name a record, and therefore have a publication state. */
export type RecordSubjectKind = Exclude<EventSubjectKind, "ops">;

/**
 * Subject kinds a public consumer may be served.
 *
 * `ops` is about the machinery and `dispute` is a private communication from a
 * member of the public. Neither has ever been published and neither may be.
 * `whereEventPublic` in `./index.ts` is where that is enforced; this type is so
 * a consumer cannot even name the kinds it must not show.
 */
export type PublicSubjectKind = Exclude<EventSubjectKind, "ops" | "dispute">;

export const EVENT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** The suffix that turns the publication check into its inverse. */
export const RETRACTION_SUFFIX = ".retracted";

export interface EventInput {
  /** `{subject}.{past-tense verb}`, e.g. `finding.published`. */
  event_type: string;
  subject_kind: EventSubjectKind;
  /** Required for every kind but `ops`, which the table's CHECK also enforces. */
  subject_id?: string | null;
  jurisdiction_id?: string | null;
  severity?: EventSeverity | null;
  payload?: EventPayload;
  /**
   * Overrides the default `{event_type}:{subject_kind}:{subject_id}`.
   *
   * An event that legitimately recurs for one subject — a sweep completing —
   * supplies a discriminator here, because the default key is what makes a
   * state change idempotent by construction.
   */
  dedupe_key?: string;
  occurred_at?: Date;
}

export interface EmitResult {
  id: string;
  dedupe_key: string;
  /**
   * False when an event with this dedupe key already existed. The same publish
   * run twice yields one row, and the second caller learns that rather than
   * being told it succeeded in writing something it did not write.
   */
  created: boolean;
}

/**
 * The wall's refusal. Distinct from a malformed-input error so a caller can
 * tell "I asked for something forbidden" from "I asked for something
 * nonsensical", and so the review queue can leave the difference in a log.
 */
export class EventPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPublicationError";
  }
}

/** A caller-side mistake: no subject id, no dedupe key, an unknown kind. */
export class EventInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetraction(eventType: string): boolean {
  return eventType.endsWith(RETRACTION_SUFFIX);
}

// ---------------------------------------------------------------------------
// The four publication checks
// ---------------------------------------------------------------------------
//
// Four different queries, because they are four different questions. `meeting`,
// `finding` and `claim` reach for the helpers `publication.ts` already exports
// rather than restating them; `document` has no helper there yet and is written
// out below, joined to the same `meetings.published_at` rule.

/**
 * This was a hand-written predicate until it went wrong in the predictable way.
 *
 * It checked `status = 'approved'` and a published meeting — correct when it was
 * written, and incomplete the moment migration 087 added `retracted_at`. A claim
 * withdrawn *after* its event was written still satisfied the copy here, so the
 * emitter would have announced a retracted sentence about a named person. The
 * feed caught it because the feed used `whereClaimPublic` and this did not.
 *
 * That is the exact failure `publication.ts`'s header warns about: a rule
 * re-typed in a second place is a rule that will be one clause out of date after
 * the next migration. The helper is now the only definition, so a third clause
 * added there reaches this automatically.
 */
async function claimIsPublic(db: EventExecutor, subjectId: string): Promise<boolean> {
  const query = db("minute_claims").where("minute_claims.id", subjectId);
  const row: unknown = await whereClaimPublic(db, query).first("minute_claims.id");
  return isRecord(row);
}

/**
 * `meeting_documents.meeting_id` is NOT NULL (migration 005), so a document
 * without a meeting cannot exist and the "orphan document with a public
 * artifact" branch the design contemplated has nothing to match. If such a
 * document ever becomes possible, this is the function that must grow the
 * second branch — not each consumer.
 */
async function documentIsPublic(db: EventExecutor, subjectId: string): Promise<boolean> {
  const row: unknown = await db("meeting_documents")
    .join("meetings", "meetings.id", "meeting_documents.meeting_id")
    .where("meeting_documents.id", subjectId)
    .whereNotNull("meetings.published_at")
    .first("meeting_documents.id");
  return isRecord(row);
}

/**
 * Where a dispute stands, in the three states the emitter has to tell apart.
 *
 * A boolean would collapse "there is no such dispute" into "it is not public",
 * and for an inverted check those are opposite answers: the first must throw,
 * the second is the only case that may proceed. `record_disputes.review_state`
 * has one legal value today (migration 039), so `public` is unreachable — and it
 * is queried rather than assumed, because the day somebody widens that CHECK is
 * the day this must start refusing.
 */
export type DisputePublicationState = "missing" | "held" | "public";

export async function disputePublicationState(
  db: EventExecutor,
  subjectId: string,
): Promise<DisputePublicationState> {
  const row: unknown = await db("record_disputes").where({ id: subjectId }).first("review_state");
  if (!isRecord(row)) return "missing";
  return row.review_state === "held" ? "held" : "public";
}

/**
 * Is this subject visible to the public *right now*?
 *
 * Exported because the retraction path and the review queue both need to ask
 * the same question the emitter asks, and a second phrasing of it would be a
 * second thing that can disagree about what "public" means.
 */
export async function subjectIsPublic(
  db: EventExecutor,
  subjectKind: RecordSubjectKind,
  subjectId: string,
): Promise<boolean> {
  switch (subjectKind) {
    case "meeting":
      return (await findPublishedMeeting(db, subjectId)) !== undefined;
    case "finding":
      return (await findPublicFinding(db, subjectId)) !== undefined;
    case "claim":
      return claimIsPublic(db, subjectId);
    case "document":
      return documentIsPublic(db, subjectId);
    case "dispute":
      return (await disputePublicationState(db, subjectId)) === "public";
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * The default key, and the reason a double-clicked publish is one event.
 *
 * There is deliberately no default for an `ops` event: it has no subject id to
 * key on, and a key of "the event type alone" would mean the second sweep
 * failure in the product's life is silently swallowed as a duplicate of the
 * first. Ops callers name their own discriminator.
 */
export function defaultEventDedupeKey(input: EventInput): string {
  if (input.subject_id === undefined || input.subject_id === null) {
    throw new EventInputError(
      `${input.event_type}: an event with no subject_id must supply its own dedupe_key, ` +
        `otherwise every later occurrence collapses into the first`,
    );
  }
  return `${input.event_type}:${input.subject_kind}:${input.subject_id}`;
}

function requireSubjectId(input: EventInput): string {
  const subjectId = input.subject_id;
  if (typeof subjectId !== "string" || subjectId === "") {
    throw new EventInputError(
      `${input.event_type}: subject_kind '${input.subject_kind}' requires a subject_id`,
    );
  }
  return subjectId;
}

/**
 * Writes one event, after asserting the subject may be announced.
 *
 * Pass the transaction that performed the publish. Passing the bare `db`
 * connection is permitted only where there is no publish to join — an ops
 * event, in practice.
 */
export async function emitEvent(db: EventExecutor, input: EventInput): Promise<EmitResult> {
  if (!(EVENT_SUBJECT_KINDS as readonly string[]).includes(input.subject_kind)) {
    throw new EventInputError(`unknown subject_kind '${input.subject_kind}'`);
  }

  if (input.subject_kind === "dispute") {
    const subjectId = requireSubjectId(input);
    const state = await disputePublicationState(db, subjectId);
    if (state === "missing") {
      throw new EventPublicationError(
        `refusing to emit ${input.event_type} for dispute ${subjectId}: there is no such dispute. ` +
          `A reply is owed to a person who wrote to us, so the row they wrote must exist first.`,
      );
    }
    if (state === "public") {
      throw new EventPublicationError(
        `refusing to emit ${input.event_type} for dispute ${subjectId}: its review_state is no ` +
          `longer 'held'. Migration 039 permits one value; a dispute that reads as public is a ` +
          `schema change nobody told this emitter about.`,
      );
    }
  } else if (input.subject_kind !== "ops") {
    const subjectId = requireSubjectId(input);
    const isPublic = await subjectIsPublic(db, input.subject_kind, subjectId);

    if (isRetraction(input.event_type)) {
      if (isPublic) {
        throw new EventPublicationError(
          `refusing to emit ${input.event_type} for ${input.subject_kind} ${subjectId}: ` +
            `it is still public, so a retraction would tell readers something untrue`,
        );
      }
    } else if (!isPublic) {
      throw new EventPublicationError(
        `refusing to emit ${input.event_type} for ${input.subject_kind} ${subjectId}: ` +
          `it is not public. Events are only written for objects a reader may already see.`,
      );
    }
  }

  const dedupeKey = input.dedupe_key ?? defaultEventDedupeKey(input);

  const inserted = await db("events")
    .insert({
      event_type: input.event_type,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id ?? null,
      jurisdiction_id: input.jurisdiction_id ?? null,
      severity: input.severity ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      dedupe_key: dedupeKey,
      occurred_at: input.occurred_at ?? db.fn.now(),
    })
    .onConflict("dedupe_key")
    .ignore()
    .returning<Array<{ id: string }>>("id");

  if (inserted.length > 0) {
    return { id: inserted[0].id, dedupe_key: dedupeKey, created: true };
  }

  // The key was taken. That is the idempotency working, not a failure — but the
  // caller still gets the id of the event that already says this.
  const existing = await db("events")
    .where({ dedupe_key: dedupeKey })
    .first<{ id: string } | undefined>("id");
  if (existing === undefined) {
    throw new Error(`events: dedupe key '${dedupeKey}' conflicted but no row holds it`);
  }
  return { id: existing.id, dedupe_key: dedupeKey, created: false };
}

// ---------------------------------------------------------------------------
// Unpublication
// ---------------------------------------------------------------------------

export interface RetractionInput {
  subject_kind: RecordSubjectKind;
  subject_id: string;
  /** Recorded on every revoked row. A revocation nobody explained is not one. */
  reason: string;
  jurisdiction_id?: string | null;
  severity?: EventSeverity | null;
}

export interface RetractionResult {
  /** Every event marked revoked by this call. */
  revoked: string[];
  /** Of those, the ones that never left — a real recall. */
  recalled: string[];
  /** Of those, the ones already handed to the dispatcher and therefore gone. */
  dispatched: string[];
  /** The `{subject}.retracted` event, written only when something had gone out. */
  retraction: EmitResult | null;
}

/**
 * Unpublication after emit, and the honest split it forces.
 *
 * *An event that has been dispatched cannot be recalled.* A Discord post is
 * gone; an RSS item is in a reader's cache. So there are two mechanisms and the
 * result reports which one applied:
 *
 *  - **Not yet dispatched.** `revoked_at` is set, the partial index drops the
 *    row, and it never sends. That is a real recall, and it is the common case,
 *    because the drain tick is seconds and a mistaken publish is usually caught
 *    in minutes.
 *  - **Already dispatched.** `revoked_at` is still set — the ledger must record
 *    that what was announced is no longer true — and a **new**
 *    `{subject}.retracted` event is emitted carrying the original ids.
 *    Consumers that can act on it do; consumers that cannot, cannot, and this
 *    comment says so rather than implying a guarantee.
 *
 * Call this *after* the unpublish, in the same transaction: `emitEvent` will
 * refuse the retraction while the subject is still public.
 */
export async function retractSubject(
  db: EventExecutor,
  input: RetractionInput,
): Promise<RetractionResult> {
  if (input.reason.trim() === "") {
    throw new EventInputError("retractSubject: a reason is required");
  }

  const live = await db("events")
    .where({ subject_kind: input.subject_kind, subject_id: input.subject_id })
    .whereNull("revoked_at")
    .orderBy([{ column: "occurred_at", order: "asc" }, { column: "id", order: "asc" }])
    .select<Array<{ id: string; dispatched_at: Date | null }>>("id", "dispatched_at");

  const revoked = live.map((row) => row.id);
  const recalled = live.filter((row) => row.dispatched_at === null).map((row) => row.id);
  const dispatched = live.filter((row) => row.dispatched_at !== null).map((row) => row.id);

  if (revoked.length > 0) {
    await db("events")
      .whereIn("id", revoked)
      .update({
        revoked_at: db.fn.now(),
        revoked_reason: input.reason,
        updated_at: db.fn.now(),
      });
  }

  if (dispatched.length === 0) {
    return { revoked, recalled, dispatched, retraction: null };
  }

  // Keyed on the first event that got out, so a subject published, retracted,
  // republished and retracted again produces two retractions rather than one
  // swallowed by the dedupe index.
  const retraction = await emitEvent(db, {
    event_type: `${input.subject_kind}${RETRACTION_SUFFIX}`,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    jurisdiction_id: input.jurisdiction_id ?? null,
    severity: input.severity ?? null,
    payload: { reason: input.reason, retracted_event_ids: dispatched },
    dedupe_key: `${input.subject_kind}${RETRACTION_SUFFIX}:${input.subject_id}:${dispatched[0]}`,
  });

  return { revoked, recalled, dispatched, retraction };
}
