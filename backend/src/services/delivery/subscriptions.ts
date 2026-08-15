import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { encryptConfig } from './crypto';
import {
  maskConfig,
  validateChannelConfig,
  type Cadence,
  type ChannelConfig,
  type ChannelType,
  type Severity,
} from './channels';
import { assertE164 } from './sms';
import type { HostLookup } from './discord';

/**
 * Subscriptions, expressed in the delivery layer's terms.
 *
 *   destination (a delivery_channel, owner_kind='subscriber')
 * + filter      (a channel_route: event type, jurisdiction, min severity)
 * + cadence     (immediate | daily | weekly)
 *
 * Everything here is scoped to `owner_kind = 'subscriber'`. An operator
 * channel id handed to a self-serve route resolves to nothing at all — not a
 * 403, because the caller has no business learning it exists.
 */

/** Re-exported so callers reach for the cadence type beside the API that uses it. */
export type { Cadence };

export const CADENCES: readonly Cadence[] = ['immediate', 'daily', 'weekly'];

/** Destinations a reader may subscribe with. Discord is operator-only. */
export type SubscriberChannelType = Extract<ChannelType, 'email' | 'sms' | 'webhook'>;

export const SUBSCRIBER_CHANNEL_TYPES: readonly SubscriberChannelType[] = [
  'email',
  'sms',
  'webhook',
];

export const DEFAULT_EVENT_TYPE = 'anomaly.flagged';

export interface SubscribeInput {
  channel_type: SubscriberChannelType;
  /** An email address, an E.164 phone number, or a webhook URL. */
  destination: string;
  jurisdiction_id?: string | null;
  event_type?: string;
  min_severity?: Severity | null;
  cadence?: Cadence;
}

export interface SubscriptionRouteView {
  id: string;
  event_type: string;
  jurisdiction_id: string | null;
  min_severity: Severity | null;
  cadence: Cadence;
  enabled: boolean;
}

/**
 * A subscriber's own view. The destination is masked even here: the holder
 * already knows their address, and an unmasked read is a route by which a
 * leaked token becomes a leaked address book.
 */
export interface SubscriptionView {
  channel_id: string;
  channel_type: ChannelType;
  destination_masked: string;
  verified: boolean;
  enabled: boolean;
  routes: SubscriptionRouteView[];
}

export interface SubscribeResult extends SubscriptionView {
  /**
   * For the mailer, and for nothing that answers an HTTP request.
   *
   * The token's whole job is to prove that whoever holds it reads the address.
   * Handing it back to the caller destroys that: the caller can then verify an
   * address they do not own, which is double opt-in with the opt-in removed.
   * Delivery §5d names this a consent hole rather than a cosmetic one, and
   * `routes/alerts.ts` is where it is kept out of the response — the service
   * still returns it because the thing that mails it needs it, and that thing
   * does not exist yet.
   */
  verify_token: string | null;
  unsubscribe_token: string;
  /**
   * Did this request create the channel, or find one that was already there?
   *
   * The distinction is load-bearing. `subscribe` on an address that is already
   * subscribed returns *that subscriber's* management token, so without this the
   * route would hand a stranger who typed a known address the token that reads,
   * edits and cancels it. Only a freshly minted token may be returned to the
   * caller, because only then is the caller demonstrably the person who made it.
   */
  created: boolean;
}

export class SubscriptionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'SubscriptionError';
    this.statusCode = statusCode;
  }
}

interface ChannelRow {
  id: string;
  channel_type: ChannelType;
  owner_kind: 'operator' | 'subscriber';
  name: string;
  config_encrypted: Buffer;
  enabled: boolean;
  verified: boolean;
  verify_token: string | null;
  unsubscribe_token: string | null;
}

interface RouteRow {
  id: string;
  event_type: string;
  jurisdiction_id: string | null;
  min_severity: Severity | null;
  cadence: Cadence;
  enabled: boolean;
}

const TOKEN_BYTES = 32;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

function configFor(channelType: SubscriberChannelType, destination: string): ChannelConfig {
  if (channelType === 'email') return { email: destination };
  if (channelType === 'sms') return { phone: destination };
  return { webhook_url: destination };
}

export interface SubscriptionServiceOptions {
  lookup?: HostLookup;
  now?: () => Date;
}

export class SubscriptionService {
  private readonly lookup?: HostLookup;
  private readonly now: () => Date;

  constructor(
    private readonly db: Knex,
    options: SubscriptionServiceOptions = {},
  ) {
    this.lookup = options.lookup;
    this.now = options.now ?? (() => new Date());
  }

  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    const channelType = input.channel_type;
    if (!SUBSCRIBER_CHANNEL_TYPES.includes(channelType)) {
      throw new SubscriptionError(`"${channelType}" is not a destination readers can subscribe with`);
    }

    const destination = input.destination.trim();
    if (destination === '') throw new SubscriptionError('A destination is required');

    const cadence = input.cadence ?? 'immediate';
    if (!CADENCES.includes(cadence)) {
      throw new SubscriptionError(`"${cadence}" is not a cadence`);
    }

    // SMS destinations are validated to E.164 before anything else touches
    // them; a malformed number is a message that costs money and goes nowhere.
    if (channelType === 'sms') assertE164(destination);

    const config = configFor(channelType, destination);
    // The same SSRF gate operator channels pass through. A reader-supplied
    // webhook URL is still a request this server will make.
    await validateChannelConfig(channelType, config, { lookup: this.lookup });

    if (input.jurisdiction_id) {
      const jurisdiction = await this.db('jurisdictions')
        .where({ id: input.jurisdiction_id })
        .first('id');
      if (!jurisdiction) throw new SubscriptionError('Jurisdiction not found');
    }

    const existing = await this.db<ChannelRow>('delivery_channels')
      .where({ name: destination })
      .first();

    let channel: ChannelRow;
    let created = false;
    if (existing) {
      if (existing.owner_kind !== 'subscriber') {
        // The destination is already an operator channel. Refusing without
        // saying why is deliberate: confirming the address would tell a
        // stranger which addresses the operator uses.
        throw new SubscriptionError('That destination cannot be subscribed', 409);
      }
      channel = existing;
    } else {
      const verify_token = newToken();
      const unsubscribe_token = newToken();
      const [row] = await this.db('delivery_channels')
        .insert({
          channel_type: channelType,
          owner_kind: 'subscriber',
          name: destination,
          config_encrypted: encryptConfig(config),
          enabled: true,
          verified: false,
          verify_token,
          unsubscribe_token,
        })
        .returning<ChannelRow[]>('*');
      channel = row;
      created = true;
    }

    await this.db('channel_routes')
      .insert({
        channel_id: channel.id,
        event_type: input.event_type ?? DEFAULT_EVENT_TYPE,
        jurisdiction_id: input.jurisdiction_id ?? null,
        min_severity: input.min_severity ?? null,
        cadence,
        enabled: true,
      })
      .onConflict(
        this.db.raw(
          `(channel_id, event_type, COALESCE(jurisdiction_id, '${NIL_UUID}'::uuid))`,
        ),
      )
      .merge(['min_severity', 'cadence', 'enabled']);

    const view = await this.viewFor(channel.id);
    return {
      ...view,
      verify_token: channel.verify_token,
      unsubscribe_token: channel.unsubscribe_token ?? '',
      created,
    };
  }

  /** Idempotent: verifying an already-verified channel is a success, not an error. */
  async verify(token: string): Promise<SubscriptionView | null> {
    const channel = await this.subscriberChannelBy({ verify_token: token });
    if (!channel) return null;

    await this.db('delivery_channels').where({ id: channel.id }).update({
      verified: true,
      verified_at: this.now(),
      updated_at: this.now(),
    });

    return this.viewFor(channel.id);
  }

  /**
   * Disable every route and the channel itself. The row is kept rather than
   * deleted so the unsubscribe token stays resolvable — a second click on the
   * link in an old email must say "you are unsubscribed", not 404.
   */
  async unsubscribe(token: string): Promise<SubscriptionView | null> {
    const channel = await this.subscriberChannelBy({ unsubscribe_token: token });
    if (!channel) return null;

    await this.db('channel_routes').where({ channel_id: channel.id }).update({ enabled: false });
    await this.db('delivery_channels')
      .where({ id: channel.id })
      .update({ enabled: false, updated_at: this.now() });

    return this.viewFor(channel.id);
  }

  /** Re-enable after an unsubscribe — the STOP/START pair SMS consent requires. */
  async resubscribe(token: string): Promise<SubscriptionView | null> {
    const channel = await this.subscriberChannelBy({ unsubscribe_token: token });
    if (!channel) return null;

    await this.db('channel_routes').where({ channel_id: channel.id }).update({ enabled: true });
    await this.db('delivery_channels')
      .where({ id: channel.id })
      .update({ enabled: true, updated_at: this.now() });

    return this.viewFor(channel.id);
  }

  async readByToken(token: string): Promise<SubscriptionView | null> {
    const channel = await this.subscriberChannelBy({ unsubscribe_token: token });
    return channel ? this.viewFor(channel.id) : null;
  }

  /** Change cadence or minimum severity on one of the holder's own routes. */
  async updateRoute(
    token: string,
    routeId: string,
    changes: { cadence?: Cadence; min_severity?: Severity | null; enabled?: boolean },
  ): Promise<SubscriptionView | null> {
    const channel = await this.subscriberChannelBy({ unsubscribe_token: token });
    if (!channel) return null;

    if (changes.cadence && !CADENCES.includes(changes.cadence)) {
      throw new SubscriptionError(`"${changes.cadence}" is not a cadence`);
    }

    const update: Record<string, unknown> = {};
    if (changes.cadence) update.cadence = changes.cadence;
    if (changes.min_severity !== undefined) update.min_severity = changes.min_severity;
    if (typeof changes.enabled === 'boolean') update.enabled = changes.enabled;
    if (Object.keys(update).length === 0) {
      throw new SubscriptionError('No changes were supplied');
    }

    // Scoped to the token holder's own channel: a route id from someone else's
    // subscription matches nothing.
    const updated = await this.db('channel_routes')
      .where({ id: routeId, channel_id: channel.id })
      .update(update);
    if (updated === 0) return null;

    return this.viewFor(channel.id);
  }

  private async subscriberChannelBy(
    where: Record<string, string>,
  ): Promise<ChannelRow | null> {
    if (Object.values(where).some((value) => !value)) return null;
    const row = await this.db<ChannelRow>('delivery_channels')
      .where({ ...where, owner_kind: 'subscriber' })
      .first();
    return row ?? null;
  }

  private async viewFor(channelId: string): Promise<SubscriptionView> {
    const channel = await this.db('delivery_channels')
      .where({ id: channelId })
      .first<{
        id: string;
        channel_type: ChannelType;
        name: string;
        enabled: boolean;
        verified: boolean;
      }>('id', 'channel_type', 'name', 'enabled', 'verified');

    const routes = await this.db<RouteRow>('channel_routes')
      .where({ channel_id: channelId })
      .orderBy('event_type', 'asc')
      .select('id', 'event_type', 'jurisdiction_id', 'min_severity', 'cadence', 'enabled');

    return {
      channel_id: channel.id,
      channel_type: channel.channel_type,
      destination_masked: maskConfig(channel.channel_type, configForName(channel.channel_type, channel.name)),
      verified: channel.verified,
      enabled: channel.enabled,
      routes,
    };
  }
}

function configForName(channelType: ChannelType, name: string): ChannelConfig {
  if (channelType === 'email') return { email: name };
  if (channelType === 'sms') return { phone: name };
  return { webhook_url: name };
}
