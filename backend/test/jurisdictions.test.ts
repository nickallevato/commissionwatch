import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";

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
