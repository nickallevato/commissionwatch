import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { signInOperator } from "./helpers/pressroom";

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";
// Bozeman's April 28 meeting — the completed meeting seeded with three votes
// (see backend/seeds/001_pilot_data.ts, MEETINGS.bozeman[1]).
const COMPLETED_MEETING_ID = "f6a7b8c9-d0e1-2345-fabc-456789012345";
const BOZEMAN_MEETING_ID = COMPLETED_MEETING_ID;
// Avery Sample, Mayor — MEMBERS.bozeman[0] in the pilot seed (fictional).
const MEMBER_CUNNINGHAM_ID = "d0e1f2a3-b4c5-6789-abcd-012345678901";

/**
 * Every write on these routers is operator-only. They were unauthenticated
 * until the guard landed, which is why these fixtures used to build
 * themselves with a bare POST.
 */
let operatorCookie: string;

before(async () => {
  operatorCookie = await signInOperator("votes@test.invalid", "Votes Suite");
});

describe("GET /api/votes", () => {
  it("lists votes", async () => {
    const res = await request(app).get("/api/votes").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.total, "number");
  });

  it("filters by meeting_id", async () => {
    const res = await request(app)
      .get(`/api/votes?meeting_id=${COMPLETED_MEETING_ID}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    res.body.data.forEach((v: { meeting_id: string }) => {
      assert.equal(v.meeting_id, COMPLETED_MEETING_ID);
    });
  });

  it("validates meeting_id format", async () => {
    await request(app)
      .get("/api/votes?meeting_id=bad-id")
      .expect(400);
  });
});

describe("POST /api/votes", () => {
  it("rejects invalid vote value", async () => {
    await request(app)
      .post("/api/votes")
      .set("Cookie", operatorCookie)
      .send({
        meeting_id: COMPLETED_MEETING_ID,
        member_id: NON_EXISTENT_ID,
        vote: "maybe",
      })
      .expect(400);
  });

  it("rejects missing meeting_id", async () => {
    await request(app)
      .post("/api/votes")
      .set("Cookie", operatorCookie)
      .send({
        member_id: NON_EXISTENT_ID,
        vote: "yes",
      })
      .expect(400);
  });
});

describe("POST /api/votes/bulk", () => {
  it("rejects empty array", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({ votes: [] })
      .expect(400);
  });

  it("rejects non-array", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({ votes: "not-an-array" })
      .expect(400);
  });

  it("validates each vote in bulk", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({
        votes: [
          { meeting_id: "bad-id", member_id: NON_EXISTENT_ID, vote: "yes" },
        ],
      })
      .expect(400);
  });
});

describe("POST /api/votes/bulk", () => {
  it("rejects empty votes array", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({ votes: [] })
      .expect(400);
  });

  it("rejects missing votes field", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({})
      .expect(400);
  });

  it("rejects invalid vote values in bulk", async () => {
    await request(app)
      .post("/api/votes/bulk")
      .set("Cookie", operatorCookie)
      .send({
        votes: [
          { meeting_id: BOZEMAN_MEETING_ID, agenda_item_id: NON_EXISTENT_ID, member_id: MEMBER_CUNNINGHAM_ID, vote: "maybe" },
        ],
      })
      .expect(400);
  });
});

describe("DELETE /api/votes/:id", () => {
  it("returns 404 for non-existent vote", async () => {
    await request(app)
      .delete(`/api/votes/${NON_EXISTENT_ID}`)
      .set("Cookie", operatorCookie)
      .expect(404);
  });
});

describe("GET /api/meetings/:id/votes", () => {
  it("returns votes for a meeting", async () => {
    const res = await request(app)
      .get(`/api/meetings/${BOZEMAN_MEETING_ID}/votes`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.total >= 3);
  });

  it("returns 404 for non-existent meeting", async () => {
    await request(app)
      .get(`/api/meetings/${NON_EXISTENT_ID}/votes`)
      .expect(404);
  });
});

/**
 * A vote row is this project's core published claim about how a named official
 * acted. All three writes were unauthenticated on the public `/api` surface,
 * and `POST /bulk` took an array.
 */
describe("the vote writes refuse an unauthenticated caller", () => {
  it("refuses POST /api/votes, and writes nothing", async () => {
    const before = Number((await db("votes").count("* as n").first())?.n ?? 0);

    await request(app).post("/api/votes").send({}).expect(401);
    await request(app).post("/api/votes/bulk").send({ votes: [] }).expect(401);

    const after_ = Number((await db("votes").count("* as n").first())?.n ?? 0);
    assert.equal(after_, before, "an unauthenticated POST inserted a vote row");
  });

  it("refuses DELETE /api/votes/:id", async () => {
    await request(app).delete(`/api/votes/${NON_EXISTENT_ID}`).expect(401);
  });

  it("leaves the public reads open", async () => {
    await request(app).get("/api/votes").expect(200);
  });
});

// The suite's own operator goes with it. `seedFirstOperator` only acts while
// `operators` is empty, so a row left behind here makes
// `operator-auth.test.ts` assert against a table this suite filled.
after(async () => {
  await db("operators").where({ email: "votes@test.invalid" }).del();
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
