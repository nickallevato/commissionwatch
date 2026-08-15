import type { Knex } from 'knex';

/**
 * The ledger of the archive's scheduled cycles — including the ones that did
 * nothing, and why.
 *
 * ## Why a table and not a log line
 *
 * `105_create_export_snapshots.ts` gave the dated archive somewhere to keep what
 * the export held on a day. Nothing ever called it: the only entry point was
 * `npm run export:snapshot`, a command a human has to remember, so the archive
 * was exactly as dense as an operator's habit and in practice held one snapshot,
 * taken the day somebody tested it.
 *
 * The scheduler that fixes that is gated on the `dated_export_archive` feature,
 * which is off by default and must stay off. A gated loop that does nothing
 * quietly is indistinguishable from a broken one — an operator turning the
 * switch on and seeing no snapshot has no way to tell "the loop is skipping
 * because the flag was off" from "the loop is not running". So **every cycle
 * lands in a row here**, skips included, and the operator console reads from
 * those rows. That is the same rule `ingestion_runs` applies to a sweep, for the
 * same reason: failures and refusals are disclosed, not swallowed.
 *
 * ## Why one row per (day, outcome) rather than one per cycle
 *
 * The loop wakes hourly, so a per-cycle row would be 24 rows a day saying the
 * same thing, forever, on a feature that is off. Instead a row is one *fact
 * about a day* — "on 2026-08-15 this loop skipped because the feature was off,
 * 24 times, most recently at 23:00" — which is what an operator actually reads,
 * and it bounds the table at a handful of rows per day.
 *
 * `cycles` and `last_at` carry what the collapse would otherwise lose: that the
 * loop is still alive. A single row with a stale `last_at` says the process
 * stopped ticking, which is a different fault from the feature being off, and
 * both are visible here.
 *
 * `run_day` is the UTC date, because that is how `/api/data/archive/{date}`
 * addresses a snapshot. Two names for a day on the two halves of one feature is
 * how an off-by-one lands in the only place that cannot be re-derived later.
 *
 * ## The constraints
 *
 * `export_snapshot_runs_taken_names_snapshot` is the one that matters: a row
 * claiming a snapshot was taken has to name it. Without it this table could
 * report a snapshot the archive cannot serve, which is precisely the
 * "shipped a feature with no data behind it" failure the whole task exists to
 * end. Both disjuncts are null-safe — `outcome` is NOT NULL and `IS NOT NULL`
 * never evaluates to NULL — see `098_null_safe_check_constraints.ts` and the
 * class test in `migrations-selfcontained.test.ts`.
 *
 * The unique index over `(run_day, outcome)` is what makes the upsert the whole
 * concurrency story, and the FK's `CASCADE` means deleting a snapshot deletes the
 * record of having taken it: a run row pointing at a snapshot that is gone would
 * be a claim the archive cannot stand behind.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('export_snapshot_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // UTC, and the same day the archive addresses by.
    table.date('run_day').notNullable();

    // `taken` | `skipped_disabled` | `skipped_same_day` | `skipped_locked` | `failed`.
    // Constrained below rather than by an enum type, so adding an outcome is a
    // migration and not a type rewrite.
    table.text('outcome').notNullable();

    // How many cycles reached this outcome today. A loop that is alive and
    // skipping looks different from one that has stopped, and this is the
    // difference.
    table.integer('cycles').notNullable().defaultTo(1);

    table.timestamp('first_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Set only for `taken`. CASCADE because a run row naming a snapshot that has
    // been deleted would claim the archive holds a day it does not.
    table
      .uuid('snapshot_id')
      .nullable()
      .references('id')
      .inTable('export_snapshots')
      .onDelete('CASCADE');

    // Why, in words: the feature name for a skip, the error text for a failure,
    // the dataset and row totals for a snapshot. Nullable because a row can be
    // fully described by its outcome.
    table.text('detail').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['run_day', 'outcome'], { indexName: 'export_snapshot_runs_day_outcome' });
    table.index(['run_day'], 'idx_export_snapshot_runs_day');
  });

  await knex.raw(`
    ALTER TABLE export_snapshot_runs
    ADD CONSTRAINT export_snapshot_runs_outcome_check
    CHECK (outcome IN ('taken', 'skipped_disabled', 'skipped_same_day', 'skipped_locked', 'failed'))
  `);

  await knex.raw(`
    ALTER TABLE export_snapshot_runs
    ADD CONSTRAINT export_snapshot_runs_cycles_check
    CHECK (cycles >= 1)
  `);

  // `outcome` is NOT NULL and `IS NOT NULL` cannot itself be NULL, so this
  // constraint refuses the row it exists to refuse rather than being satisfied
  // by it.
  await knex.raw(`
    ALTER TABLE export_snapshot_runs
    ADD CONSTRAINT export_snapshot_runs_taken_names_snapshot
    CHECK (outcome <> 'taken' OR snapshot_id IS NOT NULL)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('export_snapshot_runs');
}
