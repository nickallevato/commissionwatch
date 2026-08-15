import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// The suppression and dry-run tests drive the **real** `EmailDeliveryService`,
// because the property they hold is that transactional mail goes through the one
// send path rather than a second copy of it. A provider key in the environment
// would turn those two tests into live sends, so it is removed here rather than
// worked around inside the assertions.
delete process.env.RESEND_API_KEY;

import db from "../src/config/database";
import {
  disputeRecordLink,
  DisputeMailer,
  DISPUTE_REPLY_CHANNEL_NAME,
  ensureDisputeReplyChannel,
  listDisputeNotifications,
  parseSingleEmailAddress,
  queueDisputeNotification,
  renderDisputeMessage,
  type TransactionalMailer,
} from "../src/services/dispute-notifications";
import {
  decideDispute,
  getDispute,
  resetDisputeRateLimits,
  submitDispute,
  type DisputeReceipt,
} from "../src/services/disputes";
import { createChannel, createRoute, resolveRoutes } from "../src/services/delivery/channels";
import { DeliveryDispatcher } from "../src/services/delivery/dispatcher";
import {
  emitEvent,
  listPublicEvents,
  parseClaimedEvent,
  toDeliveryEvent,
  EventPublicationError,
} from "../src/services/events";
import { hashAddress, suppress } from "../src/services/email-suppression";
import type { SendOutcome } from "../src/services/email-delivery";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * The dispute reply loop.
 *
 * `services/disputes.ts` used to promise "no email to anyone", which read from
 * the disputant's side as: they wrote to us and never heard back. Three messages
 * now exist, and every one of them is written to an address a **stranger typed
 * into a public form**. So the questions this suite asks are the ones an
 * attacker would:
 *
 *  - can the form be used to send text of my choosing to an address of my
 *    choosing?  (no — the acknowledgement carries no dispute content at all)
 *  - can a dispute be made to reach a Discord server or a feed?  (no —
 *    `resolveRoutes` hands `dispute.*` only to a `direct` channel, and the
 *    fixture below carries the exact `*` route an operator would have created)
 *  - can one submission produce two messages?  (no — a unique index, a dedupe
 *    key, and a state guard, tested across a retry and a duplicate)
 *  - can a person who told us to stop be written to anyway?  (no — the send goes
 *    through the one path that consults the suppression list)
 *  - can somebody be told an outcome that rolled back?  (no — the ledger row and
 *    the event commit with the decision or not at all)
 *
 * `record_disputes` has no append-only trigger, so this suite deletes its own
 * rows and `dispute_notifications` cascades with them. The `record_corrections`
 * rows each submission writes cannot be deleted and are not — migration 031
 * forces that arrangement on every suite that touches the log.
 */

const PREFIX = "dispute-notify-test";
const CONTACT = `${PREFIX}@example.invalid`;
const SUPPRESSED_CONTACT = `${PREFIX}-suppressed@example.invalid`;

const WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789012345678/Xk3n_TOKEN-value.0123456789abcdefghijklmnop";

/** Words a submitter chose. None of them may appear in an acknowledgement. */
const BODY = {
  contested: "The location recorded for this meeting is not where it was held.",
  account: "I attended. It was held in the annexe, not in the main chamber.",
};

interface RecordedSend {
  to: string;
  subject: string;
  html: string;
}

/** Records what it was asked to send, and reports whatever outcome it was given. */
class RecordingMailer implements TransactionalMailer {
  readonly sends: RecordedSend[] = [];

  constructor(private readonly outcome: SendOutcome = { delivered: true, providerId: "prov-1" }) {}

  async sendTransactional(to: string, subject: string, html: string): Promise<SendOutcome> {
    this.sends.push({ to, subject, html });
    return this.outcome;
  }
}

let publishedMeeting = "";
let withheldMeeting = "";
let directChannelId = "";

async function clearSuiteDisputes(): Promise<void> {
  const rows = await db("record_disputes")
    .where("contact", "like", `${PREFIX}%`)
    .orWhere("contact", "406-555-0123")
    .select<Array<{ id: string }>>("id");
  const disputeIds = rows.map((row) => row.id);
  if (disputeIds.length === 0) return;

  const events = await db("events")
    .where({ subject_kind: "dispute" })
    .whereIn("subject_id", disputeIds)
    .select<Array<{ id: string; dedupe_key: string }>>("id", "dedupe_key");
  if (events.length > 0) {
    await db("deliveries")
      .whereIn(
        "dedupe_key",
        events.map((row) => row.dedupe_key),
      )
      .del();
    await db("events")
      .whereIn(
        "id",
        events.map((row) => row.id),
      )
      .del();
  }

  // dispute_notifications cascades from record_disputes (migration 092).
  await db("record_disputes").whereIn("id", disputeIds).del();
}

/** Files a dispute against the published meeting and returns its row id. */
async function fileDispute(contact = CONTACT): Promise<{ id: string; receipt: DisputeReceipt }> {
  const receipt = await submitDispute(db, {
    targetTable: "meetings",
    targetId: publishedMeeting,
    contested: BODY.contested,
    account: BODY.account,
    contact,
    clientKey: `${PREFIX}-client`,
  });
  const row = await db("record_disputes")
    .where({ reference: receipt.reference })
    .first<{ id: string } | undefined>("id");
  assert.ok(row, "the dispute was not written");
  return { id: row.id, receipt };
}

/**
 * Dispatches exactly the events this suite emitted, and nothing else.
 *
 * `EventDrain.tick()` claims every undispatched event in the table, which in a
 * shared test database means other suites' rows and — through the `*` route an
 * operator would plausibly have — a real POST to discord.com. The claim is not
 * what these tests are about (`test/events.test.ts` holds it), so the same
 * `parseClaimedEvent` → `toDeliveryEvent` → `dispatch` path is driven directly.
 */
async function drainDisputeEvents(disputeId: string, mailer?: TransactionalMailer): Promise<void> {
  const dispatcher = new DeliveryDispatcher(db, {
    autoFlush: false,
    // No stub means the real `EmailDeliveryService`, which is the point of the
    // suppression and dry-run tests.
    direct: new DisputeMailer(db, mailer),
  });
  try {
    const rows = await db("events")
      .where({ subject_kind: "dispute", subject_id: disputeId })
      .whereNull("dispatched_at")
      .orderBy("occurred_at", "asc")
      .select<unknown[]>("*");

    for (const raw of rows) {
      const event = parseClaimedEvent(raw);
      await dispatcher.dispatch(toDeliveryEvent(event));
      await db("events").where({ id: event.id }).update({ dispatched_at: db.fn.now() });
    }
    await dispatcher.flushAll();
  } finally {
    dispatcher.close();
  }
}

describe("the dispute reply loop", () => {
  before(async () => {
    await cleanupByPrefix(PREFIX);
    await clearSuiteDisputes();

    const fixture = await createSource(PREFIX);
    publishedMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    });
    withheldMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-05",
    });

    directChannelId = (await ensureDisputeReplyChannel(db)).id;
  });

  beforeEach(async () => {
    // The per-client windows are process memory shared by every test in this
    // file, and `fileDispute` uses one client key.
    resetDisputeRateLimits();
    await clearSuiteDisputes();
  });

  after(async () => {
    await clearSuiteDisputes();
    await db("channel_routes").where({ channel_id: directChannelId }).del();
    await db("deliveries").where({ channel_id: directChannelId }).del();
    await db("delivery_channels").where({ name: DISPUTE_REPLY_CHANNEL_NAME }).del();
    await db("email_suppressions").where({ address_hash: hashAddress(SUPPRESSED_CONTACT) }).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  /* --------------------------------------------------------------- routing */

  describe("routing", () => {
    /**
     * The highest-consequence defect available in this feature.
     *
     * The fixture is not a strawman. It is an ops Discord channel carrying `*`,
     * which is the shortcut an operator reaches for instead of writing five
     * rows, plus an explicit `dispute.*` route on the same channel — which
     * migration 088's trigger **permits**, because 088 only stops a *public*
     * channel carrying one. An ops channel is still a webhook pointed at a
     * server with people in it, so the audience rule alone is not enough, and
     * this test is what says so.
     */
    it("never resolves a dispute event to a Discord, feed, or wildcard route", async () => {
      const opsDiscord = await createChannel(db, {
        channel_type: "discord",
        name: `${PREFIX}-ops`,
        config: { webhook_url: WEBHOOK_URL },
        audience: "ops",
      });
      const publicDiscord = await createChannel(db, {
        channel_type: "discord",
        name: `${PREFIX}-public`,
        config: { webhook_url: WEBHOOK_URL },
        audience: "public",
      });

      try {
        await createRoute(db, { channel_id: opsDiscord.id, event_type: "*" });
        await createRoute(db, { channel_id: opsDiscord.id, event_type: "dispute.*" });
        await createRoute(db, { channel_id: publicDiscord.id, event_type: "finding.*" });

        for (const eventType of ["dispute.received", "dispute.upheld", "dispute.declined"]) {
          const routes = await resolveRoutes(db, { event_type: eventType, severity: "info" });
          const reached = routes.map((route) => route.channel_id);

          assert.ok(reached.includes(directChannelId), `${eventType} reached no direct channel`);
          assert.ok(!reached.includes(opsDiscord.id), `${eventType} reached an ops Discord webhook`);
          assert.ok(!reached.includes(publicDiscord.id), `${eventType} reached a public channel`);
          for (const route of routes) {
            assert.equal(route.owner_kind, "direct", `${eventType} reached ${route.channel_name}`);
          }
        }

        // The wildcard in the fixture is live, not inert — otherwise the
        // assertions above would pass for entirely the wrong reason.
        const findingRoutes = await resolveRoutes(db, {
          event_type: "finding.published",
          severity: "high",
        });
        const reached = new Set(findingRoutes.map((route) => route.channel_id));
        assert.ok(reached.has(opsDiscord.id), "the `*` route matched nothing at all");
        assert.ok(reached.has(publicDiscord.id), "the `finding.*` route matched nothing at all");
        assert.ok(!reached.has(directChannelId), "a finding reached the dispute channel");
      } finally {
        await db("channel_routes").whereIn("channel_id", [opsDiscord.id, publicDiscord.id]).del();
        await db("delivery_channels").whereIn("id", [opsDiscord.id, publicDiscord.id]).del();
      }
    });

    it("keeps the dispute channel free of a destination at rest", async () => {
      const row = await db("delivery_channels")
        .where({ id: directChannelId })
        .first<{ config_encrypted: Buffer; owner_kind: string; audience: string } | undefined>(
          "config_encrypted",
          "owner_kind",
          "audience",
        );
      assert.ok(row);
      assert.equal(row.owner_kind, "direct");
      assert.equal(row.audience, "ops");

      // Whatever the encryption does, the ciphertext of an empty object cannot
      // contain an address. The point of the kind is that there is nothing on
      // this row to leak if the table is dumped.
      assert.ok(
        !row.config_encrypted.toString("utf8").includes("@"),
        "a direct channel is holding a destination",
      );
    });
  });

  /* -------------------------------------------------------------- contents */

  describe("what the messages say", () => {
    it("puts no dispute content in the acknowledgement", async () => {
      const { id, receipt } = await fileDispute();
      const mailer = new RecordingMailer();
      await drainDisputeEvents(id, mailer);

      assert.equal(mailer.sends.length, 1);
      const sent = mailer.sends[0];
      assert.equal(sent.to, CONTACT);

      const whole = `${sent.subject}\n${sent.html}`.toLowerCase();
      // The field names, because a template that interpolated the row would
      // carry them; and the values, because a template that interpolated the
      // *values* would not.
      for (const forbidden of ["contested", "account", "target_table", "target_id"]) {
        assert.ok(!whole.includes(forbidden), `the acknowledgement mentions ${forbidden}`);
      }
      for (const value of [BODY.contested, BODY.account, publishedMeeting, id]) {
        assert.ok(
          !whole.includes(value.toLowerCase()),
          `the acknowledgement echoed something specific to this dispute: ${value}`,
        );
      }

      // What it does carry: the reference, and the sentence that makes it
      // harmless to whoever receives it by mistake.
      assert.ok(sent.html.includes(receipt.reference));
      assert.ok(sent.html.includes("we will not write again"));
    });

    it("carries no tracking pixel and no wrapped link", async () => {
      const message = renderDisputeMessage("received", "CW-ABCDEFGH", null);
      for (const beacon of ["<img", "1x1", "track", "pixel", "utm_"]) {
        assert.ok(!message.html.toLowerCase().includes(beacon), `found ${beacon} in the reply`);
      }
    });

    /**
     * A dispute can be filed only against a public record, but the record can be
     * withheld afterwards. A reply linking a reader to something an operator has
     * since pulled would leak the withheld set by email, to the one person most
     * motivated to look.
     */
    it("renders an outcome with no link when the record is no longer public", async () => {
      const withheldLink = await disputeRecordLink(db, {
        target_table: "meetings",
        target_id: withheldMeeting,
      });
      assert.equal(withheldLink, null, "resolved a link to a withheld meeting");

      const upheld = renderDisputeMessage("upheld", "CW-ABCDEFGH", withheldLink);
      assert.ok(!upheld.text.includes("/meetings/"), "the outcome linked a withheld record");
      assert.ok(upheld.text.includes("CW-ABCDEFGH"));

      // The same shape of target, still published, does resolve — otherwise the
      // assertion above would hold for a renderer that never links at all.
      const live = await disputeRecordLink(db, {
        target_table: "meetings",
        target_id: publishedMeeting,
      });
      assert.ok(live !== null && live.endsWith(`/meetings/${publishedMeeting}`));
    });

    it("never quotes the operator's reason back to the disputant", async () => {
      const { id } = await fileDispute();
      await decideDispute(db, {
        id,
        decision: "declined",
        reason: "Checked the recording; the annexe claim does not hold up.",
        actor: { id: null, email: `${PREFIX}@example.invalid` },
      });

      const mailer = new RecordingMailer();
      await drainDisputeEvents(id, mailer);

      const declined = mailer.sends.find((send) => send.subject.includes("reviewed"));
      assert.ok(declined, "no outcome message was sent");
      assert.ok(!declined.html.includes("annexe claim"), "the internal note went out as a reply");
      assert.ok(declined.html.includes("made no change to the record"));
    });
  });

  /* ---------------------------------------------------------- the contact */

  describe("the contact is free text", () => {
    it("parses only a single valid address", () => {
      assert.equal(parseSingleEmailAddress("jo@example.org"), "jo@example.org");
      assert.equal(parseSingleEmailAddress("  Jo@Example.ORG "), "jo@example.org");

      // Everything a person actually types into a 200-character box.
      for (const notAnAddress of [
        "406-555-0123",
        "PO Box 12, Bozeman MT 59715",
        "Call me, I am at the courthouse most mornings",
        "Jo <jo@example.org>",
        "jo@example.org, sam@example.org",
        "jo@example.org sam@example.org",
        "jo@example",
        "@example.org",
        "",
      ]) {
        assert.equal(
          parseSingleEmailAddress(notAnAddress),
          null,
          `guessed an address out of ${JSON.stringify(notAnAddress)}`,
        );
      }
    });

    it("sends nothing and shows the operator a task when the contact is a phone number", async () => {
      const { id } = await fileDispute("406-555-0123");

      const notifications = await listDisputeNotifications(db, id);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].state, "no_notification_channel");

      // No event either. A spine row that can only ever resolve to "no channel"
      // is a permanent entry in the delivery ledger for a message nobody
      // intended to send.
      const events = await db("events").where({ subject_kind: "dispute", subject_id: id });
      assert.equal(events.length, 0);

      const mailer = new RecordingMailer();
      await drainDisputeEvents(id, mailer);
      assert.equal(mailer.sends.length, 0);

      // And it is on the operator's view of the dispute, not behind a second
      // request — this is a task only a person can clear.
      const item = await getDispute(db, id);
      assert.ok(item);
      assert.equal(item.notifications[0].state, "no_notification_channel");
    });
  });

  /* ------------------------------------------------------------ send rules */

  describe("the send", () => {
    /**
     * Rule 3, through the real `EmailDeliveryService`. The suppression check
     * lives inside its `sendEmail`, at the one point every message in this
     * codebase passes through, and the whole property is that transactional mail
     * does not get its own copy of it.
     */
    it("writes nothing to a suppressed address", async () => {
      await suppress(db, {
        address: SUPPRESSED_CONTACT,
        reason: "complained",
        source: "provider_webhook",
      });

      const { id } = await fileDispute(SUPPRESSED_CONTACT);
      await drainDisputeEvents(id);

      const notifications = await listDisputeNotifications(db, id);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].state, "suppressed");
      assert.equal(notifications[0].sent_at, null);
    });

    /**
     * A deployment with no provider configured processes the queue correctly and
     * delivers nothing. Recording that as `sent` is the lie migration 086 exists
     * to remove, and telling a disputant "we replied" is the worst place in the
     * product to tell it.
     */
    it("writes dry_run, never sent, when no provider is configured", async () => {
      const { id } = await fileDispute();
      await drainDisputeEvents(id);

      const notifications = await listDisputeNotifications(db, id);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].state, "dry_run");
      assert.equal(notifications[0].sent_at, null);

      const delivery = await db("deliveries")
        .where({ channel_id: directChannelId })
        .orderBy("created_at", "desc")
        .first<{ status: string } | undefined>("status");
      assert.ok(delivery);
      assert.notEqual(delivery.status, "sent");
    });

    it("records a real delivery as sent, with a time on it", async () => {
      const { id } = await fileDispute();
      await drainDisputeEvents(id, new RecordingMailer({ delivered: true, providerId: "prov-9" }));

      const notifications = await listDisputeNotifications(db, id);
      assert.equal(notifications[0].state, "sent");
      assert.ok(notifications[0].sent_at !== null);
    });
  });

  /* ----------------------------------------------------------- idempotency */

  describe("one acknowledgement per dispute, ever", () => {
    it("survives a retried send and a duplicate submission", async () => {
      const { id } = await fileDispute();

      const mailer = new RecordingMailer();
      await drainDisputeEvents(id, mailer);
      assert.equal(mailer.sends.length, 1);

      // The retry, in its harshest form: the event is undispatched again *and*
      // the `deliveries` row that would absorb it is gone, so nothing but the
      // ledger's own state guard stands between the second attempt and a second
      // message to somebody's inbox.
      await db("events")
        .where({ subject_kind: "dispute", subject_id: id })
        .update({ dispatched_at: null });
      await db("deliveries").where({ channel_id: directChannelId }).del();
      await drainDisputeEvents(id, mailer);

      assert.equal(mailer.sends.length, 1, "the retry sent a second acknowledgement");

      // The duplicate submission, at the queue: a second form post is a second
      // dispute with its own reference and gets its own single acknowledgement,
      // but queueing the same kind against the same dispute never does.
      const second = await queueDisputeNotification(
        db,
        { id, reference: "CW-IGNORED0", contact: CONTACT },
        "received",
      );
      assert.equal(second.created, false);

      const notifications = await listDisputeNotifications(db, id);
      assert.equal(notifications.filter((row) => row.kind === "received").length, 1);
    });

    it("refuses a second row at the database, not only in code", async () => {
      const { id } = await fileDispute();
      await assert.rejects(
        async () => {
          await db("dispute_notifications").insert({
            dispute_id: id,
            kind: "received",
            state: "queued",
          });
        },
        /dispute_notifications_dispute_kind_unique/,
      );
    });
  });

  /* ------------------------------------------------------- the transaction */

  describe("the decision and the message commit together", () => {
    it("produces no notification when the review decision rolls back", async () => {
      const { id } = await fileDispute();
      await db("dispute_notifications").where({ dispute_id: id }).del();
      await db("events").where({ subject_kind: "dispute", subject_id: id }).del();

      // The body of `decideDispute`, made to fail after the decision and the
      // queue — which is the ordering the event spine requires, and the only
      // ordering under which a rollback takes the message with it.
      await assert.rejects(
        db.transaction(async (trx) => {
          await trx("record_disputes").where({ id }).update({ status: "upheld" });
          await queueDisputeNotification(
            trx,
            { id, reference: "CW-ROLLBACK", contact: CONTACT },
            "upheld",
          );
          throw new Error("the operator's write failed after the decision");
        }),
        /the operator's write failed/,
      );

      const dispute = await db("record_disputes").where({ id }).first<{ status: string }>("status");
      assert.equal(dispute.status, "received", "the decision survived its own rollback");
      assert.deepEqual(await listDisputeNotifications(db, id), []);
      assert.deepEqual(await db("events").where({ subject_kind: "dispute", subject_id: id }), []);
    });

    it("queues exactly one outcome when the decision commits", async () => {
      const { id } = await fileDispute();
      await decideDispute(db, {
        id,
        decision: "upheld",
        reason: "The recording confirms the annexe.",
        actor: { id: null, email: `${PREFIX}@example.invalid` },
      });

      const kinds = (await listDisputeNotifications(db, id)).map((row) => row.kind).sort();
      assert.deepEqual(kinds, ["received", "upheld"]);

      const events = await db("events")
        .where({ subject_kind: "dispute", subject_id: id })
        .select<Array<{ event_type: string }>>("event_type");
      assert.deepEqual(events.map((row) => row.event_type).sort(), [
        "dispute.received",
        "dispute.upheld",
      ]);
    });
  });

  /* ------------------------------------------------------------- the spine */

  describe("the spine", () => {
    it("keeps dispute events out of the public read path", async () => {
      const { id } = await fileDispute();
      const published = await listPublicEvents(db, { limit: 200 });
      // `PublicEventRow.subject_kind` cannot even name `dispute`, which is the
      // compile-time half of the guarantee. This is the runtime half: the row
      // exists, and the public query does not return it.
      const emitted = await db("events").where({ subject_kind: "dispute", subject_id: id });
      assert.equal(emitted.length, 1, "no dispute event was written to compare against");
      assert.ok(
        !published.some((event) => event.subject_id === id),
        "a dispute reached the public event list",
      );
    });

    it("refuses a dispute event for a dispute that does not exist", async () => {
      await assert.rejects(
        emitEvent(db, {
          event_type: "dispute.received",
          subject_kind: "dispute",
          subject_id: "00000000-0000-0000-0000-0000000000ff",
        }),
        (err: unknown) => err instanceof EventPublicationError,
      );
    });
  });
});
