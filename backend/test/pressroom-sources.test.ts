import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  assessSilence,
  assessVerdict,
  listSources,
  readCounts,
  recordsIn,
  type PressroomSource,
} from "../src/services/pressroom/sources";
import {
  cleanupByPrefix,
  createRun,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The sources screen — decisions 1, 2 and 3.
 *
 * Each of the three is a refusal to let an absence look normal: zero ingested
 * records is a failure, silence past a stated interval is *Suspect*, and a
 * disabled source stays on the screen carrying the reason it is off.
 */

const PREFIX = "pressroom-sources-test";
const EMAIL = "pressroom-sources-test@example.invalid";

const HOUR = 3_600_000;

function bySourceId(rows: PressroomSource[], id: string): PressroomSource {
  const found = rows.find((row) => row.id === id);
  assert.ok(found, `source ${id} was not in the listing`);
  return found;
}

describe("pressroom silence watch", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");

  it("is unknown when nothing has ever succeeded", () => {
    // Not "ok". A source that has never worked is not a source that is fine,
    // and `verdict` reports it as never_run, which is louder.
    const silence = assessSilence({ lastSuccessAt: null, expectedIntervalHours: 24, now });
    assert.equal(silence.verdict, "unknown");
    assert.equal(silence.hours_since_success, null);
  });

  it("is unknown when no interval was stated — an absent expectation is not zero", () => {
    const silence = assessSilence({
      lastSuccessAt: new Date(now.getTime() - 400 * HOUR),
      expectedIntervalHours: null,
      now,
    });
    assert.equal(silence.verdict, "unknown");
    assert.equal(silence.hours_since_success, 400);
  });

  it("is ok inside the stated interval", () => {
    const silence = assessSilence({
      lastSuccessAt: new Date(now.getTime() - 5 * HOUR),
      expectedIntervalHours: 24,
      now,
    });
    assert.equal(silence.verdict, "ok");
  });

  it("is suspect once the source is past its own stated interval", () => {
    // The whole point: without this a dead scraper and a quiet month at City
    // Hall produce identical screens.
    const silence = assessSilence({
      lastSuccessAt: new Date(now.getTime() - 25 * HOUR),
      expectedIntervalHours: 24,
      now,
    });
    assert.equal(silence.verdict, "suspect");
    assert.equal(silence.hours_since_success, 25);
    assert.equal(silence.expected_interval_hours, 24);
  });
});

describe("pressroom source verdict", () => {
  const base = {
    enabled: true,
    lastSuccessAt: new Date("2026-08-10T00:00:00.000Z"),
    consecutiveFailures: 0,
    latestRunStatus: "succeeded" as const,
    silence: "ok" as const,
  };

  it("reports a disabled source as disabled rather than hiding it", () => {
    assert.equal(assessVerdict({ ...base, enabled: false }), "disabled");
  });

  it("reports never_run ahead of anything else, for a source that never succeeded", () => {
    assert.equal(
      assessVerdict({ ...base, lastSuccessAt: null, silence: "unknown" }),
      "never_run",
    );
  });

  it("prefers a named failure to an inference from silence", () => {
    assert.equal(
      assessVerdict({ ...base, latestRunStatus: "failed", silence: "suspect" }),
      "failing",
    );
  });

  it("reports suspect when the only evidence is silence", () => {
    assert.equal(assessVerdict({ ...base, silence: "suspect" }), "suspect");
  });

  it("reports healthy only when nothing else applies", () => {
    assert.equal(assessVerdict(base), "healthy");
  });

  it("treats a partial run as a run, not a failure", () => {
    // Decision 4 reaches this far: a partial sweep landed work, so the source
    // is not failing on the strength of it.
    assert.equal(assessVerdict({ ...base, latestRunStatus: "partial" }), "healthy");
  });
});

describe("pressroom counts", () => {
  it("reads jsonb whether the driver hands back an object or a string", () => {
    assert.deepEqual(readCounts({ discovered: 3 }), { discovered: 3 });
    assert.deepEqual(readCounts('{"discovered":3}'), { discovered: 3 });
    assert.deepEqual(readCounts("not json"), {});
    assert.deepEqual(readCounts(null), {});
  });

  it("totals only the keys that mean work reached the database", () => {
    assert.equal(recordsIn({ discovered: 2, fetched: 3, failed: 9, blocked: 4 }), 5);
  });
});

describe("pressroom sources listing", () => {
  let cookie: string;
  let disabled: Awaited<ReturnType<typeof createSource>>;
  let silent: Awaited<ReturnType<typeof createSource>>;
  let productive: Awaited<ReturnType<typeof createSource>>;

  before(async () => {
    await cleanupByPrefix(PREFIX);

    disabled = await createSource(`${PREFIX}-a`, {
      enabled: false,
      disabledReason: "bozemanmt.gov is a blanket Akamai deny and is never fetched.",
    });
    silent = await createSource(`${PREFIX}-b`, {
      enabled: true,
      expectedIntervalHours: 24,
      lastSuccessAt: new Date(Date.now() - 72 * HOUR),
    });
    productive = await createSource(`${PREFIX}-c`, {
      enabled: true,
      expectedIntervalHours: 24,
      lastSuccessAt: new Date(Date.now() - 1 * HOUR),
    });

    await createRun(productive.sourceId, {
      status: "succeeded",
      counts: { discovered: 7, fetched: 11, parsed: 11 },
      startedAt: new Date(Date.now() - 2 * HOUR),
    });
    await createRun(productive.sourceId, {
      status: "partial",
      counts: { discovered: 1, parsed: 3, failed: 2 },
      startedAt: new Date(Date.now() - 1 * HOUR),
    });

    cookie = await signInOperator(EMAIL, "Sources Operator");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db("operators").where({ email: EMAIL }).del();
    await db.destroy();
  });

  it("is closed without a session", async () => {
    await request(app).get("/api/admin/pressroom/sources").expect(401);
  });

  it("lists a disabled source, with the reason it is off", async () => {
    // Decision 3. Filtering disabled sources out is how the Akamai block stops
    // being written down and becomes something somebody remembers.
    const rows = await listSources(db);
    const row = bySourceId(rows, disabled.sourceId);
    assert.equal(row.enabled, false);
    assert.equal(row.verdict, "disabled");
    assert.match(row.disabled_reason ?? "", /Akamai/);
  });

  it("reports zero lifetime records for a source that has never ingested anything", async () => {
    // Decision 1 is a rendering rule, and this is the number it renders. A
    // source with no runs must report 0, not null and not absent — the console
    // shows 0 in the failure colour, and it cannot do that with an empty cell.
    const rows = await listSources(db);
    assert.equal(bySourceId(rows, disabled.sourceId).lifetime_records, 0);
  });

  it("totals lifetime records across every run, partial ones included", async () => {
    const rows = await listSources(db);
    // 7 + 11 + 11 from the succeeded run, 1 + 3 from the partial one. The two
    // failures in the partial run are not records.
    assert.equal(bySourceId(rows, productive.sourceId).lifetime_records, 33);
  });

  it("marks a source past its expected interval as suspect", async () => {
    const rows = await listSources(db);
    const row = bySourceId(rows, silent.sourceId);
    assert.equal(row.silence.verdict, "suspect");
    assert.equal(row.verdict, "suspect");
    assert.ok((row.silence.hours_since_success ?? 0) >= 71);
  });

  it("carries the newest run of a source, not an arbitrary one", async () => {
    const rows = await listSources(db);
    const row = bySourceId(rows, productive.sourceId);
    assert.equal(row.latest_run?.status, "partial");
  });

  it("serves the same listing over the API to a signed-in operator", async () => {
    const res = await request(app)
      .get("/api/admin/pressroom/sources")
      .set("Cookie", cookie)
      .expect(200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.total, res.body.data.length);
    const row = res.body.data.find((item: PressroomSource) => item.id === disabled.sourceId);
    assert.ok(row, "the disabled source is served, not filtered out");
    assert.equal(row.lifetime_records, 0);
  });

  it("refuses to act when ingestion is not running in this process", async () => {
    // No stack is registered in a test process, and the honest answer is that
    // the capability is absent — not a 500 from a null dereference.
    await request(app)
      .post(`/api/admin/pressroom/sources/${disabled.sourceId}/sweep`)
      .set("Cookie", cookie)
      .expect(503);
  });
});
