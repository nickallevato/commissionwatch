import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db from "../src/config/database";
import { OperatorAuthService, hashSessionToken } from "../src/services/auth/operators";
import { SessionSweepScheduler } from "../src/services/auth/session-sweep";

/**
 * `sweepExpiredSessions()` (`services/auth/operators.ts:297`) existed since it
 * was written and nothing called it — a repo-wide search for its name found
 * only its own definition. Not an auth bypass: `validateSession` already
 * refuses a row past its expiry at use. It is unbounded growth in a table
 * holding session tokens, and the fix the retention policy specifies
 * (`docs/superpowers/specs/2026-08-16-retention-policy.md` §4) is wiring the
 * existing method into the scheduler mechanism `src/index.ts` already runs
 * three other loops through.
 *
 * This suite holds three things:
 *
 * 1. the sweep removes an expired session and leaves a live one alone — both
 *    halves, because a sweep that deleted everything would pass a test that
 *    only checked the expired row is gone;
 * 2. `src/index.ts` actually builds a `SessionSweepScheduler` and calls
 *    `.start()` on it — not merely that the class is exported. Read as text,
 *    the way `workflow-monitor-env.test.ts` proves a workflow forwards an
 *    env var and `feature-registry-audit.test.ts` proves a key has a reader
 *    outside the module that declares it;
 * 3. a sweep failure does not throw out of the scheduler.
 */

const PREFIX = "session-sweep-test";
const OPERATOR_EMAIL = "session-sweep-test@example.invalid";

let operatorId: string;

async function cleanup(): Promise<void> {
  await db("operator_sessions")
    .whereIn(
      "operator_id",
      db("operators").select("id").where("email", "like", `${PREFIX}%`),
    )
    .del();
  await db("operators").where("email", "like", `${PREFIX}%`).del();
}

/** Inserts a session row directly, bypassing sign-in, so its expiry can be dictated. */
async function insertSession(opts: { idleExpiresAt: Date; absoluteExpiresAt: Date }): Promise<string> {
  const id = randomUUID();
  await db("operator_sessions").insert({
    id,
    operator_id: operatorId,
    token_hash: hashSessionToken(`${PREFIX}-${id}`),
    idle_expires_at: opts.idleExpiresAt,
    absolute_expires_at: opts.absoluteExpiresAt,
  });
  return id;
}

async function sessionExists(id: string): Promise<boolean> {
  const row = await db("operator_sessions").where({ id }).first("id");
  return row !== undefined;
}

describe("the operator session sweep", () => {
  before(async () => {
    await cleanup();
    const [row] = await db("operators")
      .insert({
        email: OPERATOR_EMAIL,
        password_hash: "not-a-real-hash",
        name: "Session Sweep Test",
      })
      .returning("id");
    operatorId = row.id;
  });
  after(async () => {
    await cleanup();
    await db.destroy();
  });

  describe("sweepExpiredSessions itself", () => {
    it("removes a session past its absolute expiry and leaves a live one untouched", async () => {
      const now = Date.now();
      const expired = await insertSession({
        idleExpiresAt: new Date(now - 60_000),
        absoluteExpiresAt: new Date(now - 1_000),
      });
      const live = await insertSession({
        idleExpiresAt: new Date(now + 60_000),
        absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      });

      const auth = new OperatorAuthService(db, { log: () => {} });
      const removed = await auth.sweepExpiredSessions();

      assert.ok(removed >= 1, `expected at least one row removed, got ${removed}`);
      assert.equal(await sessionExists(expired), false, "the expired session should be gone");
      assert.equal(await sessionExists(live), true, "the live session must not be swept");
    });
  });

  describe("SessionSweepScheduler.tick", () => {
    it("reports the count sweepExpiredSessions returns", async () => {
      let calls = 0;
      const scheduler = new SessionSweepScheduler(
        {
          sweepExpiredSessions: async () => {
            calls += 1;
            return 3;
          },
        },
        { logger: { info: () => {}, error: () => {} } },
      );

      const removed = await scheduler.tick();
      assert.equal(removed, 3);
      assert.equal(calls, 1);
    });

    it("does not throw out of tick when the sweep fails, and logs the error", async () => {
      let loggedError: unknown;
      const scheduler = new SessionSweepScheduler(
        {
          sweepExpiredSessions: async () => {
            throw new Error("session-sweep-test: simulated database failure");
          },
        },
        {
          logger: {
            info: () => {},
            error: (_message, error) => {
              loggedError = error;
            },
          },
        },
      );

      const removed = await scheduler.tick();
      assert.equal(removed, 0);
      assert.ok(loggedError instanceof Error);
      assert.match((loggedError as Error).message, /simulated database failure/);
    });

    it("logs nothing when the sweep removes nothing, so a quiet night stays quiet", async () => {
      let infoCalls = 0;
      const scheduler = new SessionSweepScheduler(
        { sweepExpiredSessions: async () => 0 },
        {
          logger: {
            info: () => {
              infoCalls += 1;
            },
            error: () => {},
          },
        },
      );

      await scheduler.tick();
      assert.equal(infoCalls, 0);
    });
  });

  describe("wiring into src/index.ts", () => {
    const indexSource = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );

    it("builds a SessionSweepScheduler from the process-wide auth service", () => {
      assert.match(
        indexSource,
        /new SessionSweepScheduler\(operatorAuthService\(\)\)/,
        "src/index.ts no longer constructs a SessionSweepScheduler — sweepExpiredSessions would " +
          "again be called by nothing",
      );
    });

    it("starts the sweep scheduler at boot", () => {
      assert.match(
        indexSource,
        /sessionSweep\.start\(\)/,
        "src/index.ts builds a SessionSweepScheduler but never calls .start() on it — an " +
          "unwired scheduler sweeps nothing, exactly like the bug this closes",
      );
    });

    it("stops the sweep scheduler on shutdown, alongside the other loops", () => {
      assert.match(
        indexSource,
        /sessionSweep\.stop\(\)/,
        "src/index.ts never stops the session sweep scheduler on shutdown",
      );
    });
  });
});
