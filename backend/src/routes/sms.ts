import { Router } from 'express';
import db from '../config/database';
import {
  classifyInboundMessage,
  isE164,
  SMS_HELP_TEXT,
  validateTwilioSignature,
} from '../services/delivery/sms';
import { SubscriptionService } from '../services/delivery/subscriptions';

/**
 * Twilio's inbound webhook.
 *
 * `STOP` must unsubscribe. That is a carrier requirement, not a courtesy, and
 * it is the half of SMS consent that cannot be handled at subscribe time.
 *
 * The request body is the only thing naming the number, so without signature
 * validation this endpoint is an unauthenticated "unsubscribe anyone" API.
 * The signature is therefore checked **before** anything is looked up, and a
 * failure is a flat 403 that reveals nothing about whether the number exists.
 */

const router = Router();
const service = new SubscriptionService(db);

/**
 * The URL Twilio signed. Behind Caddy the request arrives as plain http on an
 * internal hop, so the public URL has to be configured rather than
 * reconstructed — a reconstructed http:// URL never matches a signature
 * computed over https://.
 */
function signedUrl(path: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

function twiml(message: string | null): string {
  return message === null
    ? '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;
}

router.post('/inbound', async (req, res, next) => {
  try {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.body ?? {})) {
      if (typeof value === 'string') params[key] = value;
    }

    const valid = validateTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? '',
      signedUrl('/api/sms/inbound'),
      params,
      req.get('x-twilio-signature') ?? undefined,
    );

    if (!valid) {
      res.status(403).json({ error: 'Invalid signature', statusCode: 403 });
      return;
    }

    const from = params.From ?? '';
    const intent = classifyInboundMessage(params.Body ?? '');

    if (intent === 'help') {
      res.type('text/xml').send(twiml(SMS_HELP_TEXT));
      return;
    }

    if (!isE164(from) || intent === 'unknown') {
      // Silence rather than an error message. An unrecognised word is not a
      // failure the sender needs to hear about, and answering costs money.
      res.type('text/xml').send(twiml(null));
      return;
    }

    const channel = await db('delivery_channels')
      .where({ name: from, owner_kind: 'subscriber', channel_type: 'sms' })
      .first<{ unsubscribe_token: string | null } | undefined>('unsubscribe_token');

    if (!channel?.unsubscribe_token) {
      res.type('text/xml').send(twiml(null));
      return;
    }

    if (intent === 'stop') {
      await service.unsubscribe(channel.unsubscribe_token);
      // Carriers handle the STOP confirmation themselves; a second message
      // from us would be both redundant and billable.
      res.type('text/xml').send(twiml(null));
      return;
    }

    await service.resubscribe(channel.unsubscribe_token);
    res.type('text/xml').send(twiml('You are resubscribed to CommissionWatch alerts.'));
  } catch (err) {
    next(err);
  }
});

export default router;
