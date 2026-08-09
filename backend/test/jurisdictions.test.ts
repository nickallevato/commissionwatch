import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";

describe("GET /api/jurisdictions", () => {
  it("returns list of jurisdictions with commissions", async () => {
    const res = await request(app).get("/api/jurisdictions").expect(200);

    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, 2);

    const bozeman = res.body.data.find(
      (j: { name: string }) => j.name === "City of Bozeman",
    );
    assert.ok(bozeman);
    assert.equal(bozeman.state, "MT");
    assert.equal(bozeman.type, "city");
    assert.ok(Array.isArray(bozeman.commissions));
    assert.equal(bozeman.commissions.length, 1);
    assert.equal(bozeman.commissions[0].name, "Bozeman City Commission");
  });

  it("returns jurisdictions ordered by name", async () => {
    const res = await request(app).get("/api/jurisdictions").expect(200);

    const names = res.body.data.map((j: { name: string }) => j.name);
    assert.deepEqual(names, ["City of Bozeman", "Gallatin County"]);
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
