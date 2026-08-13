import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { signInOperator } from "./helpers/pressroom";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
const TEST_EMAIL = "test-sub@example.com";

// Every route here except the two token ones is operator-only, so the suite
// holds one session for all of them.
let cookie: string;

before(async () => {
  cookie = await signInOperator("subscriptions-suite@example.invalid", "Subscriptions Suite");
});

/**
 * The guard itself, before any behaviour that depends on it.
 *
 * `GET /` unauthenticated returned every subscriber's email address, which is
 * the only reader PII the project stores, and `DELETE /:id` took an id that
 * `GET /` had just printed. 401, not 404 — see middleware/requireOperator.
 */
describe("/api/subscriptions authentication", () => {
  const anonymous: [string, () => request.Test][] = [
    ["GET /", () => request(app).get("/api/subscriptions")],
    ["GET /?email=", () => request(app).get(`/api/subscriptions?email=${TEST_EMAIL}`)],
    ["POST /", () =>
      request(app)
        .post("/api/subscriptions")
        .send({ email: TEST_EMAIL, jurisdiction_id: BOZEMAN_ID })],
    ["GET /:id", () => request(app).get(`/api/subscriptions/${NON_EXISTENT_ID}`)],
    ["PATCH /:id", () =>
      request(app).patch(`/api/subscriptions/${NON_EXISTENT_ID}`).send({ digest_only: true })],
    ["DELETE /:id", () => request(app).delete(`/api/subscriptions/${NON_EXISTENT_ID}`)],
  ];

  for (const [label, send] of anonymous) {
    it(`${label} is 401 without a session`, async () => {
      const res = await send().expect(401);
      assert.equal(
        JSON.stringify(res.body).includes("@"),
        false,
        "the rejection leaked an address",
      );
    });
  }
});

describe("POST /api/subscriptions", () => {
  after(async () => {
    await db("alert_subscriptions").where({ email: TEST_EMAIL }).del();
  });

  it("creates a subscription", async () => {
    const res = await request(app)
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ email: TEST_EMAIL, jurisdiction_id: BOZEMAN_ID })
      .expect(201);

    assert.equal(res.body.email, TEST_EMAIL);
    assert.equal(res.body.jurisdiction_id, BOZEMAN_ID);
    assert.equal(res.body.verified, false);
    assert.ok(res.body.id);

    // The token proves the subscriber reads the mailbox. Returning it from the
    // response that mints it means an address can be verified by someone who
    // does not own it — so it is minted, and withheld.
    assert.equal(res.body.verify_token, undefined);
    assert.equal(res.body.unsubscribe_token, undefined);

    const sub = await db("alert_subscriptions").where({ email: TEST_EMAIL }).first();
    assert.equal(sub.verify_token.length, 64);
  });

  it("rejects duplicate subscription with 409", async () => {
    await request(app)
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ email: TEST_EMAIL, jurisdiction_id: BOZEMAN_ID })
      .expect(409);
  });

  it("rejects invalid email", async () => {
    await request(app)
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ email: "not-an-email", jurisdiction_id: BOZEMAN_ID })
      .expect(400);
  });

  it("rejects non-existent jurisdiction", async () => {
    await request(app)
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ email: "new@example.com", jurisdiction_id: NON_EXISTENT_ID })
      .expect(400);
  });
});

describe("GET /api/subscriptions", () => {
  let subId: string;

  before(async () => {
    await db("alert_subscriptions").where({ email: "list-test@example.com" }).del();
    const [sub] = await db("alert_subscriptions")
      .insert({
        email: "list-test@example.com",
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "a".repeat(64),
        unsubscribe_token: "b".repeat(64),
      })
      .returning("id");
    subId = sub.id;
  });

  after(async () => {
    await db("alert_subscriptions").where({ email: "list-test@example.com" }).del();
  });

  it("lists subscriptions", async () => {
    const res = await request(app).get("/api/subscriptions").set("Cookie", cookie).expect(200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters by email", async () => {
    const res = await request(app)
      .get("/api/subscriptions?email=list-test@example.com")
      .set("Cookie", cookie)
      .expect(200);
    assert.ok(res.body.data.length >= 1);
    assert.equal(res.body.data[0].email, "list-test@example.com");
  });
});

describe("GET /api/subscriptions/verify/:token", () => {
  let verifyToken: string;

  before(async () => {
    await db("alert_subscriptions").where({ email: "verify-test@example.com" }).del();
    verifyToken = "c".repeat(64);
    await db("alert_subscriptions").insert({
      email: "verify-test@example.com",
      jurisdiction_id: BOZEMAN_ID,
      verify_token: verifyToken,
      unsubscribe_token: "d".repeat(64),
    });
  });

  after(async () => {
    await db("alert_subscriptions").where({ email: "verify-test@example.com" }).del();
  });

  it("verifies a subscription", async () => {
    const res = await request(app)
      .get(`/api/subscriptions/verify/${verifyToken}`)
      .expect(200);
    assert.equal(res.body.message, "Subscription verified successfully");

    const sub = await db("alert_subscriptions")
      .where({ email: "verify-test@example.com" })
      .first();
    assert.equal(sub.verified, true);
  });

  it("returns 404 for invalid token", async () => {
    await request(app)
      .get(`/api/subscriptions/verify/${"x".repeat(64)}`)
      .expect(404);
  });
});

describe("GET /api/subscriptions/unsubscribe/:token", () => {
  let unsubToken: string;

  before(async () => {
    await db("alert_subscriptions").where({ email: "unsub-test@example.com" }).del();
    unsubToken = "e".repeat(64);
    await db("alert_subscriptions").insert({
      email: "unsub-test@example.com",
      jurisdiction_id: BOZEMAN_ID,
      verify_token: "f".repeat(64),
      unsubscribe_token: unsubToken,
    });
  });

  after(async () => {
    await db("alert_subscriptions").where({ email: "unsub-test@example.com" }).del();
  });

  it("unsubscribes by disabling email", async () => {
    const res = await request(app)
      .get(`/api/subscriptions/unsubscribe/${unsubToken}`)
      .expect(200);
    assert.equal(res.body.message, "Successfully unsubscribed from email alerts");
    assert.equal(res.body.subscription.email_enabled, false);

    const sub = await db("alert_subscriptions")
      .where({ email: "unsub-test@example.com" })
      .first();
    assert.equal(sub.email_enabled, false);
  });
});

describe("PATCH /api/subscriptions/:id", () => {
  let subId: string;

  before(async () => {
    await db("alert_subscriptions").where({ email: "patch-test@example.com" }).del();
    const [sub] = await db("alert_subscriptions")
      .insert({
        email: "patch-test@example.com",
        jurisdiction_id: BOZEMAN_ID,
        verify_token: "g".repeat(64),
        unsubscribe_token: "h".repeat(64),
      })
      .returning("id");
    subId = sub.id;
  });

  after(async () => {
    await db("alert_subscriptions").where({ email: "patch-test@example.com" }).del();
  });

  it("updates subscription preferences", async () => {
    const res = await request(app)
      .patch(`/api/subscriptions/${subId}`)
      .set("Cookie", cookie)
      .send({ email_enabled: false, digest_only: true })
      .expect(200);

    assert.equal(res.body.email_enabled, false);
    assert.equal(res.body.digest_only, true);
  });

  it("returns 404 for non-existent subscription", async () => {
    await request(app)
      .patch(`/api/subscriptions/${NON_EXISTENT_ID}`)
      .set("Cookie", cookie)
      .send({ email_enabled: false })
      .expect(404);
  });

  it("rejects empty update", async () => {
    await request(app)
      .patch(`/api/subscriptions/${subId}`)
      .set("Cookie", cookie)
      .send({})
      .expect(400);
  });
});

describe("DELETE /api/subscriptions/:id", () => {
  it("returns 404 for non-existent subscription", async () => {
    await request(app)
      .delete(`/api/subscriptions/${NON_EXISTENT_ID}`)
      .set("Cookie", cookie)
      .expect(404);
  });
});

// Closes the knex pool so the run can end on its own.
//
// These six suites each held an idle connection open forever, which is why the
// test script carried `--test-force-exit`. That flag calls `process.exit()`,
// dropping whatever a child had not yet flushed to the reporter — so the
// largest suite in the repo silently reported a random subset of its tests.
// Closing the pool is what let the flag come off.
after(async () => {
  await db.destroy();
});
