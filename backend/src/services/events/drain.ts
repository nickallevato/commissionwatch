import type { Knex } from "knex";
import type {
  DeliveryEvent,
  DispatchResult,
  EventPayload,
  JsonValue,
} from "../delivery/dispatcher";
import type { EventExecutor, EventSubjectKind } from "./emit";

/**
 * The thing that finally feeds `DeliveryDispatcher`.
 *
 * `dispatcher.ts` is 643 lines of durable, batching, retrying, consent-gating
 * delivery machinery, and until this file existed the only callers of its
 * constructor were `src/scripts/emit-ops-event.ts` and two test files. The
 * server never built one. The product had a delivery system and no way to
 * deliver.
 *
 * The claim is `FOR UPDATE SKIP LOCKED` against the partial index migration 083
 * creates — the same idiom `services/ingestion/queue.ts` uses, for the same
 * reason: two server processes polling the same table must partition it rather
 * than collide on it, with no Redis and no new dependency.
 *
 * **Dispatch first, then set `dispatched_at`. In that order.** If the process
 * dies between the two, the event is re-dispatched on the next tick and
 * `deliveries`' existing `(channel_id, dedupe_key)` unique index absorbs it as
 * a duplicate. The other order loses events silently. Prefer the failure mode
 * the schema already defends against.
 *
 * The claim and the mark share one transaction, which is what keeps that true
 * across a crash: nothing commits until the batch is through, so a half-done
 * tick leaves every row of it claimable again. `dispatcher.dispatch` writes
 * `deliveries` rows and arms a timer — it does no network I/O — so holding the
 * transaction across it costs nothing worth avoiding.
 */

/** Just enough of `DeliveryDispatcher` to drive it, so tests can stand in. */
export interface EventDispatcherLike {
  dispatch(event: DeliveryEvent): Promise<DispatchResult>;
}

export interface DrainLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface EventDrainOptions {
  dispatcher: EventDispatcherLike;
  /** Events claimed per tick. Default 50. */
  batchSize?: number;
  /** Polling interval once started. Default 5s. */
  intervalMs?: number;
  /** Overrides the `EVENT_DRAIN_ENABLED` decision. */
  enabled?: boolean;
  logger?: DrainLogger;
}

export interface DrainTickResult {
  claimed: number;
  dispatched: number;
  /** Claimed but left undispatched because the dispatcher threw. Retried next tick. */
  failed: number;
}

export interface ClaimedEvent {
  id: string;
  event_type: string;
  subject_kind: EventSubjectKind;
  subject_id: string | null;
  jurisdiction_id: string | null;
  severity: string | null;
  payload: EventPayload;
  dedupe_key: string;
  occurred_at: Date;
}

export const DEFAULT_DRAIN_BATCH_SIZE = 50;
export const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

/**
 * `EVENT_DRAIN_ENABLED`, defaulting to **off**.
 *
 * Off by default so the spine ships and runs in production dark before any
 * channel is routed. A dark drain over an empty routes table sends nothing and
 * still proves the loop — which is the only way to find out the loop is wrong
 * without a reader finding out first.
 */
export function eventDrainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EVENT_DRAIN_ENABLED;
  if (raw === undefined || raw.trim() === "") return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * The claim. Ordered `occurred_at, id` so a subject's events are dispatched in
 * the order they were written — global ordering is not guaranteed and no
 * consumer may assume it, but a retraction following its publication is, and
 * that is the only ordering any contemplated consumer needs.
 */
const CLAIM_SQL = `
  SELECT id
  FROM events
  WHERE dispatched_at IS NULL AND revoked_at IS NULL
  ORDER BY occurred_at ASC, id ASC
  LIMIT ?
  FOR UPDATE SKIP LOCKED
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`events.${field}: expected string`);
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asSubjectKind(value: unknown): EventSubjectKind {
  // The table's CHECK is the authority; this narrows the row without asserting.
  switch (value) {
    case "meeting":
    case "finding":
    case "claim":
    case "document":
    case "ops":
    case "dispute":
      return value;
    default:
      throw new TypeError(`events.subject_kind: unknown kind ${String(value)}`);
  }
}

function asDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new TypeError(`events.${field}: expected timestamp`);
}

/**
 * Narrows a value the driver handed back into the dispatcher's `JsonValue`.
 *
 * `undefined` means "not representable in JSON", and such a key is dropped
 * rather than asserted into place. The column is `jsonb`, so in practice
 * nothing is dropped — but a payload the dispatcher may have to re-serialise on
 * retry is worth checking rather than promising.
 */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const converted = toJsonValue(item);
      if (converted !== undefined) items.push(converted);
    }
    return items;
  }
  if (isRecord(value)) {
    const object: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = toJsonValue(entry);
      if (converted !== undefined) object[key] = converted;
    }
    return object;
  }
  return undefined;
}

/**
 * `payload` is `jsonb NOT NULL DEFAULT '{}'`, so a row always has an object
 * here. A row that somehow does not gets an empty payload rather than a crashed
 * drain — the announcement still goes out, carrying nothing it cannot vouch for.
 */
function asPayload(value: unknown): EventPayload {
  if (!isRecord(value)) return {};
  const payload: EventPayload = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = toJsonValue(entry);
    if (converted !== undefined) payload[key] = converted;
  }
  return payload;
}

export function parseClaimedEvent(raw: unknown): ClaimedEvent {
  if (!isRecord(raw)) throw new TypeError("events: expected a row object");
  return {
    id: asString(raw.id, "id"),
    event_type: asString(raw.event_type, "event_type"),
    subject_kind: asSubjectKind(raw.subject_kind),
    subject_id: asNullableString(raw.subject_id, "subject_id"),
    jurisdiction_id: asNullableString(raw.jurisdiction_id, "jurisdiction_id"),
    severity: asNullableString(raw.severity, "severity"),
    payload: asPayload(raw.payload),
    dedupe_key: asString(raw.dedupe_key, "dedupe_key"),
    occurred_at: asDate(raw.occurred_at, "occurred_at"),
  };
}

/**
 * The `deliveries` view of an event.
 *
 * `dedupe_key` is carried across unchanged, which is what makes a re-dispatch
 * after a crash a no-op at the `(channel_id, dedupe_key)` index rather than a
 * second notification. The subject is folded into the payload so a consumer can
 * reach the record without the dispatcher needing to know what a meeting is.
 */
export function toDeliveryEvent(event: ClaimedEvent): DeliveryEvent {
  return {
    event_type: event.event_type,
    payload: {
      ...event.payload,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      event_id: event.id,
    },
    severity: event.severity,
    jurisdiction_id: event.jurisdiction_id,
    dedupe_key: event.dedupe_key,
    occurred_at: event.occurred_at.toISOString(),
  };
}

const consoleLogger: DrainLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

export class EventDrain {
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly enabled: boolean;

  private readonly dispatcher: EventDispatcherLike;
  private readonly logger: DrainLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Knex,
    options: EventDrainOptions,
  ) {
    this.dispatcher = options.dispatcher;
    this.batchSize = options.batchSize ?? DEFAULT_DRAIN_BATCH_SIZE;
    this.intervalMs = options.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.enabled = options.enabled ?? eventDrainEnabled();
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * Claims up to `limit` undispatched events and holds the lock for the life of
   * `executor`'s transaction.
   *
   * Public because the crash-between-dispatch-and-mark path has no other way to
   * be tested: the whole property is what happens when the two steps are run
   * separately and the second one never arrives.
   */
  async claimBatch(executor: EventExecutor, limit: number): Promise<ClaimedEvent[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("claimBatch limit must be a positive integer");
    }

    const selected = await executor.raw(CLAIM_SQL, [limit]);
    const rows: unknown[] = Array.isArray(selected?.rows) ? selected.rows : [];
    if (rows.length === 0) return [];

    const ids = rows.map((row) => {
      if (!isRecord(row)) throw new TypeError("claimBatch: expected a row object");
      return asString(row.id, "id");
    });

    const loaded = await executor("events").whereIn("id", ids).select<unknown[]>("*");
    const byId = new Map<string, ClaimedEvent>();
    for (const row of loaded) {
      const event = parseClaimedEvent(row);
      byId.set(event.id, event);
    }

    // The SELECT established the order; a plain `whereIn` has none.
    const claimed: ClaimedEvent[] = [];
    for (const id of ids) {
      const event = byId.get(id);
      if (event) claimed.push(event);
    }
    return claimed;
  }

  /** Records that these events were handed over. Never that they arrived. */
  async markDispatched(ids: string[], executor: EventExecutor): Promise<number> {
    if (ids.length === 0) return 0;
    return executor("events")
      .whereIn("id", ids)
      .whereNull("dispatched_at")
      .update({ dispatched_at: executor.fn.now(), updated_at: executor.fn.now() });
  }

  /**
   * One pass: claim, dispatch, mark. Safe to call directly, and the scheduler
   * calls nothing else.
   *
   * A dispatcher that throws leaves its event unmarked and the tick continues,
   * so one bad event does not hold up the batch behind it and does not get
   * silently dropped either — it is retried, and the reason is logged.
   */
  async tick(): Promise<DrainTickResult> {
    return this.db.transaction(async (trx) => {
      const claimed = await this.claimBatch(trx, this.batchSize);
      const sent: string[] = [];
      let failed = 0;

      for (const event of claimed) {
        try {
          await this.dispatcher.dispatch(toDeliveryEvent(event));
          sent.push(event.id);
        } catch (error) {
          failed++;
          this.logger.error(
            `EventDrain: dispatch failed for ${event.event_type} (${event.id}); ` +
              `left undispatched for the next tick`,
            error,
          );
        }
      }

      await this.markDispatched(sent, trx);
      return { claimed: claimed.length, dispatched: sent.length, failed };
    });
  }

  /** Arms the poll. A disabled drain arms nothing and says so once. */
  start(): void {
    if (!this.enabled) {
      this.logger.warn("EventDrain: disabled (EVENT_DRAIN_ENABLED is not set); nothing will send");
      return;
    }
    if (this.timer !== null) return;

    const timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((error: unknown) => {
          this.logger.error("EventDrain: tick failed", error);
        })
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
