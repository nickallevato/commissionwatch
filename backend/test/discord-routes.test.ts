process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import db from "../src/config/database";
import discordRouter from "../src/routes/discord";
import sessionRouter from "../src/routes/admin/session";
import { OperatorAuthService } from "../src/services/auth/operators";
import { TEST_SCRYPT_PARAMS } from "../src/services/auth/password";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  createRoute,
  eventTypeAudience,
  resolveRoutes,
  routeAllowedForAudience,
} from "../src/services/delivery/channels";
import { encryptConfig } from "../src/services/delivery/crypto";

/**
 * Discord routing: the operator's ability to point an event type at a channel,
 * and to find out afterwards what happened.
 *
 * The invariant under test is the one the delivery spec § 3 states and nothing
 * enforced: **an ops channel is a separate channel row from a public one.**
 * `whereEventPublic` filters `subject_kind <> 'ops'` for consumers that read
 * `events`; the dispatcher does not read `events`, it reads `channel_routes`,
 * so an operator routing `*` to a community server subscribed it to every sweep
 * failure with nothing in the way.
 *
 * It is asserted at three depths on purpose, because a rule with one enforcement
 * point is a rule with one bypass:
 *
 *  - the HTTP surface refuses the route with a sentence,
 *  - `createRoute` refuses it for any caller,
 *  - `resolveRoutes` refuses to deliver it even if a row somehow exists —
 *    which is the case that matters after a restore or a manual UPDATE.
 *
 * This router is mounted on its own app rather than through `src/app.ts`,
 * because where it is mounted is the orchestrator's decision and this suite must
 * not encode a guess about it. The guard is the router's own, so it is exercised
 * either way.
 */

const EMAIL = "discord-routes-test@example.invalid";
const PASSWORD = "a-sufficiently-long-passphrase";
const NAME_PREFIX = "discord-routes-test";
const WEBHOOK = "https://discord.com/api/webhooks/987654321/qrstuvwxyz-TOKEN-9b1c";
const OPS_WEBHOOK = "https://discord.com/api/webhooks/987654322/opsopsopsops-TOKEN-2c4d";

const auth = new OperatorAuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, log: () => {} });

const app = express();
app.use(express.json());
app.use("/api/admin/session", sessionRouter);
app.use("/api/admin/discord", discordRouter);
app.use(errorHandler);

async function cleanup(): Promise<void> {
  const rows = await db("delivery_channels")
    .where("name", "like", `${NAME_PREFIX}%`)
    .select<Array<{ id: string }>>("id");
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db("deliveries").whereIn("channel_id", ids).del();
    await db("channel_routes").whereIn("channel_id", ids).del();
    await db("delivery_channels").whereIn("id", ids).del();
  }
  await db("operators").where({ email: EMAIL }).del();
}

async function signIn(): Promise<string> {
  await auth.createOperator({ email: EMAIL, password: PASSWORD, name: "Discord Operator" });
  const res = await request(app)
    .post("/api/admin/session")
    .send({ email: EMAIL, password: PASSWORD })
    .expect(200);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies.find((c: string) => c.startsWith("cw_session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}

describe("discord routing", () => {
  let cookie: string;
  let publicChannelId: string;
  let opsChannelId: string;

  before(async () => {
    await cleanup();
    cookie = await signIn();
  });

  after(async () => {
    await cleanup();
    await db.destroy();
  });

  it("is closed without a session", async () => {
    // The guard is the router's own rather than inherited from where it is
    // mounted, so a mount that forgets `requireOperator` cannot open it.
    await request(app).get("/api/admin/discord").expect(401);
    await request(app).get("/api/admin/discord/deliveries/log").expect(401);
    await request(app).post("/api/admin/discord").send({}).expect(401);
  });

  it("refuses to create a channel without an audience", async () => {
    // No default. A default would let the operator not decide, and not deciding
    // is how a community server ends up subscribed to sweep failures.
    const res = await request(app)
      .post("/api/admin/discord")
      .set("Cookie", cookie)
      .send({ name: `${NAME_PREFIX}-undecided`, webhook_url: WEBHOOK })
      .expect(400);
    assert.match(res.body.error, /audience is required/i);
  });

  it("creates a public channel and never echoes the webhook back", async () => {
    const res = await request(app)
      .post("/api/admin/discord")
      .set("Cookie", cookie)
      .send({ name: `${NAME_PREFIX}-public`, webhook_url: WEBHOOK, audience: "public" })
      .expect(201);

    publicChannelId = res.body.id;
    assert.equal(res.body.audience, "public");
    assert.equal(
      JSON.stringify(res.body).includes(WEBHOOK),
      false,
      "the webhook token is a bearer credential and is never echoed",
    );
    assert.equal(res.body.config_masked.includes("TOKEN"), false);
  });

  it("creates an ops channel as a separate row with its own webhook", async () => {
    const res = await request(app)
      .post("/api/admin/discord")
      .set("Cookie", cookie)
      .send({ name: `${NAME_PREFIX}-ops`, webhook_url: OPS_WEBHOOK, audience: "ops" })
      .expect(201);

    opsChannelId = res.body.id;
    assert.equal(res.body.audience, "ops");
    assert.notEqual(opsChannelId, publicChannelId);
  });

  it("accepts a prefix route on a public channel, which is what * was standing in for", async () => {
    const res = await request(app)
      .post(`/api/admin/discord/${publicChannelId}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "meeting.*", min_severity: "info" })
      .expect(201);
    assert.equal(res.body.event_type, "meeting.*");
  });

  it("refuses ops.* on a public channel, and says what to do instead", async () => {
    const res = await request(app)
      .post(`/api/admin/discord/${publicChannelId}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "ops.*" })
      .expect(400);
    assert.match(res.body.error, /ops/i);
    assert.match(res.body.error, /own channel row/i);
  });

  it("refuses dispute.* on a public channel, before anything emits one", async () => {
    // A dispute is never published (migration 039). The route that would leak
    // one has to be impossible on the day something starts emitting it, not
    // after.
    await request(app)
      .post(`/api/admin/discord/${publicChannelId}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "dispute.received" })
      .expect(400);
  });

  it("refuses the bare wildcard on a public channel", async () => {
    // `*` is the shortcut an operator reaches for, and it matches ops and
    // disputes along with everything else.
    const res = await request(app)
      .post(`/api/admin/discord/${publicChannelId}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "*" })
      .expect(400);
    assert.match(res.body.error, /matches every event/i);
  });

  it("accepts ops.* on the ops channel", async () => {
    await request(app)
      .post(`/api/admin/discord/${opsChannelId}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "ops.*", min_severity: "high" })
      .expect(201);
  });

  it("answers whether a route would be allowed without sending anything", async () => {
    // A dry run rather than a test post: a test post to a public server is a
    // message real people read.
    const refused = await request(app)
      .get(`/api/admin/discord/${publicChannelId}/would-route?event_type=ops.backup_failed`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(refused.body.allowed, false);
    assert.equal(refused.body.event_audience, "ops");

    const allowed = await request(app)
      .get(`/api/admin/discord/${publicChannelId}/would-route?event_type=finding.published`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(allowed.body.allowed, true);
  });

  it("names the prefixes, so an operator has no reason to reach for *", async () => {
    const res = await request(app)
      .get("/api/admin/discord/event-types")
      .set("Cookie", cookie)
      .expect(200);

    assert.ok(res.body.public_prefixes.includes("meeting.*"));
    assert.ok(res.body.public_prefixes.includes("finding.*"));
    assert.ok(res.body.public_prefixes.includes("claim.*"));
    assert.equal(
      res.body.public_prefixes.some((prefix: string) => prefix.startsWith("ops")),
      false,
      "an ops prefix must never appear in the public list",
    );
    assert.ok(res.body.restricted_prefixes.includes("ops.*"));
    assert.equal(res.body.wildcard.allowed_audience, "ops");
  });

  it("404s an email channel addressed through the Discord router", async () => {
    const name = `${NAME_PREFIX}-email`;
    const [row] = await db("delivery_channels")
      .insert({
        channel_type: "email",
        owner_kind: "operator",
        name,
        config_encrypted: encryptConfig({ email: "ops@example.invalid" }),
        enabled: true,
      })
      .returning<Array<{ id: string }>>("id");

    // Not a 400. This router's copy is entirely about webhooks, and editing an
    // email channel through it would be a screen lying about what it edits.
    await request(app).get(`/api/admin/discord/${row.id}`).set("Cookie", cookie).expect(404);
  });

  /**
   * The service-level half. `routes/discord.ts` is not the only writer —
   * `services/delivery/subscriptions.ts` inserts into `channel_routes`
   * directly — so the rule has to hold for a caller that never touches HTTP.
   */
  it("refuses a restricted route at createRoute, for any caller", async () => {
    await assert.rejects(
      () => createRoute(db, { channel_id: publicChannelId, event_type: "ops.sweep.failed" }),
      /ops/i,
    );
  });

  /**
   * The one that survives a bad row. Configuration checks run once; this runs
   * on every send, which is what makes the guarantee independent of what is
   * already in the table after a restore or a manual UPDATE.
   */
  it("does not deliver an ops event to a public channel even when the row exists", async () => {
    // Inserted past the API and past `createRoute`. The database trigger
    // refuses this too, so the row is created while the channel is ops and the
    // channel is then rewritten underneath it — which is exactly the state a
    // partial restore leaves behind.
    const [route] = await db("channel_routes")
      .insert({ channel_id: opsChannelId, event_type: "ops.backup_failed", enabled: true })
      .returning<Array<{ id: string }>>("id");

    // Both triggers refuse this state, which is the point: it can only arise
    // from something that is not going through them. Disabling one for a single
    // statement is how that is reproduced here. What is under test is the
    // send-time filter; the trigger has its own assertion below.
    await db.raw(
      "ALTER TABLE delivery_channels DISABLE TRIGGER delivery_channels_audience_guard_trigger",
    );
    await db("delivery_channels").where({ id: opsChannelId }).update({ audience: "public" });
    await db.raw(
      "ALTER TABLE delivery_channels ENABLE TRIGGER delivery_channels_audience_guard_trigger",
    );

    const resolved = await resolveRoutes(db, { event_type: "ops.backup_failed" });
    assert.equal(
      resolved.some((r) => r.route_id === route.id),
      false,
      "an ops event must not resolve to a channel whose audience is public",
    );

    // Put it back, so the delivery-log assertions below read a sane fixture.
    await db("delivery_channels").where({ id: opsChannelId }).update({ audience: "ops" });
  });

  it("refuses to relabel an ops channel as public while it still carries ops routes", async () => {
    // Otherwise the separation is undone by editing a name field: create the
    // ops channel, add ops.*, flip it to public.
    await assert.rejects(
      () => db("delivery_channels").where({ id: opsChannelId }).update({ audience: "public" }),
      /restricted route/i,
    );
  });

  /**
   * `deliveries.status`, `.attempts` and `.last_error` have been written since
   * migration 015 and never read back. The dispatcher's durability argument —
   * "a failed post is something you can query" — was only half true.
   */
  it("shows what was sent, what failed, and why", async () => {
    await db("deliveries").insert([
      {
        channel_id: publicChannelId,
        event_type: "finding.published",
        payload: JSON.stringify({ severity: "high", jurisdiction_id: null, occurred_at: new Date().toISOString(), data: { title: "Sent one" } }),
        dedupe_key: `${NAME_PREFIX}:sent`,
        status: "sent",
        attempts: 1,
        sent_at: new Date(),
      },
      {
        channel_id: publicChannelId,
        event_type: "finding.published",
        payload: JSON.stringify({ severity: "high", jurisdiction_id: null, occurred_at: new Date().toISOString(), data: { title: "Failed one" } }),
        dedupe_key: `${NAME_PREFIX}:failed`,
        status: "failed",
        attempts: 5,
        last_error: "404 Unknown Webhook",
      },
    ]);

    const res = await request(app)
      .get(`/api/admin/discord/deliveries/log?channel_id=${publicChannelId}`)
      .set("Cookie", cookie)
      .expect(200);

    assert.equal(res.body.summary.sent, 1);
    assert.equal(res.body.summary.failed, 1);

    const failed = res.body.data.find(
      (row: { dedupe_key?: string; last_error: string | null }) =>
        row.last_error === "404 Unknown Webhook",
    );
    assert.ok(failed, "the reason a delivery failed is the reason to open this screen");
    assert.equal(failed.attempts, 5);
    assert.equal(failed.channel_name, `${NAME_PREFIX}-public`);
  });

  it("does not return the delivery payload", async () => {
    // A payload holds the rendered claim, which for a published finding is a
    // sentence about a named person. It is already on the site; a second copy
    // in a debugging screen is a copy with no review state attached.
    const res = await request(app)
      .get(`/api/admin/discord/deliveries/log?channel_id=${publicChannelId}`)
      .set("Cookie", cookie)
      .expect(200);

    assert.equal(JSON.stringify(res.body).includes("Failed one"), false);
    assert.equal(Object.hasOwn(res.body.data[0], "payload"), false);
  });

  it("rejects an unknown delivery status rather than silently returning everything", async () => {
    // A filter that quietly ignores what it does not understand shows an
    // operator a full log and lets them believe it is filtered.
    await request(app)
      .get("/api/admin/discord/deliveries/log?status=exploded")
      .set("Cookie", cookie)
      .expect(400);
  });

  it("lists channels with their routes and their delivery tally", async () => {
    const res = await request(app).get("/api/admin/discord").set("Cookie", cookie).expect(200);

    const channel = res.body.data.find((c: { id: string }) => c.id === publicChannelId);
    assert.ok(channel);
    assert.equal(channel.audience, "public");
    assert.ok(channel.routes.some((r: { event_type: string }) => r.event_type === "meeting.*"));
    assert.equal(channel.deliveries.failed, 1);
    // Every status is present with a zero. A screen that renders only the
    // statuses it received cannot say "0 failed".
    assert.equal(channel.deliveries.deferred, 0);
  });

  it("deletes a route", async () => {
    const route = await db("channel_routes")
      .where({ channel_id: publicChannelId, event_type: "meeting.*" })
      .first<{ id: string }>("id");

    await request(app)
      .delete(`/api/admin/discord/${publicChannelId}/routes/${route.id}`)
      .set("Cookie", cookie)
      .expect(204);

    const remaining = await db("channel_routes").where({ id: route.id }).first();
    assert.equal(remaining, undefined);
  });
});

describe("event type audience", () => {
  it("classifies by namespace, and treats the bare wildcard as restricted", () => {
    assert.equal(eventTypeAudience("meeting.published"), "public");
    assert.equal(eventTypeAudience("claim.*"), "public");
    assert.equal(eventTypeAudience("ops.sweep.failed"), "ops");
    assert.equal(eventTypeAudience("dispute.received"), "ops");
    // Not a namespace. It matches everything the prefixes match plus ops.
    assert.equal(eventTypeAudience("*"), "ops");
  });

  it("is one-directional: ops channels may carry anything, public may not", () => {
    // An ops channel seeing `meeting.published` is an operator watching their
    // own site's output in their own private server. A public channel seeing
    // `ops.sweep.failed` is a disclosure. Only one of those is a defect.
    assert.equal(routeAllowedForAudience("ops", "meeting.published"), true);
    assert.equal(routeAllowedForAudience("ops", "ops.backup_failed"), true);
    assert.equal(routeAllowedForAudience("public", "meeting.published"), true);
    assert.equal(routeAllowedForAudience("public", "ops.backup_failed"), false);
    assert.equal(routeAllowedForAudience("public", "*"), false);
  });
});
