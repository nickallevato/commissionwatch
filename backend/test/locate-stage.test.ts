import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { BlockedError, IngestionQueue } from "../src/services/ingestion/queue";
import type { LocateContext } from "../src/services/ingestion/worker";
import {
  LOCATE_CONCURRENCY,
  LocationUnavailable,
  createLocateHandler,
  enqueueLocation,
  queuedLocation,
} from "../src/services/locate/stage";
import { GeocoderError, type GeocodeResult, type Geocoder } from "../src/services/locate/census";
import { registerPressroomStack } from "../src/routes/admin/pressroom";
import { buildIngestionStack } from "../src/services/ingestion";
import {
  cleanupByPrefix,
  createArtifact,
  createJob,
  createMeeting,
  createRun,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * The `locate` queue stage — `services/locate/stage.ts`.
 *
 * Modelled on `extraction-batch.test.ts` and `extraction.test.ts`'s own
 * `createExtractHandler`/`enqueueExtraction` coverage: the same enqueue /
 * queued / handler / `Unavailable` shape, the same reasons. Before this file,
 * nothing imported `locate/stage.ts` at all, and nothing exercised
 * `POST /api/admin/pressroom/meetings/:id/locate` — the route that puts pins
 * on the public map for a meeting's agenda.
 */

const PREFIX = "locate-stage-test";
const EMAIL = "locate-stage-test@example.invalid";

/** The real annexation title from the 2026-08-04 Bozeman agenda fixture. */
const ADDRESS = "133 Maus Lane";
const TITLE =
  "Resolution, Adoption of the 133 Maus Lane Annexation, Annexing 5.13 acres " +
  "Including Adjacent Right-of-Way, Application 25213";

/** A geocoder that answers one address and nothing else. */
class StubGeocoder implements Geocoder {
  readonly queries: string[] = [];
  constructor(private readonly answer: GeocodeResult | null = ANSWER) {}
  async locate(query: string): Promise<GeocodeResult | null> {
    this.queries.push(query);
    return this.answer;
  }
}

/** A geocoder that always fails the way the real service fails: a bad response. */
class FailingGeocoder implements Geocoder {
  async locate(): Promise<GeocodeResult | null> {
    throw new GeocoderError("the Census geocoder answered 503 for this query", 503);
  }
}

const ANSWER: GeocodeResult = {
  lat: 45.701959309284,
  lon: -111.043593591292,
  precision: "block",
  matchedAddress: "133 MAUS LN, BOZEMAN, MT, 59715",
  geocoder: "us-census/Public_AR_Current",
};

const shas: string[] = [];

/** Registers a parsed-agenda artifact + parse job, the shape `findAgendaArtifact` reads. */
async function withAgendaArtifact(
  sourceId: string,
  meetingId: string,
  sha: string,
): Promise<void> {
  await createArtifact(sha, `https://example.invalid/${sha.slice(0, 8)}.pdf`);
  shas.push(sha);
  const runId = await createRun(sourceId, { status: "succeeded", counts: { parsed: 1 } });
  await createJob(runId, "parse", { sha256: sha, meetingId, documentType: "agenda" });
}

/** Builds a bare `LocateContext` the way `extraction.test.ts`'s `contextOver` does. */
function contextOver(content: Buffer, meetingId: string, sha256: string): LocateContext {
  return {
    stage: "locate",
    jobId: "00000000-0000-4000-8000-000000000101",
    runId: "00000000-0000-4000-8000-000000000102",
    attempts: 1,
    db,
    signal: new AbortController().signal,
    enqueue: async () => {
      throw new Error("the locate stage enqueues nothing");
    },
    target: { sha256, meetingId },
    artifact: {
      id: "00000000-0000-4000-8000-000000000103",
      sha256,
      storageKey: `artifacts/${sha256.slice(0, 2)}/${sha256}`,
      contentType: "text/html",
      sourceUrl: "https://example.invalid/agenda.html",
      byteSize: content.byteLength,
      fetchedAt: new Date(),
    },
    content,
  };
}

describe("LOCATE_CONCURRENCY", () => {
  it("is 1 — the Census geocoder is a free public service and serial pacing is the whole of the rate control", () => {
    // Raising this is a decision about somebody else's server, not a
    // performance tweak; see the comment on the export itself. This pins the
    // value so raising it breaks a test rather than a silent edit.
    assert.equal(LOCATE_CONCURRENCY, 1);
  });
});

describe("enqueueLocation / queuedLocation", () => {
  let cookie: string;
  const queue = new IngestionQueue(db);

  before(async () => {
    await cleanupByPrefix(PREFIX);
    cookie = await signInOperator(EMAIL, "Locate Stage Operator");
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await db("operators").where({ email: EMAIL }).del();
    // The pool itself is destroyed once, at the true end of the file — see
    // the bottom `after`, and extraction-batch.test.ts's comment on why.
  });

  it("queuedLocation reports null when nothing is queued", async () => {
    const src = await createSource(`${PREFIX}-none`, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2020-01-01" });
    assert.equal(await queuedLocation(db, meetingId), null);
  });

  it("enqueues a job against the parsed agenda and returns its identifiers", async () => {
    const src = await createSource(`${PREFIX}-enqueue`, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2020-02-01" });
    const sha = sha256Of(`${PREFIX}-enqueue`);
    await withAgendaArtifact(src.sourceId, meetingId, sha);

    const queued = await enqueueLocation(db, queue, meetingId);
    assert.equal(queued.meeting_id, meetingId);
    assert.equal(queued.artifact_sha256, sha);
    assert.ok(queued.job_id);
    assert.ok(queued.run_id);

    const job = await queue.get(queued.job_id);
    assert.ok(job);
    assert.equal(job.stage, "locate");
    assert.equal(job.status, "pending");
    assert.equal(job.runId, queued.run_id);
    assert.deepEqual(job.target, { sha256: sha, meetingId });
  });

  it("queuedLocation reports the pending job once one exists", async () => {
    const src = await createSource(`${PREFIX}-report`, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2020-03-01" });
    const sha = sha256Of(`${PREFIX}-report`);
    await withAgendaArtifact(src.sourceId, meetingId, sha);

    const queued = await enqueueLocation(db, queue, meetingId);
    assert.equal(await queuedLocation(db, meetingId), queued.job_id);
  });

  it("raises LocationUnavailable(404) when no agenda has been parsed for the meeting", async () => {
    const src = await createSource(`${PREFIX}-noagenda`, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2020-04-01" });

    await assert.rejects(
      () => enqueueLocation(db, queue, meetingId),
      (error: unknown) => {
        assert.ok(error instanceof LocationUnavailable);
        assert.equal(error.statusCode, 404);
        assert.match(error.message, /No agenda document has been parsed/);
        return true;
      },
    );
  });

  it(
    "enqueueing twice does not create a duplicate job: the second call is refused, " +
      "PINNED as LocationUnavailable(409) — the only queued job stays the first one",
    async () => {
      const src = await createSource(`${PREFIX}-twice`, { enabled: true });
      const meetingId = await createMeeting(src.commissionId, { date: "2020-05-01" });
      const sha = sha256Of(`${PREFIX}-twice`);
      await withAgendaArtifact(src.sourceId, meetingId, sha);

      const first = await enqueueLocation(db, queue, meetingId);

      await assert.rejects(
        () => enqueueLocation(db, queue, meetingId),
        (error: unknown) => {
          assert.ok(error instanceof LocationUnavailable);
          assert.equal(error.statusCode, 409);
          assert.match(error.message, new RegExp(first.job_id));
          return true;
        },
      );

      const jobs = await db("ingestion_jobs").where({ stage: "locate" }).whereRaw(
        "target ->> 'meetingId' = ?",
        [meetingId],
      );
      assert.equal(jobs.length, 1, "a duplicate job was queued for the same meeting");
    },
  );

  describe("the route: POST /api/admin/pressroom/meetings/:id/locate", () => {
    it("401s without an operator session", async () => {
      await request(app)
        .post("/api/admin/pressroom/meetings/00000000-0000-4000-8000-000000000001/locate")
        .expect(401);
    });

    describe("with a live stack registered", () => {
      before(() => {
        const liveStack = buildIngestionStack(db);
        registerPressroomStack({ queue: liveStack.queue, scheduler: liveStack.scheduler });
      });

      after(() => {
        registerPressroomStack(null);
      });

      it("answers 404, naming the reason, for a meeting that does not exist", async () => {
        // A syntactically valid UUID naming no meeting `findAgendaArtifact`
        // will ever match: the query joins through ingestion_jobs, so a
        // meeting that was never ingested (or was never created at all)
        // produces exactly the same "nothing to locate" answer.
        const res = await request(app)
          .post("/api/admin/pressroom/meetings/00000000-0000-4000-8000-00000000dead/locate")
          .set("Cookie", cookie)
          .expect(404);
        assert.match(res.body.error, /No agenda document has been parsed/);
      });

      it("queues a real meeting's agenda and returns 202 with the job identifiers", async () => {
        const src = await createSource(`${PREFIX}-route`, { enabled: true });
        const meetingId = await createMeeting(src.commissionId, { date: "2020-06-01" });
        const sha = sha256Of(`${PREFIX}-route`);
        await withAgendaArtifact(src.sourceId, meetingId, sha);

        const res = await request(app)
          .post(`/api/admin/pressroom/meetings/${meetingId}/locate`)
          .set("Cookie", cookie)
          .expect(202);

        assert.equal(res.body.meeting_id, meetingId);
        assert.equal(res.body.artifact_sha256, sha);
        assert.equal(res.body.status, "queued");
      });
    });
  });
});

describe("createLocateHandler", () => {
  before(async () => {
    await cleanupByPrefix(PREFIX);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts(shas);
  });

  async function meetingWithAddressItem(
    seed: string,
  ): Promise<{ meetingId: string; jurisdictionId: string }> {
    const src = await createSource(`${PREFIX}-handler-${seed}`, { enabled: true });
    const meetingId = await createMeeting(src.commissionId, { date: "2021-01-01" });
    await db("agenda_items").insert({ meeting_id: meetingId, item_number: 1, title: TITLE });
    return { meetingId, jurisdictionId: src.jurisdictionId };
  }

  it("locates the address, geocodes it and reports the tally in the stage counts", async () => {
    const { meetingId, jurisdictionId } = await meetingWithAddressItem("success");
    const sha = sha256Of(`${PREFIX}-handler-success`);
    const geocoder = new StubGeocoder();
    const handler = createLocateHandler({ geocoder });

    // The bytes an HTML reader turns into exactly one line: the item's own
    // title, which is also what `agenda_items.title` holds — so the citation
    // this handler writes locates in the same text it was read from.
    const content = Buffer.from(`<html><body><p>${TITLE}</p></body></html>`);
    const result = await handler(contextOver(content, meetingId, sha));

    assert.deepEqual(result, {
      counts: {
        locate_items_read: 1,
        locate_addresses_found: 1,
        locate_uncited: 0,
        locate_unresolved: 0,
        places_recorded: 1,
        place_links_held: 1,
      },
    });
    // The jurisdiction created by `createSource` is a *county* — its name
    // ends "... County" — so `geocodeQuery` omits it as the query's city
    // component (see the probe note in `locate/census.ts`: a county name
    // sent as the city returns zero matches) and sends only the state.
    assert.deepEqual(geocoder.queries, ["133 Maus Lane, MT"]);

    const links = await db("place_links as pl")
      .join("places as p", "p.id", "pl.place_id")
      .where({ "p.label": ADDRESS, "p.jurisdiction_id": jurisdictionId })
      .select<Array<{ status: string }>>("pl.status");
    assert.equal(links.length, 1);
    assert.equal(links[0].status, "held", "a place link auto-published");
  });

  it("blocks — never retries — a document that is neither PDF nor HTML", async () => {
    const { meetingId } = await meetingWithAddressItem("unsupported");
    const sha = sha256Of(`${PREFIX}-handler-unsupported`);
    const handler = createLocateHandler({ geocoder: new StubGeocoder() });

    await assert.rejects(
      () => handler(contextOver(Buffer.from("plain text, not a document format we read"), meetingId, sha)),
      (error: unknown) => {
        assert.ok(error instanceof BlockedError);
        assert.match(error.message, /neither a PDF nor HTML/);
        return true;
      },
    );
  });

  it("blocks — never retries — a document with no extractable text layer", async () => {
    const { meetingId } = await meetingWithAddressItem("empty");
    const sha = sha256Of(`${PREFIX}-handler-empty`);
    const handler = createLocateHandler({ geocoder: new StubGeocoder() });

    await assert.rejects(
      () => handler(contextOver(Buffer.from("<html><body></body></html>"), meetingId, sha)),
      (error: unknown) => {
        assert.ok(error instanceof BlockedError);
        assert.match(error.message, /no extractable text layer/);
        return true;
      },
    );
  });

  it("rethrows a geocoder failure as a plain Error so the queue retries it, rather than blocking", async () => {
    const { meetingId, jurisdictionId } = await meetingWithAddressItem("geocoder-down");
    const sha = sha256Of(`${PREFIX}-handler-geocoder-down`);
    const handler = createLocateHandler({ geocoder: new FailingGeocoder() });

    const content = Buffer.from(`<html><body><p>${TITLE}</p></body></html>`);

    await assert.rejects(
      () => handler(contextOver(content, meetingId, sha)),
      (error: unknown) => {
        // Deliberately NOT a BlockedError: a federal endpoint being down for
        // ten minutes is the case retrying fixes, per the comment on
        // `createLocateHandler`. `extraction/stage.ts` draws the same line —
        // `ExtractionUnavailable` blocks, an unclassified model failure
        // retries — so the two stages agree on the shape even though the
        // failing dependency differs (OpenRouter vs. the Census geocoder).
        assert.ok(!(error instanceof BlockedError), "a retryable geocoder failure was blocked");
        assert.match(String((error as Error).message), /answered 503/);
        return true;
      },
    );

    // Nothing was written for the mention the geocoder failed to resolve.
    const links = await db("place_links as pl")
      .join("places as p", "p.id", "pl.place_id")
      .where({ "p.label": ADDRESS, "p.jurisdiction_id": jurisdictionId })
      .select("pl.id");
    assert.equal(links.length, 0, "a failed geocode still wrote a place link");
  });
});

after(async () => {
  // The true end of the file: node's test runner isolates each test file in
  // its own process, and an open Knex pool is an open handle that keeps that
  // process alive past every test finishing. See extraction-batch.test.ts's
  // identical comment.
  await deleteArtifacts(shas);
  await db.destroy();
});
