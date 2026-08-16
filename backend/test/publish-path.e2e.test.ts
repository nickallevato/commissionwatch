import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key, for `events.test.ts`'s
// reason: the event spine pulls in the dispatcher's types and config.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
  signInOperator,
} from "./helpers/pressroom";

/**
 * Roadmap 6.9 · the full publish path, over HTTP, end to end.
 *
 * `claims-review.test.ts`, `review-queue.test.ts` and `pressroom-bulk-publish.test.ts`
 * each prove one link in the chain the maturity review named — sign-in, review,
 * approve, the public wall — correct in isolation. None of them walks the chain
 * in order, through HTTP, as one reader-visible story: a candidate claim, held
 * for review; invisible everywhere public; an operator who signs in, finds it
 * in the queue, and approves it; visible only from that moment; and then
 * retracted, and gone again. A join between two individually-correct links can
 * still be broken, and this chain's last link is a named person's sentence on a
 * public page — the highest-consequence path in the product.
 *
 * One seam is deliberately not driven over HTTP: the held claim itself.
 * Extraction is a queue-driven pipeline (`services/extraction/`) with its own
 * contract suite; reaching it from here would mean re-running ingestion just to
 * get a `minute_claims` row to review, which is what `claims-review.test.ts`
 * already declines to do. So this suite seeds one `held` claim directly, the
 * same way that suite's `createClaim` does, and everything downstream —
 * sign-in, the queue, approval, the wall, retraction — goes through the real
 * HTTP routes against the real database.
 *
 * Three public surfaces are checked on both sides of the wall:
 *
 *  - `GET /api/meetings/:id/claims` — the one surface built to show a claim.
 *  - `GET /api/search` — built to show six other kinds of record. It has no
 *    `claim` result kind at all (`services/search.ts` lists them), so a claim
 *    can never appear there whatever its status. That is asserted here too,
 *    not skipped, because a `claim` kind added later without a publication
 *    predicate is exactly the leak this suite exists to catch on arrival.
 *  - `GET /api/data/claims.json` — the bulk export, which hands over a whole
 *    table with no id required to reach it, per `data-export.test.ts`.
 *
 * Both `/api/meetings/:id/claims` and the export are built on the same
 * `whereClaimPublic` predicate (`services/publication.ts`), so both are the
 * mutation target that matters: break that predicate and both surfaces leak
 * together, which is exactly what a join failure at the wall would look like.
 */

const PREFIX = "publish-path-e2e";
const EMAIL = `${PREFIX}@example.invalid`;
const SUBJECT_NAME = "Commissioner Pathwalk";
const QUOTE = "Commissioner Pathwalk voted no on the motion to adopt Ordinance 3311.";
const DOCUMENT_TEXT = [
  "MINUTES OF THE REGULAR MEETING",
  "The meeting was called to order at 6:00 p.m.",
  QUOTE,
  "There being no further business, the meeting adjourned at 8:00 p.m.",
].join("\n");
const QUOTE_OFFSET = DOCUMENT_TEXT.indexOf(QUOTE);

// Content-addressed, so it is stable across runs — which is exactly why it has
// to be cleared before use rather than only after: an artifact is not scoped to
// `PREFIX`, so a run that dies before reaching `after()` leaves this exact row
// behind, and the next run's insert fails on the unique constraint with a
// message that points at the symptom rather than the leftover row.
const ARTIFACT_SHA = sha256Of(`${PREFIX}-minutes`);

interface Fixture {
  jurisdictionId: string;
  meetingId: string;
}

let fixture: Fixture | undefined;
let claimId = "";

async function createHeldClaim(meetingId: string): Promise<string> {
  const [row] = await db("minute_claims")
    .insert({
      meeting_id: meetingId,
      artifact_sha256: ARTIFACT_SHA,
      subject_name: SUBJECT_NAME,
      action: "voted_no",
      matter: "Ordinance 3311, second reading",
      quote: QUOTE,
      quote_offset: QUOTE_OFFSET,
      model: "test-model",
      prompt_version: "publish-path-e2e-v1",
      status: "held",
    })
    .returning<Array<{ id: string }>>("id");
  return row.id;
}

function requireFixture(): Fixture {
  if (fixture === undefined) throw new Error("fixture was never built");
  return fixture;
}

async function meetingClaims(): Promise<{
  claims: Array<{ id: string; text: string }>;
  tombstones: Array<{ id: string; previous_text: string | null }>;
}> {
  const res = await request(app)
    .get(`/api/meetings/${requireFixture().meetingId}/claims`)
    .expect(200);
  return res.body;
}

async function searchFor(term: string): Promise<Array<Record<string, unknown>>> {
  const res = await request(app).get("/api/search").query({ q: term }).expect(200);
  return res.body.data;
}

async function exportedClaims(): Promise<Array<Record<string, unknown>>> {
  const res = await request(app).get("/api/data/claims.json").expect(200);
  const body = JSON.parse(res.text) as { rows: Array<Record<string, unknown>> };
  return body.rows;
}

/**
 * Everything below is torn down in `after()`, but `after()` only runs if
 * `before()` finishes — a hook that throws skips its own `after`. So `before`
 * clears its own fixed-identity rows on the way *in*, not only on the way out,
 * on the assumption the previous run of this suite may have died mid-flight:
 * a killed process, a CI cancel, an earlier assertion failure that predates
 * this file's current cleanup. `PREFIX`-scoped rows are already covered —
 * `cleanupByPrefix` matches by name and finds nothing for a prefix nobody used
 * yet — but `ARTIFACT_SHA` is content-addressed and stable across runs, so a
 * leftover row from a dead run collides on `artifacts_sha256_unique` and the
 * failure reported is that constraint, not the real cause. Clearing it here
 * first makes a second run after a crash behave like a first run.
 */
before(async () => {
  await cleanupByPrefix(PREFIX);
  await db("operators").where({ email: EMAIL }).del();
  await deleteArtifacts([ARTIFACT_SHA]);

  const source = await createSource(PREFIX);
  const meetingId = await createMeeting(source.commissionId, { publishedAt: new Date() });
  const artifactId = await createArtifact(ARTIFACT_SHA, "https://example.invalid/publish-path.pdf");
  await db("artifact_texts").insert({
    artifact_id: artifactId,
    text: DOCUMENT_TEXT,
    char_count: DOCUMENT_TEXT.length,
  });

  fixture = { jurisdictionId: source.jurisdictionId, meetingId };
  claimId = await createHeldClaim(meetingId);
});

/**
 * Deliberately reads nothing off `fixture`. If `before()` throws partway —
 * exactly the crash this suite must survive, since it is what leaves a stray
 * row for the next run — `fixture` may never be assigned, and `after()` still
 * has to run to completion so the pool gets destroyed. A hook that dereferences
 * `fixture.meetingId` here would itself throw, and the effect of *that* is not
 * a second reported failure: `node:test` never reaches `db.destroy()`, the
 * process holds its database connection open, and the run has to be killed
 * from outside rather than exiting non-zero on its own. `claimId`, `PREFIX`,
 * `EMAIL` and `ARTIFACT_SHA` are all known independent of how far `before()`
 * got, which is why cleanup keys on those instead.
 */
after(async () => {
  try {
    if (claimId !== "") {
      const events = await db("events")
        .where({ subject_id: claimId })
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
    }
    // `cleanupByPrefix` deletes the meeting, which cascades `minute_claims`
    // (migration 072: `onDelete('CASCADE')`), so the claim row needs no
    // separate delete.
    await cleanupByPrefix(PREFIX);
    // Cascades `artifact_texts` (migration 035: `onDelete("CASCADE")`).
    await deleteArtifacts([ARTIFACT_SHA]);
    await db("operators").where({ email: EMAIL }).del();
  } finally {
    await db.destroy();
  }
});

describe("the publish path, end to end", () => {
  it("holds the claim off every public surface before review", async () => {
    const meeting = await meetingClaims();
    assert.equal(
      meeting.claims.some((claim) => claim.id === claimId),
      false,
      "the meeting claims surface showed an unapproved claim",
    );

    const results = await searchFor("Pathwalk");
    assert.equal(
      results.length,
      0,
      "search returned a result for an unapproved claim's subject",
    );

    const exported = await exportedClaims();
    assert.equal(
      exported.some((row) => row.id === claimId),
      false,
      "the bulk export shipped an unapproved claim",
    );
  });

  it("signs the operator in and shows the claim in their queue", async () => {
    const cookie = await signInOperator(EMAIL, "Publish Path Operator");

    const queue = await request(app)
      .get("/api/admin/claims/queue")
      .query({ status: "held", meeting_id: requireFixture().meetingId })
      .set("Cookie", cookie)
      .expect(200);
    assert.ok(
      queue.body.data.some((item: { claim: { id: string } }) => item.claim.id === claimId),
      "the review queue did not surface the held claim",
    );

    const approval = await request(app)
      .post(`/api/admin/claims/${claimId}/approve`)
      .set("Cookie", cookie)
      .send({ reason: "Checked against the stored minutes for the publish-path chain." })
      .expect(200);
    assert.equal(approval.body.claim.status, "approved");
    const renderedText = approval.body.claim.rendered_text as string;
    assert.ok(renderedText, "approval produced no rendered text");

    // Only now does it appear on the surfaces the wall test above found empty.
    const meeting = await meetingClaims();
    const shown = meeting.claims.find((claim) => claim.id === claimId);
    assert.ok(shown, "the approved claim never reached the meeting claims surface");
    assert.equal(shown?.text, renderedText, "the meeting page rendered different bytes than approval did");

    const exported = await exportedClaims();
    const exportedRow = exported.find((row) => row.id === claimId);
    assert.ok(exportedRow, "the approved claim never reached the bulk export");
    assert.equal(exportedRow?.rendered_text, renderedText);

    // Search still shows nothing — not because the wall opened for it, but
    // because search has no `claim` kind to leak through. Asserted so a
    // `claim` kind added later without a publication predicate fails here.
    assert.equal((await searchFor("Pathwalk")).length, 0);

    const retraction = await request(app)
      .post(`/api/admin/claims/${claimId}/retract`)
      .set("Cookie", cookie)
      .send({ reason: "Withdrawing for the publish-path chain's retraction step." })
      .expect(200);
    assert.ok(retraction.body.claim.retracted_at, "retraction did not record a timestamp");

    // And it disappears from both surfaces again.
    const afterRetraction = await meetingClaims();
    assert.equal(
      afterRetraction.claims.some((claim) => claim.id === claimId),
      false,
      "the meeting claims surface still showed a retracted claim",
    );
    const tombstone = afterRetraction.tombstones.find((entry) => entry.id === claimId);
    assert.ok(tombstone, "retraction left no tombstone at the claim's anchor");
    assert.equal(tombstone?.previous_text, renderedText);

    const exportedAfterRetraction = await exportedClaims();
    assert.equal(
      exportedAfterRetraction.some((row) => row.id === claimId),
      false,
      "the bulk export still shipped a retracted claim",
    );
  });
});
