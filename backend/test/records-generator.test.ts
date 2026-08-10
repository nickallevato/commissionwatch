import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import db from "../src/config/database";
import {
  findRecordsLaw,
  generateOperatorRequest,
  generatePublicLetter,
  listJurisdictionLaw,
  normaliseRequester,
  RecordsLawMissingError,
} from "../src/services/records/generator";
import { RecordsError } from "../src/services/records/requests";
import { cleanupByPrefix, createMeeting, createSource } from "./helpers/pressroom";

/**
 * P7 · the generator.
 *
 * The two assertions this file exists for:
 *
 * **It refuses without a law row.** A jurisdiction with no
 * `jurisdiction_records_law` entry produces an error naming the table, the
 * jurisdiction and the columns a person must supply — and produces no letter,
 * no fallback citation and no `records_requests` row. The table ships empty, so
 * this is the state every jurisdiction is in right now; the refusal is the
 * feature working, not the feature missing.
 *
 * **It sends nothing.** Twice over: by reading the source of every file on the
 * P7 path and asserting none of them can reach the delivery layer, and by
 * counting `deliveries` and `notifications` either side of a generation on both
 * surfaces.
 */

const PREFIX = "records-generator-test";
const TODAY = "2026-08-10";

const REQUESTER = { name: "A. Requester", email: "requester@example.invalid" };

const CREATED_REQUESTS: string[] = [];

async function outboundCounts(): Promise<{ deliveries: number; notifications: number }> {
  const [deliveries] = await db("deliveries").count<Array<{ count: string }>>("* as count");
  const [notifications] = await db("notifications").count<Array<{ count: string }>>("* as count");
  return { deliveries: Number(deliveries.count), notifications: Number(notifications.count) };
}

describe("the public-records request generator", () => {
  /** With a law row. */
  let lawful = { jurisdictionId: "", commissionId: "" };
  /** Without one — the state every real jurisdiction is in today. */
  let unlawful = { jurisdictionId: "", commissionId: "" };
  let lawfulGapId = "";
  let unlawfulGapId = "";

  before(async () => {
    await cleanupByPrefix(PREFIX);

    const a = await createSource(`${PREFIX} lawful`, { enabled: true });
    const b = await createSource(`${PREFIX} unlawful`, { enabled: true });
    lawful = { jurisdictionId: a.jurisdictionId, commissionId: a.commissionId };
    unlawful = { jurisdictionId: b.jurisdictionId, commissionId: b.commissionId };

    // A fictional statute, invented for this suite. It must not be a real
    // citation: a fixture that looked like law is how a wrong figure would get
    // copied out of a test and into production.
    await db("jurisdiction_records_law").insert({
      jurisdiction_id: lawful.jurisdictionId,
      statute_citation: "Example Code Ann. § 0-0-0000",
      statute_url: "https://example.invalid/statute",
      acknowledge_days: 7,
      respond_days: 30,
      custodian_name: "Example Clerk",
      custodian_email: "clerk@example.invalid",
      custodian_address: "1 Example Street",
      verified_on: "2026-08-01",
    });

    lawfulGapId = `missing_minutes:${await createMeeting(lawful.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    })}`;
    unlawfulGapId = `missing_minutes:${await createMeeting(unlawful.commissionId, {
      publishedAt: new Date(),
      date: "2026-08-04",
    })}`;
  });

  after(async () => {
    if (CREATED_REQUESTS.length > 0) {
      await db("records_requests").whereIn("id", CREATED_REQUESTS).del();
    }
    await cleanupByPrefix(PREFIX);
    await db.destroy();
  });

  describe("the refusal", () => {
    it("refuses to draft for a jurisdiction with no records law, and names what is missing", async () => {
      await assert.rejects(
        () =>
          generateOperatorRequest(db, {
            gapId: unlawfulGapId,
            requester: REQUESTER,
            today: TODAY,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RecordsLawMissingError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.jurisdictionId, unlawful.jurisdictionId);

          // The message must be actionable: the table, the row that is absent,
          // and the columns a person has to fill in.
          assert.match(err.message, /jurisdiction_records_law/);
          assert.ok(err.message.includes(unlawful.jurisdictionId));
          for (const column of ["statute_citation", "statute_url", "verified_on"]) {
            assert.ok(err.message.includes(column), `the refusal names ${column}`);
            assert.ok(err.missing.includes(column));
          }
          // And it must say why there is no fallback, so the next person does
          // not helpfully add one.
          assert.match(err.message, /local governments/);
          assert.match(err.message, /worse than no letter/);
          return true;
        },
      );
    });

    it("writes no records_requests row when it refuses", async () => {
      const [before] = await db("records_requests").count<Array<{ count: string }>>("* as count");
      await assert.rejects(() =>
        generateOperatorRequest(db, { gapId: unlawfulGapId, requester: REQUESTER, today: TODAY }),
      );
      const [after] = await db("records_requests").count<Array<{ count: string }>>("* as count");
      assert.equal(after.count, before.count, "a refusal persisted something");
    });

    it("refuses on the public surface too, with the same error", async () => {
      await assert.rejects(
        () => generatePublicLetter(db, { gapId: unlawfulGapId, requester: REQUESTER, today: TODAY }),
        RecordsLawMissingError,
      );
    });

    it("refuses a gap that does not exist without saying which kind of not-exist it is", async () => {
      await assert.rejects(
        () =>
          generatePublicLetter(db, {
            gapId: "missing_minutes:99999999-9999-9999-9999-999999999999",
            requester: REQUESTER,
            today: TODAY,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RecordsError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.message, "No such gap in the record");
          return true;
        },
      );
    });
  });

  describe("drafting", () => {
    it("produces a letter and a draft row, and never a submitted one", async () => {
      const generated = await generateOperatorRequest(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(generated.request);
      CREATED_REQUESTS.push(generated.request.id);

      assert.equal(generated.request.status, "draft");
      assert.equal(generated.request.submitted_at, null);
      assert.equal(generated.request.responded_at, null);
      assert.equal(generated.request.jurisdiction_id, lawful.jurisdictionId);
      // The text is durable. A draft whose letter lives only in a browser tab
      // is a preview, not a draft.
      assert.equal(generated.request.notes, generated.letter);
      assert.match(generated.request.subject, /^Public records request — /);
    });

    it("sets response_due_at from the jurisdiction's own period, not from a guess", async () => {
      const generated = await generateOperatorRequest(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(generated.request);
      CREATED_REQUESTS.push(generated.request.id);

      const due = generated.request.response_due_at;
      assert.ok(due instanceof Date);
      assert.equal(due.toISOString().slice(0, 10), "2026-09-09"); // 2026-08-10 + 30
    });

    it("leaves response_due_at null when no period is established for the jurisdiction", async () => {
      await db("jurisdiction_records_law")
        .where({ jurisdiction_id: lawful.jurisdictionId })
        .update({ respond_days: null });

      const generated = await generateOperatorRequest(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(generated.request);
      CREATED_REQUESTS.push(generated.request.id);
      assert.equal(generated.request.response_due_at, null);

      await db("jurisdiction_records_law")
        .where({ jurisdiction_id: lawful.jurisdictionId })
        .update({ respond_days: 30 });
    });

    it("produces identical text on the public surface, and writes nothing there", async () => {
      const [countBefore] = await db("records_requests").count<Array<{ count: string }>>("* as count");

      const publicLetter = await generatePublicLetter(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      const operatorLetter = await generateOperatorRequest(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(operatorLetter.request);
      CREATED_REQUESTS.push(operatorLetter.request.id);

      // String equality, not similarity. "The same generator" is a claim that
      // decays the moment the two surfaces have separate code paths.
      assert.equal(publicLetter.letter, operatorLetter.letter);
      assert.equal(publicLetter.request, null);

      const [countAfter] = await db("records_requests").count<Array<{ count: string }>>("* as count");
      // Exactly one row: the operator's. The public call added none.
      assert.equal(Number(countAfter.count), Number(countBefore.count) + 1);
    });
  });

  describe("nothing is transmitted", () => {
    it("cannot reach the delivery layer from any file on the P7 path", () => {
      const files = [
        join(__dirname, "..", "src", "services", "records", "generator.ts"),
        join(__dirname, "..", "src", "services", "records", "gaps.ts"),
        join(__dirname, "..", "src", "services", "records", "letter.ts"),
        join(__dirname, "..", "src", "routes", "public-records.ts"),
      ];

      const forbidden = [
        /from ["'].*services\/delivery/,
        /from ["'].*email-delivery/,
        /from ["'].*services\/notification/,
        /from ["']resend["']/,
        /require\(["'].*delivery/,
      ];

      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
          assert.ok(
            !pattern.test(source),
            `${file} can reach the delivery layer (${String(pattern)}). ` +
              "The application must not transmit legal correspondence on anyone's behalf.",
          );
        }
      }
    });

    it("queues nothing on either surface", async () => {
      const before = await outboundCounts();

      await generatePublicLetter(db, { gapId: lawfulGapId, requester: REQUESTER, today: TODAY });
      const generated = await generateOperatorRequest(db, {
        gapId: lawfulGapId,
        requester: REQUESTER,
        today: TODAY,
      });
      assert.ok(generated.request);
      CREATED_REQUESTS.push(generated.request.id);

      const after = await outboundCounts();
      assert.deepEqual(after, before, "generating a letter produced an outbound row");
    });
  });

  describe("the records law surface", () => {
    it("lists a jurisdiction with no row, loudly, rather than omitting it", async () => {
      const rows = await listJurisdictionLaw(db, TODAY);
      const missing = rows.find((row) => row.jurisdiction_id === unlawful.jurisdictionId);
      assert.ok(missing);
      assert.equal(missing.law, null);
      assert.equal(missing.verification_age_days, null);
      assert.match(missing.advisory, /No row in jurisdiction_records_law/);
      assert.match(missing.advisory, /local governments/);
    });

    it("marks a verification older than a year stale, and a fresh one not", async () => {
      const fresh = (await listJurisdictionLaw(db, TODAY)).find(
        (row) => row.jurisdiction_id === lawful.jurisdictionId,
      );
      assert.ok(fresh);
      assert.equal(fresh.stale, false);
      assert.equal(fresh.verification_age_days, 9);
      assert.equal(fresh.law?.verified_on, "2026-08-01");

      await db("jurisdiction_records_law")
        .where({ jurisdiction_id: lawful.jurisdictionId })
        .update({ verified_on: "2024-01-01" });

      const stale = (await listJurisdictionLaw(db, TODAY)).find(
        (row) => row.jurisdiction_id === lawful.jurisdictionId,
      );
      assert.ok(stale);
      assert.equal(stale.stale, true);
      assert.match(stale.advisory, /Temporary/);

      await db("jurisdiction_records_law")
        .where({ jurisdiction_id: lawful.jurisdictionId })
        .update({ verified_on: "2026-08-01" });
    });

    it("reads verified_on as a calendar day, not an instant", async () => {
      const law = await findRecordsLaw(db, lawful.jurisdictionId);
      assert.ok(law);
      assert.equal(law.verified_on, "2026-08-01");
      assert.equal(typeof law.verified_on, "string");
    });

    it("has no row for any jurisdiction it was not given one for", async () => {
      assert.equal(await findRecordsLaw(db, unlawful.jurisdictionId), null);
    });
  });

  describe("the requester block", () => {
    it("requires a name and a usable email", () => {
      assert.throws(() => normaliseRequester({}), /requester name is required/);
      assert.throws(() => normaliseRequester({ name: "  " }), /requester name is required/);
      assert.throws(() => normaliseRequester({ name: "A" }), /email address is required/);
      assert.throws(() => normaliseRequester({ name: "A", email: "nope" }), /not a usable email/);
    });

    it("keeps the optional fields it is given and drops the ones it is not", () => {
      const requester = normaliseRequester({
        name: "  A. Requester ",
        email: " requester@example.invalid ",
        organization: "",
        address: "1 Example Street",
      });
      assert.deepEqual(requester, {
        name: "A. Requester",
        email: "requester@example.invalid",
        organization: null,
        address: "1 Example Street",
        phone: null,
      });
    });
  });
});
