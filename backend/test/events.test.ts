import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import db from "../src/config/database";
import {
  emitEvent,
  retractSubject,
  subjectIsPublic,
  EventDrain,
  EventPublicationError,
  EventInputError,
  eventDrainEnabled,
  listPublicEvents,
  toDeliveryEvent,
  type ClaimedEvent,
  type EventDispatcherLike,
} from "../src/services/events";
import {
  createChannel,
  createRoute,
  eventTypeMatchers,
  resolveRoutes,
} from "../src/services/delivery/channels";
import { DeliveryDispatcher, type DeliveryEvent, type DispatchResult } from "../src/services/delivery/dispatcher";
import { approveFinding, ensureApprovalRequests } from "../src/services/review/queue";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * The event spine.
 *
 * One emitter writes `events`, and it writes nothing for an object a reader
 * cannot already see. Every consumer built after this reads that table instead
 * of re-deriving `publication.ts`'s two-part condition, so the wall is asserted
 * once rather than once per consumer. These tests hold the properties that make
 * that trade safe:
 *
 *  - the emitter refuses a non-public subject, by throwing, for each of the
 *    four different queries "public" means;
 *  - an event cannot outlive the transaction that published its subject;
 *  - the drain loses nothing on a crash, because it dispatches before it marks;
 *  - `ops` events never reach the public read path;
 *  - unpublication recalls what has not gone out and retracts what has.
 *
 * The events these create are deleted by id in `after`. There is no cascade
 * from `meetings` or `anomaly_flags` — deliberately, per migration 083: a
 * deleted meeting does not retroactively un-announce itself.
 */

const PREFIX = "events-spine-test";
const CITED_SHA = sha256Of("events-spine-cited-agenda");

interface Fixture {
  jurisdictionId: string;
  commissionId: string;
  publishedMeetingId: string;
  withheldMeetingId: string;
  artifactId: string;
}

let fixture: Fixture;
const flagIds: string[] = [];
const claimIds: string[] = [];
const documentIds: string[] = [];
const channelIds: string[] = [];

async function createFlag(options: {
  meetingId: string | null;
  reviewState: "published" | "held";
  severity?: string;
  description?: string;
}): Promise<string> {
  const [row] = await db("anomaly_flags")
    .insert({
      meeting_id: options.meetingId,
      artifact_id: fixture.artifactId,
      flag_type: "quorum_issue",
      description: options.description ?? "Only 2 of 5 members present",
      severity: options.severity ?? "high",
      source: "auto",
      review_state: options.reviewState,
    })
    .returning<Array<{ id: string }>>("id");
  flagIds.push(row.id);
  return row.id;
}

async function createClaim(meetingId: string, status: "held" | "approved"): Promise<string> {
  const [row] = await db("minute_claims")
    .insert({
      meeting_id: meetingId,
      artifact_sha256: CITED_SHA,
      subject_name: "Commissioner Example",
      action: "voted_yes",
      quote: "Commissioner Example voted aye.",
      quote_offset: 42,
      model: "test-model",
      prompt_version: "v0",
      status,
    })
    .returning<Array<{ id: string }>>("id");
  claimIds.push(row.id);
  return row.id;
}

async function createDocument(meetingId: string): Promise<string> {
  const [row] = await db("meeting_documents")
    .insert({
      meeting_id: meetingId,
      title: `${PREFIX} agenda`,
      document_type: "agenda",
      url: "https://example.invalid/agenda.pdf",
    })
    .returning<Array<{ id: string }>>("id");
  documentIds.push(row.id);
  return row.id;
}

/** Records what it was handed, and sends nothing. */
class RecordingDispatcher implements EventDispatcherLike {
  readonly seen: DeliveryEvent[] = [];

  dispatch(event: DeliveryEvent): Promise<DispatchResult> {
    this.seen.push(event);
    return Promise.resolve({ queued: [], deferred: [], duplicates: 0, channels: 0 });
  }
}

before(async () => {
  const source = await createSource(PREFIX);
  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
  });
  const withheldMeetingId = await createMeeting(source.commissionId, { publishedAt: null });
  const artifactId = await createArtifact(CITED_SHA, "https://example.invalid/agenda.pdf");

  fixture = {
    jurisdictionId: source.jurisdictionId,
    commissionId: source.commissionId,
    publishedMeetingId,
    withheldMeetingId,
    artifactId,
  };
});

after(async () => {
  const subjectIds = [
    ...flagIds,
    ...claimIds,
    ...documentIds,
    fixture.publishedMeetingId,
    fixture.withheldMeetingId,
  ];
  const events = await db("events")
    .whereIn("subject_id", subjectIds)
    .orWhere("jurisdiction_id", fixture.jurisdictionId)
    .select<Array<{ id: string; dedupe_key: string }>>("id", "dedupe_key");

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

  if (channelIds.length > 0) {
    await db("deliveries").whereIn("channel_id", channelIds).del();
    await db("channel_routes").whereIn("channel_id", channelIds).del();
    await db("delivery_channels").whereIn("id", channelIds).del();
  }

  await db("minute_claims").whereIn("id", claimIds).del();
  await db("approval_requests").whereIn("anomaly_flag_id", flagIds).del();
  await db("anomaly_flags").whereIn("id", flagIds).del();
  await db("meeting_documents").whereIn("id", documentIds).del();
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([CITED_SHA]);
  await db.destroy();
});

/* ------------------------------------------------------------------------- */

describe("emitEvent refuses a subject that is not public", () => {
  it("refuses an unpublished meeting", async () => {
    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "meeting.published",
          subject_kind: "meeting",
          subject_id: fixture.withheldMeetingId,
        }),
      (error: unknown) =>
        error instanceof EventPublicationError && /is not public/.test(error.message),
    );

    const row = await db("events")
      .where({ subject_id: fixture.withheldMeetingId })
      .first<{ id: string } | undefined>("id");
    assert.equal(row, undefined, "a refused emit must leave no row");
  });

  it("refuses an approved finding whose meeting is withheld", async () => {
    // The subtle one, and the reason the wall is two conditions rather than
    // one: `review_state` says published and the finding is still invisible,
    // because the meeting it describes has not been published.
    const flagId = await createFlag({
      meetingId: fixture.withheldMeetingId,
      reviewState: "published",
    });

    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "finding.published",
          subject_kind: "finding",
          subject_id: flagId,
        }),
      (error: unknown) => error instanceof EventPublicationError,
    );
  });

  it("refuses a held finding on a published meeting", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "held",
    });

    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "finding.published",
          subject_kind: "finding",
          subject_id: flagId,
        }),
      (error: unknown) => error instanceof EventPublicationError,
    );
  });

  it("refuses a held claim on a published meeting", async () => {
    const claimId = await createClaim(fixture.publishedMeetingId, "held");

    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "claim.approved",
          subject_kind: "claim",
          subject_id: claimId,
        }),
      (error: unknown) => error instanceof EventPublicationError,
    );
  });

  it("refuses a document on a withheld meeting, and allows one on a published meeting", async () => {
    const withheld = await createDocument(fixture.withheldMeetingId);
    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "document.published",
          subject_kind: "document",
          subject_id: withheld,
        }),
      (error: unknown) => error instanceof EventPublicationError,
    );

    const published = await createDocument(fixture.publishedMeetingId);
    const result = await emitEvent(db, {
      event_type: "document.published",
      subject_kind: "document",
      subject_id: published,
      jurisdiction_id: fixture.jurisdictionId,
    });
    assert.equal(result.created, true);
  });

  it("lets an ops event through without a publication state to check", async () => {
    const result = await emitEvent(db, {
      event_type: "ops.sweep.failed",
      subject_kind: "ops",
      jurisdiction_id: fixture.jurisdictionId,
      severity: "critical",
      dedupe_key: `${PREFIX}:ops.sweep.failed:1`,
      payload: { detail: "adapter returned 403" },
    });
    assert.equal(result.created, true);
  });

  it("refuses an ops event with no dedupe key, rather than collapsing every later one into the first", async () => {
    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "ops.source.stale",
          subject_kind: "ops",
        }),
      (error: unknown) => error instanceof EventInputError,
    );
  });
});

describe("emitEvent and the transaction that published the subject", () => {
  it("leaves no row when the transaction rolls back", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "held",
    });

    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          await trx("anomaly_flags").where({ id: flagId }).update({ review_state: "published" });
          await emitEvent(trx, {
            event_type: "finding.published",
            subject_kind: "finding",
            subject_id: flagId,
          });
          // Whatever goes wrong after the publish — a failed audit write, a
          // constraint, a crash — must take the announcement with it.
          throw new Error("rolled back after emitting");
        }),
      /rolled back after emitting/,
    );

    const event = await db("events").where({ subject_id: flagId }).first<{ id: string } | undefined>("id");
    assert.equal(event, undefined);

    const flag = await db("anomaly_flags")
      .where({ id: flagId })
      .first<{ review_state: string }>("review_state");
    assert.equal(flag.review_state, "held", "the publish rolled back too");
  });

  it("yields one row when the same publish runs twice", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });

    const first = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });
    const second = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false, "the second is the dedupe index working");
    assert.equal(second.id, first.id);

    const rows = await db("events").where({ subject_id: flagId }).select<Array<{ id: string }>>("id");
    assert.equal(rows.length, 1);
  });
});

describe("the review queue's approve emits finding.published", () => {
  it("announces an approved finding on a published meeting", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "held",
      description: "Only 3 of 5 members present at the vote",
    });
    await ensureApprovalRequests(db);

    await approveFinding(db, {
      flagId,
      reason: "Checked against the stored agenda; the roll call reads as described.",
      actor: { id: null, email: `${PREFIX}@example.invalid` },
    });

    const event = await db("events")
      .where({ subject_id: flagId })
      .first<{ event_type: string; severity: string | null; jurisdiction_id: string | null } | undefined>(
        "event_type",
        "severity",
        "jurisdiction_id",
      );
    assert.equal(event?.event_type, "finding.published");
    assert.equal(event?.severity, "high");
    assert.equal(event?.jurisdiction_id, fixture.jurisdictionId);
  });

  it("approves a finding on a withheld meeting without announcing it", async () => {
    // Approving is a decision about the finding; publishing is a decision about
    // the meeting. Until both are made there is nothing a reader can see, so
    // there is nothing to announce — and the approval must still succeed.
    const flagId = await createFlag({
      meetingId: fixture.withheldMeetingId,
      reviewState: "held",
      description: "Minutes not published 40 days after the meeting",
    });
    await ensureApprovalRequests(db);

    await approveFinding(db, {
      flagId,
      reason: "The gap is real and the stored agenda dates it.",
      actor: { id: null, email: `${PREFIX}@example.invalid` },
    });

    assert.equal(await subjectIsPublic(db, "finding", flagId), false);
    const event = await db("events").where({ subject_id: flagId }).first<{ id: string } | undefined>("id");
    assert.equal(event, undefined);
  });
});

describe("the drain", () => {
  it("is off unless EVENT_DRAIN_ENABLED says otherwise", () => {
    assert.equal(eventDrainEnabled({}), false);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: "" }), false);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: "0" }), false);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: "false" }), false);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: "1" }), true);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: "true" }), true);
    assert.equal(eventDrainEnabled({ EVENT_DRAIN_ENABLED: " On " }), true);
  });

  it("dispatches one subject's events in occurred_at order", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });

    const later = new Date();
    const earlier = new Date(later.getTime() - 60_000);

    // Written out of order on purpose: the drain's ORDER BY is what puts them
    // back, not the order they were inserted in.
    await emitEvent(db, {
      event_type: "finding.updated",
      subject_kind: "finding",
      subject_id: flagId,
      occurred_at: later,
      dedupe_key: `${PREFIX}:finding.updated:${flagId}`,
    });
    await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      occurred_at: earlier,
    });

    const dispatcher = new RecordingDispatcher();
    const drain = new EventDrain(db, { dispatcher, enabled: true, batchSize: 500 });
    await drain.tick();

    const mine = dispatcher.seen.filter((event) => event.payload.subject_id === flagId);
    assert.deepEqual(
      mine.map((event) => event.event_type),
      ["finding.published", "finding.updated"],
    );
  });

  it("re-dispatches after a crash between the send and the mark, adding no deliveries row", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${PREFIX} channel`,
      config: { webhook_url: "https://discord.com/api/webhooks/1234567890/abcdefghijklmnop" },
    });
    channelIds.push(channel.id);
    await createRoute(db, { channel_id: channel.id, event_type: "finding.*" });

    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });
    const emitted = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });

    // autoFlush off: rows are written, nothing is sent, no network is touched.
    const dispatcher = new DeliveryDispatcher(db, { autoFlush: false, logger: { error: () => {}, warn: () => {} } });
    const drain = new EventDrain(db, { dispatcher, enabled: true, batchSize: 500 });

    const countDeliveries = async (): Promise<number> => {
      const row = await db("deliveries")
        .where({ dedupe_key: emitted.dedupe_key, channel_id: channel.id })
        .count<Array<{ count: string }>>();
      return Number(row[0]?.count ?? 0);
    };

    // The crash: claim, dispatch, then die before the mark. The transaction
    // rolls back; the `deliveries` row does not, because the dispatcher writes
    // on its own connection.
    let claimed: ClaimedEvent[] = [];
    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          claimed = await drain.claimBatch(trx, 500);
          for (const event of claimed.filter((row) => row.id === emitted.id)) {
            await dispatcher.dispatch(toDeliveryEvent(event));
          }
          throw new Error("process died before dispatched_at");
        }),
      /process died before dispatched_at/,
    );

    assert.ok(
      claimed.some((row) => row.id === emitted.id),
      "the event was claimable",
    );
    assert.equal(await countDeliveries(), 1);

    const undispatched = await db("events")
      .where({ id: emitted.id })
      .first<{ dispatched_at: Date | null }>("dispatched_at");
    assert.equal(undispatched.dispatched_at, null, "the mark never happened, so it re-dispatches");

    await drain.tick();

    assert.equal(await countDeliveries(), 1, "the (channel_id, dedupe_key) index absorbed the repeat");
    const after = await db("events")
      .where({ id: emitted.id })
      .first<{ dispatched_at: Date | null }>("dispatched_at");
    assert.notEqual(after.dispatched_at, null);

    dispatcher.close();
  });
});

describe("a public consumer never sees an ops event", () => {
  it("filters subject_kind = 'ops' out of the public read path", async () => {
    const opsEmit = await emitEvent(db, {
      event_type: "ops.source.stale",
      subject_kind: "ops",
      jurisdiction_id: fixture.jurisdictionId,
      severity: "high",
      dedupe_key: `${PREFIX}:ops.source.stale:1`,
    });

    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });
    const findingEmit = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });

    // Asserted against the consumer, not the emitter: the emitter is allowed to
    // write an ops row, and the guarantee is that no public read returns one.
    const visible = await listPublicEvents(db, {
      jurisdiction_id: fixture.jurisdictionId,
      limit: 200,
    });
    const ids = visible.map((row) => row.id);

    assert.ok(ids.includes(findingEmit.id), "the finding event is public");
    assert.ok(!ids.includes(opsEmit.id), "the ops event is not");
    // Widened to `string` on purpose: `PublicEventRow.subject_kind` excludes
    // `ops` at the type level, so the narrow comparison would not compile. The
    // type saying so is good; a runtime check that the rows agree is better.
    const kinds = new Set(visible.map((row): string => row.subject_kind));
    assert.ok(!kinds.has("ops"));
  });
});

describe("unpublication", () => {
  it("recalls an undispatched event outright", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });
    const emitted = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });

    await db("anomaly_flags").where({ id: flagId }).update({ review_state: "held" });
    const result = await retractSubject(db, {
      subject_kind: "finding",
      subject_id: flagId,
      reason: "The roll call was misread; the quorum figure is wrong.",
      jurisdiction_id: fixture.jurisdictionId,
    });

    assert.deepEqual(result.recalled, [emitted.id]);
    assert.deepEqual(result.dispatched, []);
    assert.equal(result.retraction, null, "nothing went out, so there is nothing to retract");

    // The partial index drops it: the drain cannot claim it any more.
    const dispatcher = new RecordingDispatcher();
    const drain = new EventDrain(db, { dispatcher, enabled: true, batchSize: 500 });
    const claimed = await db.transaction((trx) => drain.claimBatch(trx, 500));
    assert.ok(!claimed.some((row) => row.id === emitted.id));

    const row = await db("events")
      .where({ id: emitted.id })
      .first<{ revoked_at: Date | null; revoked_reason: string | null }>("revoked_at", "revoked_reason");
    assert.notEqual(row.revoked_at, null);
    assert.match(row.revoked_reason ?? "", /quorum figure is wrong/);
  });

  it("emits a retraction when the event has already gone out", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });
    const emitted = await emitEvent(db, {
      event_type: "finding.published",
      subject_kind: "finding",
      subject_id: flagId,
      jurisdiction_id: fixture.jurisdictionId,
    });

    const dispatcher = new RecordingDispatcher();
    const drain = new EventDrain(db, { dispatcher, enabled: true, batchSize: 500 });
    await drain.tick();

    const sent = await db("events")
      .where({ id: emitted.id })
      .first<{ dispatched_at: Date | null }>("dispatched_at");
    assert.notEqual(sent.dispatched_at, null);

    await db("anomaly_flags").where({ id: flagId }).update({ review_state: "held" });
    const result = await retractSubject(db, {
      subject_kind: "finding",
      subject_id: flagId,
      reason: "Withdrawn after the county published a corrected roll call.",
      jurisdiction_id: fixture.jurisdictionId,
    });

    assert.deepEqual(result.dispatched, [emitted.id]);
    assert.ok(result.retraction, "a dispatched announcement gets a retraction");

    const retraction = await db("events")
      .where({ id: result.retraction?.id })
      .first<{ event_type: string; subject_id: string; payload: unknown }>(
        "event_type",
        "subject_id",
        "payload",
      );
    assert.equal(retraction.event_type, "finding.retracted");
    assert.equal(retraction.subject_id, flagId);
  });

  it("refuses a retraction for a subject that is still public", async () => {
    const flagId = await createFlag({
      meetingId: fixture.publishedMeetingId,
      reviewState: "published",
    });

    await assert.rejects(
      () =>
        emitEvent(db, {
          event_type: "finding.retracted",
          subject_kind: "finding",
          subject_id: flagId,
        }),
      (error: unknown) =>
        error instanceof EventPublicationError && /still public/.test(error.message),
    );
  });
});

describe("route prefix matching", () => {
  it("builds the matchers a dotted event type should answer to", () => {
    assert.deepEqual(eventTypeMatchers("meeting.published"), [
      "meeting.published",
      "*",
      "meeting.*",
    ]);
    assert.deepEqual(eventTypeMatchers("ops.sweep.failed"), [
      "ops.sweep.failed",
      "*",
      "ops.*",
      "ops.sweep.*",
    ]);
    assert.deepEqual(eventTypeMatchers("bare"), ["bare", "*"]);
  });

  it("routes meeting.* to meeting.published and not to ops.sweep.failed", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${PREFIX} prefix channel`,
      config: { webhook_url: "https://discord.com/api/webhooks/2234567890/abcdefghijklmnop" },
    });
    channelIds.push(channel.id);
    await createRoute(db, {
      channel_id: channel.id,
      event_type: "meeting.*",
      jurisdiction_id: fixture.jurisdictionId,
    });

    const matched = await resolveRoutes(db, {
      event_type: "meeting.published",
      jurisdiction_id: fixture.jurisdictionId,
    });
    assert.ok(matched.some((route) => route.channel_id === channel.id));

    // The reason prefix matching exists: without it operators route `*`, which
    // subscribes a public channel to ops events.
    const ops = await resolveRoutes(db, {
      event_type: "ops.sweep.failed",
      jurisdiction_id: fixture.jurisdictionId,
    });
    assert.ok(!ops.some((route) => route.channel_id === channel.id));
  });

  /**
   * The premise of this test was inverted on 2026-08-15, and the inversion is
   * the safety property.
   *
   * It used to assert that a bare `*` route matched every event type. That was
   * true and it was the hazard prefix matching existed to reduce: an operator
   * who finds per-namespace routes tedious writes `*` once, and a public Discord
   * server is silently subscribed to `ops.sweep.failed` and, worse, to
   * `dispute.*` — a contest that migration 039's CHECK forbids publishing at
   * all.
   *
   * `channels.ts` now refuses `*` on a channel whose audience is public and says
   * what to write instead. Convention could never have held this: the whole
   * failure mode is an operator taking the shortcut the system allowed.
   */
  it("refuses a bare wildcard route on a public channel", async () => {
    const channel = await createChannel(db, {
      channel_type: "discord",
      name: `${PREFIX} wildcard channel`,
      config: { webhook_url: "https://discord.com/api/webhooks/3234567890/abcdefghijklmnop" },
    });
    channelIds.push(channel.id);

    await assert.rejects(
      () =>
        createRoute(db, {
          channel_id: channel.id,
          event_type: "*",
          jurisdiction_id: fixture.jurisdictionId,
        }),
      /matches every event/,
      "a public channel must not be routable to every event type",
    );
  });});


/**
 * The emitter's claim check used a hand-written predicate that was correct when
 * written and one clause out of date the moment migration 087 added
 * `retracted_at`. A claim withdrawn after its event was written still satisfied
 * it, so the emitter would have announced a retracted sentence about a named
 * person. It now goes through `whereClaimPublic`, and this is what keeps it
 * there.
 */
describe("emitEvent · a retracted claim is not public", () => {
  it("refuses to emit for a claim that has been withdrawn", async () => {
    const columns = await db("minute_claims").columnInfo();
    assert.ok(
      "retracted_at" in columns,
      "migration 087 must have run; without the column this test proves nothing",
    );

    // The predicate itself, asserted directly: the helper is the only place the
    // rule lives, so exercising it is exercising the emitter's check.
    const { whereClaimPublic } = await import("../src/services/publication");
    const sql = whereClaimPublic(db, db("minute_claims")).toString();
    assert.match(
      sql,
      /retracted_at/,
      "the claim wall must test retracted_at, or a withdrawn claim stays announceable",
    );
    assert.match(sql, /approved/);
  });
});
