import type { Knex } from "knex";
import { decryptConfig, encryptConfig } from "./crypto";
import { assertDiscordWebhookUrl, assertPublicWebhookUrl, type HostLookup } from "./discord";

/**
 * Channel and route storage.
 *
 * A channel is "somewhere we can post"; a route is "send events of this type,
 * at or above this severity, for this jurisdiction, to that channel". The
 * credential inside a channel is encrypted at rest and only ever leaves this
 * module in masked form — {@link loadChannelSecret} is the single deliberate
 * exception, used by the dispatcher at send time.
 */

export type ChannelType = "discord" | "email" | "webhook" | "sms";

export const CHANNEL_TYPES: readonly ChannelType[] = ["discord", "email", "webhook", "sms"];

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface ChannelConfig {
  /** Discord and generic webhook channels. */
  webhook_url?: string;
  /** Email channels. */
  email?: string;
  /** SMS channels. E.164, e.g. +14065550123. */
  phone?: string;
}

export interface DeliveryChannelRow {
  id: string;
  channel_type: ChannelType;
  name: string;
  config_encrypted: Buffer;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelRouteRow {
  id: string;
  channel_id: string;
  event_type: string;
  min_severity: Severity | null;
  jurisdiction_id: string | null;
  enabled: boolean;
  cadence?: Cadence;
  daily_send_cap?: number | null;
}

/** Safe-to-return shape. Never contains a credential. */
export interface ChannelSummary {
  id: string;
  channel_type: ChannelType;
  name: string;
  enabled: boolean;
  /** e.g. `https://discord.com/…f4a2` */
  config_masked: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateChannelInput {
  channel_type: ChannelType;
  name: string;
  config: ChannelConfig;
  enabled?: boolean;
}

export interface CreateRouteInput {
  channel_id: string;
  event_type: string;
  min_severity?: Severity | null;
  jurisdiction_id?: string | null;
  enabled?: boolean;
}

export interface RouteMatchInput {
  event_type: string;
  severity?: string | null;
  jurisdiction_id?: string | null;
}

export type Cadence = "immediate" | "daily" | "weekly";

export interface ResolvedRoute {
  route_id: string;
  channel_id: string;
  channel_type: ChannelType;
  channel_name: string;
  config_encrypted: Buffer;
  /** Non-immediate routes are held for a digest rather than sent now. */
  cadence: Cadence;
  /** NULL means uncapped. Only SMS routes normally carry one. */
  daily_send_cap: number | null;
  owner_kind: "operator" | "subscriber";
  /** Subscriber destinations must confirm before their first send. */
  verified: boolean;
}

export class ChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConfigError";
  }
}

/** A route whose event_type is this matches every event. */
export const WILDCARD_EVENT_TYPE = "*";

const MASK_VISIBLE_CHARS = 4;

/**
 * Reads show the host and the last four characters, nothing else. The webhook
 * token is a bearer credential; a full URL in an API response is a leak.
 */
export function maskWebhookUrl(rawUrl: string): string {
  const tail = rawUrl.slice(-MASK_VISIBLE_CHARS);
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}/…${tail}`;
  } catch {
    return `…${tail}`;
  }
}

export function maskConfig(channelType: ChannelType, config: ChannelConfig): string {
  if (channelType === "sms") {
    // Last four digits only. A phone number is a stronger identifier than an
    // email address, not a weaker one.
    const phone = config.phone ?? "";
    return phone.length > MASK_VISIBLE_CHARS ? `…${phone.slice(-MASK_VISIBLE_CHARS)}` : "…";
  }
  if (channelType === "email") {
    const email = config.email ?? "";
    const [local, domain] = email.split("@");
    if (!domain) return "…";
    return `${local.slice(0, 1)}…@${domain}`;
  }
  return config.webhook_url ? maskWebhookUrl(config.webhook_url) : "…";
}

export function severityRank(severity: string | null | undefined): number {
  if (!severity) return SEVERITY_RANK.info;
  const key = severity.toLowerCase();
  if (key in SEVERITY_RANK) return SEVERITY_RANK[key as Severity];
  return SEVERITY_RANK.info;
}

/**
 * Validate a config before it is encrypted. This is where the SSRF gate sits:
 * Discord channels are held to the host allowlist, generic webhooks have their
 * host resolved and checked against the blocked ranges.
 */
export async function validateChannelConfig(
  channelType: ChannelType,
  config: ChannelConfig,
  options: { lookup?: HostLookup } = {},
): Promise<void> {
  if (!CHANNEL_TYPES.includes(channelType)) {
    throw new ChannelConfigError(`Unknown channel type "${channelType}"`);
  }

  if (channelType === "email") {
    if (!config.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) {
      throw new ChannelConfigError("Email channels require a valid email address");
    }
    return;
  }

  if (channelType === "sms") {
    // E.164. Validated here as well as at the subscribe boundary, because this
    // is the function every write path goes through.
    if (!config.phone || !/^\+[1-9]\d{6,14}$/.test(config.phone)) {
      throw new ChannelConfigError(
        "SMS channels require a phone number in E.164 form, e.g. +14065550123",
      );
    }
    return;
  }

  if (!config.webhook_url) {
    throw new ChannelConfigError(`${channelType} channels require a webhook_url`);
  }

  if (channelType === "discord") {
    assertDiscordWebhookUrl(config.webhook_url);
    return;
  }

  await assertPublicWebhookUrl(config.webhook_url, options);
}

export function toSummary(row: DeliveryChannelRow): ChannelSummary {
  let masked = "…";
  try {
    masked = maskConfig(row.channel_type, decryptConfig<ChannelConfig>(row.config_encrypted));
  } catch {
    // A row we cannot decrypt still lists; it just has nothing to show.
    masked = "(unreadable)";
  }
  return {
    id: row.id,
    channel_type: row.channel_type,
    name: row.name,
    enabled: row.enabled,
    config_masked: masked,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createChannel(
  db: Knex,
  input: CreateChannelInput,
  options: { lookup?: HostLookup } = {},
): Promise<ChannelSummary> {
  await validateChannelConfig(input.channel_type, input.config, options);

  const [row] = await db("delivery_channels")
    .insert({
      channel_type: input.channel_type,
      name: input.name,
      config_encrypted: encryptConfig(input.config),
      enabled: input.enabled ?? true,
    })
    .returning<DeliveryChannelRow[]>("*");

  return toSummary(row);
}

export async function updateChannelConfig(
  db: Knex,
  channelId: string,
  config: ChannelConfig,
  options: { lookup?: HostLookup } = {},
): Promise<ChannelSummary | null> {
  const existing = await db("delivery_channels")
    .where({ id: channelId })
    .first<DeliveryChannelRow | undefined>();
  if (!existing) return null;

  await validateChannelConfig(existing.channel_type, config, options);

  const [row] = await db("delivery_channels")
    .where({ id: channelId })
    .update({ config_encrypted: encryptConfig(config), updated_at: db.fn.now() })
    .returning<DeliveryChannelRow[]>("*");

  return toSummary(row);
}

export async function setChannelEnabled(
  db: Knex,
  channelId: string,
  enabled: boolean,
): Promise<ChannelSummary | null> {
  const [row] = await db("delivery_channels")
    .where({ id: channelId })
    .update({ enabled, updated_at: db.fn.now() })
    .returning<DeliveryChannelRow[]>("*");
  return row ? toSummary(row) : null;
}

export async function listChannels(db: Knex): Promise<ChannelSummary[]> {
  const rows = await db("delivery_channels")
    .orderBy("created_at", "asc")
    .select<DeliveryChannelRow[]>("*");
  return rows.map(toSummary);
}

export async function getChannel(db: Knex, channelId: string): Promise<ChannelSummary | null> {
  const row = await db("delivery_channels")
    .where({ id: channelId })
    .first<DeliveryChannelRow | undefined>();
  return row ? toSummary(row) : null;
}

/**
 * The only path that yields plaintext. Callers must not log the result — it is
 * for handing straight to the transport.
 */
export function decryptChannelConfig(row: { config_encrypted: Buffer }): ChannelConfig {
  return decryptConfig<ChannelConfig>(row.config_encrypted);
}

export async function loadChannelSecret(db: Knex, channelId: string): Promise<ChannelConfig | null> {
  const row = await db("delivery_channels")
    .where({ id: channelId })
    .first<Pick<DeliveryChannelRow, "config_encrypted"> | undefined>("config_encrypted");
  return row ? decryptChannelConfig(row) : null;
}

export async function createRoute(db: Knex, input: CreateRouteInput): Promise<ChannelRouteRow> {
  const [row] = await db("channel_routes")
    .insert({
      channel_id: input.channel_id,
      event_type: input.event_type,
      min_severity: input.min_severity ?? null,
      jurisdiction_id: input.jurisdiction_id ?? null,
      enabled: input.enabled ?? true,
    })
    .returning<ChannelRouteRow[]>("*");
  return row;
}

export async function listRoutes(db: Knex, channelId?: string): Promise<ChannelRouteRow[]> {
  const query = db("channel_routes").orderBy("event_type", "asc");
  if (channelId) query.where({ channel_id: channelId });
  return query.select<ChannelRouteRow[]>(
    "id",
    "channel_id",
    "event_type",
    "min_severity",
    "jurisdiction_id",
    "enabled",
  );
}

interface RouteJoinRow {
  route_id: string;
  channel_id: string;
  channel_type: ChannelType;
  channel_name: string;
  config_encrypted: Buffer;
  min_severity: Severity | null;
  jurisdiction_id: string | null;
  cadence: Cadence;
  daily_send_cap: number | null;
  owner_kind: "operator" | "subscriber";
  verified: boolean;
}

/**
 * Every enabled route on an enabled channel that matches this event. Absent
 * filters (NULL severity, NULL jurisdiction) mean "no filtering".
 */
export async function resolveRoutes(db: Knex, event: RouteMatchInput): Promise<ResolvedRoute[]> {
  const rows = await db("channel_routes")
    .join("delivery_channels", "channel_routes.channel_id", "delivery_channels.id")
    .where("channel_routes.enabled", true)
    .where("delivery_channels.enabled", true)
    .whereIn("channel_routes.event_type", [event.event_type, WILDCARD_EVENT_TYPE])
    .where((builder) => {
      builder.whereNull("channel_routes.jurisdiction_id");
      if (event.jurisdiction_id) {
        builder.orWhere("channel_routes.jurisdiction_id", event.jurisdiction_id);
      }
    })
    .select<RouteJoinRow[]>(
      "channel_routes.id as route_id",
      "channel_routes.min_severity as min_severity",
      "channel_routes.jurisdiction_id as jurisdiction_id",
      "channel_routes.cadence as cadence",
      "channel_routes.daily_send_cap as daily_send_cap",
      "delivery_channels.id as channel_id",
      "delivery_channels.channel_type as channel_type",
      "delivery_channels.name as channel_name",
      "delivery_channels.config_encrypted as config_encrypted",
      "delivery_channels.owner_kind as owner_kind",
      "delivery_channels.verified as verified",
    );

  const eventRank = severityRank(event.severity);

  return rows
    .filter((row) => row.min_severity === null || eventRank >= severityRank(row.min_severity))
    .map((row) => ({
      route_id: row.route_id,
      channel_id: row.channel_id,
      channel_type: row.channel_type,
      channel_name: row.channel_name,
      config_encrypted: row.config_encrypted,
      cadence: row.cadence,
      daily_send_cap: row.daily_send_cap,
      owner_kind: row.owner_kind,
      verified: row.verified,
    }));
}
