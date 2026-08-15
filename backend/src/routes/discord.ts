import { Router, type Request, type Response } from "express";
import db from "../config/database";
import { requireOperator } from "../middleware/requireOperator";
import {
  CHANNEL_AUDIENCES,
  ChannelConfigError,
  RESTRICTED_EVENT_NAMESPACES,
  WILDCARD_EVENT_TYPE,
  createChannel,
  createRoute,
  eventTypeAudience,
  getChannel,
  listRoutes,
  routeAllowedForAudience,
  setChannelEnabled,
  type ChannelAudience,
  type Severity,
} from "../services/delivery/channels";
import { WebhookUrlError } from "../services/delivery/discord";
import {
  isDeliveryStatus,
  listDeliveries,
  summariseDeliveries,
} from "../services/delivery/history";
import { EVENT_SUBJECT_KINDS } from "../services/events";

/**
 * Discord routing, and the two things `/api/admin/channels` does not do.
 *
 * The generic channels surface creates a channel of any type and adds a route
 * to it. It works, and this router does not replace it. What it never had is
 * the part of the delivery spec § 3 that is specific to Discord being a *public
 * consumer*:
 *
 *  1. **An ops channel is a separate channel row.** The spec says so in as many
 *     words. Nothing enforced it — `whereEventPublic` filters `subject_kind <>
 *     'ops'` for consumers that read `events`, and the dispatcher does not read
 *     `events`. Migration 088 adds `delivery_channels.audience` and a trigger;
 *     this router is the surface that makes an operator choose, and refuses
 *     `*`, `ops.*` and `dispute.*` on a public channel with a sentence rather
 *     than a constraint name.
 *  2. **The delivery log is readable.** `deliveries.status`, `.attempts` and
 *     `.last_error` have been written since migration 015 and never read back,
 *     so a webhook revoked by a server admin failed five times in silence.
 *
 * Discord only, on purpose. Email is a different consent regime, SMS costs
 * money per message, and both already have their own surfaces; a screen that
 * mixed them would have to caveat every field.
 *
 * The guard is applied here rather than assumed from where this is mounted. It
 * is the same reasoning `routes/admin/index.ts` gives for its own catch-all: a
 * router that carries its credential requirement cannot be mounted somewhere
 * that forgets it.
 */

const router = Router();

router.use(requireOperator);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message, statusCode: 400 });
}

function isAudience(value: unknown): value is ChannelAudience {
  return typeof value === "string" && (CHANNEL_AUDIENCES as readonly string[]).includes(value);
}

/**
 * A Discord channel this operator owns, or `undefined`.
 *
 * Filtered to `channel_type = 'discord'` as well as `owner_kind = 'operator'`,
 * so an email channel's id addressed through this router 404s instead of being
 * edited by a screen whose copy is all about webhooks.
 */
async function ownedDiscordChannel(id: string): Promise<{ id: string } | undefined> {
  return db("delivery_channels")
    .where({ id, owner_kind: "operator", channel_type: "discord" })
    .first<{ id: string } | undefined>("id");
}

/**
 * What an operator may route, and to which audience.
 *
 * This endpoint exists because prefix matching was built and never surfaced.
 * `eventTypeMatchers` has handled `meeting.*` since the event spine landed, and
 * an operator with no way to discover that writes `*` — which is exactly the
 * mistake the audience rule now refuses. Naming the prefixes makes the safe
 * option the obvious one instead of the documented one.
 */
router.get("/event-types", (_req, res) => {
  const publicPrefixes = EVENT_SUBJECT_KINDS.filter((kind) => kind !== "ops").map(
    (kind) => `${kind}.*`,
  );

  res.json({
    /** Route these to a public channel. They are the whole published record. */
    public_prefixes: publicPrefixes,
    /** These need a channel whose audience is `ops`, and nothing else. */
    restricted_prefixes: RESTRICTED_EVENT_NAMESPACES.map((ns) => `${ns}.*`),
    /**
     * Reported so the surface can say why it is refused rather than silently
     * omitting it. `*` matches everything the prefixes match plus ops and
     * disputes, which is the shortcut this rule exists to close.
     */
    wildcard: {
      event_type: WILDCARD_EVENT_TYPE,
      allowed_audience: "ops",
      reason:
        "\"*\" matches every event, including ops and disputes. Route the namespaces you want instead.",
    },
    audiences: CHANNEL_AUDIENCES,
  });
});

/** Every Discord channel the operator has configured, with its delivery tally. */
router.get("/", async (_req, res, next) => {
  try {
    const rows = await db("delivery_channels")
      .where({ owner_kind: "operator", channel_type: "discord" })
      .orderBy("created_at", "asc")
      .select<Array<{ id: string }>>("id");

    const channels = [];
    for (const row of rows) {
      const channel = await getChannel(db, row.id);
      if (!channel) continue;
      channels.push({
        ...channel,
        routes: await listRoutes(db, row.id),
        deliveries: await summariseDeliveries(db, row.id),
      });
    }

    res.json({ data: channels, total: channels.length });
  } catch (err) {
    next(err);
  }
});

interface CreateBody {
  name?: unknown;
  webhook_url?: unknown;
  audience?: unknown;
  enabled?: unknown;
}

/**
 * Create a Discord channel. `audience` is required and has no default.
 *
 * The column defaults to `public`, which is the right default for a row created
 * by any other path. Here it is required, because the whole point of this
 * surface is that the operator states which kind of channel this webhook points
 * at — a default would let them not decide, and not deciding is how a community
 * server ends up subscribed to sweep failures.
 */
router.post("/", async (req: Request<unknown, unknown, CreateBody>, res, next) => {
  try {
    const body = req.body ?? {};

    if (typeof body.name !== "string" || body.name.trim() === "") {
      badRequest(res, "name is required");
      return;
    }
    if (typeof body.webhook_url !== "string" || body.webhook_url === "") {
      badRequest(res, "webhook_url is required");
      return;
    }
    if (!isAudience(body.audience)) {
      badRequest(
        res,
        'audience is required and must be "public" or "ops". A public channel is one readers can ' +
          "see; an ops channel is the machinery talking about itself and needs its own webhook.",
      );
      return;
    }

    const summary = await createChannel(db, {
      channel_type: "discord",
      name: body.name.trim(),
      config: { webhook_url: body.webhook_url },
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      audience: body.audience,
    });

    await db("delivery_channels").where({ id: summary.id }).update({ owner_kind: "operator" });

    // `summary` carries `config_masked`. The webhook token is a bearer
    // credential and is never echoed, not even to the caller who just sent it.
    res.status(201).json(summary);
  } catch (err) {
    if (err instanceof ChannelConfigError || err instanceof WebhookUrlError) {
      badRequest(res, err.message);
      return;
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, "Invalid channel id");
      return;
    }
    if (!(await ownedDiscordChannel(id))) {
      res.status(404).json({ error: "Channel not found", statusCode: 404 });
      return;
    }

    res.json({
      channel: await getChannel(db, id),
      routes: await listRoutes(db, id),
      deliveries: await summariseDeliveries(db, id),
    });
  } catch (err) {
    next(err);
  }
});

interface PatchBody {
  enabled?: unknown;
}

/**
 * Enable or disable a channel. There is deliberately no way to change
 * `audience` here.
 *
 * Relabelling a channel from ops to public is how the separation gets undone —
 * create the ops channel, add `ops.*`, then flip it — and migration 088's
 * second trigger refuses it at the database. Offering the field on a form whose
 * submit can only fail would be worse than not offering it: delete the routes,
 * or make a new channel.
 */
router.patch("/:id", async (req: Request<{ id: string }, unknown, PatchBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, "Invalid channel id");
      return;
    }
    if (!(await ownedDiscordChannel(id))) {
      res.status(404).json({ error: "Channel not found", statusCode: 404 });
      return;
    }

    const body = req.body ?? {};
    if (typeof body.enabled !== "boolean") {
      badRequest(res, "enabled must be true or false");
      return;
    }

    res.json(await setChannelEnabled(db, id, body.enabled));
  } catch (err) {
    next(err);
  }
});

interface RouteBody {
  event_type?: unknown;
  min_severity?: unknown;
  jurisdiction_id?: unknown;
  enabled?: unknown;
}

router.post("/:id/routes", async (req: Request<{ id: string }, unknown, RouteBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, "Invalid channel id");
      return;
    }
    if (!(await ownedDiscordChannel(id))) {
      res.status(404).json({ error: "Channel not found", statusCode: 404 });
      return;
    }

    const body = req.body ?? {};
    if (typeof body.event_type !== "string" || body.event_type.trim() === "") {
      badRequest(res, "event_type is required");
      return;
    }

    // `createRoute` calls `assertRouteAllowed`, which throws
    // ChannelConfigError, which lands as a 400 below. The rule is not restated
    // here — a second copy of it is a second thing that can drift.
    const route = await createRoute(db, {
      channel_id: id,
      event_type: body.event_type.trim(),
      min_severity: typeof body.min_severity === "string" ? (body.min_severity as Severity) : null,
      jurisdiction_id: typeof body.jurisdiction_id === "string" ? body.jurisdiction_id : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    });

    res.status(201).json(route);
  } catch (err) {
    if (err instanceof ChannelConfigError) {
      badRequest(res, err.message);
      return;
    }
    next(err);
  }
});

router.delete("/:id/routes/:routeId", async (req, res, next) => {
  try {
    const { id, routeId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(routeId)) {
      badRequest(res, "Invalid id");
      return;
    }
    if (!(await ownedDiscordChannel(id))) {
      res.status(404).json({ error: "Channel not found", statusCode: 404 });
      return;
    }

    const deleted = await db("channel_routes").where({ id: routeId, channel_id: id }).del();
    if (deleted === 0) {
      res.status(404).json({ error: "Route not found", statusCode: 404 });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * `GET /deliveries` — what was sent, what failed, and why.
 *
 * The gap this closes is not subtle: the dispatcher's durability argument is
 * that a failed post is queryable rather than a lost log line, and until now
 * nothing queried it.
 *
 * The payload is not returned. It holds the rendered claim, which for a
 * published finding is a sentence about a named person; it is already on the
 * site, and a second copy in a debugging screen is a copy with no review state
 * attached to it. See `services/delivery/history.ts`.
 */
router.get("/deliveries/log", async (req, res, next) => {
  try {
    const rawStatus = req.query.status;
    if (rawStatus !== undefined && !isDeliveryStatus(rawStatus)) {
      badRequest(res, "Unknown delivery status");
      return;
    }

    const rawChannel = req.query.channel_id;
    if (typeof rawChannel === "string" && !UUID_RE.test(rawChannel)) {
      badRequest(res, "Invalid channel id");
      return;
    }

    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;

    const result = await listDeliveries(db, {
      status: rawStatus,
      channel_id: typeof rawChannel === "string" ? rawChannel : undefined,
      event_type: typeof req.query.event_type === "string" ? req.query.event_type : undefined,
      limit: typeof rawLimit === "string" ? Number(rawLimit) : undefined,
      offset: typeof rawOffset === "string" ? Number(rawOffset) : undefined,
    });

    res.json({
      ...result,
      summary: await summariseDeliveries(
        db,
        typeof rawChannel === "string" ? rawChannel : undefined,
      ),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Would this event type reach this channel? Answered without sending anything.
 *
 * A dry run rather than a test post, because a test post to a public server is
 * a message real people read. What an operator actually wants to know before
 * saving a route is whether they have just wired ops events into a room full of
 * strangers, and that question has an answer that needs no network call.
 */
router.get("/:id/would-route", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, "Invalid channel id");
      return;
    }

    const channel = await db("delivery_channels")
      .where({ id, owner_kind: "operator", channel_type: "discord" })
      .first<{ id: string; audience: ChannelAudience } | undefined>("id", "audience");
    if (!channel) {
      res.status(404).json({ error: "Channel not found", statusCode: 404 });
      return;
    }

    const eventType = req.query.event_type;
    if (typeof eventType !== "string" || eventType === "") {
      badRequest(res, "event_type is required");
      return;
    }

    res.json({
      event_type: eventType,
      channel_audience: channel.audience,
      event_audience: eventTypeAudience(eventType),
      allowed: routeAllowedForAudience(channel.audience, eventType),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
