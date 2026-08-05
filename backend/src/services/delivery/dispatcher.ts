import { createHash } from "node:crypto";
import type { Knex } from "knex";
import {
  decryptChannelConfig,
  resolveRoutes,
  type ChannelType,
  type ResolvedRoute,
} from "./channels";
import {
  backoffMs,
  DiscordClient,
  DiscordPostError,
  DISCORD_LIMITS,
  type DiscordEmbed,
  type DiscordMessage,
} from "./discord";

/**
 * The dispatcher turns an event into durable `deliveries` rows, then sends
 * them.
 *
 * Two properties matter more than anything else here:
 *
 * - **Durability.** A row is written before a request is made, so a failed post
 *   is something you can query, not a lost log line. Retries carry backoff and
 *   an attempt count.
 * - **Batching.** A bulk ingestion can flag forty anomalies in one sweep.
 *   Same-type events inside a short window collapse into one message of up to
 *   ten embeds plus an overflow count, so the sweep pages you once.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EventPayload = Record<string, JsonValue>;

export interface DeliveryEvent {
  event_type: string;
  payload: EventPayload;
  severity?: string | null;
  jurisdiction_id?: string | null;
  /** Stable identity of the event. Defaults to a hash of type + payload. */
  dedupe_key?: string;
  occurred_at?: string;
}

/** What we persist in `deliveries.payload`, and rebuild embeds from on retry. */
export interface StoredPayload {
  severity: string | null;
  jurisdiction_id: string | null;
  occurred_at: string;
  data: EventPayload;
}

export interface DeliveryRow {
  id: string;
  channel_id: string;
  event_type: string;
  payload: StoredPayload;
  dedupe_key: string;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
}

export interface DispatchResult {
  /** deliveries rows created by this call. */
  queued: string[];
  /** Routes that matched but whose (channel, dedupe_key) row already existed. */
  duplicates: number;
  /** Distinct channels the event was routed to. */
  channels: number;
}

export interface FlushResult {
  channel_id: string;
  channel_type: ChannelType;
  event_type: string;
  delivery_ids: string[];
  embeds: number;
  overflow: number;
  status: "sent" | "failed" | "retrying" | "skipped";
  error?: string;
}

export interface DispatcherOptions {
  discord?: DiscordClient;
  /** Window that same-type events collapse into one message. */
  batchWindowMs?: number;
  /** When false, nothing sends until flushAll() is called. Used by tests. */
  autoFlush?: boolean;
  /** Attempts before a delivery is marked failed for good. */
  maxAttempts?: number;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
}

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xdc2626,
  high: 0xea580c,
  medium: 0xd97706,
  low: 0x2563eb,
  info: 0x6b7280,
};

const RESERVED_PAYLOAD_KEYS = new Set(["title", "description", "summary", "link", "url"]);

/** Deterministic JSON so the default dedupe key does not depend on key order. */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function defaultDedupeKey(event: DeliveryEvent): string {
  const digest = createHash("sha256").update(stableStringify(event.payload)).digest("hex").slice(0, 32);
  return `${event.event_type}:${digest}`;
}

export function humanizeEventType(eventType: string): string {
  return eventType.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function scalarToString(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One event → one embed. Truncation to Discord's limits happens in the client. */
export function buildEmbed(eventType: string, stored: StoredPayload): DiscordEmbed {
  const data = stored.data;
  const severity = (stored.severity ?? "info").toLowerCase();

  const embed: DiscordEmbed = {
    title: asString(data.title) ?? humanizeEventType(eventType),
    color: SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info,
  };

  const description = asString(data.description) ?? asString(data.summary);
  if (description) embed.description = description;

  const link = asString(data.link) ?? asString(data.url);
  if (link && /^https?:\/\//i.test(link)) embed.url = link;

  const fields = Object.entries(data)
    .filter(([key, value]) => !RESERVED_PAYLOAD_KEYS.has(key) && value !== undefined)
    .slice(0, DISCORD_LIMITS.fieldsPerEmbed)
    .map(([key, value]) => ({
      name: humanizeEventType(key),
      value: scalarToString(value),
      inline: true,
    }));
  if (fields.length > 0) embed.fields = fields;

  if (stored.severity) {
    embed.footer = { text: `severity: ${severity}` };
  }
  embed.timestamp = stored.occurred_at;

  return embed;
}

/** Build the single message that represents a batch of same-type deliveries. */
export function buildBatchMessage(eventType: string, rows: Array<Pick<DeliveryRow, "payload">>): {
  message: DiscordMessage;
  overflow: number;
} {
  const shown = rows.slice(0, DISCORD_LIMITS.embedsPerMessage);
  const overflow = rows.length - shown.length;
  const embeds = shown.map((row) => buildEmbed(eventType, row.payload));

  const message: DiscordMessage = { embeds };
  const label = humanizeEventType(eventType);

  if (overflow > 0) {
    message.content =
      `**${label}** — ${rows.length} events in this batch; ` +
      `showing ${shown.length}, +${overflow} more not shown`;
  } else if (rows.length > 1) {
    message.content = `**${label}** — ${rows.length} events in this batch`;
  }

  return { message, overflow };
}

interface BatchKey {
  channelId: string;
  channelType: ChannelType;
  eventType: string;
}

interface Batch extends BatchKey {
  deliveryIds: string[];
}

export class DeliveryDispatcher {
  private readonly discord: DiscordClient;
  private readonly batchWindowMs: number;
  private readonly autoFlush: boolean;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "error" | "warn">;

  private readonly batches = new Map<string, Batch>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Knex,
    options: DispatcherOptions = {},
  ) {
    this.discord = options.discord ?? new DiscordClient();
    this.batchWindowMs = options.batchWindowMs ?? 2000;
    this.autoFlush = options.autoFlush ?? true;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  /**
   * Resolve routes, write one `deliveries` row per matching channel, and queue
   * the batch. The unique (channel_id, dedupe_key) index is what makes a repeat
   * of the same event a no-op rather than a second notification.
   */
  async dispatch(event: DeliveryEvent): Promise<DispatchResult> {
    const routes = await resolveRoutes(this.db, {
      event_type: event.event_type,
      severity: event.severity,
      jurisdiction_id: event.jurisdiction_id,
    });

    const byChannel = new Map<string, ResolvedRoute>();
    for (const route of routes) {
      if (!byChannel.has(route.channel_id)) byChannel.set(route.channel_id, route);
    }

    const dedupeKey = event.dedupe_key ?? defaultDedupeKey(event);
    const stored: StoredPayload = {
      severity: event.severity ?? null,
      jurisdiction_id: event.jurisdiction_id ?? null,
      occurred_at: event.occurred_at ?? this.now().toISOString(),
      data: event.payload,
    };

    const queued: string[] = [];
    let duplicates = 0;

    for (const route of byChannel.values()) {
      const inserted = await this.db("deliveries")
        .insert({
          channel_id: route.channel_id,
          event_type: event.event_type,
          payload: JSON.stringify(stored),
          dedupe_key: dedupeKey,
          status: "pending",
          attempts: 0,
        })
        .onConflict(["channel_id", "dedupe_key"])
        .ignore()
        .returning<Array<{ id: string }>>("id");

      if (inserted.length === 0) {
        duplicates++;
        continue;
      }

      queued.push(inserted[0].id);
      this.enqueue(
        { channelId: route.channel_id, channelType: route.channel_type, eventType: event.event_type },
        inserted[0].id,
      );
    }

    return { queued, duplicates, channels: byChannel.size };
  }

  private enqueue(key: BatchKey, deliveryId: string): void {
    const mapKey = `${key.channelId}::${key.eventType}`;
    const existing = this.batches.get(mapKey);
    if (existing) {
      existing.deliveryIds.push(deliveryId);
    } else {
      this.batches.set(mapKey, { ...key, deliveryIds: [deliveryId] });
    }

    if (!this.autoFlush || this.timers.has(mapKey)) return;

    const timer = setTimeout(() => {
      this.timers.delete(mapKey);
      this.flushKey(mapKey).catch((err: unknown) => {
        this.logger.error("DeliveryDispatcher: batch flush failed", err);
      });
    }, this.batchWindowMs);
    timer.unref?.();
    this.timers.set(mapKey, timer);
  }

  /** Send every buffered batch now. Also the graceful-shutdown path. */
  async flushAll(): Promise<FlushResult[]> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    const keys = [...this.batches.keys()];
    const results: FlushResult[] = [];
    for (const key of keys) {
      const result = await this.flushKey(key);
      if (result) results.push(result);
    }
    return results;
  }

  /** Clear timers without sending. */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.batches.clear();
  }

  private flushKey(mapKey: string): Promise<FlushResult | null> {
    // Serialise flushes so two windows for the same webhook cannot interleave
    // their rate-limit slots.
    const next = this.inFlight.then(() => this.doFlush(mapKey));
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  private async doFlush(mapKey: string): Promise<FlushResult | null> {
    const batch = this.batches.get(mapKey);
    if (!batch) return null;
    this.batches.delete(mapKey);
    if (batch.deliveryIds.length === 0) return null;

    return this.sendBatch(batch.channelId, batch.channelType, batch.eventType, batch.deliveryIds);
  }

  /**
   * Re-attempt deliveries that failed earlier and whose backoff has elapsed.
   * Safe to call from a scheduler; it groups by channel and event type so a
   * backlog still goes out as batched messages.
   */
  async retryPending(limit = 100): Promise<FlushResult[]> {
    const now = this.now();
    const rows = await this.db("deliveries")
      .join("delivery_channels", "deliveries.channel_id", "delivery_channels.id")
      .where("deliveries.status", "pending")
      .where("deliveries.attempts", ">", 0)
      .whereNotNull("deliveries.next_attempt_at")
      .where("deliveries.next_attempt_at", "<=", now)
      .where("delivery_channels.enabled", true)
      .orderBy("deliveries.created_at", "asc")
      .limit(limit)
      .select<Array<{ id: string; channel_id: string; event_type: string; channel_type: ChannelType }>>(
        "deliveries.id as id",
        "deliveries.channel_id as channel_id",
        "deliveries.event_type as event_type",
        "delivery_channels.channel_type as channel_type",
      );

    const grouped = new Map<string, Batch>();
    for (const row of rows) {
      const key = `${row.channel_id}::${row.event_type}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.deliveryIds.push(row.id);
      } else {
        grouped.set(key, {
          channelId: row.channel_id,
          channelType: row.channel_type,
          eventType: row.event_type,
          deliveryIds: [row.id],
        });
      }
    }

    const results: FlushResult[] = [];
    for (const batch of grouped.values()) {
      results.push(
        await this.sendBatch(batch.channelId, batch.channelType, batch.eventType, batch.deliveryIds),
      );
    }
    return results;
  }

  private async sendBatch(
    channelId: string,
    channelType: ChannelType,
    eventType: string,
    deliveryIds: string[],
  ): Promise<FlushResult> {
    const base: FlushResult = {
      channel_id: channelId,
      channel_type: channelType,
      event_type: eventType,
      delivery_ids: deliveryIds,
      embeds: 0,
      overflow: 0,
      status: "sent",
    };

    if (channelType !== "discord") {
      // Email keeps its own established path; generic webhooks are not wired
      // to a transport yet. Either way the row records why nothing was sent.
      await this.db("deliveries")
        .whereIn("id", deliveryIds)
        .update({ status: "skipped", last_error: `no dispatcher transport for channel type "${channelType}"` });
      return { ...base, status: "skipped" };
    }

    const rows = await this.db("deliveries")
      .whereIn("id", deliveryIds)
      .whereIn("status", ["pending"])
      .orderBy("created_at", "asc")
      .select<Array<Pick<DeliveryRow, "id" | "payload" | "attempts">>>("id", "payload", "attempts");

    if (rows.length === 0) return { ...base, delivery_ids: [], status: "sent" };

    const ids = rows.map((row) => row.id);
    const { message, overflow } = buildBatchMessage(eventType, rows);
    const embeds = message.embeds?.length ?? 0;

    let webhookUrl: string;
    try {
      const channel = await this.db("delivery_channels")
        .where({ id: channelId })
        .first<{ config_encrypted: Buffer } | undefined>("config_encrypted");
      if (!channel) throw new Error("channel no longer exists");
      const config = decryptChannelConfig(channel);
      if (!config.webhook_url) throw new Error("channel config has no webhook_url");
      webhookUrl = config.webhook_url;
    } catch (err) {
      // Config problems are not transient — do not burn retries on them.
      const reason = err instanceof Error ? err.message : "unreadable channel config";
      await this.db("deliveries")
        .whereIn("id", ids)
        .update({ status: "failed", last_error: reason, attempts: this.maxAttempts });
      return { ...base, delivery_ids: ids, embeds, overflow, status: "failed", error: reason };
    }

    try {
      const result = await this.discord.post(webhookUrl, message);
      if (result.truncation.truncated) {
        this.logger.warn(
          `DeliveryDispatcher: truncated ${eventType} message for channel ${channelId}: ${result.truncation.notes.join("; ")}`,
        );
      }
      await this.db("deliveries")
        .whereIn("id", ids)
        .update({ status: "sent", sent_at: this.now(), last_error: null });
      return { ...base, delivery_ids: ids, embeds, overflow, status: "sent" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown delivery error";
      const retryable = !(err instanceof DiscordPostError) || err.retryable;
      const status = await this.recordFailure(rows, reason, retryable);
      return { ...base, delivery_ids: ids, embeds, overflow, status, error: reason };
    }
  }

  private async recordFailure(
    rows: Array<Pick<DeliveryRow, "id" | "attempts">>,
    reason: string,
    retryable: boolean,
  ): Promise<"failed" | "retrying"> {
    let anyRetrying = false;

    for (const row of rows) {
      const attempts = row.attempts + 1;
      const exhausted = !retryable || attempts >= this.maxAttempts;
      const update = exhausted
        ? { status: "failed", attempts, last_error: reason, next_attempt_at: null }
        : {
            status: "pending",
            attempts,
            last_error: reason,
            next_attempt_at: new Date(this.now().getTime() + backoffMs(attempts)),
          };
      if (!exhausted) anyRetrying = true;
      await this.db("deliveries").where({ id: row.id }).update(update);
    }

    return anyRetrying ? "retrying" : "failed";
  }
}
