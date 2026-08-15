import type { Knex } from 'knex';

/**
 * Addresses this project must not write to, and why.
 *
 * The delivery design names this a hard precondition for **any** outbound mail,
 * and that includes the transactional kind. Without it, one spam complaint
 * damages deliverability for every future recipient and there is no mechanism
 * that stops the second send — the first send is a mistake, the second is a
 * pattern, and a provider treats them differently.
 *
 * It matters most where it is least expected. The dispute acknowledgement writes
 * to a contact a *stranger* typed into a public form, so anyone can name a
 * victim's address and have us mail them. Rate limits bound the volume; only a
 * suppression list stops the same address being written to again after they have
 * said no.
 *
 * ## The address is stored hashed
 *
 * A suppression list is otherwise a second copy of the subscriber list, sitting
 * in a table nobody thinks of as holding personal data — and it is the copy that
 * outlives every unsubscribe, because its whole purpose is to persist after the
 * relationship ends. The lookup is exact-match, so a hash serves it perfectly.
 *
 * SHA-256 over the normalised address, with no salt, deliberately: a per-row
 * salt would make the table unsearchable for the one query it exists to answer,
 * and a shared secret would put the whole list one leak away from plaintext
 * anyway. This is not protection against a determined attacker enumerating
 * common addresses — nothing hashing an email is — it is so that a dump of this
 * table is not a mailing list.
 *
 * ## `reason` is not decoration
 *
 * `unsubscribed` is a person's choice and is permanent until they act again.
 * `bounced_hard` and `complained` come from the provider and are permanent
 * because ignoring them is how a sending domain dies. `operator_block` is ours.
 * They are kept apart because "they asked us to stop" and "their mail server
 * rejected us" are different facts, and a future feature that offers to
 * re-subscribe must be able to tell them apart.
 */

export const SUPPRESSION_REASONS = [
  'unsubscribed',
  'bounced_hard',
  'complained',
  'operator_block',
] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_suppressions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // The lookup key. Unique, because a second suppression of the same address
    // says nothing the first did not, and the send path must be able to ask
    // exactly once.
    table.string('address_hash', 64).notNullable().unique();

    table.text('reason').notNullable();

    /**
     * Where the suppression came from: `provider_webhook`, `unsubscribe_link`,
     * `operator`. Free text rather than an enum because the set will grow with
     * every channel, and an over-constrained provenance column is one nobody
     * fills in honestly.
     */
    table.text('source').notNullable();

    /** What the provider said, when there was a provider. Bounded. */
    table.text('detail').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_reason_check
    CHECK (reason IN (${SUPPRESSION_REASONS.map((r) => `'${r}'`).join(', ')}))
  `);

  // A hash or nothing. An address that slipped in here in plaintext would be
  // the exact failure this table's design is trying to avoid, and it would be
  // invisible — 64 hex characters look like nothing in particular until you
  // check.
  await knex.raw(`
    ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_hash_check
    CHECK (address_hash ~ '^[0-9a-f]{64}$')
  `);

  await knex.raw(`
    ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_detail_check
    CHECK (detail IS NULL OR length(detail) <= 2000)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_suppressions');
}
