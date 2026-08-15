import type { Knex } from "knex";
import type { EventSubjectKind } from "./emit";

export {
  emitEvent,
  retractSubject,
  subjectIsPublic,
  defaultEventDedupeKey,
  EventInputError,
  EventPublicationError,
  EVENT_SEVERITIES,
  EVENT_SUBJECT_KINDS,
  RETRACTION_SUFFIX,
  type EmitResult,
  type EventExecutor,
  type EventInput,
  type EventSeverity,
  type EventSubjectKind,
  type RecordSubjectKind,
  type RetractionInput,
  type RetractionResult,
} from "./emit";

export {
  EventDrain,
  eventDrainEnabled,
  parseClaimedEvent,
  toDeliveryEvent,
  DEFAULT_DRAIN_BATCH_SIZE,
  DEFAULT_DRAIN_INTERVAL_MS,
  type ClaimedEvent,
  type DrainLogger,
  type DrainTickResult,
  type EventDispatcherLike,
  type EventDrainOptions,
} from "./drain";

/**
 * The consumer half of the wall.
 *
 * `emitEvent` guarantees that a `meeting`, `finding`, `claim` or `document`
 * event exists only for something already public, which is what lets a consumer
 * read `events` instead of re-deriving `publication.ts`'s two-part condition.
 * Two things that guarantee does *not* cover, and both live here:
 *
 *  - **`ops` events.** A failed sweep or a stale source is a fact about the
 *    machinery. It has no publication state, so it was never checked against
 *    one, and it must never reach a reader. Anything serving the public web
 *    filters `subject_kind <> 'ops'` — through this function, not by retyping
 *    the predicate, which is the mistake the whole spine exists to stop.
 *  - **Revoked events.** An operator who unpublished a record has said the
 *    announcement is no longer true. A public reader must not still be served it.
 *
 * Deliberately *not* a database view: the operator console reads the same table
 * and must see ops events and revocations, because that is its job.
 */
export function whereEventPublic<T extends Knex.QueryBuilder>(query: T, table = "events"): T {
  query.whereNot(`${table}.subject_kind`, "ops").whereNull(`${table}.revoked_at`);
  return query;
}

export interface PublicEventRow {
  id: string;
  event_type: string;
  subject_kind: Exclude<EventSubjectKind, "ops">;
  subject_id: string;
  jurisdiction_id: string | null;
  severity: string | null;
  occurred_at: Date;
}

export interface PublicEventFilters {
  jurisdiction_id?: string;
  subject_kind?: Exclude<EventSubjectKind, "ops">;
  limit?: number;
}

/**
 * The events a public consumer may read, newest first.
 *
 * There is no `/api/events` route and this spec does not add one — the event
 * log carries ops rows and revocation reasons, and exposing it wholesale is a
 * separate decision with its own wall. This is the query a feed, a receipt or a
 * prerender will be built on when one exists.
 */
export async function listPublicEvents(
  db: Knex,
  filters: PublicEventFilters = {},
): Promise<PublicEventRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const query = db("events")
    .orderBy([{ column: "occurred_at", order: "desc" }, { column: "id", order: "desc" }])
    .limit(limit)
    .select<PublicEventRow[]>(
      "id",
      "event_type",
      "subject_kind",
      "subject_id",
      "jurisdiction_id",
      "severity",
      "occurred_at",
    );

  if (filters.jurisdiction_id !== undefined) {
    query.where("events.jurisdiction_id", filters.jurisdiction_id);
  }
  if (filters.subject_kind !== undefined) {
    query.where("events.subject_kind", filters.subject_kind);
  }

  return whereEventPublic(query);
}
