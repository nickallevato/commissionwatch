import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Before anything in the delivery stack resolves the key.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import { EventDrain } from "../src/services/events/drain";
import { emitEvent } from "../src/services/events";
import { DeliveryDispatcher } from "../src/services/delivery/dispatcher";
import { DiscordClient, type FetchLike } from "../src/services/delivery/discord";
import {
  DISPUTE_REPLY_CHANNEL_NAME,
  DisputeMailer,
  ensureDisputeReplyChannel,
  queueDisputeNotification,
} from "../src/services/dispute-notifications";
import { PrerenderConsumer, PrerenderStore } from "../src/services/prerender";
import { FeatureRegistry, setFeatureRegistry } from "../src/services/features/registry";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * A switch an operator throws takes effect **without a restart**.
 *
 * F1d put the drain and the prerender consumer behind the registry and left them
 * reading their flag once, in the constructor. That made the console honest about
 * what the switch said and wrong about what it did: `start()` returned early when
 * disabled, so there was no timer left to notice a change, and turning the drain
 * on was a redeploy again. The spec's motivating scenario is an operator at 11pm
 * deciding the drain is misbehaving, and ten minutes of Parameter Store is exactly
 * what it exists to remove.
 *
 * Both loops now re-read per cycle. This suite is what says so, and it asserts in
 * both directions — **off→on as well as on→off**, because off→on is the one that
 * can surprise somebody: a switch thrown at 11pm now dispatches a backlog within
 * one interval.
 *
 * ## Why it asserts on the ledgers and not on a return value
 *
 * `tick()` returning `{ dispatched: 0 }` proves nothing about whether a message
 * left the process. `sendEmail` returning void whether or not it reached a
 * provider is exactly how the email log lied daily in production, and migration
 * 086 and `dry_run` exist because of it. So the assertions here are the durable
 * records: `deliveries` for what was handed to a transport, and
 * `dispute_notifications.state` for what the mail path actually did — which with
 * no provider configured must read `dry_run` and must never read `sent`.
 *
 * ## Why no message can escape this suite
 *
 * `EventDrain.tick()` claims **every** undispatched event in the table, which in a
 * shared test database can include another suite's rows — and through a `*` route
 * an operator would plausibly have, a real POST to discord.com. See the same
 * warning on `drainDisputeEvents` in `dispute-notifications.test.ts`. Two things
 * close it here: `autoFlush: false`, so nothing sends until this file says so, and
 * an injected `DiscordClient` over a stub `fetchImpl` that records instead of
 * connecting. The stub is asserted to have recorded nothing, which is also how
 * this suite would notice if a future change started sending on dispatch.
 */

const PREFIX = "toggle-live-test";
const BASE = "https://commissionwatch.example";

/** A `FetchLike` that cannot reach the network, and counts anything that tried. */
const attemptedPosts: string[] = [];
const refusingFetch: FetchLike = async (url) => {
  attemptedPosts.push(url);
  return { status: 204, headers: { get: () => null }, text: async () => "" };
};

let registry: FeatureRegistry;

/**
 * Flips a switch the way the console does — through `setFlag`, so the write is
 * audited and the writing process's cache is current on return. No restart, no
 * reconstruction of the loop, and no environment variable.
 */
async function flip(key: "event_drain" | "prerender", enabled: boolean): Promise<void> {
  await registry.setFlag(key, enabled, null, `feature-toggle-live: ${enabled ? "on" : "off"}`);
}

before(async () => {
  await db("features_audit").whereIn("key", ["event_drain", "prerender"]).del();
  await db("features").whereIn("key", ["event_drain", "prerender"]).del();
  registry = new FeatureRegistry(db, { env: {}, logger: { warn: () => {}, error: () => {} } });
  await registry.refresh();
  setFeatureRegistry(registry);
});

after(async () => {
  setFeatureRegistry(null);
  await db("features_audit").whereIn("key", ["event_drain", "prerender"]).del();
  await db("features").whereIn("key", ["event_drain", "prerender"]).del();
  // Last, and only here. A `db.destroy()` inside a `describe`'s own `after` runs
  // before this hook and leaves it unable to acquire a connection.
  await db.destroy();
});

/* --------------------------------------------------------------------------
   The drain — the one path that can send mail
   -------------------------------------------------------------------------- */

describe("the event drain re-reads its flag per cycle", () => {
  let channelId: string;
  let channelExistedBefore: boolean;
  let dispatcher: DeliveryDispatcher;
  let drain: EventDrain;
  const disputeIds: string[] = [];
  const dedupeKeys: string[] = [];

  /** A dispute, its owed reply, and the event that will send it. */
  async function fileDisputeDirectly(): Promise<{ disputeId: string; dedupeKey: string }> {
    const [row] = await db("record_disputes")
      .insert({
        reference: `${PREFIX}-${randomUUID()}`,
        target_table: "meetings",
        target_id: randomUUID(),
        contested: `${PREFIX} contested text`,
        account: `${PREFIX} account of the record`,
        contact: `${PREFIX}-${randomUUID()}@example.com`,
      })
      .returning<Array<{ id: string; contact: string; reference: string }>>([
        "id",
        "contact",
        "reference",
      ]);
    disputeIds.push(row.id);

    // Writes the `queued` ledger row and emits `dispute.received`. A held dispute
    // is the emittable state for this subject kind — inverted from every other
    // one, because a reply is owed to the person who wrote in while the dispute's
    // content stays unpublished.
    const queued = await queueDisputeNotification(db, row, "received");
    assert.equal(queued.row.state, "queued", "precondition: a reply is owed");

    const dedupeKey = `dispute.received:dispute:${row.id}`;
    dedupeKeys.push(dedupeKey);
    return { disputeId: row.id, dedupeKey };
  }

  async function deliveryCount(dedupeKey: string): Promise<number> {
    const rows = await db("deliveries")
      .where({ dedupe_key: dedupeKey, channel_id: channelId })
      .count<Array<{ count: string }>>();
    return Number(rows[0]?.count ?? 0);
  }

  async function ledgerState(disputeId: string): Promise<string> {
    const row = await db("dispute_notifications")
      .where({ dispute_id: disputeId, kind: "received" })
      .first<{ state: string }>("state");
    return row.state;
  }

  async function dispatchedAt(dedupeKey: string): Promise<Date | null> {
    const row = await db("events")
      .where({ dedupe_key: dedupeKey })
      .first<{ dispatched_at: Date | null }>("dispatched_at");
    return row.dispatched_at;
  }

  before(async () => {
    await cleanupByPrefix(PREFIX);
    const existing = await db("delivery_channels")
      .where({ name: DISPUTE_REPLY_CHANNEL_NAME, owner_kind: "direct" })
      .first<{ id: string } | undefined>("id");
    channelExistedBefore = existing !== undefined;
    channelId = (await ensureDisputeReplyChannel(db)).id;

    dispatcher = new DeliveryDispatcher(db, {
      autoFlush: false,
      discord: new DiscordClient({ fetchImpl: refusingFetch }),
      // The real mailer over the real `EmailDeliveryService`. No provider is
      // configured in a test run, which is the point: the ledger must say
      // `dry_run` and never `sent`.
      direct: new DisputeMailer(db),
      logger: { error: () => {}, warn: () => {} },
    });
    drain = new EventDrain(db, { dispatcher, batchSize: 500, logger: { warn: () => {}, error: () => {} } });
  });

  after(async () => {
    dispatcher.close();
    for (const key of dedupeKeys) {
      await db("deliveries").where({ dedupe_key: key }).del();
      await db("events").where({ dedupe_key: key }).del();
    }
    // `dispute_notifications` cascades from `record_disputes` (migration 092).
    if (disputeIds.length > 0) await db("record_disputes").whereIn("id", disputeIds).del();
    if (!channelExistedBefore) {
      await db("channel_routes").where({ channel_id: channelId }).del();
      await db("deliveries").where({ channel_id: channelId }).del();
      await db("delivery_channels").where({ id: channelId }).del();
    }
    await cleanupByPrefix(PREFIX);
  });

  it("with the flag off, dispatches nothing, arms no send, and writes no delivery row", async () => {
    await flip("event_drain", false);
    const { disputeId, dedupeKey } = await fileDisputeDirectly();

    await drain.tick();
    await drain.tick();

    // The three facts, from the ledgers rather than from a return value.
    assert.equal(await deliveryCount(dedupeKey), 0, "a delivery row was written with the flag off");
    assert.equal(await dispatchedAt(dedupeKey), null, "the event was claimed with the flag off");
    assert.equal(await ledgerState(disputeId), "queued", "the mail ledger moved with the flag off");
    assert.deepEqual(attemptedPosts, [], "something reached for the network");

    // Nothing claimed means nothing marked, which is what makes the flip below a
    // dispatch of the backlog rather than a permanent loss of it.
    assert.equal(await ledgerState(disputeId), "queued");
  });

  it("dispatches within one cycle of the flag going on, with no restart", async () => {
    const { disputeId, dedupeKey } = await fileDisputeDirectly();
    await drain.tick();
    assert.equal(await deliveryCount(dedupeKey), 0, "precondition: the flag is still off");

    // The same drain object, the same process, no reconstruction. This is the
    // whole property: an operator's click reaches a running loop.
    await flip("event_drain", true);
    await drain.tick();

    assert.equal(await deliveryCount(dedupeKey), 1, "the flip did not reach the running drain");
    assert.notEqual(await dispatchedAt(dedupeKey), null);
    // Written but not sent: `autoFlush: false` means the row is durable and the
    // send is still ours to trigger.
    const pending = await db("deliveries")
      .where({ dedupe_key: dedupeKey, channel_id: channelId })
      .first<{ status: string }>("status");
    assert.equal(pending.status, "pending");
    assert.equal(await ledgerState(disputeId), "queued");

    await dispatcher.flushAll();

    // `dry_run`, never `sent`. Telling a disputant "we replied" when nothing left
    // the process is the lie migration 086 exists to remove, and it is the reason
    // this assertion is on the ledger and not on a returned status.
    const state = await ledgerState(disputeId);
    assert.equal(state, "dry_run");
    assert.notEqual(state, "sent");
    assert.deepEqual(attemptedPosts, [], "the dispute reply reached for the network");
  });

  it("stops dispatching within one cycle of the flag going off", async () => {
    // The direction an operator uses when something is going wrong, so it is the
    // direction that must not need a deploy.
    await flip("event_drain", false);
    const { disputeId, dedupeKey } = await fileDisputeDirectly();

    await drain.tick();
    await dispatcher.flushAll();

    assert.equal(await deliveryCount(dedupeKey), 0);
    assert.equal(await dispatchedAt(dedupeKey), null);
    assert.equal(await ledgerState(disputeId), "queued", "a reply went out after the flag went off");

    // And the backlog is still claimable, so turning it back on delivers the
    // reply this person is owed rather than dropping it.
    await flip("event_drain", true);
    await drain.tick();
    await dispatcher.flushAll();
    assert.equal(await deliveryCount(dedupeKey), 1);
    assert.equal(await ledgerState(disputeId), "dry_run");
  });

  it("logs the transition, not the state", async () => {
    // A line every five seconds saying nothing is happening is how the line that
    // matters gets scrolled past.
    const lines: string[] = [];
    const quiet = new EventDrain(db, {
      dispatcher: { dispatch: async () => assert.fail("dispatched with the flag off") },
      batchSize: 1,
      logger: { warn: (message) => lines.push(message), error: () => {} },
    });

    // Three disabled cycles, one line. The dispatcher above fails the test if it
    // is ever reached, so this also holds that a disabled cycle claims nothing.
    await flip("event_drain", false);
    await quiet.tick();
    await quiet.tick();
    await quiet.tick();
    assert.equal(lines.length, 1, "the disabled state was logged per cycle");
    assert.match(lines[0], /nothing will send/);

    // The transitions are observed through `start()` rather than a cycle, because
    // an *enabled* cycle here would claim whatever else the shared test database
    // holds undispatched. `start()` observes the flag and arms a timer at the
    // default five-second interval; `stop()` clears it before it can fire. That it
    // arms at all with the flag off is the F1d bug being gone: the old `start()`
    // returned early, which is why there was no timer left to notice a change.
    await flip("event_drain", true);
    quiet.start();
    quiet.stop();
    assert.equal(lines.length, 2, "the on transition was not logged");
    assert.match(lines[1], /sends are now live/);

    quiet.start();
    quiet.stop();
    assert.equal(lines.length, 2, "the unchanged state was logged again");

    await flip("event_drain", false);
    quiet.start();
    quiet.stop();
    assert.equal(lines.length, 3, "the off transition was not logged");
    assert.match(lines[2], /nothing further will send/);
  });

  it("keeps an explicit `enabled` option winning over the registry", async () => {
    // How the existing suites pin behaviour without touching the environment: a
    // test that must not send has to be able to say so in a way no row overrides.
    await flip("event_drain", true);
    const pinnedOff = new EventDrain(db, {
      dispatcher: { dispatch: async () => assert.fail("dispatched while pinned off") },
      enabled: false,
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal(pinnedOff.enabled, false);
    await pinnedOff.tick();

    // And the other way: pinned on with the row saying off. Not ticked — the
    // property under test is which value `enabled` reports, and ticking it here
    // would claim the whole table for no gain.
    await flip("event_drain", false);
    const pinnedOn = new EventDrain(db, {
      dispatcher: { dispatch: async () => assert.fail("this drain is never ticked") },
      enabled: true,
      logger: { warn: () => {}, error: () => {} },
    });
    assert.equal(pinnedOn.enabled, true);
  });
});

/* --------------------------------------------------------------------------
   The prerender consumer
   -------------------------------------------------------------------------- */

describe("the prerender consumer re-reads its flag per cycle", () => {
  let root: string;
  let store: PrerenderStore;
  let consumer: PrerenderConsumer;
  let firstMeetingId: string;
  let secondMeetingId: string;

  before(async () => {
    await cleanupByPrefix(`${PREFIX}-pr`);
    root = await mkdtemp(join(tmpdir(), "cw-toggle-prerender-"));
    store = new PrerenderStore(root);
    consumer = new PrerenderConsumer(db, {
      store,
      baseUrl: BASE,
      logger: { warn: () => {}, error: () => {} },
    });

    // Start the cursor at whatever the event log already holds, so a tick sees
    // this suite's events and not every published meeting in the test database.
    const latest = await db("events")
      .orderBy([{ column: "updated_at", order: "desc" }, { column: "id", order: "desc" }])
      .first<{ id: string; updated_at: Date } | undefined>("id", "updated_at");
    if (latest !== undefined) {
      await consumer.writeCursor({ updated_at: latest.updated_at.toISOString(), id: latest.id });
    }

    const fixture = await createSource(`${PREFIX}-pr`, { enabled: false });
    firstMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-05-06",
    });
    secondMeetingId = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-05-13",
    });
  });

  after(async () => {
    await db("events")
      .whereIn("subject_id", [firstMeetingId, secondMeetingId])
      .where({ subject_kind: "meeting" })
      .del();
    await rm(root, { recursive: true, force: true });
    await cleanupByPrefix(`${PREFIX}-pr`);
  });

  it("writes nothing and advances no cursor while the flag is off", async () => {
    await flip("prerender", false);
    await emitEvent(db, {
      event_type: "meeting.published",
      subject_kind: "meeting",
      subject_id: firstMeetingId,
    });

    const before = await consumer.readCursor();
    const result = await consumer.tick();

    assert.equal(await store.exists(`/meetings/${firstMeetingId}`), false, "a page was written");
    assert.deepEqual(await store.list(), [], "the store is not empty");
    // The cursor is the important half. A disabled cycle that advanced it would
    // silently drop every page published while the feature was off, and the
    // operator would find out by reading a 404 rather than by reading a log.
    assert.deepEqual(await consumer.readCursor(), before);
    assert.equal(result.written, 0);
  });

  it("renders within one cycle of the flag going on, with no restart", async () => {
    await flip("prerender", true);
    await consumer.tick();

    // The event emitted while it was off, rendered now. Nothing was skipped.
    assert.equal(await store.exists(`/meetings/${firstMeetingId}`), true);
    assert.notEqual(await consumer.readCursor(), null);
  });

  it("stops rendering within one cycle of the flag going off", async () => {
    await flip("prerender", false);
    await emitEvent(db, {
      event_type: "meeting.published",
      subject_kind: "meeting",
      subject_id: secondMeetingId,
    });

    const held = await consumer.readCursor();
    await consumer.tick();
    assert.equal(await store.exists(`/meetings/${secondMeetingId}`), false);
    assert.deepEqual(await consumer.readCursor(), held);

    // And back on: the page published during the off window still arrives,
    // because the cursor waited.
    await flip("prerender", true);
    await consumer.tick();
    assert.equal(await store.exists(`/meetings/${secondMeetingId}`), true);
  });

  it("keeps an explicit `enabled` option winning over the registry", async () => {
    await flip("prerender", false);
    assert.equal(
      new PrerenderConsumer(db, { store, baseUrl: BASE, enabled: true }).enabled,
      true,
      "the option must win, or `prerender.test.ts` would depend on a database row",
    );
    await flip("prerender", true);
    assert.equal(
      new PrerenderConsumer(db, { store, baseUrl: BASE, enabled: false }).enabled,
      false,
    );
  });
});
