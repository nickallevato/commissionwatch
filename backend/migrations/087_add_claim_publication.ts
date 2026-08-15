import type { Knex } from 'knex';

/**
 * What an operator approved, pinned to the bytes of the sentence they read.
 *
 * Migration 072 gave `minute_claims` a `status`, a `reviewed_by`, a
 * `review_reason` and a `reviewed_at`, and then nothing in the codebase ever
 * wrote one of them. Every extracted claim sat `held` forever, which made the
 * whole extraction pipeline produce nothing publishable. This migration is the
 * other half of 072.
 *
 * **The pin is the point.** The operator does not approve the triple
 * (`subject_name`, `action`, `matter`) — they approve the *rendered sentence*,
 * and the rendered sentence is a function of the triple **and** of a label map
 * **and** of a template, both of which live in code that can change after the
 * approval. An operator who approved "Avery Sample — abstained" would, after a
 * well-meaning edit to that label map, be publishing "Avery Sample — declined
 * to vote" over their own name and timestamp, having never read it. So the
 * exact string is stored, its sha256 is stored, and the public path recomputes
 * the string and compares. On mismatch the claim does not render at all: it
 * does not fall back to `rendered_text`, because that would publish a sentence
 * the current code no longer agrees with.
 *
 * `render_version` is what makes a deliberate template change a batch rather
 * than a mystery: bump it, and every claim pinned to the old version goes back
 * to the queue with a reason that says why. That is supposed to be
 * inconvenient. The inconvenience is the mechanism.
 *
 * **`approved_by` is not `reviewed_by`.** 072's columns record *that a decision
 * was made*; these record *an approval to publish*. A rejection and an approval
 * are then not the same shape of row, and the CHECK below can demand a named
 * approver without also demanding one of every rejection.
 *
 * **Retraction is an append, and it leaves a mark.** `retracted_at` and
 * `retracted_reason` never blank `rendered_text` and never delete the row. A
 * reader arriving from a cache, a feed or a Discord post needs to land on the
 * sentence that says *that specific claim was withdrawn*; silence is not a
 * correction, and a transparency project that quietly unpublishes is doing the
 * thing it exists to detect.
 *
 * Schema of record for the reasoning: `docs/superpowers/specs/
 * 2026-08-14-published-claim-design.md` §4, §6 and §7.
 */

/**
 * Mirrors 031, 038, 039 and 070, plus the subject this migration adds.
 *
 * Widened because a claim decision is appended to `record_corrections` like
 * every other decision. Two audit logs can disagree about what happened, and
 * the one that disagreed would be believed at random.
 */
const CORRECTABLE_TABLES = [
  'meetings',
  'agenda_items',
  'meeting_documents',
  'anomaly_flags',
  'review_policy',
  'record_disputes',
  'entity_resolution_decisions',
  'minute_claims',
] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('minute_claims', (table) => {
    // The exact string approved, byte for byte. Nullable because a held claim
    // has not been rendered by anyone yet, and a rejected one never will be.
    table.text('rendered_text').nullable();
    table.string('render_sha256', 64).nullable();
    /** Template plus label-map version, e.g. `claim-render@1`. */
    table.text('render_version').nullable();

    // No FK to `operators`: an operator row may be deleted, and the record of
    // who published a sentence about a named person must survive that. The
    // corrections log snapshots the email for the same reason.
    table.uuid('approved_by').nullable();
    table.timestamp('approved_at', { useTz: true }).nullable();

    table.timestamp('retracted_at', { useTz: true }).nullable();
    table.text('retracted_reason').nullable();
  });

  // An approved claim carries the bytes, the sha of those bytes, and a person
  // who approved them. Enforced here rather than in the writer, because the
  // writer is one caller and this table is the source of truth.
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_approved_pin_check
    CHECK (
      status <> 'approved'
      OR (rendered_text IS NOT NULL
          AND render_sha256 ~ '^[0-9a-f]{64}$'
          AND render_version IS NOT NULL
          AND approved_by IS NOT NULL)
    )
  `);

  // A reason with no retraction is a reason for nothing.
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_retraction_check
    CHECK (retracted_reason IS NULL OR retracted_at IS NOT NULL)
  `);

  // Nothing may be retracted that was never approved. Without this, a `held`
  // claim could carry a retraction date and the public tombstone would announce
  // the withdrawal of a sentence no reader was ever shown.
  await knex.raw(`
    ALTER TABLE minute_claims
    ADD CONSTRAINT minute_claims_retraction_needs_approval_check
    CHECK (retracted_at IS NULL OR approved_at IS NOT NULL)
  `);

  // The public wall's exact predicate: approved, not retracted. A partial index
  // so the meeting page's read costs nothing on a table whose held rows are
  // expected to outnumber its published ones for a long time.
  await knex.raw(`
    CREATE INDEX idx_minute_claims_public
    ON minute_claims (meeting_id, quote_offset)
    WHERE status = 'approved' AND retracted_at IS NULL
  `);

  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES)}))
  `);
}

/**
 * Rolling back narrows the CHECK again, which fails loudly once any claim
 * decision has been logged — `record_corrections` forbids DELETE, so those rows
 * cannot be removed to make room. Migrations 038, 039 and 070 record the same
 * honest failure: the log cannot be un-widened once it holds a decision.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE record_corrections DROP CONSTRAINT IF EXISTS record_corrections_target_table_check',
  );
  await knex.raw(`
    ALTER TABLE record_corrections
    ADD CONSTRAINT record_corrections_target_table_check
    CHECK (target_table IN (${quoted(CORRECTABLE_TABLES.slice(0, -1))}))
  `);

  await knex.raw('DROP INDEX IF EXISTS idx_minute_claims_public');
  await knex.raw(
    'ALTER TABLE minute_claims DROP CONSTRAINT IF EXISTS minute_claims_retraction_needs_approval_check',
  );
  await knex.raw(
    'ALTER TABLE minute_claims DROP CONSTRAINT IF EXISTS minute_claims_retraction_check',
  );
  await knex.raw(
    'ALTER TABLE minute_claims DROP CONSTRAINT IF EXISTS minute_claims_approved_pin_check',
  );

  await knex.schema.alterTable('minute_claims', (table) => {
    table.dropColumn('retracted_reason');
    table.dropColumn('retracted_at');
    table.dropColumn('approved_at');
    table.dropColumn('approved_by');
    table.dropColumn('render_version');
    table.dropColumn('render_sha256');
    table.dropColumn('rendered_text');
  });
}
