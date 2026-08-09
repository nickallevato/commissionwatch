import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { readLastSuccessfulSweep, SWEPT_STATUSES } from "../src/routes/ingestion";

/**
 * `GET /api/ingestion/status`.
 *
 * The masthead reads this. Until 2026-08-09 it read a string constant that said
 * "Last sweep 12 min ago" whatever had or had not happened, which is the kind of
 * invented number this project exists to find in other people's publications.
 *
 * Every assertion here is about not inventing one: a sweep that never happened
 * answers `null`, a sweep that is still running does not count, and a sweep that
 * landed work while also erroring does.
 *
 * `ingestion_runs` is emptied in `before`. No seed creates a row in it — every
 * row in the test database belongs to whichever suite made it, and each of those
 * suites cascades its own away.
 */

const JURISDICTION_NAME = "Ingestion Status Test County";
const ADAPTER_KEY = "ingestion-status-test-adapter";

let sourceId: string;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
}

before(async () => {
  await removeFixtures();
  await db("ingestion_runs").del();
  const [jurisdiction] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "city" })
    .returning("id");
  const [source] = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdiction.id,
      adapter_key: ADAPTER_KEY,
      enabled: false,
      cron_expression: "0 7 * * *",
    })
    .returning("id");
  sourceId = source.id;
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_runs").where({ source_id: sourceId }).del();
});

interface RunFixture {
  status: "running" | "succeeded" | "partial" | "failed";
  startedAt: string;
  finishedAt: string | null;
}

async function insertRun(run: RunFixture): Promise<void> {
  await db("ingestion_runs").insert({
    source_id: sourceId,
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    counts: "{}",
  });
}

async function getStatus(): Promise<{ lastSuccessfulSweepAt: string | null }> {
  const response = await request(app).get("/api/ingestion/status");
  assert.equal(response.status, 200);
  return response.body;
}

describe("GET /api/ingestion/status", () => {
  it("answers null when no sweep has ever finished", async () => {
    assert.deepEqual(await getStatus(), { lastSuccessfulSweepAt: null });
  });

  it("reports the finish time of a succeeded sweep as an ISO instant", async () => {
    await insertRun({
      status: "succeeded",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: "2026-08-09T04:12:00.000Z",
    });
    assert.deepEqual(await getStatus(), {
      lastSuccessfulSweepAt: "2026-08-09T04:12:00.000Z",
    });
  });

  it("reports the newest finish across several sweeps", async () => {
    await insertRun({
      status: "succeeded",
      startedAt: "2026-08-07T04:00:00.000Z",
      finishedAt: "2026-08-07T04:10:00.000Z",
    });
    await insertRun({
      status: "succeeded",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: "2026-08-09T04:10:00.000Z",
    });
    await insertRun({
      status: "succeeded",
      startedAt: "2026-08-08T04:00:00.000Z",
      finishedAt: "2026-08-08T04:10:00.000Z",
    });
    assert.deepEqual(await getStatus(), {
      lastSuccessfulSweepAt: "2026-08-09T04:10:00.000Z",
    });
  });

  it("counts a partial sweep — work reached the database", async () => {
    await insertRun({
      status: "partial",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: "2026-08-09T04:30:00.000Z",
    });
    assert.deepEqual(await getStatus(), {
      lastSuccessfulSweepAt: "2026-08-09T04:30:00.000Z",
    });
  });

  it("ignores a failed sweep", async () => {
    await insertRun({
      status: "failed",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: "2026-08-09T04:01:00.000Z",
    });
    assert.deepEqual(await getStatus(), { lastSuccessfulSweepAt: null });
  });

  it("ignores a sweep still running, which has no finish time", async () => {
    await insertRun({
      status: "running",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: null,
    });
    assert.deepEqual(await getStatus(), { lastSuccessfulSweepAt: null });
  });

  it("does not let a failed sweep hide an earlier successful one", async () => {
    await insertRun({
      status: "succeeded",
      startedAt: "2026-08-08T04:00:00.000Z",
      finishedAt: "2026-08-08T04:10:00.000Z",
    });
    await insertRun({
      status: "failed",
      startedAt: "2026-08-09T04:00:00.000Z",
      finishedAt: "2026-08-09T04:01:00.000Z",
    });
    assert.deepEqual(await getStatus(), {
      lastSuccessfulSweepAt: "2026-08-08T04:10:00.000Z",
    });
  });
});

describe("readLastSuccessfulSweep", () => {
  it("treats exactly the statuses that landed work as swept", () => {
    // The same rule SourceScheduler applies to last_success_at. If these two
    // ever disagree, the masthead and the source's own health tell different
    // stories about the same sweep.
    assert.deepEqual([...SWEPT_STATUSES], ["succeeded", "partial"]);
  });

  it("returns null rather than throwing on an empty table", async () => {
    assert.equal(await readLastSuccessfulSweep(), null);
  });
});
