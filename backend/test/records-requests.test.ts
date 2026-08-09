import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { RecordsService, type DocumentStore } from "../src/services/records/requests";
import { registerRecordsService } from "../src/routes/admin/records";
import { OperatorAuthService } from "../src/services/auth/operators";
import { TEST_SCRYPT_PARAMS } from "../src/services/auth/password";

const BOZEMAN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const EMAIL = "records-test@example.invalid";
const PASSWORD = "a-sufficiently-long-passphrase";
const SUBJECT_PREFIX = "records-test:";

// Every name below is invented. Fixtures in this project never name a real
// person, and a records fixture is no exception.
const DOCUMENT_TEXT = `
CONTRACT AWARD MEMORANDUM
The Placeholder County Procurement Office recommends a sole source award to
Fictional Paving LLC. The initial estimate was $40,000. The revised award is
$390,000. Submitted by Jordan Placeholder on 2026-03-01.
`;

/** In-memory store, so the regular suite needs no MinIO. */
function memoryStore(): DocumentStore & { keys: () => string[] } {
  const objects = new Map<string, Buffer>();
  return {
    async upload(key, data) {
      objects.set(key, data);
      return key;
    },
    keys: () => [...objects.keys()],
  };
}

const auth = new OperatorAuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, log: () => {} });

async function cleanup(): Promise<void> {
  const requests = await db("records_requests")
    .where("subject", "like", `${SUBJECT_PREFIX}%`)
    .select<Array<{ id: string }>>("id");
  const requestIds = requests.map((row) => row.id);

  const artifacts = await db("artifacts")
    .where("storage_key", "like", "records/%")
    .select<Array<{ id: string }>>("id");
  const artifactIds = artifacts.map((row) => row.id);

  if (requestIds.length > 0) {
    await db("records_request_artifacts").whereIn("request_id", requestIds).del();
  }
  if (artifactIds.length > 0) {
    await db("records_request_artifacts").whereIn("artifact_id", artifactIds).del();
    await db("anomaly_flags").whereIn("artifact_id", artifactIds).del();
    await db("record_extractions").whereIn("artifact_id", artifactIds).del();
    await db("artifacts").whereIn("id", artifactIds).del();
  }
  if (requestIds.length > 0) {
    await db("records_requests").whereIn("id", requestIds).del();
  }
  await db("operators").where({ email: EMAIL }).del();
}

async function signIn(): Promise<string> {
  await auth.createOperator({ email: EMAIL, password: PASSWORD, name: "Records Operator" });
  const res = await request(app)
    .post("/api/admin/session")
    .send({ email: EMAIL, password: PASSWORD })
    .expect(200);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies.find((c: string) => c.startsWith("cw_session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}

describe("records requests", () => {
  before(cleanup);
  after(async () => {
    await cleanup();
    await db.destroy();
  });

  describe("the surface is operator-only", () => {
    it("401s every records route without a session", async () => {
      // Extraction output names people. This is the only place it is readable,
      // and it is not readable without a session.
      await request(app).get("/api/admin/records/requests").expect(401);
      await request(app).post("/api/admin/records/requests").send({ subject: "x" }).expect(401);
      await request(app).post("/api/admin/records/documents").send({}).expect(401);
      await request(app)
        .get(`/api/admin/records/documents/${"0".repeat(8)}-0000-0000-0000-000000000000/extraction`)
        .expect(401);
    });
  });

  describe("the request lifecycle", () => {
    let service: RecordsService;

    beforeEach(async () => {
      await cleanup();
      service = new RecordsService(db, { store: memoryStore() });
    });

    it("creates a request and defaults it to draft", async () => {
      const created = await service.createRequest({
        subject: `${SUBJECT_PREFIX} paving contracts`,
        jurisdiction_id: BOZEMAN_ID,
      });

      assert.equal(created.status, "draft");
      assert.equal(created.submitted_at, null);
      assert.equal(created.jurisdiction_id, BOZEMAN_ID);
    });

    it("stamps the submission date when the status becomes submitted", async () => {
      // A submitted request with no submission date is a lifecycle that cannot
      // answer "how long have they had this?", which is the whole point of
      // tracking one.
      const created = await service.createRequest({ subject: `${SUBJECT_PREFIX} stamped` });
      const updated = await service.updateRequest(created.id, { status: "submitted" });

      assert.equal(updated?.status, "submitted");
      assert.ok(updated?.submitted_at);
    });

    it("refuses a status the lifecycle does not have", async () => {
      const created = await service.createRequest({ subject: `${SUBJECT_PREFIX} bad status` });
      await assert.rejects(
        () => service.updateRequest(created.id, { status: "lost in the post" as never }),
        /not a records request status/,
      );
    });

    it("refuses a jurisdiction that does not exist", async () => {
      await assert.rejects(
        () =>
          service.createRequest({
            subject: `${SUBJECT_PREFIX} bad jurisdiction`,
            jurisdiction_id: "00000000-0000-0000-0000-000000000000",
          }),
        /Jurisdiction not found/,
      );
    });
  });

  describe("document ingestion", () => {
    let service: RecordsService;
    let store: ReturnType<typeof memoryStore>;

    beforeEach(async () => {
      await cleanup();
      store = memoryStore();
      service = new RecordsService(db, { store });
    });

    it("writes an artifacts row with source_url NULL — the same row a scrape produces", async () => {
      const result = await service.ingestDocument({
        filename: "award.pdf",
        contentType: "application/pdf",
        content: Buffer.from(DOCUMENT_TEXT, "utf8"),
        text: DOCUMENT_TEXT,
      });

      assert.equal(result.created, true);
      assert.equal(result.artifact.source_url, null);
      assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(store.keys().length, 1);
    });

    it("deduplicates identical bytes and reprocesses nothing", async () => {
      const content = Buffer.from(DOCUMENT_TEXT, "utf8");
      const first = await service.ingestDocument({ filename: "a.pdf", content, text: DOCUMENT_TEXT });
      const second = await service.ingestDocument({ filename: "b.pdf", content, text: DOCUMENT_TEXT });

      assert.equal(second.created, false);
      assert.equal(second.artifact.id, first.artifact.id);
      assert.equal(second.flagIds.length, 0, "a re-upload must not raise the flags a second time");

      const extractions = await service.extractionHistory(first.artifact.id);
      assert.equal(extractions.length, 1, "and must not extract a second time");
    });

    it("still attaches a duplicate to a new request", async () => {
      // "We already had this" and "this request produced it" are different
      // facts, and the second one is worth recording.
      const requestA = await service.createRequest({ subject: `${SUBJECT_PREFIX} first` });
      const requestB = await service.createRequest({ subject: `${SUBJECT_PREFIX} second` });
      const content = Buffer.from(DOCUMENT_TEXT, "utf8");

      await service.ingestDocument({ filename: "a.pdf", content, text: DOCUMENT_TEXT, requestId: requestA.id });
      await service.ingestDocument({ filename: "a.pdf", content, text: DOCUMENT_TEXT, requestId: requestB.id });

      const found = await service.getRequest(requestB.id);
      assert.equal(found?.artifacts.length, 1);
    });

    it("extracts and raises the flags the document earns", async () => {
      const result = await service.ingestDocument({
        filename: "award.pdf",
        content: Buffer.from(DOCUMENT_TEXT, "utf8"),
        text: DOCUMENT_TEXT,
      });

      assert.ok(result.extraction);
      assert.equal(result.namesAPerson, true);
      assert.ok(result.flagIds.length >= 1);

      const flags = await db("anomaly_flags").whereIn("id", result.flagIds);
      assert.ok(flags.some((f: { flag_type: string }) => f.flag_type === "no_bid_contract"));
    });

    it("writes no extraction when there is no text, rather than an empty one", async () => {
      // An empty extraction row would assert that we looked and found nobody.
      // That is not what happened.
      const result = await service.ingestDocument({
        filename: "scan.pdf",
        content: Buffer.from("binary-ish bytes"),
        text: null,
      });

      assert.equal(result.extraction, null);
      assert.equal(result.flagIds.length, 0);
    });

    it("refuses an empty document", async () => {
      await assert.rejects(
        () => service.ingestDocument({ filename: "empty.pdf", content: Buffer.alloc(0) }),
        /empty/,
      );
    });
  });

  describe("the publication gate", () => {
    it("holds every records-derived flag, and the public API cannot see it", async () => {
      // /api/anomalies is public and extraction names people. A records-derived
      // flag that published itself would break the project's central invariant.
      const service = new RecordsService(db, { store: memoryStore() });
      const result = await service.ingestDocument({
        filename: "gate.pdf",
        content: Buffer.from(`${DOCUMENT_TEXT}\ngate marker`, "utf8"),
        text: `${DOCUMENT_TEXT}\ngate marker`,
      });
      assert.ok(result.flagIds.length > 0);

      const rows = await db("anomaly_flags").whereIn("id", result.flagIds);
      assert.equal(
        rows.every((row: { review_state: string }) => row.review_state === "held"),
        true,
      );

      const publicList = await request(app).get("/api/anomalies?limit=200").expect(200);
      const publicIds = publicList.body.data.map((flag: { id: string }) => flag.id);
      for (const id of result.flagIds) {
        assert.equal(publicIds.includes(id), false, "a held flag must not appear publicly");
      }

      // And addressed directly it is a 404, not a 403 — a public caller has no
      // business learning it exists.
      await request(app).get(`/api/anomalies/${result.flagIds[0]}`).expect(404);
    });
  });

  describe("the correction path is append-only", () => {
    it("appends a correction and keeps what the machine originally said", async () => {
      const service = new RecordsService(db, { store: memoryStore() });
      const marker = `${DOCUMENT_TEXT}\ncorrection marker`;
      const ingested = await service.ingestDocument({
        filename: "correct.pdf",
        content: Buffer.from(marker, "utf8"),
        text: marker,
      });
      assert.ok(ingested.extraction);
      const originalId = ingested.extraction.id;

      const corrected = await service.correctExtraction({
        artifactId: ingested.artifact.id,
        entities: {
          people: [],
          organizations: [
            { value: "Fictional Paving LLC", confidence: "high", pattern: "operator correction" },
          ],
          amounts: [],
          dates: [],
        },
        note: "Jordan Placeholder was a room name, not a person",
      });

      assert.equal(corrected.supersedes_id, originalId);

      const history = await service.extractionHistory(ingested.artifact.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].id, originalId, "the superseded row still exists");

      const current = await service.latestExtraction(ingested.artifact.id);
      assert.equal(current?.id, corrected.id);
      assert.equal(current?.entities.people.length, 0);
    });
  });

  describe("the operator HTTP surface", () => {
    let cookie: string;

    before(async () => {
      await cleanup();
      // The router's default service is backed by MinIO, which CI does not
      // run. Same seam as registerDigestStatus in routes/health.ts.
      registerRecordsService(new RecordsService(db, { store: memoryStore() }));
      cookie = await signIn();
    });

    it("uploads base64, attaches to a request, and reports a duplicate as such", async () => {
      const created = await request(app)
        .post("/api/admin/records/requests")
        .set("Cookie", cookie)
        .send({ subject: `${SUBJECT_PREFIX} http`, jurisdiction_id: BOZEMAN_ID })
        .expect(201);

      const text = `${DOCUMENT_TEXT}\nhttp marker`;
      const payload = {
        filename: "award.pdf",
        content_type: "application/pdf",
        content_base64: Buffer.from(text, "utf8").toString("base64"),
        text,
      };

      const first = await request(app)
        .post(`/api/admin/records/requests/${created.body.id}/documents`)
        .set("Cookie", cookie)
        .send(payload)
        .expect(201);
      assert.equal(first.body.created, true);

      // 200 rather than 201, so a re-upload does not look like it silently did
      // nothing.
      const second = await request(app)
        .post(`/api/admin/records/requests/${created.body.id}/documents`)
        .set("Cookie", cookie)
        .send(payload)
        .expect(200);
      assert.equal(second.body.created, false);

      const detail = await request(app)
        .get(`/api/admin/records/requests/${created.body.id}`)
        .set("Cookie", cookie)
        .expect(200);
      assert.equal(detail.body.artifacts.length, 1);

      const extraction = await request(app)
        .get(`/api/admin/records/documents/${first.body.artifact.id}/extraction`)
        .set("Cookie", cookie)
        .expect(200);
      assert.ok(extraction.body.current.entities.people.length > 0);
      assert.equal(extraction.body.history.length, 1);
    });

    it("rejects a request with no content", async () => {
      await request(app)
        .post("/api/admin/records/documents")
        .set("Cookie", cookie)
        .send({ filename: "x.pdf" })
        .expect(400);
    });

    it("records who made a correction", async () => {
      const text = `${DOCUMENT_TEXT}\nattribution marker`;
      const uploaded = await request(app)
        .post("/api/admin/records/documents")
        .set("Cookie", cookie)
        .send({
          filename: "attr.pdf",
          content_base64: Buffer.from(text, "utf8").toString("base64"),
          text,
        })
        .expect(201);

      const corrected = await request(app)
        .post(`/api/admin/records/documents/${uploaded.body.artifact.id}/extraction`)
        .set("Cookie", cookie)
        .send({
          entities: { people: [], organizations: [], amounts: [], dates: [] },
          note: "cleared",
        })
        .expect(201);

      assert.ok(corrected.body.corrected_by, "a correction is attributed to the operator who made it");
      assert.ok(corrected.body.supersedes_id);
    });
  });
});
