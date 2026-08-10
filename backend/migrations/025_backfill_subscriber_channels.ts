import type { Knex } from 'knex';
import { createCipheriv, randomBytes } from 'node:crypto';

/**
 * Deliberately self-contained. This file previously imported `encryptConfig`
 * from `../src/services/delivery/crypto`, which works on every developer
 * machine and in no production image: `backend/Dockerfile` copies `dist/` and
 * `migrations/`, never `src/`. The import therefore resolved in every test and
 * failed at module load inside the container, before a single line of the
 * careful logic below could run — so even a database with zero subscriptions
 * died here. The entrypoint runs migrations under `set -e`, so the server never
 * started, and `restart: unless-stopped` retried the same failure forever. That
 * took production down from 2026-08-09T23:18Z until it was found.
 *
 * A migration runs against schemas its author will never see, in an image that
 * ships no application source. It must depend on nothing but knex and the Node
 * standard library. `backend/test/migrations-selfcontained.test.ts` enforces
 * that for every migration, so this cannot recur.
 *
 * The envelope below MUST stay byte-identical to
 * `src/services/delivery/crypto.ts`, because the application reads what this
 * writes: [version:1][iv:12][tag:16][ciphertext:n], AES-256-GCM, version 1.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

function resolveChannelKey(): Buffer {
  const raw = (process.env.CHANNEL_SECRET_KEY ?? '').trim();
  if (raw.length === 0) {
    throw new Error('CHANNEL_SECRET_KEY is not set');
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CHANNEL_SECRET_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

function encryptConfig(config: unknown): Buffer {
  const key = resolveChannelKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

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
