import type { Knex } from "knex";
import type { ChannelAudience, ChannelType } from "./channels";

/**
 * What was sent, what failed, and why.
 *
 * `deliveries` has carried `status`, `attempts` and `last_error` since
 * migration 015 and nothing has ever read them back. The dispatcher's whole
 * durability argument — "a failed post is something you can query, not a lost
 * log line" — was only half true: the row was written and there was no query.
 * An operator whose webhook was revoked by a server admin had five failed
 * attempts recorded and no surface that would ever mention it.
 *
 * Two rules about what leaves this module:
 *
 * **The payload does not.** A delivery payload holds the rendered claim, which
 * on a Discord embed is a sentence about a named person. It is already on the
 * site if it was ever sent, and reprinting it in a delivery log adds a second
 * copy in a screen built for debugging. The event type, the channel and the
 * error are what "why did this not arrive" needs.
 *
 * **`last_error` does.** It is written by the dispatcher from a Discord or
 * Twilio response, so it is provider text rather than anything about a reader,
 * and it is the entire point of the screen. This is an operator surface behind
 * `requireOperator`; it is not public.
 */

export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "deferred";

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "pending",
  "sent",
  "failed",
  "skipped",
  "deferred",
];

export interface DeliveryHistoryRow {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_type: ChannelType;
  audience: ChannelAudience;
  event_type: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
}

export interface DeliveryHistoryFilters {
  channel_id?: string;
  status?: DeliveryStatus;
  event_type?: string;
  limit?: number;
  offset?: number;
}

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * The delivery log, newest first.
 *
 * Ordered by `created_at` rather than `sent_at`, because the rows an operator
 * opens this screen for are the ones with no `sent_at` at all.
 */
export async function listDeliveries(
  db: Knex,
  filters: DeliveryHistoryFilters = {},
): Promise<{ data: DeliveryHistoryRow[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);

  const scope = (query: Knex.QueryBuilder): Knex.QueryBuilder => {
    // Operator channels only. A subscriber's row names their own destination,
    // and an operator browsing a delivery log is not a reason to disclose a
    // reader's email address — the same rule the admin channels list follows.
    query.where("delivery_channels.owner_kind", "operator");
    if (filters.channel_id) query.where("deliveries.channel_id", filters.channel_id);
    if (filters.status) query.where("deliveries.status", filters.status);
    if (filters.event_type) query.where("deliveries.event_type", filters.event_type);
    return query;
  };

  const rows = await scope(
    db("deliveries").join("delivery_channels", "deliveries.channel_id", "delivery_channels.id"),
  )
    .orderBy([
      { column: "deliveries.created_at", order: "desc" },
      { column: "deliveries.id", order: "desc" },
    ])
    .limit(limit)
    .offset(offset)
    .select<DeliveryHistoryRow[]>(
      "deliveries.id as id",
      "deliveries.channel_id as channel_id",
      "delivery_channels.name as channel_name",
      "delivery_channels.channel_type as channel_type",
      "delivery_channels.audience as audience",
      "deliveries.event_type as event_type",
      "deliveries.status as status",
      "deliveries.attempts as attempts",
      "deliveries.last_error as last_error",
      "deliveries.next_attempt_at as next_attempt_at",
      "deliveries.created_at as created_at",
      "deliveries.sent_at as sent_at",
    );

  const countRow = await scope(
    db("deliveries").join("delivery_channels", "deliveries.channel_id", "delivery_channels.id"),
  ).count<Array<{ count: string }>>("deliveries.id as count");

  return { data: rows, total: Number(countRow[0]?.count ?? 0) };
}

/**
 * One count per status, so the screen can lead with "3 failed" rather than
 * making an operator page through a log to discover it.
 */
export async function summariseDeliveries(
  db: Knex,
  channelId?: string,
): Promise<Record<DeliveryStatus, number>> {
  const query = db("deliveries")
    .join("delivery_channels", "deliveries.channel_id", "delivery_channels.id")
    .where("delivery_channels.owner_kind", "operator")
    .groupBy("deliveries.status")
    .select<Array<{ status: DeliveryStatus; count: string }>>("deliveries.status as status")
    .count("deliveries.id as count");

  if (channelId) query.where("deliveries.channel_id", channelId);

  const rows = await query;

  // Every status is present with a zero rather than absent. A screen that
  // renders only the statuses it received cannot show "0 failed", and "0
  // failed" is the sentence an operator came to read.
  const summary: Record<DeliveryStatus, number> = {
    pending: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
  };
  for (const row of rows) {
    // Narrowed rather than asserted. `status` is a varchar with a CHECK
    // constraint, not an enum type, so the database's word for it is a string
    // and a cast here would be the compiler being told to stop asking.
    if (isDeliveryStatus(row.status)) summary[row.status] = Number(row.count);
  }
  return summary;
}
