import type { Knex } from 'knex';

/**
 * The dated export archive — what the export said, on the days we recorded it.
 *
 * ## Why this is forward-only, and why that is the honest answer
 *
 * "What did this site say in March" cannot be reconstructed from the rows. The
 * publication state of a meeting is `meetings.published_at`, a single mutable
 * timestamp, and `unpublishMeeting` sets it to **NULL** — so a meeting published
 * in March and withdrawn in April carries no trace of having ever been public.
 * `anomaly_flags.review_state` is the same shape: one column, overwritten. A
 * query filtering `published_at <= '2026-03-12'` would silently answer with
 * today's *survivors*, presented as March's record, and would be most wrong
 * exactly where the answer matters most — about the things that were later taken
 * down.
 *
 * So this table stores what the export contained at the moment it was taken, and
 * the archive can answer for dates from the first snapshot onward and for no
 * date before it. A forward-only archive that is true beats a backfilled one
 * that is inferred, and `/data` already says the question is unanswerable rather
 * than implying otherwise — this narrows that statement instead of replacing it
 * with a computed guess.
 *
 * ## Why it stores row ids and not bytes
 *
 * A stored CSV is a copy of a publication, and a copy cannot be un-published. A
 * dataset published in March and retracted since must stop being downloadable
 * through this path, and bytes on a disk have no way to learn that.
 *
 * So a snapshot records **which rows were in the export**, and serving one
 * re-runs the very same walled dataset builder — `ExportDataset.build` — and
 * intersects it with the recorded ids. The wall is therefore applied at read
 * time, once, by the one implementation `/api/data` uses. A row an operator has
 * since withdrawn is not in the builder's output, so it is not in the archived
 * export either, without any code here knowing what retraction is.
 *
 * The cost is stated rather than hidden: an archived export is "the rows that
 * were published then **and are still published now**", which is a narrower
 * claim than "the file we served then". The recorded `sha256` is what lets the
 * service say whether the bytes have changed since, rather than implying they
 * have not.
 *
 * `row_ids` as jsonb is right for a corpus of this size and would not be for a
 * corpus a thousand times larger; a snapshot of a million-row dataset belongs in
 * a join table. That is a real limit and it is written here rather than
 * discovered later.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('export_snapshots', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // When the export was read. The archive is addressed by date, and this is
    // the only fact that makes an address meaningful.
    table.timestamp('taken_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Why it was taken, when somebody had a reason. Nullable: a scheduled
    // snapshot has no author and inventing one would be worse than a null.
    table.text('note').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['taken_at'], 'idx_export_snapshots_taken_at');
  });

  await knex.schema.createTable('export_snapshot_datasets', (table) => {
    table.bigIncrements('id').primary();

    table
      .uuid('snapshot_id')
      .notNullable()
      .references('id')
      .inTable('export_snapshots')
      .onDelete('CASCADE');

    // The `ExportDataset.name`, not a foreign key: the set of datasets is a
    // property of the deployed code, and a snapshot naming one this build no
    // longer ships must be inert rather than an error — the same rule, for the
    // same reason, as `features.key`.
    table.text('dataset').notNullable();

    // What the export held then. Compared against what the builder returns now,
    // which is how the service can say how much has been withdrawn since.
    table.integer('row_count').notNullable();

    table.jsonb('row_ids').notNullable();

    // Of the bytes as they were served then. Not a promise that they can be
    // served again — see the header — but the only way to state honestly that
    // what the archive returns today differs from what went out that day.
    table.string('sha256', 64).notNullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['snapshot_id', 'dataset'], { indexName: 'export_snapshot_datasets_unique' });
  });

  // Both columns are NOT NULL, so neither CHECK can evaluate to NULL and be
  // satisfied by the row that violates it hardest. See
  // `098_null_safe_check_constraints.ts`.
  await knex.raw(`
    ALTER TABLE export_snapshot_datasets
    ADD CONSTRAINT export_snapshot_datasets_row_count_check
    CHECK (row_count >= 0)
  `);

  await knex.raw(`
    ALTER TABLE export_snapshot_datasets
    ADD CONSTRAINT export_snapshot_datasets_row_ids_is_array_check
    CHECK (jsonb_typeof(row_ids) = 'array')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('export_snapshot_datasets');
  await knex.schema.dropTableIfExists('export_snapshots');
}
