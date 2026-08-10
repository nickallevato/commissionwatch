import { after, before, beforeEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import db from "../src/config/database";
import { createTapeTransport, loadTape } from "./helpers/cers-tape";
import {
  CAMPAIGN_TYPE_COUNTY,
  COUNTY_COMMISSIONER_OFFICE_CODE,
  GALLATIN_COUNTY_CODE,
  RECORD_KIND_CANDIDATE_ROSTER,
  RECORD_KIND_REPORT_INDEX,
  RECORD_KIND_REPORT_SCHEDULE,
  createMtCersAdapter,
} from "../src/services/ingestion/adapters/mt-cers";
import type { DocumentRef } from "../src/services/ingestion/adapters/types";
import {
  cityFromAddress,
  directionForSchedule,
  isCampaignFinanceKind,
  recordCampaignFinance,
  toIsoDate,
  toIsoDateFromEpoch,
} from "../src/services/ingestion/campaign-finance";

/**
 * Campaign-finance persistence, against a real database and the recorded tape.
 *
 * The bytes are the ones `test/fixtures/mt-cers/record.ts` took off
 * `cers-ext.mt.gov` on 2026-08-10 by driving the real adapter. Nothing here
 * reaches the network — an unrecorded request throws.
 */

const JURISDICTION_NAME = "CF Test State";
const ADAPTER_KEY = "cf-test-source";
const SINCE = new Date("2026-01-01T00:00:00Z");

let sourceId = "";
let jurisdictionId = "";
let refs: DocumentRef[] = [];
const artifactIds = new Map<string, string>();

function adapter() {
  return createMtCersAdapter({
    transport: createTapeTransport(loadTape()),
    targets: [
      {
        key: "gallatin-county-commissioner",
        label: "Gallatin County Commissioner",
        campaignType: CAMPAIGN_TYPE_COUNTY,
        countyCode: GALLATIN_COUNTY_CODE,
        officeCode: COUNTY_COMMISSIONER_OFFICE_CODE,
      },
    ],
    schedules: ["individual", "expendOther"],
    maxCandidatesPerTarget: 2,
    maxReportsPerCandidate: 2,
    now: () => new Date("2026-08-10T05:28:15.261Z"),
  });
}

/** Stores a ref's bytes as an artifact and returns its id, as `fetch` would. */
async function storeArtifact(ref: DocumentRef): Promise<string> {
  const cached = artifactIds.get(ref.url);
  if (cached !== undefined) return cached;
  const artifact = await adapter().fetchDocument(ref);
  const rows = await db("artifacts")
    .insert({
      sha256: artifact.sha256,
      storage_key: `artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`,
      content_type: artifact.contentType,
      source_url: artifact.sourceUrl,
      byte_size: artifact.byteSize,
      fetched_at: artifact.fetchedAt,
    })
    .onConflict("sha256")
    .merge({ source_url: artifact.sourceUrl })
    .returning("id");
  const id = String((rows[0] as { id: string }).id);
  artifactIds.set(ref.url, id);
  return id;
}

async function ingest(ref: DocumentRef): Promise<Record<string, number>> {
  const artifactId = await storeArtifact(ref);
  const artifact = await adapter().fetchDocument(ref);
  return recordCampaignFinance(
    { db, sourceId, artifactId, metadata: { ...ref.metadata, sourceUrl: ref.url } },
    artifact.bytes,
  );
}

function refsOfKind(kind: string): DocumentRef[] {
  return refs.filter((ref) => ref.metadata?.recordKind === kind);
}

before(async () => {
  refs = await adapter().discoverDocuments(SINCE);

  const jurisdiction = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "state" })
    .returning("id");
  jurisdictionId = String((jurisdiction[0] as { id: string }).id);

  const source = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdictionId,
      adapter_key: ADAPTER_KEY,
      config: JSON.stringify({}),
      enabled: false,
      health_status: "healthy",
      cron_expression: "0 7 * * *",
    })
    .returning("id");
  sourceId = String((source[0] as { id: string }).id);
});

beforeEach(async () => {
  // cf_transactions cascades from cf_reports, which cascades from cf_filers.
  await db("cf_filers").where({ source_id: sourceId }).del();
});

after(async () => {
  await db("cf_filers").where({ source_id: sourceId }).del();
  await db("ingestion_sources").where({ id: sourceId }).del();
  // Artifacts are dropped last: cf_transactions.artifact_id has no cascade, so
  // a transaction still standing here would refuse the delete — which is the
  // citation guarantee working, and is asserted below.
  for (const id of artifactIds.values()) {
    await db("artifacts").where({ id }).del();
  }
  await db("jurisdictions").where({ id: jurisdictionId }).del();
  await db.destroy();
});

describe("campaign finance — routing", () => {
  it("recognises exactly the three CERS record kinds", () => {
    expect(isCampaignFinanceKind(RECORD_KIND_CANDIDATE_ROSTER)).toBe(true);
    expect(isCampaignFinanceKind(RECORD_KIND_REPORT_INDEX)).toBe(true);
    expect(isCampaignFinanceKind(RECORD_KIND_REPORT_SCHEDULE)).toBe(true);
    expect(isCampaignFinanceKind("agenda")).toBe(false);
    expect(isCampaignFinanceKind(undefined)).toBe(false);
  });

  it("takes direction from the schedule requested, never from the row", () => {
    expect(directionForSchedule("individual")).toBe("contribution");
    expect(directionForSchedule("committee")).toBe("contribution");
    expect(directionForSchedule("expendOther")).toBe("expenditure");
    expect(directionForSchedule("expendIndependent")).toBe("expenditure");
  });
});

describe("campaign finance — value conversion", () => {
  it("reads a city out of a filed address, and refuses anything else", () => {
    expect(cityFromAddress("109 Sunset Blvd., Bozeman, MT 59715")).toBe("Bozeman");
    expect(cityFromAddress("PO Box 275, Bozeman, MT 59771")).toBe("Bozeman");
    // No state-and-ZIP tail: we are not reading the shape we think we are.
    expect(cityFromAddress("Bozeman")).toBe(null);
    expect(cityFromAddress("somewhere, else")).toBe(null);
    expect(cityFromAddress(null)).toBe(null);
  });

  it("stores an unreadable date as null rather than a plausible wrong one", () => {
    expect(toIsoDate("09/16/2022")).toBe("2022-09-16");
    expect(toIsoDate("02/30/2024")).toBe(null);
    expect(toIsoDate("2022-09-16")).toBe(null);
    expect(toIsoDate(null)).toBe(null);
  });

  it("reads an epoch stamp in Mountain time, not UTC", () => {
    // CERS stamps local midnight, so the instant is the previous day in UTC and
    // `toISOString()` would move every contribution one day earlier.
    const localMidnight = Date.parse("2022-09-19T06:00:00Z");
    expect(toIsoDateFromEpoch(localMidnight)).toBe("2022-09-19");
    expect(toIsoDateFromEpoch(null)).toBe(null);
  });
});

describe("campaign finance — the roster", () => {
  it("writes one filer per candidacy in the roster", async () => {
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    expect(roster).toBeDefined();
    if (roster === undefined) return;

    const counts = await ingest(roster);
    expect(counts.cf_filers_written).toBe(42);

    const rows = await db("cf_filers").where({ source_id: sourceId });
    expect(rows.length).toBe(42);
  });

  it("records the residence, and concludes no jurisdiction from it", async () => {
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    if (roster === undefined) return;
    await ingest(roster);

    const row = await db("cf_filers")
      .where({ source_id: sourceId, cers_filer_id: "22048" })
      .first();
    expect(row).toBeDefined();
    expect(row.name).toMatch(/Brown, Zach/);
    expect(row.office_title).toBe("County Commissioner");
    expect(row.residence_county).toBe("Gallatin");
    expect(row.residence_city).toBe("Bozeman");
    // CERS has no city field. Anything we conclude from a residence address is
    // an inference and must not be stored as though CERS asserted it.
    expect(row.derived_jurisdiction).toBe(null);
  });

  it("is idempotent: re-ingesting the roster writes no second filer", async () => {
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    if (roster === undefined) return;
    await ingest(roster);
    await ingest(roster);
    const rows = await db("cf_filers").where({ source_id: sourceId });
    expect(rows.length).toBe(42);
  });
});

describe("campaign finance — filed reports", () => {
  it("writes a report per filing, with its period and status", async () => {
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    const index = refsOfKind(RECORD_KIND_REPORT_INDEX)[0];
    if (roster === undefined || index === undefined) return;
    await ingest(roster);

    const counts = await ingest(index);
    expect(counts.cf_reports_written).toBeGreaterThan(0);

    const rows = await db("cf_reports")
      .join("cf_filers", "cf_reports.filer_id", "cf_filers.id")
      .where("cf_filers.source_id", sourceId)
      .select("cf_reports.*");
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(typeof first.form_type).toBe("string");
    expect(first.period_start).toBeInstanceOf(Date);
  });

  it("counts a report whose filer is unknown rather than inventing one", async () => {
    // The roster is deliberately not ingested first. A filer conjured from a
    // job target is a filer whose existence rests on our queue, not on
    // anything CERS served.
    const index = refsOfKind(RECORD_KIND_REPORT_INDEX)[0];
    if (index === undefined) return;
    const counts = await ingest(index);
    expect(counts.cf_reports_unattributed).toBe(1);
    expect(counts.cf_reports_written).toBeUndefined();
  });
});

describe("campaign finance — itemised transactions", () => {
  async function ingestChainFor(schedule: DocumentRef): Promise<void> {
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    if (roster !== undefined) await ingest(roster);
    for (const index of refsOfKind(RECORD_KIND_REPORT_INDEX)) {
      if (index.metadata?.candidateId === schedule.metadata?.candidateId) {
        await ingest(index);
      }
    }
  }

  function populatedSchedule(): DocumentRef | undefined {
    return refsOfKind(RECORD_KIND_REPORT_SCHEDULE).find(
      (ref) => ref.metadata?.schedule === "individual" && ref.metadata.candidateId === "22048",
    );
  }

  it("writes real donors with occupation, employer and amount", async () => {
    const schedule = populatedSchedule();
    expect(schedule).toBeDefined();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);

    const counts = await ingest(schedule);
    expect(counts.cf_contributions_written).toBeGreaterThan(0);

    const rows = await db("cf_transactions")
      .where({ artifact_id: artifactIds.get(schedule.url) })
      .orderBy("row_index");
    expect(rows.length).toBe(counts.cf_contributions_written);

    for (const row of rows) {
      expect(row.direction).toBe("contribution");
      expect(row.schedule).toBe("individual");
      expect(typeof row.entity_name).toBe("string");
    }
    // At least one donor states an employer — the field that makes a donor
    // network more than a list of names.
    expect(rows.some((row: { employer: string | null }) => row.employer !== null)).toBe(true);
    expect(rows.some((row: { total_amount: string | null }) => row.total_amount !== null)).toBe(
      true,
    );
  });

  it("cites the artifact it read, and that column cannot be null", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);
    await ingest(schedule);

    const rows = await db("cf_transactions").whereNull("artifact_id");
    expect(rows.length).toBe(0);

    await expect(
      db("cf_transactions").insert({
        report_id: (await db("cf_reports").first("id")).id,
        artifact_id: null,
        direction: "contribution",
        schedule: "individual",
        row_index: 999,
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete the evidence under a stored contribution", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);
    await ingest(schedule);

    // No ON DELETE CASCADE, on purpose: a published figure whose evidence
    // vanished silently is the failure this project exists to find elsewhere.
    await expect(
      db("artifacts").where({ id: artifactIds.get(schedule.url) }).del(),
    ).rejects.toThrow();
  });

  it("is idempotent: a re-parse rewrites its own rows and adds none", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);
    const first = await ingest(schedule);
    const second = await ingest(schedule);
    expect(second).toEqual(first);

    const rows = await db("cf_transactions").where({
      artifact_id: artifactIds.get(schedule.url),
    });
    expect(rows.length).toBe(first.cf_contributions_written);
  });

  it("records an empty schedule as zero rows, not as a failure", async () => {
    const empty = refsOfKind(RECORD_KIND_REPORT_SCHEDULE).find(
      (ref) => ref.metadata?.candidateId === "22095" && ref.metadata.schedule === "individual",
    );
    expect(empty).toBeDefined();
    if (empty === undefined) return;
    await ingestChainFor(empty);

    const counts = await ingest(empty);
    expect(counts.cf_contributions_written).toBe(0);
    expect(counts.cf_transactions_unattributed).toBeUndefined();
  });

  it("files expenditures on the other side of the ledger", async () => {
    const spend = refsOfKind(RECORD_KIND_REPORT_SCHEDULE).find(
      (ref) => ref.metadata?.schedule === "expendOther" && ref.metadata.candidateId === "22048",
    );
    if (spend === undefined) return;
    await ingestChainFor(spend);

    const counts = await ingest(spend);
    expect(counts.cf_expenditures_written).toBeGreaterThan(0);
    expect(counts.cf_contributions_written).toBeUndefined();

    const rows = await db("cf_transactions").where({
      artifact_id: artifactIds.get(spend.url),
    });
    expect(rows.every((row: { direction: string }) => row.direction === "expenditure")).toBe(true);
  });

  it("counts a schedule whose report is unknown rather than guessing", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    const roster = refsOfKind(RECORD_KIND_CANDIDATE_ROSTER)[0];
    if (roster !== undefined) await ingest(roster);
    // Filer present, report index never parsed.
    const counts = await ingest(schedule);
    expect(counts.cf_transactions_unattributed).toBe(1);
  });

  it("counts a zero-byte body under its own key, not as an empty list", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);

    // Observed on the first real sweep: CERS answers 200 with no bytes at all
    // for `expendIndependent` on an ordinary C-5. "They published nothing here"
    // and "they published an empty list" are different statements about the
    // record, so they get different counters.
    const counts = await recordCampaignFinance(
      {
        db,
        sourceId,
        artifactId: artifactIds.get(schedule.url) ?? "",
        metadata: { ...schedule.metadata, sourceUrl: schedule.url },
      },
      new Uint8Array(0),
    );
    expect(counts.cf_empty_body).toBe(1);
    expect(counts.cf_contributions_written).toBeUndefined();
  });

  it("refuses a body that is not JSON, because a WAF challenge looks like one", async () => {
    const schedule = populatedSchedule();
    if (schedule === undefined) return;
    await ingestChainFor(schedule);
    await expect(
      recordCampaignFinance(
        {
          db,
          sourceId,
          artifactId: artifactIds.get(schedule.url) ?? "",
          metadata: { ...schedule.metadata, sourceUrl: schedule.url },
        },
        new TextEncoder().encode("<html><body>Access Denied</body></html>"),
      ),
    ).rejects.toThrow(/non-JSON body/);
  });
});
