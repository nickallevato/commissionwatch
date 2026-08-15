import type { Knex } from 'knex';

/**
 * `dry_run` — the status a send got when nothing was sent.
 *
 * `EmailDeliveryService.sendEmail` logs `[dry-run]` and returns when no provider
 * is configured, and both callers then wrote `email_status: 'sent'` with a
 * timestamp regardless. `DigestScheduler` has been running that path daily in
 * production against a service with no `RESEND_API_KEY`, so the table has been
 * accumulating rows that claim a person was emailed when nobody was.
 *
 * That is worse than a missing feature. `notifications` is the record of what
 * this project told people, and the delivery design makes it a precondition for
 * any outbound mail — including the dispute acknowledgement, where "we replied"
 * is the whole content of the promise.
 *
 * The value is added rather than the write being silently corrected because the
 * distinction has to survive in the column. A dry run is not a failure — nothing
 * went wrong, and marking it `failed` would put a retry queue behind a
 * deployment choice. It is its own outcome and the schema now says so.
 *
 * Existing rows are left alone. They are wrong, and there is no way to tell from
 * here which of them were genuinely sent — the deployment's configuration at the
 * time is not recorded anywhere. Rewriting them would replace a known-unreliable
 * history with an invented one.
 */

const STATUSES = ['pending', 'queued', 'sent', 'failed', 'skipped', 'dry_run'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_email_status_check');
  await knex.raw(`
    ALTER TABLE notifications
    ADD CONSTRAINT notifications_email_status_check
    CHECK (email_status IN (${STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Narrowing the CHECK fails loudly if any row has taken the new value, which
  // is the correct outcome: rolling back would otherwise leave rows the
  // constraint forbids and the next write would be the one that breaks.
  await knex.raw('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_email_status_check');
  await knex.raw(`
    ALTER TABLE notifications
    ADD CONSTRAINT notifications_email_status_check
    CHECK (email_status IN ('pending', 'queued', 'sent', 'failed', 'skipped'))
  `);
}
