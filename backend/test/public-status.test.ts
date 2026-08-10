import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { toPublicSource } from "../src/services/ingestion-status";
import type { PressroomSource } from "../src/services/pressroom/sources";

/**
 * `GET /api/ingestion/sources` — the public status page's only read.
 *
 * The page is a projection of the operator's Sources screen, so most of what it
 * says is already proved in `pressroom-sources.test.ts`. What is proved here is
 * the part that is new: that the projection publishes *figures* and never
 * *content*, and that nothing is filtered out of it.
 *
 * The leak test is the reason this file exists. Run metadata is ours to publish
 * — it describes our ingestion, not anybody's record — but `ingestion_runs.error`
 * is free text written by whatever threw, and the thing that throws in this
 * pipeline is a fetch of a document belonging to a meeting an operator may not
 * have published. So the fixture builds the worst case on purpose: an
 * unpublished meeting, an agenda item under it, and a run whose error string
 * quotes both, and then asserts that none of those strings survives into the
 * response.
 */

const JURISDICTION_NAME = "Public Status Test County";
const NEVER_RUN_KEY = "public-status-never-run";
const DISABLED_KEY = "public-status-disabled";
const QUIET_KEY = "public-status-quiet";

const DISABLED_REASON =
  "Registered disabled pending an operator decision. The Akamai block on the city site is why.";

/** Strings that exist only inside an unpublished meeting. None may be published. */
const SECRET_LOCATION = "Unpublished Chamber 3B QZX";
const SECRET_ITEM_TITLE = "Confidential rezoning of parcel QZX-9911";
const SECRET_ITEM_BODY = "Deliberation text that no reader may see, token QZX-DESCRIPTION";

interface Ids {
  jurisdictionId: string;
  neverRunId: string;
  disabledId: string;
  quietId: string;
  meetingId: string;
}

let ids: Ids;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
}

async function insertSource(
  jurisdictionId: string,
  adapterKey: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const [row] = await db("ingestion_sources")
    .insert({
      jurisdiction_id: jurisdictionId,
      adapter_key: adapterKey,
      cron_expression: "17 7 * * *",
      ...extra,
    })
    .returning("id");
  return (row as { id: string }).id;
}

before(async () => {
  await removeFixtures();

  const [jurisdiction] = await db("jurisdictions")
    .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
    .returning("id");
  const jurisdictionId = (jurisdiction as { id: string }).id;

  const neverRunId = await insertSource(jurisdictionId, NEVER_RUN_KEY, {
    enabled: true,
    expected_interval_hours: 24,
  });
  const disabledId = await insertSource(jurisdictionId, DISABLED_KEY, {
    enabled: false,
    disabled_reason: DISABLED_REASON,
  });
  // Last succeeded four days ago against a stated expectation of one day.
  const quietId = await insertSource(jurisdictionId, QUIET_KEY, {
    enabled: true,
    expected_interval_hours: 24,
    last_success_at: new Date(Date.now() - 96 * 3_600_000).toISOString(),
  });

  const [commission] = await db("commissions")
    .insert({ jurisdiction_id: jurisdictionId, name: "Public Status Test Commission" })
    .returning("id");
  // Deliberately `published_at: null`. This meeting is a candidate, not a
  // publication, and every string on it is off limits to the public API.
  const [meeting] = await db("meetings")
    .insert({
      commission_id: (commission as { id: string }).id,
      date: "2026-08-01",
      location: SECRET_LOCATION,
      status: "completed",
      published_at: null,
    })
    .returning("id");
  const meetingId = (meeting as { id: string }).id;

  await db("agenda_items").insert({
    meeting_id: meetingId,
    item_number: 1,
    title: SECRET_ITEM_TITLE,
    description: SECRET_ITEM_BODY,
  });

  ids = { jurisdictionId, neverRunId, disabledId, quietId, meetingId };
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_runs")
    .whereIn("source_id", [ids.neverRunId, ids.disabledId, ids.quietId])
    .del();
});

interface PublicRun {
  status: string;
  started_at: string;
  finished_at: string | null;
  records: number;
  failures: number;
}

interface PublicSource {
  adapter_key: string;
  enabled: boolean;
  disabled_reason: string | null;
  verdict: string;
  lifetime_records: number;
  last_success_at: string | null;
  silence: {
    verdict: string;
    hours_since_success: number | null;
    expected_interval_hours: number | null;
  };
  latest_run: PublicRun | null;
}

interface PublicStatusBody {
  generated_at: string;
  last_successful_sweep_at: string | null;
  total: number;
  sources: PublicSource[];
}

async function getStatus(): Promise<PublicStatusBody> {
  const response = await request(app).get("/api/ingestion/sources");
  assert.equal(response.status, 200);
  return response.body as PublicStatusBody;
}

function find(body: PublicStatusBody, key: string): PublicSource {
  const source = body.sources.find((candidate) => candidate.adapter_key === key);
  assert.ok(source, `${key} is missing from the public status response`);
  return source;
}

describe("GET /api/ingestion/sources", () => {
  it("is reachable without a session", async () => {
    // No cookie is sent. The operator console 401s here; this does not, because
    // it describes our ingestion rather than anybody's record.
    const response = await request(app).get("/api/ingestion/sources");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sources));
  });

  it("lists a source that has never run rather than omitting it", async () => {
    const source = find(await getStatus(), NEVER_RUN_KEY);
    assert.equal(source.verdict, "never_run");
    assert.equal(source.latest_run, null);
    assert.equal(source.last_success_at, null);
    // Present and zero, not absent. An absence you can see is a commitment.
    assert.equal(source.lifetime_records, 0);
  });

  it("lists a disabled source with the reason it is off", async () => {
    const source = find(await getStatus(), DISABLED_KEY);
    assert.equal(source.enabled, false);
    assert.equal(source.verdict, "disabled");
    assert.equal(source.disabled_reason, DISABLED_REASON);
  });

  it("reads a source past its expected interval as suspect, with both numbers", async () => {
    const source = find(await getStatus(), QUIET_KEY);
    assert.equal(source.silence.verdict, "suspect");
    assert.equal(source.silence.expected_interval_hours, 24);
    assert.ok((source.silence.hours_since_success ?? 0) >= 95);
  });

  it("reads a source inside its expected interval as ok", async () => {
    await db("ingestion_sources")
      .where({ id: ids.quietId })
      .update({ last_success_at: new Date(Date.now() - 3_600_000).toISOString() });
    try {
      assert.equal(find(await getStatus(), QUIET_KEY).silence.verdict, "ok");
    } finally {
      await db("ingestion_sources")
        .where({ id: ids.quietId })
        .update({ last_success_at: new Date(Date.now() - 96 * 3_600_000).toISOString() });
    }
  });

  it("reads a source with no stated interval as unknown rather than as fine", async () => {
    const source = find(await getStatus(), DISABLED_KEY);
    assert.equal(source.silence.expected_interval_hours, null);
    assert.equal(source.silence.verdict, "unknown");
  });

  it("sums lifetime records across every run of a source", async () => {
    await db("ingestion_runs").insert([
      {
        source_id: ids.neverRunId,
        status: "succeeded",
        started_at: new Date(Date.now() - 7_200_000).toISOString(),
        finished_at: new Date(Date.now() - 7_000_000).toISOString(),
        counts: JSON.stringify({ discovered: 4, fetched: 3, parsed: 2, analyzed: 1 }),
      },
      {
        source_id: ids.neverRunId,
        status: "partial",
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        finished_at: new Date(Date.now() - 3_500_000).toISOString(),
        counts: JSON.stringify({ discovered: 1, failed: 2, blocked: 1 }),
      },
    ]);

    const source = find(await getStatus(), NEVER_RUN_KEY);
    assert.equal(source.lifetime_records, 11);
    assert.ok(source.latest_run);
    assert.equal(source.latest_run.status, "partial");
    // The figures, in place of the text.
    assert.equal(source.latest_run.records, 1);
    assert.equal(source.latest_run.failures, 3);
  });

  it("reports the newest successful sweep across every source", async () => {
    const body = await getStatus();
    // The quiet source is the only one carrying a success time in this fixture,
    // and the value comes from a row rather than from a clock.
    assert.equal(body.last_successful_sweep_at, find(body, QUIET_KEY).last_success_at);
  });

  // -------------------------------------------------------------------------
  // The wall
  // -------------------------------------------------------------------------

  it("publishes no run error text, and nothing from an unpublished meeting", async () => {
    // The worst case, built on purpose: the thing that threw was a fetch of a
    // document belonging to a meeting no operator has published, and it said so.
    const error =
      `fetch failed for meeting ${ids.meetingId} at ${SECRET_LOCATION}: ` +
      `item "${SECRET_ITEM_TITLE}" — ${SECRET_ITEM_BODY}`;

    await db("ingestion_runs").insert({
      source_id: ids.quietId,
      status: "failed",
      started_at: new Date(Date.now() - 1_800_000).toISOString(),
      finished_at: new Date(Date.now() - 1_700_000).toISOString(),
      counts: JSON.stringify({ discovered: 1, failed: 1 }),
      error,
    });

    const body = await getStatus();
    const serialised = JSON.stringify(body);

    for (const secret of [SECRET_LOCATION, SECRET_ITEM_TITLE, SECRET_ITEM_BODY, ids.meetingId]) {
      assert.equal(
        serialised.includes(secret),
        false,
        `the public status response leaked: ${secret}`,
      );
    }

    // The failure is still reported. Suppressing the leak by suppressing the
    // fact would be the worse defect of the two.
    const source = find(body, QUIET_KEY);
    assert.ok(source.latest_run);
    assert.equal(source.latest_run.status, "failed");
    assert.equal(source.latest_run.failures, 1);
    assert.equal("error" in source.latest_run, false);
    assert.equal("id" in source.latest_run, false);
  });

  it("drops the error and the ids from any console row it is handed", async () => {
    // Straight at the pure function, with a row no query would produce, so the
    // narrowing is proved by construction rather than by the fixture happening
    // not to contain anything sensitive.
    const hostile: PressroomSource = {
      id: "11111111-2222-3333-4444-555555555555",
      adapter_key: "hostile",
      enabled: true,
      disabled_reason: null,
      health_status: "healthy",
      cron_expression: "17 7 * * *",
      expected_interval_hours: 24,
      consecutive_failures: 1,
      jurisdiction: { id: "66666666-7777-8888-9999-000000000000", name: "Somewhere", state: "MT" },
      last_success_at: null,
      lifetime_records: 0,
      silence: { verdict: "unknown", hours_since_success: null, expected_interval_hours: 24 },
      verdict: "never_run",
      latest_run: {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        status: "failed",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:01:00.000Z",
        counts: { discovered: 2, failed: 3 },
        error: SECRET_ITEM_TITLE,
      },
    };

    const serialised = JSON.stringify(toPublicSource(hostile));
    assert.equal(serialised.includes(SECRET_ITEM_TITLE), false);
    assert.equal(serialised.includes(hostile.id), false);
    assert.equal(serialised.includes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), false);
    assert.equal(serialised.includes("66666666-7777-8888-9999-000000000000"), false);
  });
});
