import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { recordError, resetErrorCountsForTest } from "../src/services/logging/error-metrics";
import { signInOperator } from "./helpers/pressroom";

/**
 * `GET /api/admin/errors` — roadmap 6.8's "error counts the monitor can
 * read", exposed behind the operator line rather than on the public
 * `/api/health`. See the module doc in `services/logging/error-metrics.ts`
 * for why.
 */

const OPERATOR_EMAIL = "admin-errors-test@example.com";
let cookie: string;

before(async () => {
  cookie = await signInOperator(OPERATOR_EMAIL, "Admin Errors Test");
});

after(async () => {
  await db("operators").where({ email: OPERATOR_EMAIL }).del();
  await db.destroy();
});

describe("GET /api/admin/errors", () => {
  it("401s without an operator session", async () => {
    resetErrorCountsForTest();
    await request(app).get("/api/admin/errors").expect(401);
  });

  it("reports the counts recorded by requestContext, keyed by route", async () => {
    resetErrorCountsForTest();
    recordError("/api/matters/:id");
    recordError("/api/matters/:id");
    recordError("/api/votes/:id");

    const res = await request(app).get("/api/admin/errors").set("Cookie", cookie).expect(200);

    assert.equal(res.body.byRoute["/api/matters/:id"], 2);
    assert.equal(res.body.byRoute["/api/votes/:id"], 1);
    assert.equal(res.body.total, 3);
    assert.equal(typeof res.body.since, "string");
    assert.ok(!Number.isNaN(Date.parse(res.body.since)), "since is not a valid date string");
  });

  it("reports zero routes with an empty count after a reset", async () => {
    resetErrorCountsForTest();
    const res = await request(app).get("/api/admin/errors").set("Cookie", cookie).expect(200);
    assert.deepEqual(res.body.byRoute, {});
    assert.equal(res.body.total, 0);
  });
});
