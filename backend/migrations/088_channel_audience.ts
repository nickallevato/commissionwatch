import type { Knex } from 'knex';

/**
 * An ops channel is a different row from a public one, and the database says so.
 *
 * The delivery spec § 3 states it plainly: "A public Discord channel is a public
 * consumer, so it filters `subject_kind <> 'ops'`. An ops channel is a separate
 * channel row with its own webhook, and the plan must make that separation
 * explicit rather than leave it to an operator's route configuration."
 *
 * Nothing enforced it. `whereEventPublic` filters `subject_kind <> 'ops'` for
 * the consumers that read `events` directly — the feed, the calendar — but the
 * dispatcher does not read `events`, it reads `channel_routes`. An operator who
 * routes `*` to a community Discord server to save creating five rows has
 * subscribed a public server to every sweep failure, every stale-source
 * warning, and every dispute, and nothing between the form and the webhook
 * would have said no.
 *
 * So `delivery_channels.audience` is what a channel is *for*, and a public
 * channel may not carry a route in a restricted namespace. The check is a
 * trigger rather than application code because `channel_routes` has two writers
 * — `services/delivery/channels.ts` and the self-serve subscribe path in
 * `services/delivery/subscriptions.ts`, which inserts directly — and a rule
 * that lives in one of them is a rule the other does not have.
 *
 * `dispute` joins `ops` in the restricted list even though nothing emits it
 * yet. A dispute is never published (migration 039), so the day something does
 * emit one, the route that leaks it must already be impossible.
 *
 * The bare `*` is restricted too. It is not a namespace, it matches everything
 * including `ops.*`, and it is exactly the shortcut an operator reaches for.
 * The prefix forms — `meeting.*`, `finding.*`, `claim.*` — are what `*` was
 * being used for, they already work (`eventTypeMatchers`), and they are safe.
 */

/** `ops` and `dispute`, as SQL. Kept beside the trigger that reads it. */
const RESTRICTED_PREDICATE = `
  NEW.event_type = '*'
  OR NEW.event_type = 'ops' OR NEW.event_type LIKE 'ops.%'
  OR NEW.event_type = 'dispute' OR NEW.event_type LIKE 'dispute.%'
`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('delivery_channels', (table) => {
    // 'public' is the safe default: a new channel cannot receive ops events
    // until somebody says it is for them. Existing rows are corrected below.
    table.string('audience', 20).notNullable().defaultTo('public');
  });

  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_audience_check
    CHECK (audience IN ('public', 'ops'))
  `);

  // Preserve what is already configured. A channel that carries a restricted
  // route today is being used as an ops channel today — `deploy/backup.sh`
  // dispatches `ops.backup_failed` through exactly this table — and defaulting
  // it to 'public' would silently stop the one notification an operator most
  // needs. This migration changes what can be configured next, not what is
  // already delivered.
  await knex.raw(`
    UPDATE delivery_channels SET audience = 'ops'
    WHERE id IN (
      SELECT channel_id FROM channel_routes
      WHERE event_type = '*'
         OR event_type = 'ops' OR event_type LIKE 'ops.%'
         OR event_type = 'dispute' OR event_type LIKE 'dispute.%'
    )
  `);

  await knex.raw(`
    CREATE INDEX idx_delivery_channels_audience ON delivery_channels(audience)
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION channel_routes_audience_guard() RETURNS trigger AS $$
    DECLARE
      channel_audience text;
    BEGIN
      SELECT audience INTO channel_audience
        FROM delivery_channels WHERE id = NEW.channel_id;

      IF channel_audience = 'public' AND (${RESTRICTED_PREDICATE}) THEN
        RAISE EXCEPTION
          'event type "%" may only be routed to a channel whose audience is ops', NEW.event_type
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER channel_routes_audience_guard_trigger
    BEFORE INSERT OR UPDATE ON channel_routes
    FOR EACH ROW EXECUTE FUNCTION channel_routes_audience_guard()
  `);

  // The other half of the same rule. Without it the guard is bypassed by
  // creating an ops channel, adding `ops.*`, then flipping it to public — which
  // is not a clever attack, it is what relabelling a channel looks like.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION delivery_channels_audience_guard() RETURNS trigger AS $$
    DECLARE
      restricted integer;
    BEGIN
      IF NEW.audience = 'public' AND OLD.audience <> 'public' THEN
        SELECT count(*) INTO restricted FROM channel_routes
          WHERE channel_id = NEW.id
            AND (event_type = '*'
              OR event_type = 'ops' OR event_type LIKE 'ops.%'
              OR event_type = 'dispute' OR event_type LIKE 'dispute.%');

        IF restricted > 0 THEN
          RAISE EXCEPTION
            'channel % still carries % restricted route(s); remove them before making it public',
            NEW.id, restricted
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER delivery_channels_audience_guard_trigger
    BEFORE UPDATE ON delivery_channels
    FOR EACH ROW EXECUTE FUNCTION delivery_channels_audience_guard()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS delivery_channels_audience_guard_trigger ON delivery_channels');
  await knex.raw('DROP FUNCTION IF EXISTS delivery_channels_audience_guard()');
  await knex.raw('DROP TRIGGER IF EXISTS channel_routes_audience_guard_trigger ON channel_routes');
  await knex.raw('DROP FUNCTION IF EXISTS channel_routes_audience_guard()');
  await knex.raw('DROP INDEX IF EXISTS idx_delivery_channels_audience');
  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT IF EXISTS delivery_channels_audience_check');
  await knex.schema.alterTable('delivery_channels', (table) => {
    table.dropColumn('audience');
  });
}
