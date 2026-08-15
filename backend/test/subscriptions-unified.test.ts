process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { SubscriptionService } from "../src/services/delivery/subscriptions";
import { DeliveryDispatcher } from "../src/services/delivery/dispatcher";
import { TwilioClient } from "../src/services/delivery/sms";
import { encryptConfig } from "../src/services/delivery/crypto";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const GALLATIN_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

/**
 * Every fixture in this file is named with one of these prefixes so cleanup can
 * be exact. Several suites in this project count global rows.
 */
const EMAIL_PREFIX = "unified-test";
const PHONE_PREFIX = "+1500555";

async function cleanup(): Promise<void> {
  const ids = await db("delivery_channels")
    .where("name", "like", `${EMAIL_PREFIX}%`)
    .orWhere("name", "like", `${PHONE_PREFIX}%`)
    .select<Array<{ id: string }>>("id");
  const channelIds = ids.map((row) => row.id);
  if (channelIds.length === 0) return;
  await db("deliveries").whereIn("channel_id", channelIds).del();
  await db("channel_routes").whereIn("channel_id", channelIds).del();
  await db("delivery_channels").whereIn("id", channelIds).del();
}

const service = new SubscriptionService(db);

function email(suffix: string): string {
  return `${EMAIL_PREFIX}-${suffix}@example.invalid`;
}

describe("subscriptions on the unified delivery model", () => {
  before(cleanup);
  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await db.destroy();
  });

  describe("subscribe", () => {
    it("creates one subscriber channel and one route", async () => {
      const result = await service.subscribe({
        channel_type: "email",
        destination: email("basic"),
        jurisdiction_id: BOZEMAN_ID,
      });

      assert.equal(result.channel_type, "email");
      assert.equal(result.verified, false, "a new destination is unconfirmed");
      assert.equal(result.routes.length, 1);
      assert.equal(result.routes[0].cadence, "immediate");
      assert.equal(result.routes[0].jurisdiction_id, BOZEMAN_ID);
      assert.equal(result.routes[0].event_type, "anomaly.flagged");
    });

    it("collapses two jurisdictions onto one destination with two routes", async () => {
      // This is the shape alert_subscriptions' (email, jurisdiction_id) unique
      // key was approximating: one destination, many filters.
      await service.subscribe({
        channel_type: "email",
        destination: email("two-jurisdictions"),
        jurisdiction_id: BOZEMAN_ID,
      });
      const second = await service.subscribe({
        channel_type: "email",
        destination: email("two-jurisdictions"),
        jurisdiction_id: GALLATIN_ID,
      });

      assert.equal(second.routes.length, 2);

      const [{ count }] = await db("delivery_channels")
        .where({ name: email("two-jurisdictions") })
        .count<{ count: string }[]>();
      assert.equal(Number(count), 1, "one destination is one channel");
    });

    it("does not duplicate a route when the same subscription is submitted twice", async () => {
      await service.subscribe({
        channel_type: "email",
        destination: email("twice"),
        jurisdiction_id: BOZEMAN_ID,
        cadence: "immediate",
      });
      const again = await service.subscribe({
        channel_type: "email",
        destination: email("twice"),
        jurisdiction_id: BOZEMAN_ID,
        cadence: "weekly",
      });

      assert.equal(again.routes.length, 1, "a resubmitted form must not double someone's mail");
      assert.equal(again.routes[0].cadence, "weekly", "it updates the existing route instead");
    });

    it("masks the destination even in the holder's own view", async () => {
      const result = await service.subscribe({
        channel_type: "email",
        destination: email("masked"),
        jurisdiction_id: BOZEMAN_ID,
      });
      assert.equal(result.destination_masked.includes(EMAIL_PREFIX), false);
      assert.match(result.destination_masked, /@example\.invalid$/);
    });

    it("refuses a phone number that is not E.164", async () => {
      await assert.rejects(
        () =>
          service.subscribe({
            channel_type: "sms",
            destination: "4065550123",
            jurisdiction_id: BOZEMAN_ID,
          }),
        /E\.164/,
      );
    });

    it("refuses a jurisdiction that does not exist", async () => {
      await assert.rejects(
        () =>
          service.subscribe({
            channel_type: "email",
            destination: email("bad-jurisdiction"),
            jurisdiction_id: "00000000-0000-0000-0000-000000000000",
          }),
        /Jurisdiction not found/,
      );
    });

    it("refuses to subscribe a destination that is already an operator channel", async () => {
      const name = email("operator-owned");
      await db("delivery_channels").insert({
        channel_type: "email",
        owner_kind: "operator",
        name,
        config_encrypted: encryptConfig({ email: name }),
        enabled: true,
      });

      await assert.rejects(
        () => service.subscribe({ channel_type: "email", destination: name, jurisdiction_id: BOZEMAN_ID }),
        /cannot be subscribed/,
      );
    });
  });

  describe("verify, unsubscribe, resubscribe", () => {
    it("verifies once and stays verified", async () => {
      const created = await service.subscribe({
        channel_type: "email",
        destination: email("verify"),
        jurisdiction_id: BOZEMAN_ID,
      });
      assert.ok(created.verify_token);

      const verified = await service.verify(created.verify_token);
      assert.equal(verified?.verified, true);

      const again = await service.verify(created.verify_token);
      assert.equal(again?.verified, true, "verifying twice is a success, not an error");
    });

    it("disables every route on unsubscribe and keeps the token resolvable", async () => {
      const created = await service.subscribe({
        channel_type: "email",
        destination: email("unsub"),
        jurisdiction_id: BOZEMAN_ID,
      });

      const after = await service.unsubscribe(created.unsubscribe_token);
      assert.equal(after?.enabled, false);
      assert.equal(after?.routes.every((route) => !route.enabled), true);

      // A second click on an old link must be able to say "you are
      // unsubscribed" rather than 404.
      const stillThere = await service.readByToken(created.unsubscribe_token);
      assert.equal(stillThere?.enabled, false);
    });

    it("resubscribes, which is the START half of SMS consent", async () => {
      const created = await service.subscribe({
        channel_type: "email",
        destination: email("resub"),
        jurisdiction_id: BOZEMAN_ID,
      });

      await service.unsubscribe(created.unsubscribe_token);
      const back = await service.resubscribe(created.unsubscribe_token);
      assert.equal(back?.enabled, true);
      assert.equal(back?.routes.every((route) => route.enabled), true);
    });

    it("resolves nothing for an operator channel's id or a stranger's token", async () => {
      assert.equal(await service.readByToken("f".repeat(64)), null);
      assert.equal(await service.verify(""), null);
      assert.equal(await service.unsubscribe(""), null);
    });
  });

  describe("the public /api/alerts surface", () => {
    it("subscribes, never returns the verify token, and never the raw destination", async () => {
      const res = await request(app)
        .post("/api/alerts")
        .send({
          channel_type: "email",
          destination: email("route-create"),
          jurisdiction_id: BOZEMAN_ID,
          cadence: "daily",
        })
        .expect(201);

      // The verify token proves the requester reads the address. Returning it
      // to the requester lets them verify an address they do not own, which is
      // double opt-in with the opt-in removed — delivery §5d. It reaches the
      // holder by mail and by no other route.
      assert.equal(res.body.verify_token, undefined);
      assert.equal(res.body.created, true);
      assert.equal(res.body.routes[0].cadence, "daily");
      assert.equal(
        JSON.stringify(res.body).includes(email("route-create")),
        false,
        "the raw destination must not appear in any response",
      );
    });

    it("verifies through the token, and 404s an unknown one", async () => {
      await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-verify"), jurisdiction_id: BOZEMAN_ID })
        .expect(201);

      // Read from the row, because the response no longer carries it — which is
      // the point. Only something with database access, i.e. the mailer, can
      // put this token in front of the person who owns the address.
      const row = await db("delivery_channels")
        .where({ name: email("route-verify") })
        .first<{ verify_token: string }>("verify_token");
      await request(app).get(`/api/alerts/verify/${row.verify_token}`).expect(200);
      await request(app).get(`/api/alerts/verify/${"a".repeat(64)}`).expect(404);
      await request(app).get("/api/alerts/verify/short").expect(400);
    });

    it("gives a re-subscriber no token for a channel it did not create", async () => {
      const first = await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-again"), jurisdiction_id: BOZEMAN_ID })
        .expect(201);
      assert.equal(first.body.created, true);
      assert.ok(first.body.unsubscribe_token);

      // The same address, typed by somebody else. `subscribe` resolves to the
      // existing row, so an unconditional response would hand a stranger the
      // token that reads, edits and cancels that subscriber's alerts.
      const again = await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-again"), jurisdiction_id: GALLATIN_ID })
        .expect(201);
      assert.equal(again.body.created, false);
      assert.equal(again.body.unsubscribe_token, undefined);
      assert.equal(again.body.verify_token, undefined);
    });

    it("lets the holder change cadence on their own route and nobody else's", async () => {
      const mine = await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-mine"), jurisdiction_id: BOZEMAN_ID })
        .expect(201);
      const theirs = await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-theirs"), jurisdiction_id: BOZEMAN_ID })
        .expect(201);

      await request(app)
        .patch(`/api/alerts/${mine.body.unsubscribe_token}`)
        .send({ route_id: mine.body.routes[0].id, cadence: "weekly" })
        .expect(200);

      // Someone else's route id, presented with my token, is a 404 — not a 403,
      // which would confirm it exists.
      await request(app)
        .patch(`/api/alerts/${mine.body.unsubscribe_token}`)
        .send({ route_id: theirs.body.routes[0].id, cadence: "weekly" })
        .expect(404);
    });

    it("unsubscribes through the token", async () => {
      const created = await request(app)
        .post("/api/alerts")
        .send({ channel_type: "email", destination: email("route-unsub"), jurisdiction_id: BOZEMAN_ID })
        .expect(201);

      const res = await request(app)
        .delete(`/api/alerts/${created.body.unsubscribe_token}`)
        .expect(200);
      assert.equal(res.body.subscription.enabled, false);
    });

    it("rejects a request with no destination", async () => {
      await request(app).post("/api/alerts").send({ channel_type: "email" }).expect(400);
    });
  });

  describe("the dispatcher under the unified model", () => {
    async function makeChannel(input: {
      name: string;
      channel_type: string;
      owner_kind: string;
      verified?: boolean;
      config: Record<string, string>;
    }): Promise<string> {
      const [row] = await db("delivery_channels")
        .insert({
          channel_type: input.channel_type,
          owner_kind: input.owner_kind,
          name: input.name,
          config_encrypted: encryptConfig(input.config),
          enabled: true,
          verified: input.verified ?? true,
          verify_token: input.owner_kind === "subscriber" ? `${input.name}-v`.padEnd(64, "0").slice(0, 64) : null,
          unsubscribe_token: input.owner_kind === "subscriber" ? `${input.name}-u`.padEnd(64, "0").slice(0, 64) : null,
        })
        .returning<Array<{ id: string }>>("id");
      return row.id;
    }

    it("holds a non-immediate route as deferred instead of sending it now", async () => {
      const channelId = await makeChannel({
        name: `${PHONE_PREFIX}0001`,
        channel_type: "sms",
        owner_kind: "subscriber",
        config: { phone: `${PHONE_PREFIX}0001` },
      });
      await db("channel_routes").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        cadence: "daily",
        enabled: true,
      });

      let sends = 0;
      const dispatcher = new DeliveryDispatcher(db, {
        autoFlush: false,
        sms: new TwilioClient({
          accountSid: "AC",
          authToken: "t",
          fromNumber: "+15005550006",
          fetchImpl: async () => {
            sends += 1;
            return { ok: true, status: 201, text: async () => "" };
          },
        }),
      });

      const result = await dispatcher.dispatch({
        event_type: "anomaly.flagged",
        payload: { title: "Deferred event" },
        severity: "high",
      });
      dispatcher.close();

      assert.equal(result.queued.length, 0);
      assert.equal(result.deferred.length, 1);
      assert.equal(sends, 0);

      const row = await db("deliveries").where({ id: result.deferred[0] }).first();
      assert.equal(row.status, "deferred");
      assert.match(row.last_error, /daily digest/);
    });

    it("never sends to an unverified subscriber destination", async () => {
      // The consent gate lives at the transport so no future caller can route
      // around it by writing a delivery row directly.
      const channelId = await makeChannel({
        name: `${PHONE_PREFIX}0002`,
        channel_type: "sms",
        owner_kind: "subscriber",
        verified: false,
        config: { phone: `${PHONE_PREFIX}0002` },
      });
      await db("channel_routes").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        cadence: "immediate",
        enabled: true,
      });

      let sends = 0;
      const dispatcher = new DeliveryDispatcher(db, {
        autoFlush: false,
        sms: new TwilioClient({
          accountSid: "AC",
          authToken: "t",
          fromNumber: "+15005550006",
          fetchImpl: async () => {
            sends += 1;
            return { ok: true, status: 201, text: async () => "" };
          },
        }),
      });

      await dispatcher.dispatch({ event_type: "anomaly.flagged", payload: { title: "No consent" } });
      const flushed = await dispatcher.flushAll();
      dispatcher.close();

      assert.equal(sends, 0, "an unconfirmed number must never be texted");
      assert.equal(flushed[0].status, "skipped");
      assert.match(flushed[0].error ?? "", /consent/);
    });

    it("sends to a verified subscriber destination", async () => {
      const channelId = await makeChannel({
        name: `${PHONE_PREFIX}0003`,
        channel_type: "sms",
        owner_kind: "subscriber",
        verified: true,
        config: { phone: `${PHONE_PREFIX}0003` },
      });
      await db("channel_routes").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        cadence: "immediate",
        enabled: true,
      });

      const bodies: string[] = [];
      const dispatcher = new DeliveryDispatcher(db, {
        autoFlush: false,
        sms: new TwilioClient({
          accountSid: "AC",
          authToken: "t",
          fromNumber: "+15005550006",
          fetchImpl: async (_url, init) => {
            bodies.push(new URLSearchParams(init.body).get("Body") ?? "");
            return { ok: true, status: 201, text: async () => "" };
          },
        }),
      });

      await dispatcher.dispatch({
        event_type: "anomaly.flagged",
        payload: { title: "Emergency session flagged" },
      });
      const flushed = await dispatcher.flushAll();
      dispatcher.close();

      assert.equal(flushed[0].status, "sent");
      assert.equal(bodies.length, 1);
      assert.match(bodies[0], /Emergency session flagged/);
      assert.match(bodies[0], /STOP/, "every message carries the opt-out keyword");
    });

    it("defers rather than dropping when a route's daily cap is reached", async () => {
      const channelId = await makeChannel({
        name: `${PHONE_PREFIX}0004`,
        channel_type: "sms",
        owner_kind: "subscriber",
        verified: true,
        config: { phone: `${PHONE_PREFIX}0004` },
      });
      await db("channel_routes").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        cadence: "immediate",
        daily_send_cap: 1,
        enabled: true,
      });
      // One message already sent today.
      await db("deliveries").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        payload: JSON.stringify({ severity: null, jurisdiction_id: null, occurred_at: new Date().toISOString(), data: {} }),
        dedupe_key: "already-sent-today",
        status: "sent",
        sent_at: new Date(),
      });

      let sends = 0;
      const dispatcher = new DeliveryDispatcher(db, {
        autoFlush: false,
        sms: new TwilioClient({
          accountSid: "AC",
          authToken: "t",
          fromNumber: "+15005550006",
          fetchImpl: async () => {
            sends += 1;
            return { ok: true, status: 201, text: async () => "" };
          },
        }),
      });

      await dispatcher.dispatch({ event_type: "anomaly.flagged", payload: { title: "Over the cap" } });
      const flushed = await dispatcher.flushAll();
      dispatcher.close();

      assert.equal(sends, 0);
      assert.equal(flushed[0].status, "deferred");
      assert.match(flushed[0].error ?? "", /daily send cap of 1/);

      const rows = await db("deliveries").where({ channel_id: channelId, status: "deferred" });
      assert.equal(rows.length, 1, "an over-cap message is held, never dropped silently");
    });

    it("still does not send email — the legacy path remains its only sender", async () => {
      // This is what makes migration 025's back-fill of alert_subscriptions
      // onto delivery_channels incapable of double-sending. If this assertion
      // ever needs changing, alert_subscriptions must be dropped in the same
      // commit.
      const channelId = await makeChannel({
        name: email("dispatcher-email"),
        channel_type: "email",
        owner_kind: "subscriber",
        verified: true,
        config: { email: email("dispatcher-email") },
      });
      await db("channel_routes").insert({
        channel_id: channelId,
        event_type: "anomaly.flagged",
        cadence: "immediate",
        enabled: true,
      });

      const dispatcher = new DeliveryDispatcher(db, { autoFlush: false });
      await dispatcher.dispatch({ event_type: "anomaly.flagged", payload: { title: "Email event" } });
      const flushed = await dispatcher.flushAll();
      dispatcher.close();

      assert.equal(flushed[0].status, "skipped");
      assert.match(flushed[0].error ?? flushed[0].status, /skipped/);
      const row = await db("deliveries").where({ channel_id: channelId }).first();
      assert.equal(row.status, "skipped");
      assert.match(row.last_error, /no dispatcher transport for channel type "email"/);
    });
  });

  describe("the inbound SMS webhook", () => {
    it("refuses an unsigned request with 403 before looking anything up", async () => {
      // Without this the endpoint is an unauthenticated "unsubscribe anyone"
      // API — the body is the only thing naming the number.
      await request(app)
        .post("/api/sms/inbound")
        .type("form")
        .send({ From: `${PHONE_PREFIX}0009`, Body: "STOP" })
        .expect(403);
    });

    it("refuses a wrongly-signed request", async () => {
      await request(app)
        .post("/api/sms/inbound")
        .type("form")
        .set("X-Twilio-Signature", "bm90LWEtc2lnbmF0dXJlLWF0LWFsbA==")
        .send({ From: `${PHONE_PREFIX}0009`, Body: "STOP" })
        .expect(403);
    });
  });
});
