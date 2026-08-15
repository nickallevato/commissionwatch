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

/**
 * What a channel is *for*, and the one thing an operator cannot fix by being
 * careful.
 *
 * `whereEventPublic` filters `subject_kind <> 'ops'` for consumers that read
 * `events`. The dispatcher does not read `events` — it reads `channel_routes` —
 * so nothing in that path stopped an operator routing `*` to a community
 * Discord server and subscribing it to every sweep failure and every dispute.
 * Migration 088 added the column and the triggers; this is the same rule in
 * TypeScript, so a caller gets a sentence rather than a Postgres error.
 */
export type ChannelAudience = "public" | "ops";

export const CHANNEL_AUDIENCES: readonly ChannelAudience[] = ["public", "ops"];

/**
 * Namespaces only an ops channel may carry.
 *
 * `dispute` is here before anything emits it. A dispute is never published
 * (migration 039), so the route that would leak one must already be impossible
 * on the day it starts existing.
 */
export const RESTRICTED_EVENT_NAMESPACES: readonly string[] = ["ops", "dispute"];

/**
 * Who a channel belongs to.
 *
 * `direct` was added with the dispute reply loop and is the only kind that holds
 * **no destination at rest**. An operator channel stores a webhook; a subscriber
 * channel stores a reader's address until they unsubscribe; a direct channel
 * stores an empty config and takes its one recipient from the subject row at
 * send time. There is nothing on it to leak and nothing to keep in sync.
 */
export type ChannelOwnerKind = "operator" | "subscriber" | "direct";

export const CHANNEL_OWNER_KINDS: readonly ChannelOwnerKind[] = [
  "operator",
  "subscriber",
  "direct",
];

/**
 * Namespaces that may reach **only** a `direct` channel — and why the audience
 * rule above is not enough on its own.
 *
 * Migration 088 put `dispute` in `RESTRICTED_EVENT_NAMESPACES` before anything
 * emitted one, which stops a *public* channel carrying `dispute.*`. That is half
 * the rule. The other half is that an **ops** channel is still a Discord webhook
 * pointed at a server with people in it, and `resolveRoutes`' audience filter
 * happily hands a restricted event to one — that is exactly what it is for, with
 * `ops.sweep.failed`. A dispute is not a sweep failure. It is a private
 * communication from a member of the public that migration 039 forbids
 * publishing, and posting one into an operator's chat server publishes it.
 *
 * So a dispute event resolves to a direct channel or to nothing at all. This is
 * the single highest-risk defect available in this feature, so it is a filter in
 * the one function every send goes through, not a convention about how routes
 * should be configured.
 */
export const DIRECT_ONLY_EVENT_NAMESPACES: readonly string[] = ["dispute"];

export function requiresDirectChannel(eventType: string): boolean {
  return DIRECT_ONLY_EVENT_NAMESPACES.includes(eventType.split(".")[0]);
}

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
  audience: ChannelAudience;
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
  /** Public consumer or operator machinery. Never both — see `ChannelAudience`. */
  audience: ChannelAudience;
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
  /** Defaults to `public`, which is the audience that may receive least. */
  audience?: ChannelAudience;
  /** Defaults to `operator`. A `direct` channel must be created with an empty config. */
  owner_kind?: ChannelOwnerKind;
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
  owner_kind: ChannelOwnerKind;
  /** Subscriber destinations must confirm before their first send. */
  verified: boolean;
  audience: ChannelAudience;
}

export class ChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConfigError";
  }
}

/** A route whose event_type is this matches every event. */
export const WILDCARD_EVENT_TYPE = "*";

/**
 * The route event_types that match this event: the exact type, `*`, and every
 * dot-prefix wildcard — `ops.sweep.failed` is matched by `ops.*` and
 * `ops.sweep.*`, and by nothing else.
 *
 * Without prefix matching, every new event type needs a new route row on every
 * channel. Operators will not do that chore; they will route `*`, which
 * silently subscribes a public channel to ops events. Make the easy thing the
 * safe thing.
 *
 * Matching is done here rather than with a SQL `LIKE` on purpose: the pattern
 * lives in an operator-editable column, and turning stored text into a SQL
 * pattern is how a route row becomes an injection surface. The candidate list
 * is short, bounded by the number of dots in the event type, and goes through
 * the same parameterised `whereIn` the exact match always used.
 */
export function eventTypeMatchers(eventType: string): string[] {
  const matchers = [eventType, WILDCARD_EVENT_TYPE];
  const segments = eventType.split(".");
  for (let end = 1; end < segments.length; end++) {
    matchers.push(`${segments.slice(0, end).join(".")}.*`);
  }
  return matchers;
}

/**
 * The audience a route or an event belongs to.
 *
 * The bare `*` is restricted. It is not a namespace, it matches everything the
 * prefix wildcards match *plus* `ops.*` and `dispute.*`, and it is precisely
 * the shortcut an operator reaches for rather than writing five rows. The
 * prefix forms are what `*` was standing in for, they already work, and they
 * are safe — so the easy thing and the safe thing are now the same thing.
 */
export function eventTypeAudience(eventType: string): ChannelAudience {
  if (eventType === WILDCARD_EVENT_TYPE) return "ops";
  const namespace = eventType.split(".")[0];
  return RESTRICTED_EVENT_NAMESPACES.includes(namespace) ? "ops" : "public";
}

/**
 * Whether a channel with this audience may carry this route.
 *
 * One-directional, and deliberately so. An ops channel receiving a
 * `meeting.published` embed is an operator seeing their own site's output in
 * their own private server; a public channel receiving `ops.sweep.failed` is a
 * disclosure. Only the second one is a defect, so only the second one is
 * refused.
 */
export function routeAllowedForAudience(
  audience: ChannelAudience,
  eventType: string,
): boolean {
  return audience === "ops" || eventTypeAudience(eventType) === "public";
}

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
    audience: row.audience,
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
  const ownerKind = input.owner_kind ?? "operator";

  if (ownerKind === "direct") {
    // The point of a direct channel is that there is no destination on it. A
    // stored address would be a destination somebody could later route
    // unrelated traffic to, and the whole reason this kind exists is that the
    // recipient of a dispute reply is decided per send, from the dispute row.
    if (Object.values(input.config).some((value) => value !== undefined && value !== "")) {
      throw new ChannelConfigError(
        "A direct channel holds no destination at rest; its config must be empty. " +
          "The recipient is supplied per send from the subject row.",
      );
    }
  } else {
    await validateChannelConfig(input.channel_type, input.config, options);
  }

  const [row] = await db("delivery_channels")
    .insert({
      channel_type: input.channel_type,
      name: input.name,
      config_encrypted: encryptConfig(input.config),
      enabled: input.enabled ?? true,
      audience: input.audience ?? "public",
      owner_kind: ownerKind,
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

/**
 * The audience rule, as a sentence rather than a Postgres error.
 *
 * Migration 088's trigger is the enforcement — it covers the self-serve
 * subscribe path, which inserts into `channel_routes` directly and never comes
 * through here. This exists so the operator who typed `ops.*` into a form gets
 * told what to do about it instead of a 500 with a constraint name in it.
 */
export async function assertRouteAllowed(
  db: Knex,
  channelId: string,
  eventType: string,
): Promise<void> {
  const row = await db("delivery_channels")
    .where({ id: channelId })
    .first<Pick<DeliveryChannelRow, "audience"> | undefined>("audience");
  if (!row) throw new ChannelConfigError("No such channel");

  if (!routeAllowedForAudience(row.audience, eventType)) {
    throw new ChannelConfigError(
      eventType === WILDCARD_EVENT_TYPE
        ? `"*" matches every event, including ops and disputes. Route the ` +
          `namespaces you want instead — "meeting.*", "finding.*", "claim.*" — ` +
          `or set this channel's audience to "ops".`
        : `"${eventType}" is an ops event type and this channel's audience is ` +
          `"public". Ops belongs on its own channel row, with its own webhook.`,
    );
  }
}

export async function createRoute(db: Knex, input: CreateRouteInput): Promise<ChannelRouteRow> {
  await assertRouteAllowed(db, input.channel_id, input.event_type);

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
  // `cadence` and `daily_send_cap` are selected because an operator screen that
  // lists routes without them shows a route that looks immediate and is held
  // for a weekly digest. They were added in migration 024 and this select was
  // not updated with it.
  return query.select<ChannelRouteRow[]>(
    "id",
    "channel_id",
    "event_type",
    "min_severity",
    "jurisdiction_id",
    "enabled",
    "cadence",
    "daily_send_cap",
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
  owner_kind: ChannelOwnerKind;
  verified: boolean;
  audience: ChannelAudience;
}

/**
 * Every enabled route on an enabled channel that matches this event. Absent
 * filters (NULL severity, NULL jurisdiction) mean "no filtering".
 *
 * The audience filter here is the second of two, not the only one. Migration
 * 088's trigger stops the route being created; this stops it mattering if a row
 * predates the trigger, or if a restore, a manual `UPDATE`, or a future writer
 * gets one past it. Configuration is checked once, at send time, on every send
 * — which is the ordering that makes the guarantee independent of what is
 * already in the table.
 */
export async function resolveRoutes(db: Knex, event: RouteMatchInput): Promise<ResolvedRoute[]> {
  const rows = await db("channel_routes")
    .join("delivery_channels", "channel_routes.channel_id", "delivery_channels.id")
    .where("channel_routes.enabled", true)
    .where("delivery_channels.enabled", true)
    .whereIn("channel_routes.event_type", eventTypeMatchers(event.event_type))
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
      "delivery_channels.audience as audience",
    );

  const eventRank = severityRank(event.severity);
  const eventAudience = eventTypeAudience(event.event_type);
  const directOnly = requiresDirectChannel(event.event_type);

  return rows
    .filter((row) => eventAudience === "public" || row.audience === "ops")
    // See `DIRECT_ONLY_EVENT_NAMESPACES`. A `*` route on an ops Discord channel
    // is a legal, useful configuration that satisfies every filter above it —
    // and it must still not pick up a dispute.
    .filter((row) => !directOnly || row.owner_kind === "direct")
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
      audience: row.audience,
    }));
}
