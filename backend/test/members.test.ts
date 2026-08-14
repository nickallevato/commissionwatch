import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { signInOperator } from "./helpers/pressroom";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Every write on these routers is operator-only. They were unauthenticated
 * until the guard landed, which is why these fixtures used to build
 * themselves with a bare POST.
 */
let operatorCookie: string;

before(async () => {
  operatorCookie = await signInOperator("members@test.invalid", "Members Suite");
});

describe("GET /api/members", () => {
  it("lists all members", async () => {
    const res = await request(app).get("/api/members").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters members by jurisdiction_id", async () => {
    const res = await request(app)
      .get(`/api/members?jurisdiction_id=${BOZEMAN_ID}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    res.body.data.forEach((m: { jurisdiction_id: string }) => {
      assert.equal(m.jurisdiction_id, BOZEMAN_ID);
    });
  });

  it("validates jurisdiction_id format", async () => {
    await request(app)
      .get("/api/members?jurisdiction_id=not-a-uuid")
      .expect(400);
  });

  it("supports pagination", async () => {
    const res = await request(app)
      .get("/api/members?limit=2&offset=0")
      .expect(200);

    assert.ok(res.body.data.length <= 2);
  });
});

describe("POST /api/members", () => {
  it("creates a new member", async () => {
    const res = await request(app)
      .post("/api/members")
      .set("Cookie", operatorCookie)
      .send({
        jurisdiction_id: BOZEMAN_ID,
        name: "Test Member",
        term_start: "2026-01-01",
      })
      .expect(201);

    assert.equal(res.body.name, "Test Member");
    assert.equal(res.body.jurisdiction_id, BOZEMAN_ID);
    assert.ok(res.body.id);
  });

  it("rejects missing required fields", async () => {
    await request(app)
      .post("/api/members")
      .set("Cookie", operatorCookie)
      .send({ name: "No Jurisdiction" })
      .expect(400);
  });
});

describe("GET /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    const res = await request(app)
      .get(`/api/members/${NON_EXISTENT_ID}`)
      .expect(404);

    assert.equal(res.body.error, "Member not found");
  });

  it("validates ID format", async () => {
    await request(app).get("/api/members/bad-id").expect(400);
  });
});

describe("PUT /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    await request(app)
      .put(`/api/members/${NON_EXISTENT_ID}`)
      .set("Cookie", operatorCookie)
      .send({ name: "Updated" })
      .expect(404);
  });
});

describe("DELETE /api/members/:id", () => {
  it("returns 404 for non-existent member", async () => {
    await request(app)
      .delete(`/api/members/${NON_EXISTENT_ID}`)
      .set("Cookie", operatorCookie)
      .expect(404);
  });
});

/**
 * The roster is what `/officials/:id` computes its arithmetic over, and a
 * member row is a named living person. All three writes were unauthenticated
 * on the public `/api` surface.
 */
describe("the roster writes refuse an unauthenticated caller", () => {
  it("refuses POST /api/members, and writes nothing", async () => {
    const before = Number((await db("members").count("* as n").first())?.n ?? 0);

    await request(app)
      .post("/api/members")
      .send({ jurisdiction_id: BOZEMAN_ID, name: "Posted By Nobody", term_start: "2026-01-01" })
      .expect(401);

    const after_ = Number((await db("members").count("* as n").first())?.n ?? 0);
    assert.equal(after_, before, "an unauthenticated POST inserted a roster row");
  });

  it("refuses PUT and DELETE /api/members/:id", async () => {
    await request(app)
      .put(`/api/members/${NON_EXISTENT_ID}`)
      .send({ name: "Renamed by nobody" })
      .expect(401);
    await request(app).delete(`/api/members/${NON_EXISTENT_ID}`).expect(401);
  });

  it("leaves the public reads open", async () => {
    await request(app).get("/api/members").expect(200);
  });
});

// The suite's own operator goes with it. `seedFirstOperator` only acts while
// `operators` is empty, so a row left behind here makes
// `operator-auth.test.ts` assert against a table this suite filled.
after(async () => {
  await db("operators").where({ email: "members@test.invalid" }).del();
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
