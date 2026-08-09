import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

// The deploy compares this endpoint's `sha` against the frontend's
// /version.json to catch a half-finished rollout — two images roll
// independently, and a stack serving the old API behind the new UI looks
// perfectly healthy from the outside. These tests pin the contract that check
// depends on: the field names, and that a missing build arg reports "unknown"
// rather than anything that could pass for a real version.
describe("GET /api/version", () => {
  it("reports the service and the baked-in build identifiers", async () => {
    const res = await request(app).get("/api/version").expect(200);

    assert.equal(res.body.service, "backend");
    assert.ok("sha" in res.body, "response must carry a sha field");
    assert.ok("builtAt" in res.body, "response must carry a builtAt field");
  });

  it("reports unknown rather than a plausible-looking value when unbuilt", async () => {
    // The suite runs from source with no BUILD_SHA baked in, which is exactly
    // the un-stamped case. A deploy comparing versions must be able to tell
    // "not stamped" apart from "stamped with something", so this must never
    // degrade to a commit-shaped string.
    const res = await request(app).get("/api/version").expect(200);

    assert.equal(res.body.sha, "unknown");
    assert.equal(res.body.builtAt, "unknown");
    assert.doesNotMatch(
      res.body.sha,
      /^[0-9a-f]{7,40}$/,
      "an unstamped build must not report something that looks like a commit",
    );
  });
});

// Closes the knex pool `../src/app` opens on import.
//
// Suites that leaked a pool are why the test script carried
// `--test-force-exit`. That flag calls `process.exit()`, which drops whatever a
// child had not yet flushed to the reporter — so the largest suite in this repo
// silently reported 29, 40 or 44 of its 68 tests depending on timing, always
// green, with nothing to say the rest had gone unreported. Closing the pools is
// what let the flag come off.
after(async () => {
  await db.destroy();
});
