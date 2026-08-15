import type { Knex } from 'knex';

/**
 * The operator's switch for what is shipped dark, and the log of who threw it.
 *
 * Three features run today behind a `process.env` read — the event drain,
 * prerendering, the MCP server — and that convention was right for shipping them
 * and wrong for operating them. The value lives in a SecureString at
 * `/commissionwatch/env`, so turning one off is a Parameter Store edit plus an
 * SSM deploy: ten minutes, spent on the thing that is already going wrong. And
 * every other consequential act in this codebase leaves an actor and a reason,
 * while enabling the delivery pipeline — a larger act than approving one claim —
 * currently leaves no trace at all.
 *
 * ## What may never get a row here
 *
 * A feature flag is not a wall. The publication wall, the review gate, the claim
 * wall and "nothing naming a person auto-publishes" are invariants, not
 * settings, and there is deliberately no row that can turn one off. This table
 * gates **whether a capability runs**, never **whether a check applies** —
 * `feature-registry-audit.test.ts` holds the key set to that.
 *
 * ## Why `key` has no foreign key to a table of valid keys
 *
 * The set of real features is a property of the deployed code, not of the data.
 * A row naming a key this build does not know about must be **inert** rather
 * than an error, because that row is what a rolled-back deploy leaves behind and
 * a rollback that trips a constraint is not a rollback. `FeatureRegistry`
 * resolves only keys in its compiled `FEATURES` manifest and ignores the rest.
 *
 * The corollary is that this table can never be the authority on what a key
 * means, so the CHECK below constrains only its *shape* — a key has to be a
 * snake_case token so that `FEATURE_<UPPER_SNAKE_KEY>` is derivable from it
 * without escaping. `key` is the primary key and cannot be NULL, so this is one
 * of the constraints that is safe to write plainly.
 *
 * ## Where the nullability sits, and why no CHECK spans it
 *
 * `update_reason` and `updated_by` are nullable on `features`: the row mirrors
 * its most recent write, and a row created by a seed or a migration has no
 * operator behind it. Both are NOT NULL-by-construction on `features_audit`,
 * where every row exists because somebody wrote it — so the "a change has a
 * reason" rule is enforced where it is actually true, on the audit row, and the
 * service refuses an empty reason before either table is touched.
 *
 * **No CHECK here spans a nullable column.** A CHECK whose expression evaluates
 * to NULL is satisfied, so the row that violates such a constraint hardest — the
 * one with the column simply absent — is the one that passes. This project
 * shipped four of those in a single day; `098_null_safe_check_constraints.ts` is
 * the sweep and `migrations-selfcontained.test.ts` holds the class. The two
 * CHECKs below are on `features.key` and `features_audit.reason`, both NOT NULL,
 * and neither can go NULL for any admissible row.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('features', (table) => {
    // The manifest key itself, not a surrogate id. There is exactly one row per
    // feature by definition, so a separate id would only create the possibility
    // of two rows disagreeing about one switch.
    table.text('key').primary();

    // Default false, and the service defaults to false again when no row exists.
    // Every failure mode in this design falls the same way — off.
    table.boolean('enabled').notNullable().defaultTo(false);

    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // SET NULL rather than CASCADE, as everywhere else an operator is
    // referenced: deleting an operator account must not delete the record that
    // the drain was turned on. The audit row keeps the same shape for the same
    // reason.
    table.uuid('updated_by').nullable().references('id').inTable('operators').onDelete('SET NULL');

    table.text('update_reason').nullable();
  });

  await knex.raw(`
    ALTER TABLE features
    ADD CONSTRAINT features_key_shape_check
    CHECK (key ~ '^[a-z][a-z0-9_]*$')
  `);

  await knex.schema.createTable('features_audit', (table) => {
    table.bigIncrements('id').primary();

    // Not a foreign key to `features`. The audit trail has to outlive the row it
    // describes — including a key this build stopped recognising — and a log
    // that a rollback can delete is not a log.
    table.text('key').notNullable();

    // Null on the first write for a key, because before it there was no row and
    // "false" would be a claim about a state that was never recorded. The
    // resolved value was in fact off, but off-by-default and off-by-decision are
    // different facts and the log must not conflate them.
    table.boolean('enabled_from').nullable();

    table.boolean('enabled_to').notNullable();

    table
      .uuid('operator_id')
      .nullable()
      .references('id')
      .inTable('operators')
      .onDelete('SET NULL');

    // NOT NULL here and nullable on `features`, deliberately. Approving a claim
    // and correcting a place link each demand a reason; this is a larger act
    // than either.
    table.text('reason').notNullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE features_audit
    ADD CONSTRAINT features_audit_reason_present_check
    CHECK (length(btrim(reason)) > 0)
  `);

  // The console's per-row question is "what was the last change to this key, by
  // whom, and why" — one lookup per manifest entry on every page load. Descending
  // on `created_at` so that answer is the index's first tuple.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_features_audit_key_recent
    ON features_audit (key, created_at DESC)
  `);
}

/**
 * Rolling back drops the audit trail with the switches. That is a real loss and
 * it is the honest consequence: there is nowhere else for those rows to live,
 * and a `down` that stashed them somewhere would leave a second, unreadable
 * copy of an operator log behind. Behaviour after the rollback is what it was
 * before this release — the legacy env vars, which `104` never removed.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_features_audit_key_recent');
  await knex.schema.dropTableIfExists('features_audit');
  await knex.schema.dropTableIfExists('features');
}
