import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import { registerDigestStatus } from "../src/routes/health";
import db from "../src/config/database";

describe("GET /api/health", () => {
  afterEach(() => {
    registerDigestStatus(() => ({
      dailyLastRun: null,
      weeklyLastRun: null,
      running: false,
    }));
  });

  it("returns status ok with database connected", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.status, "ok");
    assert.equal(res.body.database, "connected");
    assert.ok(res.body.timestamp);
  });

  it("includes digest scheduler status", async () => {
    const res = await request(app).get("/api/health").expect(200);

    assert.ok("digest" in res.body);
    assert.equal(res.body.digest.running, false);
    assert.equal(res.body.digest.dailyLastRun, null);
    assert.equal(res.body.digest.weeklyLastRun, null);
  });

  it("reports digest last run times when registered", async () => {
    const daily = new Date("2026-05-05T06:00:00Z");
    const weekly = new Date("2026-05-04T06:00:00Z");
    registerDigestStatus(() => ({
      dailyLastRun: daily,
      weeklyLastRun: weekly,
      running: true,
    }));

    const res = await request(app).get("/api/health").expect(200);

    assert.equal(res.body.digest.running, true);
    assert.equal(res.body.digest.dailyLastRun, daily.toISOString());
    assert.equal(res.body.digest.weeklyLastRun, weekly.toISOString());
  });
});

// Closes the knex pool `../src/app` opens on import.
//
// Suites that leaked a pool are why the test script carried
// `--test-force-exit`. That flag calls `process.exit()`, which drops whatever
// a child had not yet flushed to the reporter — so the largest suite here
// silently reported 29, 40 or 44 of its 68 tests depending on timing, always
// green, with nothing to say the rest had gone unreported. Closing the pools
// is what let the flag come off.
after(async () => {
  await db.destroy();
});
