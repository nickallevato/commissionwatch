# Tier A Foundations Implementation Plan (A4 + A2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two small, standalone Tier A items — the `vote_donor_conflict` anomaly flag type, and the OpenFEC campaign-finance client decoupled from the archive's orchestration framework onto a plain Postgres cache.

**Architecture:** Two independent migrations plus one service. The OpenFEC client is a near-verbatim port of `backend/src/services/openfec-client.ts` from the archived 91-commit branch, with its three `getMemory`/`setMemory` call sites replaced by a `HttpCache` class backed by a new `http_cache` table. Everything else about the client — pagination types, request spacing, cache-key hashing — is unchanged, because it was already correct.

**Tech Stack:** TypeScript, Node 22, Express 5, Knex 3, PostgreSQL 16, `node:test` + `node:assert/strict`, supertest.

## Global Constraints

- Never silence a type error: no `any`, no `@ts-ignore`, no `@ts-expect-error`, no cast to quiet the compiler.
- Never delete or skip a test to go green.
- The database schema is the source of truth for types.
- CI is Gitea Actions only. Never add anything under `.github/workflows/`.
- Detection logic applies identically to every entity class. No detector may filter on entity type.
- Tests must not contact the live OpenFEC API. `DEMO_KEY` allows only 10 requests per window (`x-ratelimit-limit: 10`, probed 2026-08-09) and would rate-limit in CI.
- Backend commands run from `backend/`. The database must be up: `docker compose up -d db` from the repository root.
- Node version: 22. Verified 22.22.2.

## Pre-flight

The suite is green on `origin/main` as of 2026-08-09: backend 101 tests / 40 suites, frontend 130 tests / 17 files. If it is not green before you start, stop and fix that first — do not begin on a red baseline.

```bash
docker compose up -d db
cd backend && npm ci && npm run typecheck && npm test
```

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/020_add_vote_donor_conflict_flag.ts` | Adds one value to the `anomaly_flag_type` enum. Runs outside a transaction. |
| `backend/migrations/021_create_http_cache.ts` | Creates `http_cache` — a TTL key/value store for outbound HTTP responses. |
| `backend/src/services/http-cache.ts` | `HttpCache` class: `get`, `set`, `sweepExpired`. Knows nothing about OpenFEC. |
| `backend/src/services/openfec-client.ts` | `OpenFecClient` — typed OpenFEC access with request spacing and caching. Consumes `HttpCache` through an interface, so tests inject a fake. |
| `backend/test/http-cache.test.ts` | Cache behaviour against the real database. |
| `backend/test/openfec-client.test.ts` | Client behaviour against an injected `fetch`. No network. |
| `backend/.env.example` | Documents `OPENFEC_API_KEY`. |
| `backend/package.json` | **The `test` script enumerates test files explicitly. A new test file that is not added here never runs.** |

---

### Task 1: `vote_donor_conflict` anomaly flag type

**Files:**
- Create: `backend/migrations/020_add_vote_donor_conflict_flag.ts`
- Test: `backend/test/anomaly-flag-types.test.ts`
- Modify: `backend/package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces: the string literal `'vote_donor_conflict'` becomes a legal value of the `anomaly_flag_type` enum. Later work (Tier C `vote-tracker`) inserts `anomaly_flags` rows with this `flag_type`.

**Background the implementer needs:** `anomaly_flag_type` is a PostgreSQL enum created in migration `011_create_anomaly_flags.ts` with six values: `emergency_session`, `closed_door_vote`, `last_minute_agenda_change`, `quorum_issue`, `unanimous_controversial`, `missing_minutes`. PostgreSQL cannot remove a value from an enum, so `down` is deliberately a no-op with a comment rather than a broken rollback.

**The trap:** Knex wraps each migration in a transaction by default, and `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. The migration must export `config = { transaction: false }`. Without it you get `ALTER TYPE ... ADD cannot run inside a transaction block` at migrate time.

- [ ] **Step 1: Write the failing test**

Create `backend/test/anomaly-flag-types.test.ts`:

```typescript
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";

// The enum is the contract between the detectors and the database. A detector
// that raises a flag type the enum does not carry fails at insert time, in
// production, on real data — so the permitted set is asserted here rather than
// discovered later.
describe("anomaly_flag_type enum", () => {
  after(async () => {
    await db.destroy();
  });

  it("carries vote_donor_conflict", async () => {
    const { rows } = await db.raw(
      `SELECT unnest(enum_range(NULL::anomaly_flag_type))::text AS value`,
    );
    const values = rows.map((r: { value: string }) => r.value);

    assert.ok(
      values.includes("vote_donor_conflict"),
      `expected vote_donor_conflict in enum, got: ${values.join(", ")}`,
    );
  });

  it("still carries every value migration 011 created", async () => {
    const { rows } = await db.raw(
      `SELECT unnest(enum_range(NULL::anomaly_flag_type))::text AS value`,
    );
    const values = rows.map((r: { value: string }) => r.value);

    for (const original of [
      "emergency_session",
      "closed_door_vote",
      "last_minute_agenda_change",
      "quorum_issue",
      "unanimous_controversial",
      "missing_minutes",
    ]) {
      assert.ok(values.includes(original), `enum lost ${original}`);
    }
  });
});
```

- [ ] **Step 2: Register the test file so it actually runs**

In `backend/package.json`, append ` test/anomaly-flag-types.test.ts` to the end of the `test` script's file list. The script enumerates files explicitly; an unregistered test is a test that never runs and always "passes".

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && npm test 2>&1 | tail -20
```

Expected: FAIL on "carries vote_donor_conflict", listing the six existing values.

- [ ] **Step 4: Write the migration**

Create `backend/migrations/020_add_vote_donor_conflict_flag.ts`:

```typescript
import type { Knex } from "knex";

// ALTER TYPE ... ADD VALUE cannot run inside a transaction block, and Knex
// wraps migrations in one by default. Without this the migration fails with
// "ALTER TYPE ... ADD cannot run inside a transaction block".
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // IF NOT EXISTS keeps the migration idempotent, which matters because a
  // non-transactional migration that fails partway cannot be rolled back.
  await knex.raw(
    `ALTER TYPE anomaly_flag_type ADD VALUE IF NOT EXISTS 'vote_donor_conflict'`,
  );
}

export async function down(): Promise<void> {
  // Deliberately a no-op. PostgreSQL cannot remove a value from an enum type;
  // the only route back is recreating the type and rewriting every column that
  // uses it, which would destroy rows for a rollback nobody needs. Recorded
  // here so a future reader knows this is a decision, not an omission.
}
```

- [ ] **Step 5: Run the migration and the test**

```bash
cd backend && NODE_ENV=test npx knex migrate:latest --knexfile knexfile.ts && npm test 2>&1 | tail -20
```

Expected: migration reports `Batch N run: 1 migrations`, then both tests PASS.

- [ ] **Step 6: Verify the whole suite is still green**

```bash
cd backend && npm run typecheck && npm test 2>&1 | tail -12
```

Expected: typecheck silent, `# fail 0`, test count increased by 2 from the 101 baseline.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/020_add_vote_donor_conflict_flag.ts backend/test/anomaly-flag-types.test.ts backend/package.json
git commit -m "feat(db): add vote_donor_conflict to the anomaly flag enum

The six existing values cannot express an official voting on a matter
involving a donor, which every money-to-vote correlation needs. Runs with
transaction:false because ALTER TYPE ... ADD VALUE cannot run inside a
transaction block; down is a documented no-op because PostgreSQL cannot
remove an enum value."
```

---

### Task 2: `http_cache` table and `HttpCache` service

**Files:**
- Create: `backend/migrations/021_create_http_cache.ts`
- Create: `backend/src/services/http-cache.ts`
- Test: `backend/test/http-cache.test.ts`
- Modify: `backend/package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export interface CacheStore {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  }
  export class HttpCache implements CacheStore {
    constructor(db: Knex, now?: () => number);
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlMs: number): Promise<void>;
    sweepExpired(): Promise<number>;
  }
  ```
  Task 3 consumes `CacheStore` (the interface, not the class) so its tests can inject an in-memory fake.

**Why a table rather than the archive's approach:** the archive stored OpenFEC responses in `agent_memory`, a table belonging to the orchestration framework this project is not adopting. The cache is the only reason `openfec-client.ts` imported orchestration at all.

- [ ] **Step 1: Write the failing test**

Create `backend/test/http-cache.test.ts`:

```typescript
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

    const [{ count }] = await db("http_cache").where({ cache_key: "k3" }).count<{ count: string }[]>();
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
```

- [ ] **Step 2: Register the test file**

Append ` test/http-cache.test.ts` to the `test` script in `backend/package.json`.

- [ ] **Step 3: Run to verify it fails**

```bash
cd backend && npm test 2>&1 | tail -20
```

Expected: FAIL — cannot resolve `../src/services/http-cache`.

- [ ] **Step 4: Write the migration**

Create `backend/migrations/021_create_http_cache.ts`:

```typescript
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // A TTL store for outbound HTTP responses. Deliberately generic: the cache
  // key is an opaque hash chosen by the caller, so a second API can share this
  // table without a schema change.
  await knex.schema.createTable("http_cache", (table) => {
    table.text("cache_key").primary();
    table.jsonb("payload").notNullable();
    table.timestamp("fetched_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("expires_at", { useTz: true }).notNullable();

    // Sweep query: delete where expires_at <= now.
    table.index("expires_at", "idx_http_cache_expires_at");
  });

  await knex.raw(`
    ALTER TABLE http_cache
    ADD CONSTRAINT http_cache_expires_after_fetched_check
    CHECK (expires_at > fetched_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("http_cache");
}
```

- [ ] **Step 5: Write the service**

Create `backend/src/services/http-cache.ts`:

```typescript
import type { Knex } from "knex";

/**
 * The narrow contract a caller needs. `OpenFecClient` depends on this rather
 * than on `HttpCache`, so its tests can inject an in-memory fake and stay off
 * the database.
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

interface HttpCacheRow {
  cache_key: string;
  payload: unknown;
  expires_at: Date;
}

/**
 * A TTL key/value store for outbound HTTP responses, backed by `http_cache`.
 *
 * Expiry is enforced on read as well as by the sweep: a row that has passed
 * its expiry is never served, even if the sweep has not run. The sweep exists
 * to bound table growth, not to enforce correctness.
 */
export class HttpCache implements CacheStore {
  constructor(
    private readonly db: Knex,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db<HttpCacheRow>("http_cache")
      .where({ cache_key: key })
      .andWhere("expires_at", ">", new Date(this.now()))
      .first();

    return row ? (row.payload as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const fetchedAt = new Date(this.now());
    const expiresAt = new Date(this.now() + ttlMs);

    await this.db("http_cache")
      .insert({
        cache_key: key,
        payload: JSON.stringify(value),
        fetched_at: fetchedAt,
        expires_at: expiresAt,
      })
      .onConflict("cache_key")
      .merge(["payload", "fetched_at", "expires_at"]);
  }

  /** Deletes expired rows. Returns how many were removed. */
  async sweepExpired(): Promise<number> {
    return this.db("http_cache").where("expires_at", "<=", new Date(this.now())).del();
  }
}
```

- [ ] **Step 6: Migrate and run the tests**

```bash
cd backend && NODE_ENV=test npx knex migrate:latest --knexfile knexfile.ts && npm test 2>&1 | tail -20
```

Expected: all five `HttpCache` tests PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/021_create_http_cache.ts backend/src/services/http-cache.ts backend/test/http-cache.test.ts backend/package.json
git commit -m "feat(cache): add http_cache table and HttpCache service

A TTL store for outbound HTTP responses. This is what replaces the archive
branch's use of agent_memory as a cache — the only reason its OpenFEC client
imported the orchestration framework at all. Expiry is enforced on read as
well as by the sweep, so a stale row is never served even if the sweep has
not run."
```

---

### Task 3: OpenFEC client

**Files:**
- Create: `backend/src/services/openfec-client.ts`
- Test: `backend/test/openfec-client.test.ts`
- Modify: `backend/.env.example`
- Modify: `backend/package.json` (test script)

**Interfaces:**
- Consumes: `CacheStore` from `backend/src/services/http-cache.ts` (Task 2).
- Produces:
  ```typescript
  export interface OpenFecResponse<T> {
    api_version?: string;
    pagination?: { page?: number; pages?: number; per_page?: number; count?: number };
    results: T[];
  }
  export interface OpenFecContributionRecord { /* fields below */ }
  export interface OpenFecExpenditureRecord { /* fields below */ }
  export class OpenFecClient {
    constructor(options?: OpenFecClientOptions);
    searchContributions(input: SearchContributionsInput): Promise<OpenFecResponse<OpenFecContributionRecord>>;
    searchExpenditures(input: SearchExpendituresInput): Promise<OpenFecResponse<OpenFecExpenditureRecord>>;
    query<T>(options: OpenFecQueryOptions): Promise<OpenFecResponse<T>>;
  }
  ```

**Two deliberate changes from the archive version.** Everything else is a verbatim port.

1. The cache store is injected as `CacheStore` instead of being built from `(db, agentId, namespace)` via `agent_memory`.
2. **The API key is excluded from the cache key.** The archive hashed the full request URL, which includes `api_key`. That means rotating the key silently invalidates the entire cache — a correctness-neutral but expensive surprise, and one that shows up as an unexplained burst of traffic against a rate-limited API. The key is stripped before hashing.

**Probe results this task depends on** (2026-08-09, recorded in the spec): the API is live, returns the documented envelope, declares `cache-control: max-age=3600`, and reports `x-ratelimit-limit: 10` for `DEMO_KEY`. The 3.6 s default interval corresponds to the 1,000/hour registered-key allowance and is correct. Tests use an injected `fetch` and never touch the network.

- [ ] **Step 1: Write the failing test**

Create `backend/test/openfec-client.test.ts`:

```typescript
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

    const before = new OpenFecClient({ apiKey: "old-key", cacheStore: shared, minIntervalMs: 0, fetchImpl });
    await before.searchContributions({ committeeName: "EXAMPLE COMMITTEE" });

    const after = new OpenFecClient({ apiKey: "new-key", cacheStore: shared, minIntervalMs: 0, fetchImpl });
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
      fetchImpl: async () => new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
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
```

- [ ] **Step 2: Register the test file**

Append ` test/openfec-client.test.ts` to the `test` script in `backend/package.json`.

- [ ] **Step 3: Run to verify it fails**

```bash
cd backend && npm test 2>&1 | tail -20
```

Expected: FAIL — cannot resolve `../src/services/openfec-client`.

- [ ] **Step 4: Write the client**

Create `backend/src/services/openfec-client.ts`:

```typescript
import { createHash } from "node:crypto";
import type { CacheStore } from "./http-cache";

const DEFAULT_BASE_URL = "https://api.open.fec.gov/v1";
// The API declares cache-control: max-age=3600. Six hours is deliberately
// more conservative: campaign finance filings do not change hourly.
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// 1,000 requests/hour is the registered-key allowance, i.e. one per 3.6s.
// DEMO_KEY is limited to 10 per window and must never be used in CI.
const DEFAULT_MIN_INTERVAL_MS = 3_600;

type Primitive = string | number | boolean;

export interface OpenFecResponse<T> {
  api_version?: string;
  pagination?: {
    page?: number;
    pages?: number;
    per_page?: number;
    count?: number;
  };
  results: T[];
}

export interface OpenFecContributionRecord {
  committee_name?: string | null;
  candidate_name?: string | null;
  contributor_name?: string | null;
  contributor_city?: string | null;
  contributor_state?: string | null;
  contribution_receipt_amount?: number | null;
  contribution_receipt_date?: string | null;
  two_year_transaction_period?: number | null;
  image_number?: string | null;
  sub_id?: string | number | null;
}

export interface OpenFecExpenditureRecord {
  committee_name?: string | null;
  recipient_name?: string | null;
  disbursement_amount?: number | null;
  disbursement_date?: string | null;
  disbursement_description?: string | null;
  two_year_transaction_period?: number | null;
  image_number?: string | null;
  sub_id?: string | number | null;
}

export interface OpenFecQueryOptions {
  path: string;
  params?: Record<string, Primitive | null | undefined>;
  cacheTtlMs?: number;
}

export interface OpenFecClientOptions {
  apiKey?: string;
  baseUrl?: string;
  cacheTtlMs?: number;
  minIntervalMs?: number;
  cacheStore?: CacheStore | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchContributionsInput {
  candidateName?: string;
  committeeName?: string;
  contributorName?: string;
  cycle?: number;
  minAmount?: number;
  perPage?: number;
}

export interface SearchExpendituresInput {
  committeeName?: string;
  recipientName?: string;
  cycle?: number;
  minAmount?: number;
  perPage?: number;
}

export class OpenFecClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly cacheStore: CacheStore | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private rateLimitChain: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(options: OpenFecClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENFEC_API_KEY;
    if (!apiKey) {
      throw new Error("OPENFEC_API_KEY is required to query campaign finance data");
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheStore = options.cacheStore ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async searchContributions(
    input: SearchContributionsInput,
  ): Promise<OpenFecResponse<OpenFecContributionRecord>> {
    return this.query<OpenFecContributionRecord>({
      path: "/schedules/schedule_a/",
      params: {
        sort_hide_null: false,
        sort: "-contribution_receipt_date",
        per_page: input.perPage ?? 20,
        candidate_name: input.candidateName,
        committee_name: input.committeeName,
        contributor_name: input.contributorName,
        min_amount: input.minAmount,
        two_year_transaction_period: input.cycle,
      },
    });
  }

  async searchExpenditures(
    input: SearchExpendituresInput,
  ): Promise<OpenFecResponse<OpenFecExpenditureRecord>> {
    return this.query<OpenFecExpenditureRecord>({
      path: "/schedules/schedule_b/by_recipient/",
      params: {
        sort_hide_null: false,
        sort: "-disbursement_date",
        per_page: input.perPage ?? 20,
        committee_name: input.committeeName,
        recipient_name: input.recipientName,
        min_amount: input.minAmount,
        two_year_transaction_period: input.cycle,
      },
    });
  }

  async query<T>(options: OpenFecQueryOptions): Promise<OpenFecResponse<T>> {
    const queryParams = sanitizeParams(options.params ?? {});

    // The cache key covers the query only. Including api_key would mean a key
    // rotation silently discards every cached response and produces a burst of
    // traffic against a rate-limited API for no gain.
    const cacheKey = buildCacheKey(
      `${this.baseUrl}${options.path}?${toSearchParams(queryParams).toString()}`,
    );

    const cached = await this.cacheStore?.get<OpenFecResponse<T>>(cacheKey);
    if (cached) {
      return cached;
    }

    const search = toSearchParams({ ...queryParams, api_key: this.apiKey });
    const requestUrl = `${this.baseUrl}${options.path}?${search.toString()}`;

    await this.waitForTurn();

    const response = await this.fetchImpl(requestUrl, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // Deliberately not cached. A cached failure would be served for the
      // whole TTL and read as an empty result set rather than an outage.
      throw new Error(`OpenFEC request failed with ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as OpenFecResponse<T>;
    await this.cacheStore?.set(cacheKey, body, options.cacheTtlMs ?? this.cacheTtlMs);
    return body;
  }

  /**
   * Serialises requests and spaces them by `minIntervalMs`. Callers may run
   * concurrently; the chain guarantees the API still sees one request at a
   * time at the configured rate.
   */
  private async waitForTurn(): Promise<void> {
    const previous = this.rateLimitChain;
    let release: (() => void) | undefined;
    this.rateLimitChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    const waitMs = Math.max(0, this.nextAllowedAt - this.now());
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this.nextAllowedAt = this.now() + this.minIntervalMs;
    release?.();
  }
}

function sanitizeParams(
  params: Record<string, Primitive | null | undefined>,
): Record<string, Primitive> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, Primitive>;
}

function toSearchParams(params: Record<string, Primitive>): URLSearchParams {
  return new URLSearchParams(
    Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildCacheKey(requestUrl: string): string {
  return `openfec:${createHash("sha256").update(requestUrl).digest("hex")}`;
}
```

- [ ] **Step 5: Run the tests**

```bash
cd backend && npm test 2>&1 | tail -20
```

Expected: all six `OpenFecClient` tests PASS.

- [ ] **Step 6: Document the environment variable**

Append to `backend/.env.example`:

```
# Campaign finance. Free key from https://api.data.gov/signup/ — the DEMO_KEY
# ceiling is 10 requests per window and must not be used outside a scratch
# probe. Registered keys allow 1,000/hour, which is the 3.6s default interval.
OPENFEC_API_KEY=
```

- [ ] **Step 7: Verify the full suite and typecheck**

```bash
cd backend && npm run typecheck && npm test 2>&1 | tail -12
```

Expected: typecheck silent, `# fail 0`, roughly 112 tests total.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/openfec-client.ts backend/test/openfec-client.test.ts backend/.env.example backend/package.json
git commit -m "feat(finance): port the OpenFEC client onto the plain HTTP cache

A near-verbatim port from the archive branch. Its three orchestration call
sites were getMemory/setMemory used as a TTL cache; they are replaced by the
CacheStore interface, which is the whole reason this file depended on the
agent framework.

Two deliberate changes. The cache key now covers the query only, not the API
key — the archive hashed the full URL, so rotating the key silently discarded
every cached response and produced a traffic burst against a rate-limited API.
And a non-2xx response throws without caching, so an outage is never served
for six hours as an empty result set.

Rate limiting is unchanged and correct: 3.6s matches the 1,000/hour registered
key allowance, probed 2026-08-09. Tests use an injected fetch and never touch
the network."
```

---

## Self-Review

**Spec coverage.** Spec §A4 → Task 1. Spec §A2 → Tasks 2 and 3, with the `http_cache` table named in the spec created in Task 2. Spec §A3 is withdrawn and correctly has no task. Spec §A1 is a separate plan. Tier B, C and D items are out of scope for this plan by design.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the actual content.

**Type consistency.** `CacheStore` is defined in Task 2 and consumed in Task 3 under exactly that name. `OpenFecResponse<T>`, `OpenFecContributionRecord` and `OpenFecClientOptions` are used in the Task 3 test exactly as the Task 3 implementation exports them. `HttpCache` takes `(db, now?)` in both the interface block and the implementation.

**Two things the implementer will get wrong if they skim:**

1. `backend/package.json`'s `test` script enumerates every test file by path. A new test file that is not added to it never runs and reports no failure. Three tasks here modify that script.
2. Task 1's migration must export `config = { transaction: false }`, or `ALTER TYPE ... ADD VALUE` fails at migrate time.

## Acceptance for the whole plan

```bash
docker compose up -d db
cd backend && npm run typecheck && npm test
```

- `# fail 0`, with roughly 112 tests, up from the 101 baseline.
- `NODE_ENV=test npx knex migrate:latest` applies migrations 020 and 021 cleanly from a fresh volume.
- No network access occurs during the suite.
