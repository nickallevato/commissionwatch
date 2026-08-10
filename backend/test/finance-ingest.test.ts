import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import db from "../src/config/database";
import {
  federalCycle,
  ingestFederalFinance,
  ingestFederalFinanceForOfficial,
  normalizeContribution,
} from "../src/services/finance/ingest";
import { OpenFecClient, publicRequestUrl } from "../src/services/openfec-client";
import { cleanupByPrefix, createSource } from "./helpers/pressroom";

/**
 * Federal campaign finance ingestion.
 *
 * **Nothing here touches the network.** `fetch` is injected and answers from
 * fixtures held in this file, and the key is a literal — `DEMO_KEY` is never
 * used anywhere in this suite, because its ceiling is ten requests per window
 * and a suite that passed on a laptop would rate-limit in CI.
 */

const PREFIX = "finance-ingest-test";

interface RecordedRequest {
  url: string;
}

function fixtureFetch(
  contributions: unknown[],
  expenditures: unknown[],
  recorded: RecordedRequest[],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    recorded.push({ url });
    const results = url.includes("schedule_a") ? contributions : expenditures;
    return new Response(JSON.stringify({ results, pagination: { count: results.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function client(recorded: RecordedRequest[], contributions: unknown[], expenditures: unknown[] = []) {
  return new OpenFecClient({
    apiKey: "test-key-not-demo",
    cacheStore: null,
    minIntervalMs: 0,
    fetchImpl: fixtureFetch(contributions, expenditures, recorded),
  });
}

const CONTRIBUTION = {
  contributor_name: "Ridgeline Aggregate LLC",
  candidate_name: "Dana Whitcomb",
  committee_name: "Whitcomb for Montana",
  contribution_receipt_amount: 2500,
  contribution_receipt_date: "2026-03-04T00:00:00",
  contributor_city: "Bozeman",
  contributor_state: "MT",
  two_year_transaction_period: 2026,
  image_number: "202604159876543210",
  sub_id: `${PREFIX}-sub-1`,
};

const EXPENDITURE = {
  committee_name: "Whitcomb for Montana",
  recipient_name: "Ridgeline Print Shop",
  disbursement_amount: 812.5,
  disbursement_date: "2026-04-01T00:00:00",
  disbursement_description: "Printing",
  two_year_transaction_period: 2026,
  image_number: "202604159876543211",
  sub_id: `${PREFIX}-exp-1`,
};

describe("federal finance ingestion", () => {
  let fixture: Awaited<ReturnType<typeof createSource>>;
  let official: { id: string; name: string; jurisdiction_id: string };

  before(async () => {
    fixture = await createSource(PREFIX);
    const [member] = await db("members")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        name: "Dana Whitcomb",
        title: "Commissioner",
        term_start: "2024-01-01",
      })
      .returning<Array<{ id: string; name: string; jurisdiction_id: string }>>([
        "id",
        "name",
        "jurisdiction_id",
      ]);
    official = member;
  });

  beforeEach(async () => {
    await db("campaign_contributions").where("external_id", "like", `${PREFIX}%`).del();
    await db("campaign_expenditures").where("external_id", "like", `${PREFIX}%`).del();
  });

  after(async () => {
    await db("campaign_contributions").where("external_id", "like", `${PREFIX}%`).del();
    await db("campaign_expenditures").where("external_id", "like", `${PREFIX}%`).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  it("stores a filing with its own identifiers and the request that returned it", async () => {
    const recorded: RecordedRequest[] = [];
    const counts = await ingestFederalFinanceForOfficial(db, official, {
      client: client(recorded, [CONTRIBUTION], [EXPENDITURE]),
      cycle: 2026,
    });

    assert.equal(counts.contributionsInserted, 1);
    assert.equal(counts.expendituresInserted, 1);
    assert.equal(counts.recordsRejected, 0);

    const row = await db("campaign_contributions")
      .where({ external_id: `${PREFIX}-sub-1` })
      .first();
    assert.ok(row);
    assert.equal(row.source_system, "openfec");
    assert.equal(row.donor_name, "Ridgeline Aggregate LLC");
    assert.equal(Number(row.amount), 2500);
    assert.equal(row.image_number, "202604159876543210");
    assert.equal(row.jurisdiction_id, fixture.jurisdictionId);
    assert.match(row.source_url, /^https:\/\/api\.open\.fec\.gov\/v1\/schedules\/schedule_a\//);
  });

  /**
   * `source_url` is a public column on a public API. A key in it would be
   * published the first time anybody opened an official's page.
   */
  it("never stores the API key in the provenance URL", async () => {
    const recorded: RecordedRequest[] = [];
    await ingestFederalFinanceForOfficial(db, official, {
      client: client(recorded, [CONTRIBUTION], [EXPENDITURE]),
      cycle: 2026,
    });

    // The request we actually sent carries the key, which is correct.
    assert.ok(recorded.some((request) => request.url.includes("api_key=test-key-not-demo")));

    const rows = await db("campaign_contributions")
      .where("external_id", "like", `${PREFIX}%`)
      .select("source_url");
    const expenditures = await db("campaign_expenditures")
      .where("external_id", "like", `${PREFIX}%`)
      .select("source_url");

    for (const row of [...rows, ...expenditures]) {
      assert.ok(!row.source_url.includes("api_key"), row.source_url);
      assert.ok(!row.source_url.includes("test-key-not-demo"), row.source_url);
    }
  });

  it("stores the filing as filed, so a normalisation defect stays visible", async () => {
    await ingestFederalFinanceForOfficial(db, official, {
      client: client([], [CONTRIBUTION]),
      cycle: 2026,
    });
    const row = await db("campaign_contributions")
      .where({ external_id: `${PREFIX}-sub-1` })
      .first();
    assert.ok(row);
    const raw = typeof row.raw === "string" ? (JSON.parse(row.raw) as typeof CONTRIBUTION) : (row.raw as typeof CONTRIBUTION);
    assert.equal(raw.contributor_name, "Ridgeline Aggregate LLC");
  });

  it("does not double-count a filing seen twice", async () => {
    await ingestFederalFinanceForOfficial(db, official, {
      client: client([], [CONTRIBUTION]),
      cycle: 2026,
    });
    const second = await ingestFederalFinanceForOfficial(db, official, {
      client: client([], [CONTRIBUTION]),
      cycle: 2026,
    });

    assert.equal(second.contributionsSeen, 1);
    assert.equal(second.contributionsInserted, 0);

    const total = await db("campaign_contributions")
      .where("external_id", "like", `${PREFIX}%`)
      .count("* as total")
      .first();
    assert.equal(Number(total?.total ?? 0), 1);
  });

  it("counts a record it cannot describe rather than storing half of it", async () => {
    const counts = await ingestFederalFinanceForOfficial(db, official, {
      client: client(
        [],
        [
          { ...CONTRIBUTION, sub_id: `${PREFIX}-bad-1`, contribution_receipt_amount: 0 },
          { ...CONTRIBUTION, sub_id: `${PREFIX}-bad-2`, contributor_name: "   " },
          { ...CONTRIBUTION, sub_id: `${PREFIX}-bad-3`, contribution_receipt_date: null },
        ],
      ),
      cycle: 2026,
    });

    assert.equal(counts.contributionsSeen, 3);
    assert.equal(counts.contributionsInserted, 0);
    assert.equal(counts.recordsRejected, 3);
  });

  it("sweeps a whole roster and reports the counts, including zero", async () => {
    const counts = await ingestFederalFinance(db, {
      client: client([], []),
      jurisdictionId: fixture.jurisdictionId,
      cycle: 2026,
    });
    assert.equal(counts.officialsQueried, 1);
    assert.equal(counts.contributionsSeen, 0);
    assert.equal(counts.contributionsInserted, 0);
  });

  it("serves a repeat sweep from the cache without a second request", async () => {
    const recorded: RecordedRequest[] = [];
    const store = new Map<string, unknown>();
    const cacheStore = {
      get: async <T,>(key: string) => (store.get(key) as T | undefined) ?? null,
      set: async <T,>(key: string, value: T) => {
        store.set(key, value);
      },
    };
    const cached = new OpenFecClient({
      apiKey: "test-key-not-demo",
      cacheStore,
      minIntervalMs: 0,
      fetchImpl: fixtureFetch([CONTRIBUTION], [], recorded),
    });

    await ingestFederalFinanceForOfficial(db, official, { client: cached, cycle: 2026 });
    const requestsAfterFirst = recorded.length;
    await ingestFederalFinanceForOfficial(db, official, { client: cached, cycle: 2026 });

    assert.equal(recorded.length, requestsAfterFirst, "a cached sweep must make no request");
  });
});

describe("normalisation", () => {
  it("takes the date only, never the time the API pads onto it", () => {
    const row = normalizeContribution(CONTRIBUTION, {
      fallbackRecipient: "Dana Whitcomb",
      jurisdictionId: null,
      cycle: 2026,
      sourceUrl: "https://example.invalid/",
      retrievedAt: new Date(),
    });
    assert.ok(row);
    assert.equal(row.contribution_date, "2026-03-04");
  });

  it("falls back to the official's name only when the filing names no recipient", () => {
    const row = normalizeContribution(
      { ...CONTRIBUTION, candidate_name: null, committee_name: null },
      {
        fallbackRecipient: "Dana Whitcomb",
        jurisdictionId: null,
        cycle: 2026,
        sourceUrl: "https://example.invalid/",
        retrievedAt: new Date(),
      },
    );
    assert.ok(row);
    assert.equal(row.recipient_name, "Dana Whitcomb");
  });
});

describe("federalCycle", () => {
  it("rounds an odd year up to its two-year period", () => {
    assert.equal(federalCycle(new Date("2025-06-01T00:00:00Z")), 2026);
    assert.equal(federalCycle(new Date("2026-06-01T00:00:00Z")), 2026);
  });
});

describe("publicRequestUrl", () => {
  it("is the query without the credential", () => {
    const url = publicRequestUrl("/schedules/schedule_a/", {
      per_page: 25,
      candidate_name: "Dana Whitcomb",
    });
    assert.ok(!url.includes("api_key"));
    assert.match(url, /candidate_name=Dana\+Whitcomb/);
  });
});
