import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  generateReference,
  RATE_LIMITS,
  resetDisputeRateLimits,
  type DisputeItem,
} from "../src/services/disputes";
import { FixedWindowLimiter } from "../src/services/rate-limit";
import type { PublicCorrection } from "../src/services/public-corrections";
import {
  cleanupByPrefix,
  createMeeting,
  createSource,
  signInOperator,
} from "./helpers/pressroom";

/**
 * B3 · the dispute route.
 *
 * It is the only unauthenticated write in this product, so the questions this
 * suite asks are the ones a hostile caller would:
 *
 *  - can it be used to discover a record an operator has withheld?  (no — an
 *    unpublished target and a non-existent one answer identically)
 *  - can it be used to change the published record?  (no — nothing on the path
 *    updates a record, and upholding a dispute is asserted to change nothing)
 *  - can what a stranger types reach the public site?  (no — a dispute is never
 *    published, and the public corrections log is checked for its text)
 *  - can one caller fill the operator's queue?  (no — three separate bounds)
 *
 * `record_disputes` has no append-only trigger, so this suite cleans up after
 * itself. Its `record_corrections` rows cannot be deleted and are not — they
 * key on ids this run generated, which is the arrangement migration 031 forces
 * on every suite that writes to the log.
 */

const PREFIX = "disputes-test";
const OPERATOR_EMAIL = "disputes-test@example.invalid";
const CONTACT = `${PREFIX}@example.invalid`;

const BODY = {
  contested: "The location recorded for this meeting is not where it was held.",
  account: "I attended. It was held in the annexe, not in the main chamber.",
  contact: CONTACT,
};

interface Receipt {
  reference: string;
  status: string;
  received_at: string;
}

interface DisputeListBody {
  data: DisputeItem[];
  total: number;
  counts: { received: number; upheld: number; declined: number };
}

interface ErrorBody {
  error: string;
  statusCode: number;
}

/**
 * Removes the suite's disputes **and the events they emitted**.
 *
 * `events.subject_id` is not a foreign key (migration 083: a deleted subject
 * does not retroactively un-announce itself), so deleting the disputes alone
 * left every `dispute.*` row behind for good — 25 of them per run, the largest
 * single contributor to a log that eventually stops the batched consumers
 * reaching any suite's own fixtures. `deliveries` keys on the same
 * `dedupe_key`, so it goes with them. `npm test`'s `posttest` hook
 * (`helpers/assert-events-clean.ts`) is what fails the run if this drifts.
 */
async function clearSuiteDisputes(): Promise<void> {
  const disputes = await db("record_disputes")
    .where({ contact: CONTACT })
    .select<Array<{ id: string }>>("id");
  const disputeIds = disputes.map((row) => row.id);
  if (disputeIds.length > 0) {
    const events = await db("events")
      .where({ subject_kind: "dispute" })
      .whereIn("subject_id", disputeIds)
      .select<Array<{ id: string; dedupe_key: string }>>("id", "dedupe_key");
    if (events.length > 0) {
      await db("deliveries")
        .whereIn(
          "dedupe_key",
          events.map((row) => row.dedupe_key),
        )
        .del();
      await db("events")
        .whereIn(
          "id",
          events.map((row) => row.id),
        )
        .del();
    }
    // dispute_notifications cascades from record_disputes (migration 092).
    await db("record_disputes").whereIn("id", disputeIds).del();
  }
}

describe("the dispute route", () => {
  let cookie = "";
  let publishedMeeting = "";
  let withheldMeeting = "";
  let publishedItem = "";

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await clearSuiteDisputes();
    cookie = await signInOperator(OPERATOR_EMAIL, "Disputes Test");

    const fixture = await createSource(PREFIX);
    publishedMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    });
    withheldMeeting = await createMeeting(fixture.commissionId, {
      publishedAt: null,
      date: "2026-08-05",
    });
    const [item] = await db("agenda_items")
      .insert({ meeting_id: publishedMeeting, item_number: 1, title: "An item" })
      .returning<Array<{ id: string }>>("id");
    publishedItem = item.id;
  });

  beforeEach(async () => {
    // The per-client windows are process memory shared by every test in this
    // file, and supertest calls all arrive from one address.
    resetDisputeRateLimits();
    await clearSuiteDisputes();
  });

  after(async () => {
    await clearSuiteDisputes();
    await db("operators").where({ email: OPERATOR_EMAIL }).del();
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  /* ----------------------------------------------------------- submission */

  describe("POST /api/corrections/disputes", () => {
    it("accepts a contest of a published record and hands back a reference", async () => {
      const res = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);

      const receipt = res.body as Receipt;
      assert.match(receipt.reference, /^CW-[0-9A-HJKMNP-TV-Z]{8}$/);
      assert.equal(receipt.status, "received");
      assert.ok(receipt.received_at);
    });

    it("collects three things and stores nothing else about the submitter", async () => {
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);

      const row = await db("record_disputes").where({ contact: CONTACT }).first();
      assert.ok(row);
      const columns = Object.keys(row);
      for (const forbidden of ["ip", "ip_address", "ip_hash", "user_agent", "fingerprint"]) {
        assert.ok(
          !columns.includes(forbidden),
          `record_disputes carries a ${forbidden} column; the route promises it collects nothing more`,
        );
      }
    });

    it("holds the dispute, and there is no legal value that publishes it", async () => {
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);

      const row = await db("record_disputes")
        .where({ contact: CONTACT })
        .first<{ id: string; review_state: string } | undefined>();
      assert.ok(row);
      assert.equal(row.review_state, "held");

      // Migration 039 permits exactly one value, so this is not a rule that a
      // later route could simply forget to apply.
      await assert.rejects(
        () => db("record_disputes").where({ id: row.id }).update({ review_state: "published" }),
        /record_disputes_never_published_check/,
      );
    });

    it("appends the arrival to the one audit log", async () => {
      const res = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);
      const { reference } = res.body as Receipt;

      const row = await db("record_disputes")
        .where({ reference })
        .first<{ id: string } | undefined>();
      assert.ok(row);

      const logged = await db("record_corrections")
        .where({ target_table: "record_disputes", target_id: row.id })
        .select<Array<{ field: string; new_value: string | null; dispute_id: string | null }>>("*");
      assert.equal(logged.length, 1);
      assert.equal(logged[0].field, "status");
      assert.equal(logged[0].new_value, "received");
      assert.equal(logged[0].dispute_id, row.id);
    });

    it("answers a withheld record and a non-existent one identically", async () => {
      const withheld = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: withheldMeeting, ...BODY })
        .expect(404);

      const missing = await request(app)
        .post("/api/corrections/disputes")
        .send({
          target_table: "meetings",
          target_id: "00000000-0000-4000-8000-000000000000",
          ...BODY,
        })
        .expect(404);

      assert.deepEqual(withheld.body, missing.body);
      assert.equal(await db("record_disputes").where({ contact: CONTACT }).first(), undefined);
    });

    it("reaches an agenda item through its meeting's publication", async () => {
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "agenda_items", target_id: publishedItem, ...BODY })
        .expect(201);

      await db("meetings").where({ id: publishedMeeting }).update({ published_at: null });
      resetDisputeRateLimits();
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "agenda_items", target_id: publishedItem, ...BODY })
        .expect(404);
      await db("meetings").where({ id: publishedMeeting }).update({ published_at: new Date() });
    });

    it("refuses a table that is not disputable", async () => {
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "operators", target_id: publishedMeeting, ...BODY })
        .expect(400);
    });

    it("refuses a blank or oversize field rather than storing it", async () => {
      await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY, account: "   " })
        .expect(400);

      resetDisputeRateLimits();
      await request(app)
        .post("/api/corrections/disputes")
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          ...BODY,
          account: "x".repeat(4001),
        })
        .expect(400);

      assert.equal(await db("record_disputes").where({ contact: CONTACT }).first(), undefined);
    });

    it("caps one client, and says when to come back", async () => {
      for (let n = 0; n < RATE_LIMITS.perClientPerHour; n += 1) {
        await request(app)
          .post("/api/corrections/disputes")
          .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
          .expect(201);
      }

      const refused = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(429);

      assert.ok(Number(refused.headers["retry-after"]) > 0);
      const body = refused.body as ErrorBody;
      // The message must not confirm anything about this record's disputes.
      assert.ok(!/this record/i.test(body.error));
    });

    it("caps the number of undecided disputes on one record", async () => {
      // Filed under this suite's contact so teardown still finds them; the cap
      // counts by target, not by submitter, which is what makes it a defence
      // against a distributed brigade rather than against one client.
      for (let n = 0; n < RATE_LIMITS.perTargetOpen; n += 1) {
        await db("record_disputes").insert({
          reference: generateReference(),
          target_table: "meetings",
          target_id: publishedMeeting,
          contested: BODY.contested,
          account: BODY.account,
          contact: CONTACT,
        });
      }

      const refused = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(429);
      assert.match((refused.body as ErrorBody).error, /capacity/);
    });
  });

  /* --------------------------------------------------------- the operator */

  describe("the operator surface", () => {
    async function fileOne(): Promise<{ reference: string; id: string }> {
      resetDisputeRateLimits();
      const res = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);
      const { reference } = res.body as Receipt;
      const row = await db("record_disputes")
        .where({ reference })
        .first<{ id: string } | undefined>();
      assert.ok(row);
      return { reference, id: row.id };
    }

    it("is closed without a session", async () => {
      await request(app).get("/api/admin/review/disputes").expect(401);
    });

    it("lists disputes separately from the findings queue, and describes the record", async () => {
      const { reference } = await fileOne();

      const res = await request(app)
        .get("/api/admin/review/disputes?status=received")
        .set("Cookie", cookie)
        .expect(200);
      const body = res.body as DisputeListBody;
      const found = body.data.find((item) => item.dispute.reference === reference);
      assert.ok(found, "the dispute is not in the operator listing");
      assert.equal(found.dispute.status, "received");
      assert.match(found.context.record_summary, /^Meeting · /);
      assert.equal(found.context.meeting_id, publishedMeeting);
      assert.ok(body.counts.received >= 1);

      // And it is not in the findings queue: the two are different objects.
      const queue = await request(app)
        .get("/api/admin/review/queue")
        .set("Cookie", cookie)
        .expect(200);
      assert.ok(!JSON.stringify(queue.body).includes(reference));
    });

    it("refuses a decision with no reason", async () => {
      const { id } = await fileOne();
      await request(app)
        .post(`/api/admin/review/disputes/${id}/uphold`)
        .set("Cookie", cookie)
        .send({ reason: "  " })
        .expect(400);
    });

    it("refuses a decision that asserts motive", async () => {
      const { id } = await fileOne();
      const res = await request(app)
        .post(`/api/admin/review/disputes/${id}/decline`)
        .set("Cookie", cookie)
        .send({ reason: "The complainant is acting in bad faith." })
        .expect(400);
      assert.match((res.body as ErrorBody).error, /never the motive/);
    });

    it("upholds a dispute and changes no record", async () => {
      const { id } = await fileOne();
      const before = await db("meetings").where({ id: publishedMeeting }).first();

      const res = await request(app)
        .post(`/api/admin/review/disputes/${id}/uphold`)
        .set("Cookie", cookie)
        .send({ reason: "The agenda for that date names the annexe." })
        .expect(200);
      assert.equal((res.body as DisputeItem).dispute.status, "upheld");

      const after = await db("meetings").where({ id: publishedMeeting }).first();
      assert.deepEqual(after, before, "upholding a dispute altered the record");
    });

    it("records the decision in the same log as the arrival", async () => {
      const { id } = await fileOne();
      await request(app)
        .post(`/api/admin/review/disputes/${id}/decline`)
        .set("Cookie", cookie)
        .send({ reason: "The minutes and the agenda both name the main chamber." })
        .expect(200);

      const trail = await db("record_corrections")
        .where({ target_table: "record_disputes", target_id: id })
        .orderBy("created_at", "asc")
        .select<Array<{ new_value: string | null; operator_email: string | null }>>("*");
      assert.equal(trail.length, 2);
      assert.equal(trail[0].new_value, "received");
      assert.equal(trail[0].operator_email, null);
      assert.equal(trail[1].new_value, "declined");
      assert.equal(trail[1].operator_email, OPERATOR_EMAIL);
    });

    it("refuses a second decision on the same dispute", async () => {
      const { id } = await fileOne();
      await request(app)
        .post(`/api/admin/review/disputes/${id}/uphold`)
        .set("Cookie", cookie)
        .send({ reason: "The agenda names the annexe." })
        .expect(200);
      await request(app)
        .post(`/api/admin/review/disputes/${id}/decline`)
        .set("Cookie", cookie)
        .send({ reason: "Changed my mind." })
        .expect(409);
    });

    it("404s an unknown dispute and 400s a malformed id", async () => {
      await request(app)
        .get("/api/admin/review/disputes/00000000-0000-4000-8000-000000000000")
        .set("Cookie", cookie)
        .expect(404);
      await request(app).get("/api/admin/review/disputes/nope").set("Cookie", cookie).expect(400);
    });
  });

  /* --------------------------------------- the join, end to end */

  /**
   * `record_corrections.dispute_id` has existed since migration 039 and the
   * public log has been rendering *"Prompted by dispute CW-…"* off it, but no
   * operator screen set it — so an operator who upheld a dispute and then
   * corrected the record produced two rows nothing joined, and the trail the
   * feature was designed around silently did not connect. This suite walks the
   * whole of it: filed, upheld, corrected, published.
   */
  describe("a dispute and the correction it produced", () => {
    async function fileAndUphold(): Promise<{ id: string; reference: string }> {
      resetDisputeRateLimits();
      const filed = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);
      const { reference } = filed.body as Receipt;
      const row = await db("record_disputes")
        .where({ reference })
        .first<{ id: string } | undefined>();
      assert.ok(row);

      await request(app)
        .post(`/api/admin/review/disputes/${row.id}/uphold`)
        .set("Cookie", cookie)
        .send({ reason: "The agenda for that date names the annexe." })
        .expect(200);

      return { id: row.id, reference };
    }

    it("carries the dispute onto the correction, and the public log shows the link", async () => {
      const { id, reference } = await fileAndUphold();

      const corrected = await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "The annexe",
          reason: "The agenda published for that date records the annexe.",
          dispute_id: id,
        })
        .expect(201);
      const correction = corrected.body as { id: string; dispute_id: string | null };
      assert.equal(correction.dispute_id, id);

      // The record itself changed — the correction is the act that changes it,
      // and upholding was not.
      const meeting = await db("meetings")
        .where({ id: publishedMeeting })
        .first<{ location: string } | undefined>();
      assert.equal(meeting?.location, "The annexe");

      // And the two are joined where a reader can see it.
      const log = await request(app).get("/api/corrections?limit=200").expect(200);
      const entry = (log.body as { data: PublicCorrection[] }).data.find(
        (row) => row.id === correction.id,
      );
      assert.ok(entry, "the correction is not on the public corrections log");
      assert.equal(entry.dispute_reference, reference);
      assert.equal(entry.new_value, "The annexe");
      // The reference travels; nothing the contester wrote does.
      assert.ok(!JSON.stringify(entry).includes(BODY.account));

      await db("meetings").where({ id: publishedMeeting }).update({ location: "City Hall" });
    });

    it("refuses a dispute that does not exist, rather than silently ignoring it", async () => {
      const before = await db("meetings").where({ id: publishedMeeting }).first();

      const res = await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "The annexe",
          reason: "The agenda published for that date records the annexe.",
          dispute_id: "00000000-0000-4000-8000-000000000000",
        })
        .expect(404);
      assert.match((res.body as ErrorBody).error, /No dispute with that id/);

      // Refused means refused: the record is untouched and nothing was logged.
      assert.deepEqual(await db("meetings").where({ id: publishedMeeting }).first(), before);
      const logged = await db("record_corrections")
        .where({ dispute_id: "00000000-0000-4000-8000-000000000000" })
        .first();
      assert.equal(logged, undefined);
    });

    it("refuses a declined dispute, because declining says the record stands", async () => {
      resetDisputeRateLimits();
      const filed = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);
      const { reference } = filed.body as Receipt;
      const row = await db("record_disputes")
        .where({ reference })
        .first<{ id: string } | undefined>();
      assert.ok(row);
      await request(app)
        .post(`/api/admin/review/disputes/${row.id}/decline`)
        .set("Cookie", cookie)
        .send({ reason: "The agenda and the minutes both record the main chamber." })
        .expect(200);

      const res = await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "The annexe",
          reason: "The agenda published for that date records the annexe.",
          dispute_id: row.id,
        })
        .expect(409);
      assert.match((res.body as ErrorBody).error, /declined/);
    });

    it("refuses a malformed dispute id", async () => {
      await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "The annexe",
          reason: "The agenda published for that date records the annexe.",
          dispute_id: "CW-ABCD1234",
        })
        .expect(400);
    });

    it("still records an unlinked correction, so the column stays optional", async () => {
      const res = await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "City Hall annexe",
          reason: "The agenda published for that date records the annexe.",
        })
        .expect(201);
      assert.equal((res.body as { dispute_id: string | null }).dispute_id, null);
      await db("meetings").where({ id: publishedMeeting }).update({ location: "City Hall" });
    });

    it("maps the motive scan to a 400, on the linked path as much as the plain one", async () => {
      // `appendCorrectionRow` motive-scans every reason, so a caller that does
      // not map `CorrectionError` surfaces a 400 as a 500.
      const { id } = await fileAndUphold();
      const res = await request(app)
        .post("/api/admin/pressroom/corrections")
        .set("Cookie", cookie)
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          field: "location",
          new_value: "The annexe",
          reason: "The clerk concealed the venue to keep people away.",
          dispute_id: id,
        })
        .expect(400);
      assert.match((res.body as ErrorBody).error, /never the motive/);
    });
  });

  /* ------------------------------------------------------- nothing leaks */

  describe("nothing a contester writes reaches the public site", () => {
    it("keeps the account text off the public corrections log", async () => {
      resetDisputeRateLimits();
      const secret = "UNIQUE-CONTESTER-SENTENCE-9f2c";
      await request(app)
        .post("/api/corrections/disputes")
        .send({
          target_table: "meetings",
          target_id: publishedMeeting,
          ...BODY,
          account: secret,
        })
        .expect(201);

      const res = await request(app).get("/api/corrections?limit=200").expect(200);
      assert.ok(
        !JSON.stringify(res.body).includes(secret),
        "a contester's account text reached the public corrections log",
      );
      const body = res.body as { data: PublicCorrection[] };
      for (const entry of body.data) {
        assert.notEqual(entry.record_kind.toString(), "dispute");
      }
    });

    it("offers no public route that reads a dispute", async () => {
      resetDisputeRateLimits();
      const res = await request(app)
        .post("/api/corrections/disputes")
        .send({ target_table: "meetings", target_id: publishedMeeting, ...BODY })
        .expect(201);
      const { reference } = res.body as Receipt;
      const row = await db("record_disputes")
        .where({ reference })
        .first<{ id: string } | undefined>();
      assert.ok(row);

      // The reference is the submitter's handle on their own dispute, not a
      // read token: there is nowhere to redeem it without a session.
      await request(app).get(`/api/corrections/disputes/${row.id}`).expect(404);
      await request(app).get(`/api/admin/review/disputes/${row.id}`).expect(401);
    });
  });
});

/* --------------------------------------------------------------- the limiter */

describe("the fixed-window limiter", () => {
  it("permits up to the limit and then refuses with a wait", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1000 });
    const start = new Date(0);
    assert.equal(limiter.check("a", start).allowed, true);
    assert.equal(limiter.check("a", start).allowed, true);

    const refused = limiter.check("a", start);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSeconds, 1);
  });

  it("does not extend the window on a refusal", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
    assert.equal(limiter.check("a", new Date(0)).allowed, true);
    // Refused at 500ms; a client that retries must still be let in at 1000ms.
    assert.equal(limiter.check("a", new Date(500)).allowed, false);
    assert.equal(limiter.check("a", new Date(1000)).allowed, true);
  });

  it("counts each key separately", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
    assert.equal(limiter.check("a", new Date(0)).allowed, true);
    assert.equal(limiter.check("b", new Date(0)).allowed, true);
    assert.equal(limiter.check("a", new Date(0)).allowed, false);
  });

  it("stays bounded when the key is attacker-controlled", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 8 });
    for (let n = 0; n < 500; n += 1) limiter.check(`key-${n}`, new Date(0));
    assert.ok(limiter.size <= 8, `limiter grew to ${limiter.size} keys`);
  });

  it("drops expired windows rather than accumulating them", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
    for (let n = 0; n < 50; n += 1) limiter.check(`key-${n}`, new Date(0));
    assert.equal(limiter.size, 50);
    limiter.check("later", new Date(2000));
    assert.equal(limiter.size, 1);
  });
});

describe("the dispute reference", () => {
  it("avoids the glyphs that are read wrong down a phone line", () => {
    for (let n = 0; n < 200; n += 1) {
      const reference = generateReference();
      assert.match(reference, /^CW-[0-9A-HJKMNP-TV-Z]{8}$/);
      assert.ok(!/[ILOU]/.test(reference.slice(3)));
    }
  });

  it("is not a sequence, so one reference reveals nothing about another", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 500; n += 1) seen.add(generateReference());
    assert.ok(seen.size > 490, "references collided far more than chance allows");
  });
});
