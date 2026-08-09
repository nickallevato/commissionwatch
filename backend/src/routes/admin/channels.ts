import { Router, type Request } from 'express';
import db from '../../config/database';
import {
  ChannelConfigError,
  createChannel,
  createRoute,
  getChannel,
  listChannels,
  listRoutes,
  setChannelEnabled,
  updateChannelConfig,
  type ChannelConfig,
  type ChannelType,
  type Severity,
} from '../../services/delivery/channels';
import { WebhookUrlError } from '../../services/delivery/discord';
import type { Cadence } from '../../services/delivery/subscriptions';

/**
 * Operator channel and route management.
 *
 * Mounted inside the admin router, after `requireOperator`, so the guard is
 * not something this file can forget. W7 said these endpoints stay unmounted
 * until an authenticated session exists; A1 landed it, so here they are.
 *
 * Every query is filtered to `owner_kind = 'operator'`. Subscriber channels
 * are readers' personal data and are not the operator's to browse — they are
 * reachable only by their holder's own token, through `/api/alerts`.
 *
 * **Reads are masked and writes are never echoed.** The archive's
 * SubscriptionsPage read channel config back to populate its edit form; under
 * W7's masking rule that is not possible and not permitted. The form shows a
 * masked value and accepts a replacement.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message, statusCode: 400 });
}

async function operatorChannelIds(): Promise<string[]> {
  const rows = await db('delivery_channels')
    .where({ owner_kind: 'operator' })
    .select<Array<{ id: string }>>('id');
  return rows.map((row) => row.id);
}

router.get('/', async (_req, res, next) => {
  try {
    const ids = new Set(await operatorChannelIds());
    const channels = (await listChannels(db)).filter((channel) => ids.has(channel.id));
    res.json({ data: channels, total: channels.length });
  } catch (err) {
    next(err);
  }
});

interface CreateChannelBody {
  channel_type?: unknown;
  name?: unknown;
  config?: unknown;
  enabled?: unknown;
}

router.post('/', async (req: Request<unknown, unknown, CreateChannelBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (typeof body.channel_type !== 'string' || typeof body.name !== 'string' || body.name.trim() === '') {
      badRequest(res, 'channel_type and name are required');
      return;
    }
    if (typeof body.config !== 'object' || body.config === null) {
      badRequest(res, 'config is required');
      return;
    }

    const summary = await createChannel(db, {
      channel_type: body.channel_type as ChannelType,
      name: body.name.trim(),
      config: body.config as ChannelConfig,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    });

    // createChannel defaults owner_kind to 'operator' at the column level;
    // stated here so a future default change cannot silently create a
    // subscriber row from an admin route.
    await db('delivery_channels').where({ id: summary.id }).update({ owner_kind: 'operator' });

    // `summary` carries config_masked, never the credential that was posted.
    res.status(201).json(summary);
  } catch (err) {
    // Both are operator input problems, not server faults. assertDiscordWebhookUrl
    // and the SSRF gate throw WebhookUrlError; everything else throws
    // ChannelConfigError. A 500 here would report a rejected URL as an outage.
    if (err instanceof ChannelConfigError || err instanceof WebhookUrlError) {
      badRequest(res, err.message);
      return;
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, 'Invalid channel id');
      return;
    }

    const owner = await db('delivery_channels')
      .where({ id, owner_kind: 'operator' })
      .first<{ id: string } | undefined>('id');
    if (!owner) {
      res.status(404).json({ error: 'Channel not found', statusCode: 404 });
      return;
    }

    const channel = await getChannel(db, id);
    const routes = await listRoutes(db, id);
    res.json({ channel, routes });
  } catch (err) {
    next(err);
  }
});

interface UpdateChannelBody {
  config?: unknown;
  enabled?: unknown;
}

router.patch('/:id', async (req: Request<{ id: string }, unknown, UpdateChannelBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, 'Invalid channel id');
      return;
    }

    const owner = await db('delivery_channels')
      .where({ id, owner_kind: 'operator' })
      .first<{ id: string } | undefined>('id');
    if (!owner) {
      res.status(404).json({ error: 'Channel not found', statusCode: 404 });
      return;
    }

    const body = req.body ?? {};
    let summary = null;

    if (typeof body.config === 'object' && body.config !== null) {
      summary = await updateChannelConfig(db, id, body.config as ChannelConfig);
    }
    if (typeof body.enabled === 'boolean') {
      summary = await setChannelEnabled(db, id, body.enabled);
    }

    if (!summary) {
      badRequest(res, 'No changes were supplied');
      return;
    }

    res.json(summary);
  } catch (err) {
    // Both are operator input problems, not server faults. assertDiscordWebhookUrl
    // and the SSRF gate throw WebhookUrlError; everything else throws
    // ChannelConfigError. A 500 here would report a rejected URL as an outage.
    if (err instanceof ChannelConfigError || err instanceof WebhookUrlError) {
      badRequest(res, err.message);
      return;
    }
    next(err);
  }
});

interface CreateRouteBody {
  channel_id?: unknown;
  event_type?: unknown;
  min_severity?: unknown;
  jurisdiction_id?: unknown;
  cadence?: unknown;
  daily_send_cap?: unknown;
  enabled?: unknown;
}

router.post('/:id/routes', async (req: Request<{ id: string }, unknown, CreateRouteBody>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      badRequest(res, 'Invalid channel id');
      return;
    }

    const owner = await db('delivery_channels')
      .where({ id, owner_kind: 'operator' })
      .first<{ id: string } | undefined>('id');
    if (!owner) {
      res.status(404).json({ error: 'Channel not found', statusCode: 404 });
      return;
    }

    const body = req.body ?? {};
    if (typeof body.event_type !== 'string' || body.event_type.trim() === '') {
      badRequest(res, 'event_type is required');
      return;
    }

    const route = await createRoute(db, {
      channel_id: id,
      event_type: body.event_type.trim(),
      min_severity: typeof body.min_severity === 'string' ? (body.min_severity as Severity) : null,
      jurisdiction_id: typeof body.jurisdiction_id === 'string' ? body.jurisdiction_id : null,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    });

    const update: Record<string, unknown> = {};
    if (typeof body.cadence === 'string') update.cadence = body.cadence as Cadence;
    if (typeof body.daily_send_cap === 'number') update.daily_send_cap = body.daily_send_cap;
    if (Object.keys(update).length > 0) {
      await db('channel_routes').where({ id: route.id }).update(update);
    }

    const stored = await db('channel_routes').where({ id: route.id }).first();
    res.status(201).json(stored);
  } catch (err) {
    next(err);
  }
});

export default router;
