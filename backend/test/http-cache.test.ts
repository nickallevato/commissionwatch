import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import { HttpCache } from "../src/services/http-cache";

// Several suites in this project count global rows, so every fixture must
// clean up after itself or it pollutes whatever runs next.
describe("HttpCache", () => {
  let clock = 1_000_000;
  const now = () => clock;
  let cache: HttpCache;

  before(() => {
    cache = new HttpCache(db, now);
  });

  beforeEach(async () => {
    clock = 1_000_000;
    await db("http_cache").del();
  });

  after(async () => {
    await db("http_cache").del();
    await db.destroy();
  });

  it("returns a value stored within its TTL", async () => {
    await cache.set("k1", { results: [1, 2, 3] }, 60_000);
    const got = await cache.get<{ results: number[] }>("k1");

    assert.deepEqual(got, { results: [1, 2, 3] });
  });

  it("returns null for a key that was never stored", async () => {
    assert.equal(await cache.get("missing"), null);
  });

  it("does not serve a value past its expiry", async () => {
    await cache.set("k2", { results: [1] }, 60_000);
    clock += 60_001;

    assert.equal(await cache.get("k2"), null);
  });

  it("overwrites rather than duplicating on repeated set", async () => {
    await cache.set("k3", { results: [1] }, 60_000);
    await cache.set("k3", { results: [2] }, 60_000);

    const got = await cache.get<{ results: number[] }>("k3");
    assert.deepEqual(got, { results: [2] });

    const [{ count }] = await db("http_cache")
      .where({ cache_key: "k3" })
      .count<{ count: string }[]>();
    assert.equal(Number(count), 1);
  });

  it("sweepExpired deletes only expired rows and reports how many", async () => {
    await cache.set("fresh", { results: [1] }, 600_000);
    await cache.set("stale", { results: [2] }, 1_000);
    clock += 60_000;

    const deleted = await cache.sweepExpired();
    assert.equal(deleted, 1);

    assert.notEqual(await cache.get("fresh"), null);
    assert.equal(await cache.get("stale"), null);
  });
});
