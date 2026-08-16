import { describe, it, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  FixedWindowLimiter,
  PUBLIC_RATE_LIMITS,
  envInt,
  limiterFor,
  resetPublicRateLimits,
} from "../src/services/rate-limit";

/**
 * Until 2026-08-14 the dispute form was the only rate-limited thing in this
 * product. The bulk export, full-text search and the whole meeting archive were
 * unlimited, and what was really holding the line was the Caddy IP allowlist —
 * an access control standing in for a rate limit, which is fine right up to the
 * queued operator task that takes it off.
 *
 * These tests are all against the *shared, process-wide* limiters, so every one
 * of them resets first. A limiter that survives between tests is cross-test
 * state, and this project has already lost time to exactly that.
 */
beforeEach(() => {
  resetPublicRateLimits();
});

after(async () => {
  // Belt and braces: leaving windows behind would only affect this process,
  // but the habit is what keeps it true when someone adds a suite below.
  resetPublicRateLimits();
  // Closes the knex pool `../src/app` opens on import.
  await db.destroy();
});

/**
 * A path under `/api/data` that no dataset matches. It is refused by the route
 * in a few microseconds, which is the point: the limiter counts before routing,
 * so the tier can be proved without streaming sixty copies of the corpus.
 */
const EXPENSIVE_PATH = "/api/data/no-such-dataset.json";
/** Malformed id, so the ordinary tier is exercised without touching the database. */
const ORDINARY_PATH = "/api/meetings/not-a-uuid";

describe("the expensive tier · /api/search and /api/data", () => {
  it("refuses with 429 once the window's limit is spent", async () => {
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive; i += 1) {
      const res = await request(app).get(EXPENSIVE_PATH);
      assert.notEqual(res.status, 429, `request ${i + 1} was throttled early`);
    }

    const refused = await request(app).get(EXPENSIVE_PATH);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.statusCode, 429);
  });

  it("names a Retry-After in whole seconds, so a client is not left polling", async () => {
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive; i += 1) {
      await request(app).get(EXPENSIVE_PATH);
    }

    const refused = await request(app).get(EXPENSIVE_PATH);
    assert.equal(refused.status, 429);

    const header = refused.headers["retry-after"];
    assert.ok(header, "429 carried no Retry-After header");
    const seconds = Number(header);
    assert.ok(Number.isInteger(seconds), `Retry-After was ${header}, not whole seconds`);
    assert.ok(seconds >= 1 && seconds <= PUBLIC_RATE_LIMITS.windowMs / 1000);
  });

  it("counts /api/search on the same tier as /api/data", () => {
    assert.equal(limiterFor("/api/search"), limiterFor("/api/data"));
    assert.equal(limiterFor("/api/data/meetings.csv"), limiterFor("/api/data"));
  });

  it("does not catch a path that merely starts with the same letters", () => {
    // `/api/database` is not `/api/data`. A naive startsWith would say it is.
    assert.notEqual(limiterFor("/api/database"), limiterFor("/api/data"));
  });
});

describe("the ordinary tier", () => {
  it("is a looser limit than the expensive one", () => {
    assert.ok(
      PUBLIC_RATE_LIMITS.default > PUBLIC_RATE_LIMITS.expensive,
      "an ordinary read must not be limited as tightly as a bulk export",
    );
  });

  it("lets an ordinary route past the point where an expensive one is refused", async () => {
    for (let i = 0; i <= PUBLIC_RATE_LIMITS.expensive; i += 1) {
      const res = await request(app).get(ORDINARY_PATH);
      assert.notEqual(res.status, 429, `ordinary request ${i + 1} was throttled`);
    }
  });

  it("refuses at its own limit", () => {
    // Driven through the limiter rather than the HTTP surface: six hundred
    // supertest round trips to prove an off-by-one is a slow way to learn it.
    const limiter = limiterFor(ORDINARY_PATH);
    assert.ok(limiter !== null);
    const now = new Date("2026-08-14T12:00:00Z");
    for (let i = 0; i < PUBLIC_RATE_LIMITS.default; i += 1) {
      assert.equal(limiter.check("ordinary-tier", now).allowed, true);
    }
    assert.equal(limiter.check("ordinary-tier", now).allowed, false);
  });
});

describe("the window", () => {
  it("resets, and the client is told how long that takes", () => {
    const limiter = limiterFor(EXPENSIVE_PATH);
    assert.ok(limiter !== null);

    const start = new Date("2026-08-14T12:00:00Z");
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive; i += 1) {
      assert.equal(limiter.check("window-key", start).allowed, true);
    }

    const refused = limiter.check("window-key", start);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSeconds, PUBLIC_RATE_LIMITS.windowMs / 1000);

    // A refused attempt must not push the window out, or a client polling on a
    // timer is banned rather than limited and can never discover otherwise.
    const halfway = new Date(start.getTime() + PUBLIC_RATE_LIMITS.windowMs / 2);
    assert.equal(limiter.check("window-key", halfway).allowed, false);

    const after = new Date(start.getTime() + PUBLIC_RATE_LIMITS.windowMs + 1);
    assert.equal(limiter.check("window-key", after).allowed, true);
  });

  it("counts each client separately", () => {
    const limiter = limiterFor(EXPENSIVE_PATH);
    assert.ok(limiter !== null);
    const now = new Date("2026-08-14T12:00:00Z");
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive; i += 1) {
      limiter.check("noisy-client", now);
    }
    assert.equal(limiter.check("noisy-client", now).allowed, false);
    assert.equal(limiter.check("quiet-client", now).allowed, true);
  });
});

describe("what is deliberately not limited", () => {
  it("leaves the health checks alone", async () => {
    assert.equal(limiterFor("/api/health"), null);
    assert.equal(limiterFor("/api/health/live"), null);

    // A limit here means an orchestrator eventually reads a 429 as an outage —
    // the probe causing the incident it exists to watch for.
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive + 5; i += 1) {
      const res = await request(app).get("/api/health/live");
      assert.equal(res.status, 200);
    }
  });

  it("leaves the operator console alone, because requireOperator is the wall there", async () => {
    assert.equal(limiterFor("/api/admin"), null);
    assert.equal(limiterFor("/api/admin/session"), null);

    // Every response below is a 401 from `requireOperator` — a stronger refusal
    // than a counter, and the reason a public limit here would only ever lock
    // an operator out of their own console mid-incident.
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive + 5; i += 1) {
      const res = await request(app).get("/api/admin/session");
      assert.notEqual(res.status, 429);
    }
  });
});

describe("/api/search specifics", () => {
  it("carries Cache-Control on a successful response", async () => {
    const res = await request(app).get("/api/search");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "public, max-age=60");
  });

  it("points a throttled searcher at the bulk export instead of just refusing", async () => {
    for (let i = 0; i < PUBLIC_RATE_LIMITS.expensive; i += 1) {
      await request(app).get("/api/search");
    }

    const refused = await request(app).get("/api/search");
    assert.equal(refused.status, 429);
    assert.equal(refused.body.statusCode, 429);
    assert.match(refused.body.error, /\/api\/data/);
  });

  it("leaves the plain message on a non-search refusal", async () => {
    for (let i = 0; i <= PUBLIC_RATE_LIMITS.expensive; i += 1) {
      await request(app).get(EXPENSIVE_PATH);
    }
    const refused = await request(app).get(EXPENSIVE_PATH);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "Too many requests");
  });
});

describe("what the limiter stores about a client", () => {
  it("keeps no identifier reachable from outside the class — only a count", () => {
    const key = "203.0.113.7";
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 1000 });
    limiter.check(key);
    assert.equal(limiter.size, 1);

    // The only public introspection is `size`, a count. There is no method
    // that hands back a key or an identifier. Serialising the whole object —
    // the way an incautious `console.log(limiter)` or crash reporter might —
    // is the sharpest test of the docblock's promise: a `Map` does not
    // survive `JSON.stringify`, so even that accident cannot surface the
    // client string, only the limiter's own configuration.
    const serialised = JSON.stringify(limiter);
    assert.ok(!serialised.includes(key), `serialised limiter leaked the client key: ${serialised}`);
    assert.equal(typeof (limiter as unknown as Record<string, unknown>).keys, "undefined");
  });
});

describe("envInt · the operator override the numbers are read through", () => {
  const VAR = "__RATE_LIMIT_TEST_VAR__";

  afterEach(() => {
    delete process.env[VAR];
  });

  it("uses the fallback when the variable is unset", () => {
    delete process.env[VAR];
    assert.equal(envInt(VAR, 60), 60);
  });

  it("uses the fallback when the variable is set but empty", () => {
    // The compose-file trap `- FOO=${FOO:-}` sets every unconfigured var to
    // "" rather than leaving it unset. Reading that as 0 would 429 the whole
    // tier the moment nobody had explicitly set a value.
    process.env[VAR] = "";
    assert.equal(envInt(VAR, 60), 60);
  });

  it("honours a valid override", () => {
    process.env[VAR] = "120";
    assert.equal(envInt(VAR, 60), 120);
  });

  it("falls back on a non-numeric or non-positive value rather than misconfiguring the tier", () => {
    process.env[VAR] = "not-a-number";
    assert.equal(envInt(VAR, 60), 60);
    process.env[VAR] = "0";
    assert.equal(envInt(VAR, 60), 60);
    process.env[VAR] = "-5";
    assert.equal(envInt(VAR, 60), 60);
  });
});

describe("resetPublicRateLimits", () => {
  it("clears a spent window on every tier", async () => {
    for (let i = 0; i <= PUBLIC_RATE_LIMITS.expensive; i += 1) {
      await request(app).get(EXPENSIVE_PATH);
    }
    assert.equal((await request(app).get(EXPENSIVE_PATH)).status, 429);

    resetPublicRateLimits();

    assert.notEqual((await request(app).get(EXPENSIVE_PATH)).status, 429);
  });
});
