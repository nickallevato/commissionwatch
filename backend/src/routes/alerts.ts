import { Router, type Request } from 'express';
import db from '../config/database';
import {
  SubscriptionError,
  SubscriptionService,
  type Cadence,
} from '../services/delivery/subscriptions';
import { ChannelConfigError, type Severity } from '../services/delivery/channels';
import { WebhookUrlError } from '../services/delivery/discord';

/**
 * Public self-serve alerts, on the unified delivery model.
 *
 * `/api/subscriptions` is the legacy email-only surface. It is untouched and
 * keeps working: per W7's standing constraint the existing email path stays
 * green throughout, and B-e retains the old table read-only for one release.
 * This is the surface the new UI talks to.
 *
 * Everything is addressed by the holder's own unsubscribe token. There is no
 * listing endpoint and no id-addressed read — a reader can reach their own
 * subscription and nothing else, and a token that resolves to nothing gets a
 * 404 rather than a 403, because a stranger has no business learning that a
 * given address is subscribed.
 */

const router = Router();
const service = new SubscriptionService(db);

const TOKEN_RE = /^[0-9a-f]{64}$/i;

interface SubscribeBody {
  channel_type?: unknown;
  destination?: unknown;
  jurisdiction_id?: unknown;
  event_type?: unknown;
  min_severity?: unknown;
  cadence?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

router.post('/', async (req: Request<unknown, unknown, SubscribeBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (!isString(body.channel_type) || !isString(body.destination)) {
      res
        .status(400)
        .json({ error: 'channel_type and destination are required', statusCode: 400 });
      return;
    }

    const result = await service.subscribe({
      channel_type: body.channel_type as 'email' | 'sms' | 'webhook',
      destination: body.destination,
      jurisdiction_id: isString(body.jurisdiction_id) ? body.jurisdiction_id : null,
      event_type: isString(body.event_type) ? body.event_type : undefined,
      min_severity: isString(body.min_severity) ? (body.min_severity as Severity) : null,
      cadence: isString(body.cadence) ? (body.cadence as Cadence) : undefined,
    });

    // The verify token is returned exactly once, at creation, so it can be
    // delivered to the holder. It is never readable again.
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof SubscriptionError) {
      res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
      return;
    }
    // A malformed destination, a non-E.164 number, or a webhook URL the SSRF
    // gate refuses are all reader input problems. Reporting them as 500 would
    // read as an outage and tell the reader nothing they can act on.
    if (err instanceof ChannelConfigError || err instanceof WebhookUrlError) {
      res.status(400).json({ error: err.message, statusCode: 400 });
      return;
    }
    next(err);
  }
});

router.get('/verify/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      res.status(400).json({ error: 'Invalid verification token', statusCode: 400 });
      return;
    }

    const view = await service.verify(token);
    if (!view) {
      res.status(404).json({ error: 'Invalid or expired verification token', statusCode: 404 });
      return;
    }

    res.json({ message: 'Subscription verified', subscription: view });
  } catch (err) {
    next(err);
  }
});

router.get('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      res.status(400).json({ error: 'Invalid token', statusCode: 400 });
      return;
    }

    const view = await service.readByToken(token);
    if (!view) {
      res.status(404).json({ error: 'Subscription not found', statusCode: 404 });
      return;
    }

    res.json(view);
  } catch (err) {
    next(err);
  }
});

interface UpdateRouteBody {
  route_id?: unknown;
  cadence?: unknown;
  min_severity?: unknown;
  enabled?: unknown;
}

router.patch('/:token', async (req: Request<{ token: string }, unknown, UpdateRouteBody>, res, next) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      res.status(400).json({ error: 'Invalid token', statusCode: 400 });
      return;
    }

    const body = req.body ?? {};
    if (!isString(body.route_id)) {
      res.status(400).json({ error: 'route_id is required', statusCode: 400 });
      return;
    }

    const view = await service.updateRoute(token, body.route_id, {
      cadence: isString(body.cadence) ? (body.cadence as Cadence) : undefined,
      min_severity:
        body.min_severity === null
          ? null
          : isString(body.min_severity)
            ? (body.min_severity as Severity)
            : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });

    if (!view) {
      res.status(404).json({ error: 'Subscription not found', statusCode: 404 });
      return;
    }

    res.json(view);
  } catch (err) {
    if (err instanceof SubscriptionError) {
      res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
      return;
    }
    // A malformed destination, a non-E.164 number, or a webhook URL the SSRF
    // gate refuses are all reader input problems. Reporting them as 500 would
    // read as an outage and tell the reader nothing they can act on.
    if (err instanceof ChannelConfigError || err instanceof WebhookUrlError) {
      res.status(400).json({ error: err.message, statusCode: 400 });
      return;
    }
    next(err);
  }
});

router.delete('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
      res.status(400).json({ error: 'Invalid token', statusCode: 400 });
      return;
    }

    const view = await service.unsubscribe(token);
    if (!view) {
      res.status(404).json({ error: 'Subscription not found', statusCode: 404 });
      return;
    }

    // Not 204: a second click on an old unsubscribe link must be able to say
    // "you are unsubscribed" rather than look like a broken page.
    res.json({ message: 'Unsubscribed', subscription: view });
  } catch (err) {
    next(err);
  }
});

export default router;
