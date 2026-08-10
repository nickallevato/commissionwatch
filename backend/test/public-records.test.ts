import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import type { RecordGap } from "../src/services/records/gaps";
import { cleanupByPrefix, createMeeting, createSource, signInOperator } from "./helpers/pressroom";

/**
 * P7 · the two HTTP surfaces.
 *
 * `/api/public-records` is unauthenticated, produces the same letter as the
 * console, and **writes nothing** — no request row, no record of who asked. The
 * console's `/api/admin/records/draft-request` produces the same text and does
 * write the row.
 *
 * The wall is asserted here as well as in the service, because it is the route
 * a stranger reaches: an unpublished meeting must not be listable, and its gap
 * id must not be redeemable for a letter even when guessed correctly.
 */

const PREFIX = "public-records-test";
const OPERATOR_EMAIL = "public-records-test@example.invalid";

const REQUESTER = { name: "A. Requester", email: "requester@example.invalid" };

interface GapsBody {
  data: RecordGap[];
  total: number;
}

interface LetterBody {
  letter: string;
  gap: RecordGap;
  law: { statute_citation: string; statute_url: string };
  warnings: string[];
  request: { id: string; status: string; notes: string | null } | null;
}

interface ErrorBody {
  error: string;
  statusCode: number;
}

async function countRequests(): Promise<number> {
  const [row] = await db("records_requests").count<Array<{ count: string }>>("* as count");
  return Number(row.count);
}

describe("the public-records request generator over HTTP", () => {
  let cookie = "";
  let lawfulJurisdiction = "";
  let publishedGapId = "";
  let withheldGapId = "";
  let unlawfulGapId = "";
  let unlawfulJurisdiction = "";
  const created: string[] = [];

  before(async () => {
    await cleanupByPrefix(PREFIX);
    cookie = await signInOperator(OPERATOR_EMAIL, "Public Records Test");

    const lawful = await createSource(`${PREFIX} lawful`, { enabled: true });
    const unlawful = await createSource(`${PREFIX} unlawful`, { enabled: true });
    lawfulJurisdiction = lawful.jurisdictionId;
    unlawfulJurisdiction = unlawful.jurisdictionId;

    await db("jurisdiction_records_law").insert({
      jurisdiction_id: lawfulJurisdiction,
      statute_citation: "Example Code Ann. § 0-0-0000",
      statute_url: "https://example.invalid/statute",
      acknowledge_days: null,
      respond_days: null,
      verified_on: "2026-08-01",
    });

    publishedGapId = `missing_minutes:${await createMeeting(lawful.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    })}`;
    withheldGapId = `missing_minutes:${await createMeeting(lawful.commissionId, {
      publishedAt: null,
      date: "2026-08-03",
    })}`;
    unlawfulGapId = `missing_minutes:${await createMeeting(unlawful.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    })}`;
  });

  after(async () => {
    if (created.length > 0) await db("records_requests").whereIn("id", created).del();
    await db("operators").where({ email: OPERATOR_EMAIL }).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  describe("GET /api/public-records/gaps", () => {
    it("answers a stranger, and lists only published records", async () => {
      const res = await request(app).get("/api/public-records/gaps").expect(200);
      const body = res.body as GapsBody;
      const ids = body.data.map((gap) => gap.id);
      assert.ok(ids.includes(publishedGapId));
      assert.ok(!ids.includes(withheldGapId), "an unpublished meeting was listed publicly");
      assert.equal(body.total, body.data.length);
    });

    it("rejects a malformed meeting filter rather than ignoring it", async () => {
      await request(app).get("/api/public-records/gaps?meeting_id=nope").expect(400);
    });
  });

  describe("POST /api/public-records/letter", () => {
    it("drafts a letter for a stranger and writes no row", async () => {
      const before = await countRequests();

      const res = await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(200);

      const body = res.body as LetterBody;
      assert.equal(body.request, null, "the public surface persisted a request");
      assert.ok(body.letter.includes("Example Code Ann. § 0-0-0000"));
      assert.ok(body.letter.includes(REQUESTER.email));
      // The fixture law establishes no period, so the letter states none.
      assert.ok(!/provides for/.test(body.letter));
      assert.ok(body.warnings.some((text) => text.includes("No acknowledgement or response period")));

      assert.equal(await countRequests(), before, "the public surface wrote a row");
    });

    it("will not redeem an unpublished meeting's gap id, even a correctly guessed one", async () => {
      const res = await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: withheldGapId, requester: REQUESTER })
        .expect(404);
      assert.equal((res.body as ErrorBody).error, "No such gap in the record");
    });

    it("will not redeem an operator-only gap kind", async () => {
      const source = await db("ingestion_sources")
        .where({ jurisdiction_id: lawfulJurisdiction })
        .first<{ id: string }>("id");
      assert.ok(source);
      await db("ingestion_sources").where({ id: source.id }).update({ enabled: false });

      await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: `disabled_source:${source.id}`, requester: REQUESTER })
        .expect(404);

      await db("ingestion_sources").where({ id: source.id }).update({ enabled: true });
    });

    it("refuses with 409 for a jurisdiction with no records law, naming the columns", async () => {
      const res = await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: unlawfulGapId, requester: REQUESTER })
        .expect(409);

      const body = res.body as ErrorBody;
      assert.match(body.error, /jurisdiction_records_law/);
      assert.match(body.error, /statute_citation/);
      assert.match(body.error, /verified_on/);
      assert.ok(body.error.includes(unlawfulJurisdiction));
    });

    it("requires a gap and a requester", async () => {
      await request(app).post("/api/public-records/letter").send({}).expect(400);
      await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: publishedGapId, requester: { name: "A" } })
        .expect(400);
      await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: "nonsense", requester: REQUESTER })
        .expect(404);
    });
  });

  describe("the operator surface", () => {
    it("is closed without a session", async () => {
      await request(app).get("/api/admin/records/gaps").expect(401);
      await request(app).get("/api/admin/records/law").expect(401);
      await request(app)
        .post("/api/admin/records/draft-request")
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(401);
    });

    it("lists the operator-only kinds the public surface withholds", async () => {
      const source = await db("ingestion_sources")
        .where({ jurisdiction_id: lawfulJurisdiction })
        .first<{ id: string }>("id");
      assert.ok(source);
      await db("ingestion_sources").where({ id: source.id }).update({ enabled: false });

      const res = await request(app)
        .get("/api/admin/records/gaps")
        .set("Cookie", cookie)
        .expect(200);
      const ids = (res.body as GapsBody).data.map((gap) => gap.id);
      assert.ok(ids.includes(`disabled_source:${source.id}`));
      // The operator also sees the withheld meeting: the wall stands between
      // ingested and published, not between the operator and the database.
      assert.ok(ids.includes(withheldGapId));

      await db("ingestion_sources").where({ id: source.id }).update({ enabled: true });
    });

    it("reports which jurisdictions have no records law", async () => {
      const res = await request(app).get("/api/admin/records/law").set("Cookie", cookie).expect(200);
      const rows = (
        res.body as { data: Array<{ jurisdiction_id: string; law: unknown; advisory: string }> }
      ).data;

      const missing = rows.find((row) => row.jurisdiction_id === unlawfulJurisdiction);
      assert.ok(missing, "a jurisdiction with no law row must still be listed");
      assert.equal(missing.law, null);
      assert.match(missing.advisory, /No row in jurisdiction_records_law/);

      const present = rows.find((row) => row.jurisdiction_id === lawfulJurisdiction);
      assert.ok(present);
      assert.ok(present.law);
    });

    it("drafts the identical letter and does write the row", async () => {
      const publicRes = await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(200);

      const operatorRes = await request(app)
        .post("/api/admin/records/draft-request")
        .set("Cookie", cookie)
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(201);

      const operatorBody = operatorRes.body as LetterBody;
      assert.ok(operatorBody.request);
      created.push(operatorBody.request.id);

      assert.equal((publicRes.body as LetterBody).letter, operatorBody.letter);
      assert.equal(operatorBody.request.status, "draft");
      assert.equal(operatorBody.request.notes, operatorBody.letter);
    });

    it("refuses with 409 rather than drafting against a missing records law", async () => {
      const res = await request(app)
        .post("/api/admin/records/draft-request")
        .set("Cookie", cookie)
        .send({ gap_id: unlawfulGapId, requester: REQUESTER })
        .expect(409);
      assert.match((res.body as ErrorBody).error, /worse than no letter/);
    });
  });

  describe("nothing is transmitted", () => {
    it("adds no delivery and no notification on either surface", async () => {
      const before = {
        deliveries: Number(
          (await db("deliveries").count<Array<{ count: string }>>("* as count"))[0].count,
        ),
        notifications: Number(
          (await db("notifications").count<Array<{ count: string }>>("* as count"))[0].count,
        ),
      };

      await request(app)
        .post("/api/public-records/letter")
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(200);
      const res = await request(app)
        .post("/api/admin/records/draft-request")
        .set("Cookie", cookie)
        .send({ gap_id: publishedGapId, requester: REQUESTER })
        .expect(201);
      const body = res.body as LetterBody;
      assert.ok(body.request);
      created.push(body.request.id);

      const after = {
        deliveries: Number(
          (await db("deliveries").count<Array<{ count: string }>>("* as count"))[0].count,
        ),
        notifications: Number(
          (await db("notifications").count<Array<{ count: string }>>("* as count"))[0].count,
        ),
      };
      assert.deepEqual(after, before, "drafting a letter produced something outbound");
    });
  });
});
