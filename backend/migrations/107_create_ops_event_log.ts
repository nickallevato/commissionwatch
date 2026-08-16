import type { Knex } from 'knex';

/**
 * A durable, unconditional record of operational events — independent of
 * whether any delivery channel is configured to hear about them.
 *
 * ## Why this exists
 *
 * `DeliveryDispatcher.dispatch()` (`src/services/delivery/dispatcher.ts`) only
 * writes a `deliveries` row per **matched channel route**. An event that
 * matches zero routes — no operator has wired `ops.*` to a channel yet, or the
 * one channel that was wired is later removed — leaves no row anywhere. That
 * is the right behaviour for `deliveries`, whose whole job is "what did we
 * send and to whom", but it means nothing durable records "did the backup
 * succeed" independent of notification configuration. The 2026-08-16 maturity
 * review named this precisely: `external-monitor.ts` probes the deployed site
 * over HTTP and cannot read the host, `backup.sh` already emits an ops event
 * on every run, and yet nothing the monitor can reach records whether that
 * event was ever emitted at all.
 *
 * This table is the honest fix: every `ops.*` event `emit-ops-event.ts`
 * processes is written here once, unconditionally, before dispatch is
 * attempted — so "was a backup ever recorded as successful" has one place to
 * ask that does not depend on an operator having configured Discord.
 *
 * `/api/health` reads the latest `ops.backup_succeeded` row from this table
 * and reports it in its public, unauthenticated `backup` field, and
 * `external-monitor.ts` judges freshness against it — the same pattern
 * `resources` already uses for disk/memory pressure the monitor cannot
 * otherwise see.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ops_event_log', (table) => {
    table.bigIncrements('id').primary();

    // Not a foreign key against a closed enum table: this log is meant to
    // outlive any given release's idea of what event names exist, the same
    // reasoning `export_snapshot_datasets.dataset` uses for its own free-text
    // name.
    table.text('event_type').notNullable();

    table.text('detail').notNullable().defaultTo('');
    table.text('source').notNullable().defaultTo('ops');
    table.text('host').notNullable().defaultTo('unknown');

    // When the thing actually happened, as the emitting script understands
    // it — distinct from `created_at`, which is when this row was written.
    // They will usually be the same instant; keeping them separate columns
    // costs nothing and avoids ever having to explain why they briefly
    // disagreed.
    table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // The read this table exists to serve — "when did event X last occur" —
    // is always "most recent row of this type", so index for exactly that.
    table.index(['event_type', 'occurred_at'], 'idx_ops_event_log_type_occurred');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ops_event_log');
}
