import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  toPublicExtraction,
  type PublicExtraction,
} from "../src/services/ingestion-status";
import type {
  ExtractionBacklog,
  ExtractionDistribution,
} from "../src/services/extraction/distribution";
import { rosterCoverage, rosterProvenance } from "../src/services/roster-coverage";

/**
 * The two numbers this project was computing and not saying out loud.
 *
 * **The extraction backlog** was queryable — `extractionBacklog` and
 * `extractionDistribution` shipped with a script over them — and no route
 * called either, so `/status` reported that documents had been *collected*
 * while saying nothing about whether any of them had been *read*. Those look
 * identical from the outside and fail separately.
 *
 * **The roster distribution** was summed into three totals on `/api/metrics`,
 * and a total cannot say whether the coverage is even — one fully accounted
 * body and one wholly unaccounted body read as partial coverage in both. The
 * first attempt at that answered it with a per-body roll and had to be
 * withdrawn: `/api/metrics` is public and takes no id, and a body name in a
 * breakdown tells a stranger we hold records for that body before an operator
 * has published one. So the public shape is a distribution over bodies and the
 * roll stays an operator's view.
 *
 * The assertion this file exists for is the first one below: an unread fraction
 * over zero chunks is `0`, and rendering that as "0% went unread" is the
 * confident wrong answer. Unmeasured and zero are different states and the type
 * has to keep them apart. It is proved against the pure narrowing rather than
 * against the endpoint, because the test database is shared and another suite's
 * `extraction_runs` rows are indistinguishable from a fixture's.
 */

const JURISDICTION_NAME = "Roster Coverage Test County";
/** A name that exists nowhere else. If it reaches `/api/metrics`, we published a person. */
const ROSTER_NAME = "Zzyzx Quorumbane";

function backlog(over: Partial<ExtractionBacklog> = {}): ExtractionBacklog {
  return { eligible: 0, read: 0, unread: 0, queued: 0, blocked: 0, failed: 0, ...over };
}

function distribution(over: Partial<ExtractionDistribution> = {}): ExtractionDistribution {
  return {
    runs: 0,
    meetings: 0,
    chunks: 0,
    unread: 0,
    unread_fraction: 0,
    recovered: 0,
    by_status: { running: 0, succeeded: 0, partial: 0, failed: 0 },
    by_reason: [],
    runs_wholly_unread: 0,
    runs_refused: 0,
    meetings_read: 0,
    ...over,
  };
}

describe("the extraction reading state is unmeasured, not zero", () => {
  it("reports an empty extraction_runs as unmeasured rather than as a clean run", () => {
    // Exactly the state production was in until 2026-08-15: nothing has run.
    const reading = toPublicExtraction(backlog({ eligible: 9, unread: 9 }), distribution()).reading;
    assert.equal(reading.measured, false);
    assert.equal(reading.runs, 0);
    // The flattering figure must not be reachable at all, not merely unrendered.
    assert.equal("unread_fraction" in reading, false);
  });

  it("stays unmeasured when runs finished without attempting a chunk", () => {
    // A run that died before chunking contributes no denominator. Dividing by it
    // is the same confident zero one layer up, so `runs > 0` alone is not enough.
    const reading = toPublicExtraction(backlog(), distribution({ runs: 4, chunks: 0 })).reading;
    assert.equal(reading.measured, false);
    // The runs are still reported. Suppressing the fact to suppress the
    // ambiguity would be the worse of the two defects.
    assert.equal(reading.runs, 4);
  });

  it("carries the measured distribution once chunks have been attempted", () => {
    // The real 2026-08-15 measurement: 24 chunks, 5 unread, every one truncated.
    const reading = toPublicExtraction(
      backlog({ eligible: 10, read: 10 }),
      distribution({
        runs: 20,
        meetings: 10,
        chunks: 24,
        unread: 5,
        unread_fraction: 0.208,
        recovered: 88,
        by_reason: [{ reason: "truncated-reply", chunks: 5, runs: 5, recovered: 88 }],
      }),
    ).reading;

    if (reading.measured !== true) assert.fail("a 24-chunk corpus read as unmeasured");
    assert.equal(reading.chunks, 24);
    assert.equal(reading.chunks_unread, 5);
    assert.equal(reading.unread_fraction, 0.208);
    assert.equal(reading.claims_recovered, 88);
    assert.deepEqual(reading.reasons, [{ reason: "truncated-reply", chunks: 5, recovered: 88 }]);
  });

  it("publishes the reason taxonomy and never a chunk's error text", () => {
    // `failed_chunks[].error` is verbatim third-party text and can quote a
    // document belonging to an unpublished meeting. Only the closed reason set
    // and the counts cross the line.
    const serialised = JSON.stringify(
      toPublicExtraction(
        backlog(),
        distribution({
          runs: 1,
          chunks: 2,
          unread: 1,
          by_reason: [{ reason: "refused", chunks: 1, runs: 1, recovered: 0 }],
        }),
      ),
    );
    assert.equal(serialised.includes("refused"), true);
    assert.equal(serialised.includes("error"), false);
  });
});

describe("GET /api/ingestion/sources carries the backlog depth", () => {
  it("states how much of the collected record has been read", async () => {
    const response = await request(app).get("/api/ingestion/sources");
    assert.equal(response.status, 200);
    const extraction = response.body.extraction as PublicExtraction;

    assert.ok(extraction, "the public status payload carries no extraction backlog");
    // Derived, never counted twice: the three must be consistent by
    // construction, since two counts taken microseconds apart can disagree.
    assert.equal(extraction.unread, extraction.eligible - extraction.read);
    for (const value of [
      extraction.eligible,
      extraction.read,
      extraction.unread,
      extraction.queued,
      extraction.blocked,
      extraction.failed,
    ]) {
      assert.equal(typeof value, "number");
      assert.ok(value >= 0);
    }
    assert.equal(typeof extraction.reading.measured, "boolean");
  });

  it("hands back no meeting id with the backlog", async () => {
    // `listUnextractedMeetings` answers the same question with ids and content
    // addresses attached, and an unread backlog is mostly unpublished meetings.
    // The wall is what stops that set being enumerable, so the public payload
    // carries the depth and nothing that identifies a record in it.
    const response = await request(app).get("/api/ingestion/sources");
    const extraction = response.body.extraction as Record<string, unknown>;
    for (const key of ["meetings", "meeting_ids", "sha256", "unextracted"]) {
      assert.equal(key in extraction, false, `the backlog leaked ${key}`);
    }
  });
});

describe("the roster distribution names no body and no person", () => {
  before(async () => {
    await db("jurisdictions").where({ name: JURISDICTION_NAME }).del();
    const [row] = await db("jurisdictions")
      .insert({ name: JURISDICTION_NAME, state: "MT", type: "county" })
      .returning("id");
    await db("members").insert({
      jurisdiction_id: (row as { id: string }).id,
      name: ROSTER_NAME,
      title: "Commissioner",
      term_start: "2020-01-01",
    });
  });

  after(async () => {
    await db("jurisdictions").where({ name: JURISDICTION_NAME }).del();
  });

  it("sorts bodies into coverage states without carrying a name", () => {
    const provenance = rosterProvenance([
      {
        jurisdiction_id: "11111111-2222-3333-4444-555555555555",
        jurisdiction_name: "Somewhere",
        seats_sourced: 5,
        seats_implied: 5,
        unmatched: [],
        seats_traceable: 0,
        provenance: "unsourced",
      },
      {
        jurisdiction_id: "22222222-3333-4444-5555-666666666666",
        jurisdiction_name: "Elsewhere",
        seats_sourced: 2,
        seats_implied: 3,
        unmatched: ["emma bode"],
        seats_traceable: 0,
        provenance: "unsourced",
      },
      {
        jurisdiction_id: "33333333-4444-5555-6666-777777777777",
        jurisdiction_name: "Nowhere",
        seats_sourced: 0,
        seats_implied: 3,
        unmatched: ["a", "b", "c"],
        seats_traceable: 0,
        provenance: "unsourced",
      },
      {
        jurisdiction_id: "44444444-5555-6666-7777-888888888888",
        jurisdiction_name: "Unread County",
        seats_sourced: 0,
        seats_implied: 0,
        unmatched: [],
        seats_traceable: 0,
        provenance: "unsourced",
      },
    ]);

    assert.deepEqual(provenance, {
      jurisdictions: 4,
      accounted: 1,
      partial: 1,
      none: 1,
      // The fourth body has nothing to match against. A roster that matches
      // nothing matches everything, and counting it as covered is the same
      // confident zero this file's other half exists to refuse.
      unmeasured: 1,
      traceable: 0,
    });

    const serialised = JSON.stringify(provenance);
    for (const secret of ["Somewhere", "Nowhere", "bode", "11111111"]) {
      assert.equal(serialised.includes(secret), false, `the distribution leaked ${secret}`);
    }
  });

  it("counts a body whose roster matches none of the printed names as none", () => {
    // Rows exist and account for nobody. Keyed on the names, not on whether the
    // table has anything in it, or five wrong rows would read as partial cover.
    const provenance = rosterProvenance([
      {
        jurisdiction_id: "55555555-6666-7777-8888-999999999999",
        jurisdiction_name: "Mismatch County",
        seats_sourced: 5,
        seats_implied: 2,
        unmatched: ["one", "two"],
        seats_traceable: 0,
        provenance: "unsourced",
      },
    ]);
    assert.equal(provenance.none, 1);
    assert.equal(provenance.partial, 0);
  });

  it("counts every jurisdiction, including one whose roster is empty", async () => {
    // Nothing is filtered here for the same reason nothing is filtered out of
    // the source table: the body with no roster is the one the number exists to
    // expose.
    const coverage = await rosterCoverage(db);
    assert.ok(
      coverage.some((row) => row.jurisdiction_name === JURISDICTION_NAME),
      "the fixture jurisdiction is missing from the coverage report",
    );
    const provenance = rosterProvenance(coverage);
    assert.equal(provenance.jurisdictions, coverage.length);
    // Nothing in `members` can prove where it came from, so no body may claim to.
    assert.equal(provenance.traceable, 0);
  });

  it("serves the distribution on /api/metrics and names no body or person", async () => {
    const response = await request(app).get("/api/metrics");
    assert.equal(response.status, 200);
    const roster = response.body.roster as Record<string, unknown>;
    assert.equal(typeof roster.jurisdictions, "number");
    assert.equal(roster.traceable, 0);

    // The general assertion, not the fixture's own name: `/api/metrics` takes no
    // id and the publication wall exists so a stranger cannot enumerate what has
    // been ingested and withheld. A body name in a breakdown undoes that in one
    // field, so every name in the table is checked, not just this suite's.
    const serialised = JSON.stringify(response.body);
    const names: unknown = await db("jurisdictions").select("name");
    const jurisdictionNames = (Array.isArray(names) ? names : [])
      .map((row) => (typeof row === "object" && row !== null ? (row as { name?: unknown }).name : null))
      .filter((name): name is string => typeof name === "string" && name !== "");
    assert.ok(jurisdictionNames.length > 0, "no jurisdiction exists to check against");
    for (const name of jurisdictionNames) {
      assert.equal(serialised.includes(name), false, `/api/metrics leaked the body name ${name}`);
    }
    assert.equal(serialised.includes(ROSTER_NAME), false);

    // The summed figures the page already showed are untouched by the addition.
    assert.equal(typeof response.body.quality.roster_sourced, "boolean");
  });
});

// File scope, not inside a describe's `after`: the first suite to finish would
// otherwise close the pool out from under the two that follow it.
after(async () => {
  await db.destroy();
});
