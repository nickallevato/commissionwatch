import type { Knex } from 'knex';
import { encryptConfig } from '../src/services/delivery/crypto';

interface LegacySubscription {
  id: string;
  email: string;
  jurisdiction_id: string;
  email_enabled: boolean;
  digest_only: boolean;
  verified: boolean;
  verify_token: string;
  unsubscribe_token: string;
}

/**
 * Express the existing alert_subscriptions rows on the unified model.
 *
 * `alert_subscriptions` is deliberately left intact and untouched. Per W7's
 * standing constraint the existing email path keeps working throughout, and
 * per B-e the old table is retained read-only for one release and dropped in a
 * separate change. This migration only adds; it never rewrites or deletes.
 *
 * Two subscriptions from one address to two jurisdictions collapse into one
 * channel with two routes. That is the shape (email, jurisdiction_id) was
 * approximating, not a lossy conversion.
 *
 * There is no double-send risk from this: DeliveryDispatcher marks every
 * non-Discord channel `skipped`, so email still has exactly one sender — the
 * legacy path. Cutting email over is the separate change.
 */
export async function up(knex: Knex): Promise<void> {
  const subscriptions = await knex<LegacySubscription>('alert_subscriptions').select(
    'id',
    'email',
    'jurisdiction_id',
    'email_enabled',
    'digest_only',
    'verified',
    'verify_token',
    'unsubscribe_token',
  );

  if (subscriptions.length === 0) return;

  // CHANNEL_SECRET_KEY may legitimately be absent when migrations run — the
  // host fetches it into the container's environment, and a migration that
  // throws leaves the deploy dead. Skipping loudly is recoverable: this
  // migration is idempotent and can be re-run by hand once the key is present.
  try {
    encryptConfig({ email: 'probe@example.invalid' });
  } catch {
    console.warn(
      'Migration 025: CHANNEL_SECRET_KEY is not set, so alert_subscriptions were not ' +
        'back-filled onto delivery_channels. The legacy email path is unaffected. ' +
        'Re-run this migration once the key is available.',
    );
    return;
  }

  for (const subscription of subscriptions) {
    const existing = await knex('delivery_channels')
      .where({ name: subscription.email })
      .first<{ id: string } | undefined>('id');

    let channelId: string;
    if (existing) {
      channelId = existing.id;
    } else {
      const [row] = await knex('delivery_channels')
        .insert({
          channel_type: 'email',
          owner_kind: 'subscriber',
          // One destination, one channel. The filters live in the routes.
          name: subscription.email,
          config_encrypted: encryptConfig({ email: subscription.email }),
          enabled: subscription.email_enabled,
          verified: subscription.verified,
          verified_at: subscription.verified ? knex.fn.now() : null,
          verify_token: subscription.verify_token,
          unsubscribe_token: subscription.unsubscribe_token,
        })
        .returning<Array<{ id: string }>>('id');
      channelId = row.id;
    }

    await knex('channel_routes')
      .insert({
        channel_id: channelId,
        event_type: 'anomaly.flagged',
        jurisdiction_id: subscription.jurisdiction_id,
        min_severity: null,
        // digest_only was a boolean standing in for a cadence. This is the
        // column it was approximating.
        cadence: subscription.digest_only ? 'daily' : 'immediate',
        enabled: subscription.email_enabled,
      })
      .onConflict(knex.raw(
        `(channel_id, event_type, COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
      ))
      .ignore();
  }

  console.log(
    `Migration 025: expressed ${subscriptions.length} alert_subscriptions on the unified model. ` +
      'The legacy table is retained read-only and is dropped in a separate change.',
  );
}

export async function down(knex: Knex): Promise<void> {
  // Only the rows this migration could have created. Operator channels are
  // never touched.
  await knex('channel_routes')
    .whereIn(
      'channel_id',
      knex('delivery_channels').select('id').where({ owner_kind: 'subscriber' }),
    )
    .del();
  await knex('delivery_channels').where({ owner_kind: 'subscriber' }).del();
}
