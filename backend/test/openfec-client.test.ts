import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpenFecClient,
  type OpenFecResponse,
  type OpenFecContributionRecord,
} from "../src/services/openfec-client";
import type { CacheStore } from "../src/services/http-cache";

/** An in-memory CacheStore so these tests need no database. */
function memoryCache(): CacheStore & { size: () => number } {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    size: () => store.size,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE: OpenFecResponse<OpenFecContributionRecord> = {
  api_version: "1.0",
  pagination: { page: 1, pages: 1, per_page: 20, count: 1 },
  results: [
    {
      committee_name: "EXAMPLE COMMITTEE",
      contributor_name: "PLACEHOLDER, SAMPLE",
      contribution_receipt_amount: 500,
      contribution_receipt_date: "2026-03-01",
      sub_id: "4020120181234567890",
    },
  ],
};

describe("OpenFecClient", () => {
  it("requires an API key", () => {
    assert.throws(
      () => new OpenFecClient({ apiKey: undefined, cacheStore: memoryCache() }),
      /OPENFEC_API_KEY/,
    );
  });

  it("serves a repeated identical query from cache, making one request", async () => {
    let calls = 0;
    const client = new OpenFecClient({
      apiKey: "test-key",
      cacheStore: memoryCache(),
      minIntervalMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(SAMPLE);
      },
    });

    const first = await client.searchContributions({ committeeName: "EXAMPLE COMMITTEE" });
    const second = await client.searchContributions({ committeeName: "EXAMPLE COMMITTEE" });

    assert.equal(calls, 1, "second identical query must be served from cache");
    assert.deepEqual(first.results, second.results);
  });

  it("caches on the query, not on the API key, so rotation does not dump the cache", async () => {
    const shared = memoryCache();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(SAMPLE);
    };

    const before = new OpenFecClient({
      apiKey: "old-key",
      cacheStore: shared,
      minIntervalMs: 0,
      fetchImpl,
    });
    await before.searchContributions({ committeeName: "EXAMPLE COMMITTEE" });

    const after = new OpenFecClient({
      apiKey: "new-key",
      cacheStore: shared,
      minIntervalMs: 0,
      fetchImpl,
    });
    await after.searchContributions({ committeeName: "EXAMPLE COMMITTEE" });

    assert.equal(calls, 1, "rotating the API key must not invalidate cached responses");
  });

  it("spaces consecutive live requests by the configured interval", async () => {
    let clock = 0;
    const waits: number[] = [];
    const client = new OpenFecClient({
      apiKey: "test-key",
      cacheStore: memoryCache(),
      minIntervalMs: 3_600,
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      fetchImpl: async () => jsonResponse(SAMPLE),
    });

    await client.searchContributions({ committeeName: "A" });
    await client.searchContributions({ committeeName: "B" });

    assert.equal(waits.length, 1, "the second distinct query must wait");
    assert.equal(waits[0], 3_600);
  });

  it("throws on a non-2xx response rather than caching a failure", async () => {
    const cache = memoryCache();
    const client = new OpenFecClient({
      apiKey: "test-key",
      cacheStore: cache,
      minIntervalMs: 0,
      fetchImpl: async () =>
        new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    });

    await assert.rejects(
      () => client.searchContributions({ committeeName: "EXAMPLE COMMITTEE" }),
      /429/,
    );
    assert.equal(cache.size(), 0, "a failed request must not populate the cache");
  });

  it("produces the same cache key regardless of parameter order", async () => {
    let calls = 0;
    const client = new OpenFecClient({
      apiKey: "test-key",
      cacheStore: memoryCache(),
      minIntervalMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(SAMPLE);
      },
    });

    await client.query({ path: "/schedules/schedule_a/", params: { a: 1, b: 2 } });
    await client.query({ path: "/schedules/schedule_a/", params: { b: 2, a: 1 } });

    assert.equal(calls, 1, "parameter order must not change the cache key");
  });
});
