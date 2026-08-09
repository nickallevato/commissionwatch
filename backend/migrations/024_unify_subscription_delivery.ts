import type { Knex } from 'knex';

/**
 * B-e — express a subscription in the delivery layer's terms.
 *
 * A subscription is a destination (a delivery_channel), a filter (a
 * channel_route) and a cadence (this migration's new column). Before this,
 * `alert_subscriptions` and `delivery_channels` were two implementations of
 * one idea, and the digest scheduler ran as a parallel system beside a
 * dispatcher no subscriber could reach.
 */
export async function up(knex: Knex): Promise<void> {
  // ---- delivery_channels -------------------------------------------------

  await knex.schema.alterTable('delivery_channels', (table) => {
    // An operator's Discord webhook and a reader's email address can share a
    // table but must not share a permission model. Every admin route filters
    // to 'operator'; every self-serve route to 'subscriber', scoped to the
    // token holder. Defaulting to 'operator' is right for the rows that exist
    // today — all of them were created by the operator.
    table.string('owner_kind', 20).notNullable().defaultTo('operator');

    // A subscriber destination is unconfirmed until its holder proves control
    // of it. Operator channels are verified by construction.
    table.boolean('verified').notNullable().defaultTo(true);
    table.timestamp('verified_at', { useTz: true }).nullable();
    table.string('verify_token', 64).nullable();
    table.string('unsubscribe_token', 64).nullable();
  });

  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_owner_kind_check
    CHECK (owner_kind IN ('operator', 'subscriber'))
  `);

  // A subscriber row without tokens is unreachable by verification and cannot
  // be removed by its own holder. The database refuses to hold one.
  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_subscriber_tokens_check
    CHECK (
      owner_kind <> 'subscriber'
      OR (verify_token IS NOT NULL AND unsubscribe_token IS NOT NULL)
    )
  `);

  // Tokens are credentials, per the launch-readiness data-handling section.
  // Unique so a lookup by token identifies exactly one channel.
  await knex.raw(`
    CREATE UNIQUE INDEX delivery_channels_verify_token_unique
    ON delivery_channels(verify_token) WHERE verify_token IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX delivery_channels_unsubscribe_token_unique
    ON delivery_channels(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX idx_delivery_channels_owner_kind ON delivery_channels(owner_kind)
  `);

  // SMS. W7 put it out of scope — "building them now is speculation" — and the
  // operator asked for it by name on 2026-08-09, which is what makes it no
  // longer speculation. Recorded in the B-e spec as an explicit reversal.
  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT delivery_channels_type_check');
  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_type_check
    CHECK (channel_type IN ('discord', 'email', 'webhook', 'sms'))
  `);

  // ---- channel_routes ----------------------------------------------------

  await knex.schema.alterTable('channel_routes', (table) => {
    // W7's routes are implicitly immediate. This is the column that lets the
    // existing digest scheduler drive the other channels rather than running
    // as a parallel system beside them.
    table.string('cadence', 20).notNullable().defaultTo('immediate');

    // SMS costs money per message, so a route can carry a per-day ceiling.
    // NULL means uncapped, which is the right default for every free channel.
    table.integer('daily_send_cap').nullable();
  });

  await knex.raw(`
    ALTER TABLE channel_routes
    ADD CONSTRAINT channel_routes_cadence_check
    CHECK (cadence IN ('immediate', 'daily', 'weekly'))
  `);

  await knex.raw(`
    ALTER TABLE channel_routes
    ADD CONSTRAINT channel_routes_daily_send_cap_check
    CHECK (daily_send_cap IS NULL OR daily_send_cap > 0)
  `);

  await knex.raw(`
    CREATE INDEX idx_channel_routes_cadence ON channel_routes(cadence)
  `);

  // One route per (channel, event type, jurisdiction). Without this a
  // double-submitted subscribe form silently doubles someone's mail.
  await knex.raw(`
    CREATE UNIQUE INDEX channel_routes_channel_event_jurisdiction_unique
    ON channel_routes(channel_id, event_type, COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid))
  `);

  // ---- deliveries --------------------------------------------------------

  // A message held for a digest, or held because a per-day cap was reached, is
  // neither sent nor failed nor skipped. Reusing 'skipped' would make "we
  // decided not to" indistinguishable from "we will, later" — and a
  // transparency project cannot afford a status that hides a backlog.
  await knex.raw('ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check');
  await knex.raw(`
    ALTER TABLE deliveries
    ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'deferred'))
  `);

  await knex.raw(`
    CREATE INDEX idx_deliveries_deferred ON deliveries(created_at) WHERE status = 'deferred'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_deliveries_deferred');
  await knex.raw('ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check');
  await knex.raw(`
    ALTER TABLE deliveries
    ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
  `);

  await knex.raw('DROP INDEX IF EXISTS channel_routes_channel_event_jurisdiction_unique');
  await knex.raw('DROP INDEX IF EXISTS idx_channel_routes_cadence');
  await knex.raw('ALTER TABLE channel_routes DROP CONSTRAINT IF EXISTS channel_routes_daily_send_cap_check');
  await knex.raw('ALTER TABLE channel_routes DROP CONSTRAINT IF EXISTS channel_routes_cadence_check');
  await knex.schema.alterTable('channel_routes', (table) => {
    table.dropColumn('daily_send_cap');
    table.dropColumn('cadence');
  });

  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT IF EXISTS delivery_channels_type_check');
  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_type_check
    CHECK (channel_type IN ('discord', 'email', 'webhook'))
  `);
  await knex.raw('DROP INDEX IF EXISTS idx_delivery_channels_owner_kind');
  await knex.raw('DROP INDEX IF EXISTS delivery_channels_unsubscribe_token_unique');
  await knex.raw('DROP INDEX IF EXISTS delivery_channels_verify_token_unique');
  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT IF EXISTS delivery_channels_subscriber_tokens_check');
  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT IF EXISTS delivery_channels_owner_kind_check');
  await knex.schema.alterTable('delivery_channels', (table) => {
    table.dropColumn('unsubscribe_token');
    table.dropColumn('verify_token');
    table.dropColumn('verified_at');
    table.dropColumn('verified');
    table.dropColumn('owner_kind');
  });
}
