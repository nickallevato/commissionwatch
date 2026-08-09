import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { OperatorAuthService } from "../src/services/auth/operators";
import { TEST_SCRYPT_PARAMS } from "../src/services/auth/password";

const EMAIL = "operator-auth-test@example.invalid";
const PASSWORD = "a-sufficiently-long-passphrase";

// Cheap scrypt: this suite performs dozens of verifications and the production
// parameters cost 64 MiB apiece. The routes under test still use the real ones
// — only the fixtures that create operators here are cheapened.
const service = new OperatorAuthService(db, {
  scryptParams: TEST_SCRYPT_PARAMS,
  log: () => {},
});

async function cleanup(): Promise<void> {
  await db("operators").where("email", "like", "%@example.invalid").del();
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  assert.ok(raw, "expected a Set-Cookie header");
  const cookies = Array.isArray(raw) ? raw : [raw];
  const session = cookies.find((c) => c.startsWith("cw_session="));
  assert.ok(session, `expected a cw_session cookie, got: ${cookies.join(" | ")}`);
  return session.split(";")[0];
}

describe("operator authentication", () => {
  before(cleanup);
  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await db.destroy();
  });

  describe("the admin surface is closed by default", () => {
    it("returns 401, not 200, for an admin route with no cookie", async () => {
      await request(app).get("/api/admin/session").expect(401);
    });

    it("returns 401, not 404, for an unknown admin path with no cookie", async () => {
      // A 404 would confirm to an unauthenticated caller which admin routes exist.
      await request(app).get("/api/admin/no-such-thing").expect(401);
    });

    it("returns 401 for a forged cookie", async () => {
      await request(app)
        .get("/api/admin/session")
        .set("Cookie", `cw_session=${"0".repeat(64)}`)
        .expect(401);
    });
  });

  describe("sign in", () => {
    beforeEach(async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
    });

    it("sets an httpOnly, SameSite=Lax session cookie", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const raw = res.headers["set-cookie"];
      const cookies = Array.isArray(raw) ? raw : [raw];
      const cookie = cookies.find((c: string) => c.startsWith("cw_session="));
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//i);
      assert.equal(res.body.operator.email, EMAIL);
      assert.equal("password_hash" in res.body.operator, false);
    });

    it("does not put the session token in the response body", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      assert.equal(JSON.stringify(res.body).includes("token"), false);
    });

    it("matches email case-insensitively", async () => {
      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL.toUpperCase(), password: PASSWORD })
        .expect(200);
    });

    it("rejects a wrong password with 401 and no cookie", async () => {
      const res = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: "wrong-password-entirely" })
        .expect(401);
      assert.equal(res.headers["set-cookie"], undefined);
    });

    it("gives the same 401 body for an unknown address as for a wrong password", async () => {
      const unknown = await request(app)
        .post("/api/admin/session")
        .send({ email: "nobody@example.invalid", password: PASSWORD })
        .expect(401);
      const wrong = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: "wrong-password-entirely" })
        .expect(401);
      assert.deepEqual(unknown.body, wrong.body);
    });

    it("rejects a malformed body with 400", async () => {
      await request(app).post("/api/admin/session").send({ email: EMAIL }).expect(400);
      await request(app).post("/api/admin/session").send({}).expect(400);
    });
  });

  describe("who am I", () => {
    it("returns the signed-in operator, and never the password hash", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const signIn = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const res = await request(app)
        .get("/api/admin/session")
        .set("Cookie", sessionCookie(signIn))
        .expect(200);

      assert.equal(res.body.operator.email, EMAIL);
      assert.equal(res.body.operator.name, "Test Operator");
      assert.equal(res.body.operator.role, "operator");
      assert.equal(JSON.stringify(res.body).includes("password"), false);
    });
  });

  describe("sign out", () => {
    it("invalidates the session server-side, so replaying the cookie fails", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const signIn = await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const cookie = sessionCookie(signIn);

      await request(app).get("/api/admin/session").set("Cookie", cookie).expect(200);
      await request(app).delete("/api/admin/session").set("Cookie", cookie).expect(204);
      await request(app).get("/api/admin/session").set("Cookie", cookie).expect(401);
    });
  });

  describe("lockout", () => {
    it("locks after five failures and then refuses even the correct password", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app)
          .post("/api/admin/session")
          .send({ email: EMAIL, password: `wrong-${attempt}` })
          .expect(401);
      }

      const row = await db("operators").where({ email: EMAIL }).first();
      assert.equal(row.failed_attempts, 5);
      assert.ok(row.locked_until, "the fifth failure must record a lockout");

      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(401);
    });

    it("still performs one password verification while locked, so the lockout is not visible in timing", async () => {
      // Counting verifications is the deterministic form of the spec's timing
      // requirement. A wall-clock assertion would be flaky in CI and would not
      // actually prove the work was done.
      let verifications = 0;
      const counting = new OperatorAuthService(db, {
        scryptParams: TEST_SCRYPT_PARAMS,
        maxFailedAttempts: 2,
        onVerify: () => {
          verifications += 1;
        },
        log: () => {},
      });

      await counting.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      await counting.signIn({ email: EMAIL, password: "wrong-a" });
      await counting.signIn({ email: EMAIL, password: "wrong-b" });

      verifications = 0;
      const locked = await counting.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(locked.ok, false);
      assert.equal(verifications, 1, "a locked account must still cost one verification");

      verifications = 0;
      await counting.signIn({ email: "nobody@example.invalid", password: PASSWORD });
      assert.equal(verifications, 1, "an unknown address must still cost one verification");
    });

    it("clears the failure counter on a successful sign-in", async () => {
      await service.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: "nope" })
        .expect(401);
      await request(app)
        .post("/api/admin/session")
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const row = await db("operators").where({ email: EMAIL }).first();
      assert.equal(row.failed_attempts, 0);
      assert.equal(row.locked_until, null);
    });
  });

  describe("session expiry", () => {
    it("does not accept a session past its idle window", async () => {
      let clock = Date.parse("2026-08-09T12:00:00Z");
      const timed = new OperatorAuthService(db, {
        scryptParams: TEST_SCRYPT_PARAMS,
        idleMs: 1_000,
        absoluteMs: 10_000,
        log: () => {},
        now: () => clock,
      });
      await timed.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const result = await timed.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.notEqual(await timed.validateSession(result.token), null);
      clock += 1_001;
      assert.equal(await timed.validateSession(result.token), null);
    });

    it("does not extend a session past its absolute ceiling", async () => {
      let clock = Date.parse("2026-08-09T12:00:00Z");
      const timed = new OperatorAuthService(db, {
        scryptParams: TEST_SCRYPT_PARAMS,
        idleMs: 5_000,
        absoluteMs: 8_000,
        log: () => {},
        now: () => clock,
      });
      await timed.createOperator({ email: EMAIL, password: PASSWORD, name: "Test Operator" });
      const result = await timed.signIn({ email: EMAIL, password: PASSWORD });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      // Kept alive by use, but the ceiling is never pushed out.
      clock += 4_000;
      assert.notEqual(await timed.validateSession(result.token), null);
      clock += 4_001;
      assert.equal(await timed.validateSession(result.token), null);
    });
  });

  describe("first-operator seed", () => {
    it("runs once and is a no-op on a non-empty table", async () => {
      const env = {
        OPERATOR_SEED_EMAIL: EMAIL,
        OPERATOR_SEED_PASSWORD: PASSWORD,
        OPERATOR_SEED_NAME: "Seeded Operator",
      } as NodeJS.ProcessEnv;

      const quiet = new OperatorAuthService(db, {
        scryptParams: TEST_SCRYPT_PARAMS,
        log: () => {},
      });

      const first = await quiet.seedFirstOperator(env);
      assert.ok(first);
      const second = await quiet.seedFirstOperator(env);
      assert.equal(second, null, "a second boot must not create another operator");

      const [{ count }] = await db("operators")
        .where({ email: EMAIL })
        .count<{ count: string }[]>();
      assert.equal(Number(count), 1);
    });

    it("creates nobody when the environment carries no seed", async () => {
      const quiet = new OperatorAuthService(db, { log: () => {} });
      assert.equal(await quiet.seedFirstOperator({} as NodeJS.ProcessEnv), null);
    });
  });

  describe("CORS", () => {
    it("keeps the public API open to any origin", async () => {
      const res = await request(app)
        .get("/api/health")
        .set("Origin", "https://someone-elses-site.example")
        .expect(200);
      assert.equal(res.headers["access-control-allow-origin"], "*");
    });

    it("does not allow an unlisted origin to reach the admin surface with credentials", async () => {
      const res = await request(app)
        .get("/api/admin/session")
        .set("Origin", "https://someone-elses-site.example");
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    });

    it("allows the configured admin origin with credentials", async () => {
      const res = await request(app)
        .get("/api/admin/session")
        .set("Origin", "http://localhost:3000");
      assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
      assert.equal(res.headers["access-control-allow-credentials"], "true");
    });
  });
});
