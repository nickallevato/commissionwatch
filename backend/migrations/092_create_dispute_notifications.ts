import type { Knex } from 'knex';

/**
 * The dispute reply loop — the ledger, and the two CHECKs that let it exist.
 *
 * `services/disputes.ts` promised, in its own header, "no edit to the record, no
 * public statement, no email to anyone". Read from the disputant's side that
 * third clause is not a safeguard, it is silence: somebody found a claim about
 * themselves, wrote out a contested account, left a contact, and never hears
 * back. The `CW-XXXXXXXX` reference exists — by its own comment — "to be quoted
 * down a phone line and typed back into an email", and there was no email.
 *
 * Three things land here.
 *
 * ## 1. `events.subject_kind` admits `dispute`
 *
 * The reply goes out on the event spine, not by a direct call from the dispute
 * route, so that one dispatcher does the routing, the batching and the durable
 * `deliveries` row. That needs a subject kind, and the kind needs an *inverted*
 * publication check: migration 039 permits exactly one `review_state`, so a
 * dispute is never public, and `emitEvent` must require it to be non-public
 * rather than skip the check. Same shape as the `.retracted` exemption — a
 * different question, not an absent one. See `services/events/emit.ts`.
 *
 * Migration 088 already put `dispute` in the restricted route namespace, before
 * anything emitted one, so the route that would post a contest to a Discord
 * server was impossible on the day the event started existing. That was the
 * right instinct and it is not sufficient on its own: 088 stops a *public*
 * channel carrying `dispute.*`, and an **ops** channel is still a webhook. The
 * second half of the rule is in `resolveRoutes`, which now resolves a dispute
 * event only to a `direct` channel.
 *
 * ## 2. `delivery_channels.owner_kind` admits `direct`
 *
 * `operator` is a webhook somebody configured; `subscriber` is a reader's own
 * address held until they unsubscribe. A dispute reply is neither. It goes to
 * exactly one address, supplied per send from the dispute row, and that address
 * is **not stored on the channel** — a direct channel holds no destination and
 * no credential at rest. There is nothing to leak if the row is dumped, and
 * nothing to keep in sync if the disputant's contact is wrong.
 *
 * ## 3. `dispute_notifications` — one row per message this project owes
 *
 * `(dispute_id, kind)` is unique, and that index is the whole of rule 4: one
 * acknowledgement per dispute, ever. A retried submission, a double-clicked
 * form, a re-drained event — all of them collide here rather than becoming a
 * second message to a stranger's inbox.
 *
 * **The address is stored hashed, or not at all.** Same reasoning as migration
 * 091: a delivery ledger that keeps a plaintext copy of every contact anyone
 * ever typed into a public form is a mailing list in a table nobody thinks of as
 * holding personal data. The live address lives in `record_disputes.contact`,
 * where the operator can see it and where deleting the dispute deletes it. The
 * hash here answers the only question this table needs to answer later — "was
 * this the address we wrote to?" — and answers nothing else.
 *
 * `state` distinguishes the four ways a message can fail to be sent, because
 * they are four different operator problems:
 *
 *  - `no_notification_channel` — `contact` is 200 characters of free text and
 *    what arrived was a phone number, a postal address or a sentence. Nothing is
 *    wrong; nothing can be automated. It surfaces as a task.
 *  - `suppressed` — the address is on migration 091's list. Never retried.
 *  - `dry_run` — no mail provider is configured. Telling a disputant "we
 *    replied" when nothing left the process is the exact lie migration 086
 *    exists to remove, and it is worse here than anywhere else.
 *  - `failed` — the provider was asked and did not confirm.
 *
 * ON DELETE CASCADE, unlike `record_corrections`. This is not the audit log —
 * `record_corrections` already records the dispute's arrival and its decision,
 * append-only and permanent. This is the delivery ledger for one dispute, and a
 * row about a message owed to a dispute that no longer exists is not a record of
 * anything.
 */

const NOTIFICATION_KINDS = ['received', 'upheld', 'declined'] as const;

const NOTIFICATION_STATES = [
  'queued',
  'sent',
  'dry_run',
  'suppressed',
  'no_notification_channel',
  'failed',
] as const;

/** Mirrors migration 083, plus the kind this migration adds. */
const SUBJECT_KINDS = ['meeting', 'finding', 'claim', 'document', 'ops', 'dispute'] as const;

/** Mirrors migration 024, plus the kind this migration adds. */
const OWNER_KINDS = ['operator', 'subscriber', 'direct'] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE events DROP CONSTRAINT events_subject_kind_check');
  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_subject_kind_check
    CHECK (subject_kind IN (${quoted(SUBJECT_KINDS)}))
  `);

  await knex.raw('ALTER TABLE delivery_channels DROP CONSTRAINT delivery_channels_owner_kind_check');
  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_owner_kind_check
    CHECK (owner_kind IN (${quoted(OWNER_KINDS)}))
  `);

  await knex.schema.createTable('dispute_notifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    table
      .uuid('dispute_id')
      .notNullable()
      .references('id')
      .inTable('record_disputes')
      .onDelete('CASCADE');

    table.text('kind').notNullable();
    table.text('state').notNullable().defaultTo('queued');

    /** SHA-256 of the normalised address, computed by `services/email-suppression.ts`. */
    table.string('address_hash', 64).nullable();

    /** The spine row this message rides on. Not an FK: events outlive their cause. */
    table.uuid('event_id').nullable();

    /** What the provider said, or why nothing was attempted. Bounded. */
    table.text('detail').nullable();

    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE dispute_notifications
    ADD CONSTRAINT dispute_notifications_kind_check
    CHECK (kind IN (${quoted(NOTIFICATION_KINDS)}))
  `);

  await knex.raw(`
    ALTER TABLE dispute_notifications
    ADD CONSTRAINT dispute_notifications_state_check
    CHECK (state IN (${quoted(NOTIFICATION_STATES)}))
  `);

  // A hash or nothing, exactly as in migration 091. An address that slipped in
  // here in plaintext would be invisible — 64 hex characters look like nothing
  // in particular until somebody checks.
  await knex.raw(`
    ALTER TABLE dispute_notifications
    ADD CONSTRAINT dispute_notifications_hash_check
    CHECK (address_hash IS NULL OR address_hash ~ '^[0-9a-f]{64}$')
  `);

  await knex.raw(`
    ALTER TABLE dispute_notifications
    ADD CONSTRAINT dispute_notifications_detail_check
    CHECK (detail IS NULL OR length(detail) <= 2000)
  `);

  // Only a real delivery gets a timestamp, for migration 086's reason: a dry run
  // carrying a send time reads, to anyone querying this table later, exactly
  // like a send.
  await knex.raw(`
    ALTER TABLE dispute_notifications
    ADD CONSTRAINT dispute_notifications_sent_at_check
    CHECK (sent_at IS NULL OR state = 'sent')
  `);

  // Rule 4, as an index. One acknowledgement per dispute, ever.
  await knex.raw(`
    CREATE UNIQUE INDEX dispute_notifications_dispute_kind_unique
    ON dispute_notifications (dispute_id, kind)
  `);

  // The operator's queue: what is owed and what could not be sent.
  await knex.raw(`
    CREATE INDEX idx_dispute_notifications_state
    ON dispute_notifications (state, created_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dispute_notifications');

  await knex.raw(
    'ALTER TABLE delivery_channels DROP CONSTRAINT IF EXISTS delivery_channels_owner_kind_check',
  );
  await knex.raw(`
    ALTER TABLE delivery_channels
    ADD CONSTRAINT delivery_channels_owner_kind_check
    CHECK (owner_kind IN ('operator', 'subscriber'))
  `);

  await knex.raw('ALTER TABLE events DROP CONSTRAINT IF EXISTS events_subject_kind_check');
  await knex.raw(`
    ALTER TABLE events
    ADD CONSTRAINT events_subject_kind_check
    CHECK (subject_kind IN ('meeting', 'finding', 'claim', 'document', 'ops'))
  `);
}
