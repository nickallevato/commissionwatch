process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { OperatorAuthService } from "../src/services/auth/operators";
import { TEST_SCRYPT_PARAMS } from "../src/services/auth/password";
import { encryptConfig } from "../src/services/delivery/crypto";

const EMAIL = "admin-channels-test@example.invalid";
const PASSWORD = "a-sufficiently-long-passphrase";
const NAME_PREFIX = "admin-channels-test";
const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789/abcdefghijklmnop-TOKEN-f4a2";

const auth = new OperatorAuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, log: () => {} });

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
  await auth.createOperator({ email: EMAIL, password: PASSWORD, name: "Channels Operator" });
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

describe("operator channel management", () => {
  let cookie: string;

  before(async () => {
    await cleanup();
    cookie = await signIn();
  });

  after(async () => {
    await cleanup();
    await db.destroy();
  });

  it("is closed without a session", async () => {
    // W7 said these endpoints stay unmounted until an authenticated session
    // exists. A1 landed it, so they are mounted — behind the guard.
    await request(app).get("/api/admin/channels").expect(401);
    await request(app).post("/api/admin/channels").send({}).expect(401);
  });

  it("creates a channel and never echoes the credential back", async () => {
    const res = await request(app)
      .post("/api/admin/channels")
      .set("Cookie", cookie)
      .send({
        channel_type: "discord",
        name: `${NAME_PREFIX}-discord`,
        config: { webhook_url: WEBHOOK_URL },
      })
      .expect(201);

    assert.equal(res.body.channel_type, "discord");
    assert.ok(res.body.config_masked, "reads are masked");
    assert.equal(
      JSON.stringify(res.body).includes(WEBHOOK_URL),
      false,
      "a write is accepted and never echoed back",
    );
    assert.equal(res.body.config_masked.includes("TOKEN"), false);
  });

  it("rejects a webhook URL that is not Discord's, which is the SSRF gate", async () => {
    await request(app)
      .post("/api/admin/channels")
      .set("Cookie", cookie)
      .send({
        channel_type: "discord",
        name: `${NAME_PREFIX}-ssrf`,
        config: { webhook_url: "http://169.254.169.254/latest/meta-data/" },
      })
      .expect(400);
  });

  it("lists only operator channels, never a reader's subscription", async () => {
    const subscriberName = `${NAME_PREFIX}-subscriber@example.invalid`;
    await db("delivery_channels").insert({
      channel_type: "email",
      owner_kind: "subscriber",
      name: subscriberName,
      config_encrypted: encryptConfig({ email: subscriberName }),
      enabled: true,
      verified: true,
      verify_token: "sv".padEnd(64, "0"),
      unsubscribe_token: "su".padEnd(64, "0"),
    });

    const res = await request(app).get("/api/admin/channels").set("Cookie", cookie).expect(200);

    // Subscriber destinations are readers' personal data. They are reachable
    // only by their holder's own token, never by browsing the admin console.
    assert.equal(
      res.body.data.some((channel: { id: string }) => channel.id === subscriberName),
      false,
    );
    assert.equal(
      JSON.stringify(res.body).includes(subscriberName),
      false,
      "an operator listing must not disclose a subscriber address",
    );
  });

  it("404s a subscriber channel addressed through an admin route", async () => {
    const row = await db("delivery_channels")
      .where("name", "like", `${NAME_PREFIX}-subscriber%`)
      .first<{ id: string }>("id");

    await request(app).get(`/api/admin/channels/${row.id}`).set("Cookie", cookie).expect(404);
  });

  it("adds a route carrying a cadence and a per-day cap", async () => {
    const channel = await db("delivery_channels")
      .where({ name: `${NAME_PREFIX}-discord` })
      .first<{ id: string }>("id");

    const res = await request(app)
      .post(`/api/admin/channels/${channel.id}/routes`)
      .set("Cookie", cookie)
      .send({ event_type: "anomaly.flagged", min_severity: "high", cadence: "daily", daily_send_cap: 20 })
      .expect(201);

    assert.equal(res.body.cadence, "daily");
    assert.equal(res.body.daily_send_cap, 20);
    assert.equal(res.body.min_severity, "high");
  });
});
