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
import { CLAIM_ACTIONS } from "../src/services/extraction/verify";
import * as claimsModule from "../src/services/review/claims";
import {
  ACTION_LABEL,
  RENDER_VERSION,
  approveClaim,
  getClaimReview,
  listClaimQueue,
  listPublicClaims,
  rejectClaim,
  renderApprovedClaim,
  renderClaim,
  renderSha256,
  retractClaim,
} from "../src/services/review/claims";
import { findPublicClaim, whereClaimPublic } from "../src/services/publication";
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
 * The claims review path.
 *
 * `minute_claims` shipped in migration 072 with a `status` nothing wrote, so
 * every extracted claim sat `held` forever and the extraction pipeline produced
 * nothing publishable. These tests hold the properties that make the path that
 * changed it safe to have built:
 *
 *  - the operator approves **exact bytes**, and if this build would render
 *    different bytes the claim does not render at all and does not fall back;
 *  - `ACTION_LABEL` covers exactly the actions the database permits, so adding a
 *    ninth action fails here rather than reaching a reader unworded;
 *  - the wall has three predicates and each is asserted separately, because a
 *    held claim, a rejected claim, a retracted claim and a claim on a withheld
 *    meeting are four different ways to be invisible;
 *  - a decision writes the claim, one audit row and one event, or none of them;
 *  - there is no bulk approve, asserted structurally.
 *
 * `record_corrections` is never cleaned up — migration 031 forbids DELETE, which
 * is the property it exists to prove — so every assertion here counts rows for a
 * target id this suite generated.
 */

const PREFIX = "claims-review-test";

/** The artifact text the citations index into. */
const QUOTE_ONE = "Commissioner Sample voted no on the motion to adopt Ordinance 2145.";
const QUOTE_TWO = "Commissioner Fixture moved to table the item until the next meeting.";
const DOCUMENT_TEXT = [
  "MINUTES OF THE REGULAR MEETING",
  "The meeting was called to order at 6:00 p.m.",
  "A quorum was present.",
  QUOTE_ONE,
  "The motion carried on a vote of four to one.",
  QUOTE_TWO,
  "There being no further business, the meeting adjourned at 8:14 p.m.",
].join("\n");

const OFFSET_ONE = DOCUMENT_TEXT.indexOf(QUOTE_ONE);
const OFFSET_TWO = DOCUMENT_TEXT.indexOf(QUOTE_TWO);

interface Fixture {
  jurisdictionId: string;
  commissionId: string;
  publishedMeetingId: string;
  withheldMeetingId: string;
  artifactId: string;
  artifactSha: string;
  operatorId: string;
  cookie: string;
}

let fixture: Fixture;
const claimIds: string[] = [];
const extraMeetingIds: string[] = [];

interface ClaimOptions {
  meetingId?: string;
  subjectName?: string;
  action?: string;
  matter?: string | null;
  quote?: string;
  quoteOffset?: number;
  artifactSha256?: string;
}

let subjectCounter = 0;

async function createClaim(options: ClaimOptions = {}): Promise<string> {
  subjectCounter += 1;
  const [row] = await db("minute_claims")
    .insert({
      meeting_id: options.meetingId ?? fixture.publishedMeetingId,
      artifact_sha256: options.artifactSha256 ?? fixture.artifactSha,
      subject_name: options.subjectName ?? `Commissioner Sample ${subjectCounter}`,
      action: options.action ?? "voted_no",
      matter: options.matter === undefined ? "Ordinance 2145, second reading" : options.matter,
      quote: options.quote ?? QUOTE_ONE,
      quote_offset: options.quoteOffset ?? OFFSET_ONE,
      model: "test-model",
      prompt_version: "claims-test-v1",
      status: "held",
    })
    .returning<Array<{ id: string }>>("id");
  claimIds.push(row.id);
  return row.id;
}

function actor(): { id: string; email: string } {
  return { id: fixture.operatorId, email: `${PREFIX}@example.invalid` };
}

async function correctionsFor(claimId: string): Promise<Array<Record<string, unknown>>> {
  return db("record_corrections")
    .where({ target_table: "minute_claims", target_id: claimId })
    .orderBy("created_at", "asc")
    .select<Array<Record<string, unknown>>>("*");
}

async function eventsFor(subjectId: string): Promise<Array<Record<string, unknown>>> {
  return db("events")
    .where({ subject_id: subjectId })
    .select<Array<Record<string, unknown>>>("*");
}

before(async () => {
  const source = await createSource(PREFIX);
  const artifactSha = sha256Of(`${PREFIX}-minutes`);

  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
  });
  const withheldMeetingId = await createMeeting(source.commissionId, { publishedAt: null });
  const artifactId = await createArtifact(artifactSha, "https://example.invalid/minutes.pdf");
  await db("artifact_texts").insert({
    artifact_id: artifactId,
    text: DOCUMENT_TEXT,
    char_count: DOCUMENT_TEXT.length,
  });

  const email = `${PREFIX}@example.invalid`;
  const cookie = await signInOperator(email, "Claims Review Operator");
  const operator = await db("operators").where({ email }).first<{ id: string }>("id");
  assert.ok(operator, "the suite operator was not created");

  fixture = {
    jurisdictionId: source.jurisdictionId,
    commissionId: source.commissionId,
    publishedMeetingId,
    withheldMeetingId,
    artifactId,
    artifactSha,
    operatorId: operator.id,
    cookie,
  };
});

after(async () => {
  const subjectIds = [
    ...claimIds,
    ...extraMeetingIds,
    fixture.publishedMeetingId,
    fixture.withheldMeetingId,
  ];
  const events = await db("events")
    .whereIn("subject_id", subjectIds)
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

  await db("minute_claims").whereIn("id", claimIds).del();
  await db("artifact_texts").where({ artifact_id: fixture.artifactId }).del();
  await db("meetings").whereIn("id", extraMeetingIds).del();
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([fixture.artifactSha]);
  await db("operators").where({ email: `${PREFIX}@example.invalid` }).del();
  await db.destroy();
});

/* ------------------------------------------------------------------------- */

describe("the rendered sentence", () => {
  it("covers exactly the actions a claim may carry", () => {
    // Iterating the constant rather than listing eight strings again: adding a
    // ninth action to migration 072 must fail here until it has words.
    for (const action of CLAIM_ACTIONS) {
      const label = ACTION_LABEL[action];
      assert.equal(typeof label, "string", `${action} has no label`);
      assert.notEqual(label.trim(), "", `${action}'s label is empty`);
    }
    assert.deepEqual(Object.keys(ACTION_LABEL).sort(), [...CLAIM_ACTIONS].sort());
  });

  it("covers exactly the actions the database permits", async () => {
    // The label map is written against `verify.ts`'s copy of the list. The
    // database holds the real one, and a ninth value added there is exactly the
    // change this suite must refuse.
    const row = await db
      .raw(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'minute_claims_action_check'`,
      )
      .then((result: { rows: Array<{ def: string }> }) => result.rows[0]);
    assert.ok(row, "minute_claims_action_check is missing");
    const permitted = [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort();
    assert.deepEqual(Object.keys(ACTION_LABEL).sort(), permitted);
  });

  it("is a template fill, with the matter and without it", () => {
    assert.equal(
      renderClaim({ subject_name: "Avery Sample", action: "voted_no", matter: "Ordinance 2145" }),
      "Avery Sample — voted no on Ordinance 2145",
    );
    assert.equal(
      renderClaim({ subject_name: "Avery Sample", action: "recused", matter: null }),
      "Avery Sample — recused themselves",
    );
    assert.equal(
      renderClaim({ subject_name: " Avery Sample ", action: "moved", matter: "   " }),
      "Avery Sample — moved",
    );
  });
});

describe("approval", () => {
  it("writes the pin, one audit row and one event", async () => {
    const claimId = await createClaim({ quoteOffset: OFFSET_ONE });
    const item = await approveClaim(db, {
      claimId,
      reason: "Checked against the stored minutes at page 4.",
      actor: actor(),
    });

    assert.equal(item.claim.status, "approved");
    assert.equal(item.claim.approved_by, fixture.operatorId);
    assert.ok(item.claim.approved_at, "approved_at was not written");
    assert.equal(item.claim.render_version, RENDER_VERSION);
    assert.ok(item.claim.rendered_text, "rendered_text was not written");
    assert.equal(item.claim.render_sha256, renderSha256(item.claim.rendered_text ?? ""));
    assert.equal(item.render.pin?.state, "renderable");
    // The decision itself, separately from the approval to publish.
    assert.equal(item.claim.reviewed_by, fixture.operatorId);
    assert.ok(item.claim.reviewed_at, "reviewed_at was not written");

    const corrections = await correctionsFor(claimId);
    assert.equal(corrections.length, 1, "approval must append exactly one audit row");
    assert.equal(corrections[0].field, "status");
    assert.equal(corrections[0].old_value, "held");
    assert.equal(corrections[0].new_value, "approved");
    assert.equal(corrections[0].operator_id, fixture.operatorId);

    const events = await eventsFor(claimId);
    assert.equal(events.length, 1, "approval must emit exactly one event");
    assert.equal(events[0].event_type, "claim.approved");
    assert.equal(events[0].subject_kind, "claim");
    assert.equal(events[0].jurisdiction_id, fixture.jurisdictionId);
  });

  it("refuses a decision with no reason", async () => {
    const claimId = await createClaim({ quoteOffset: OFFSET_TWO });
    await assert.rejects(
      approveClaim(db, { claimId, reason: "   ", actor: actor() }),
      /reason is required/,
    );
    const row = await db("minute_claims").where({ id: claimId }).first<{ status: string }>("status");
    assert.equal(row?.status, "held");
  });

  it("refuses an approval that names no operator", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Unsigned" });
    await assert.rejects(
      approveClaim(db, {
        claimId,
        reason: "Read the minutes.",
        actor: { id: null, email: "nobody@example.invalid" },
      }),
      /must name the operator/,
    );
    assert.equal((await correctionsFor(claimId)).length, 0);
  });

  it("refuses a claim whose cited bytes are not stored", async () => {
    const missing = "0".repeat(64);
    const claimId = await createClaim({
      subjectName: "Commissioner Uncited",
      artifactSha256: missing,
    });
    await assert.rejects(
      approveClaim(db, { claimId, reason: "Looks right.", actor: actor() }),
      /not stored/,
    );
    assert.equal((await correctionsFor(claimId)).length, 0);
    const row = await db("minute_claims").where({ id: claimId }).first<{ status: string }>("status");
    assert.equal(row?.status, "held");
  });

  it("refuses a sentence that asserts motive", async () => {
    const claimId = await createClaim({
      subjectName: "Commissioner Motive",
      matter: "the deliberately concealed contract award",
    });
    await assert.rejects(
      approveClaim(db, { claimId, reason: "It reads fine to me.", actor: actor() }),
      /never the motive/,
    );
    assert.equal((await correctionsFor(claimId)).length, 0);
  });

  it("refuses a claim that is not held", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Twice" });
    await approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() });
    await assert.rejects(
      approveClaim(db, { claimId, reason: "Checked them again.", actor: actor() }),
      /nothing to approve/,
    );
    assert.equal((await correctionsFor(claimId)).length, 1);
  });

  it("rolls the audit row back with the write it describes", async () => {
    // A real post-log failure, induced rather than simulated: the audit row is
    // appended before the claim is updated, so a trigger that refuses the update
    // is exactly the ordering that would leave the log asserting an approval
    // that never happened.
    const claimId = await createClaim({ subjectName: "Commissioner Rollback" });
    await db.raw(`
      CREATE OR REPLACE FUNCTION claims_review_test_refuse_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'claims-review-test: refusing the update';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER claims_review_test_refuse
      BEFORE UPDATE ON minute_claims
      FOR EACH ROW EXECUTE FUNCTION claims_review_test_refuse_update()
    `);
    try {
      await assert.rejects(
        approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() }),
        /refusing the update/,
      );
    } finally {
      await db.raw("DROP TRIGGER IF EXISTS claims_review_test_refuse ON minute_claims");
      await db.raw("DROP FUNCTION IF EXISTS claims_review_test_refuse_update()");
    }

    assert.equal((await correctionsFor(claimId)).length, 0, "the log row survived a failed write");
    assert.equal((await eventsFor(claimId)).length, 0);
    const row = await db("minute_claims").where({ id: claimId }).first<{ status: string }>("status");
    assert.equal(row?.status, "held");
  });

  it("approves a claim on a withheld meeting without announcing it", async () => {
    const claimId = await createClaim({
      meetingId: fixture.withheldMeetingId,
      subjectName: "Commissioner Withheld",
    });
    const item = await approveClaim(db, {
      claimId,
      reason: "Approved ahead of publishing the meeting.",
      actor: actor(),
    });
    assert.equal(item.claim.status, "approved");
    // `emitEvent` refuses a subject no reader can see, so the approval is
    // legitimate and silent. The meeting publish path announces it later.
    assert.equal((await eventsFor(claimId)).length, 0);
    assert.equal(await findPublicClaim(db, claimId), undefined);
  });
});

describe("rejection", () => {
  it("marks the claim rejected, logs it, and announces nothing", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Rejected" });
    const item = await rejectClaim(db, {
      claimId,
      reason: "The quote names two people and the action attaches to the other one.",
      actor: actor(),
    });
    assert.equal(item.claim.status, "rejected");
    assert.equal(item.claim.approved_at, null);

    const corrections = await correctionsFor(claimId);
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].new_value, "rejected");
    assert.equal((await eventsFor(claimId)).length, 0);
  });
});

describe("the publication wall", () => {
  it("hides a held claim", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Held" });
    assert.equal(await findPublicClaim(db, claimId), undefined);
    const shown = await listPublicClaims(db, fixture.publishedMeetingId);
    assert.equal(shown.claims.some((claim) => claim.id === claimId), false);
  });

  it("hides a rejected claim", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Refused" });
    await rejectClaim(db, { claimId, reason: "Misattributed.", actor: actor() });
    assert.equal(await findPublicClaim(db, claimId), undefined);
  });

  it("hides an approved claim whose meeting is not published", async () => {
    const claimId = await createClaim({
      meetingId: fixture.withheldMeetingId,
      subjectName: "Commissioner Unpublished",
    });
    await approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() });

    assert.equal(await findPublicClaim(db, claimId), undefined);
    const shown = await listPublicClaims(db, fixture.withheldMeetingId);
    assert.deepEqual(shown.claims, []);

    // And through the helper directly, the way a public route would reach it.
    const rows = await whereClaimPublic(
      db,
      db("minute_claims").where("minute_claims.id", claimId).select("minute_claims.id"),
    );
    assert.deepEqual(rows, []);
  });

  it("hides a retracted claim and keeps what it said", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Withdrawn" });
    const approved = await approveClaim(db, {
      claimId,
      reason: "Checked the minutes.",
      actor: actor(),
    });
    const published = approved.claim.rendered_text;
    assert.ok(published);

    const item = await retractClaim(db, {
      claimId,
      reason: "The minutes were reissued and the vote is recorded differently.",
      actor: actor(),
    });
    assert.ok(item.claim.retracted_at);
    assert.equal(item.claim.rendered_text, published, "retraction blanked the published text");
    assert.equal(item.claim.status, "approved", "retraction rewrote the decision");

    assert.equal(await findPublicClaim(db, claimId), undefined);
    const shown = await listPublicClaims(db, fixture.publishedMeetingId);
    assert.equal(shown.claims.some((claim) => claim.id === claimId), false);

    const tombstone = shown.tombstones.find((entry) => entry.id === claimId);
    assert.ok(tombstone, "the meeting page shows no tombstone for a retracted claim");
    assert.equal(tombstone.previous_text, published);
    assert.equal(tombstone.anchor, `claim-${claimId}`);

    // Append, not overwrite: the approval row and the retraction row both stand.
    const corrections = await correctionsFor(claimId);
    assert.equal(corrections.length, 2);
    assert.equal(corrections[1].field, "retracted_at");
  });

  it("refuses to retract a claim that was never approved", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Never" });
    await assert.rejects(
      retractClaim(db, { claimId, reason: "Withdrawing it.", actor: actor() }),
      /never published/,
    );
  });
});

describe("the pin", () => {
  it("does not render when the sentence this build produces has changed", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Pinned" });
    const approved = await approveClaim(db, {
      claimId,
      reason: "Checked the minutes.",
      actor: actor(),
    });
    const published = approved.claim.rendered_text ?? "";

    // What a label edit or a re-extraction would do: the triple no longer
    // renders to the bytes the operator read.
    await db("minute_claims")
      .where({ id: claimId })
      .update({ matter: "Ordinance 2145, first reading" });

    const shown = await listPublicClaims(db, fixture.publishedMeetingId);
    assert.equal(shown.claims.some((claim) => claim.id === claimId), false);
    assert.equal(shown.awaiting_re_review >= 1, true);
    // And it does not fall back to the stored text — that is the whole point.
    assert.equal(
      shown.claims.some((claim) => claim.text === published),
      false,
      "the stored text was published after the pin broke",
    );

    const row = await db("minute_claims")
      .where({ id: claimId })
      .first<Record<string, unknown> | undefined>();
    assert.ok(row);
    const render = renderApprovedClaim({
      subject_name: row.subject_name,
      action: row.action,
      matter: row.matter,
      rendered_text: row.rendered_text,
      render_sha256: row.render_sha256,
      render_version: row.render_version,
    });
    assert.equal(render.state, "awaiting_re_review");
  });

  it("does not render a claim pinned to an older render version", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Versioned" });
    await approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() });
    await db("minute_claims").where({ id: claimId }).update({ render_version: "claim-render@0" });

    const shown = await listPublicClaims(db, fixture.publishedMeetingId);
    assert.equal(shown.claims.some((claim) => claim.id === claimId), false);
  });

  it("does not render when the stored text and the stored hash disagree", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Tampered" });
    await approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() });
    await db("minute_claims")
      .where({ id: claimId })
      .update({ rendered_text: "Commissioner Tampered — voted yes" });

    const shown = await listPublicClaims(db, fixture.publishedMeetingId);
    assert.equal(shown.claims.some((claim) => claim.id === claimId), false);
  });
});

describe("the meeting page", () => {
  it("renders a meeting's claims in the order the minutes say them", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: new Date() });
    extraMeetingIds.push(meetingId);

    const second = await createClaim({
      meetingId,
      subjectName: "Commissioner Fixture",
      action: "moved",
      matter: "tabling the item",
      quote: QUOTE_TWO,
      quoteOffset: OFFSET_TWO,
    });
    const first = await createClaim({
      meetingId,
      subjectName: "Commissioner Sample",
      action: "voted_no",
      matter: "Ordinance 2145",
      quote: QUOTE_ONE,
      quoteOffset: OFFSET_ONE,
    });
    for (const claimId of [second, first]) {
      await approveClaim(db, { claimId, reason: "Checked the minutes.", actor: actor() });
    }

    const shown = await listPublicClaims(db, meetingId);
    assert.deepEqual(
      shown.claims.map((claim) => claim.id),
      [first, second],
      "claims are not in agenda order",
    );
    // Anchors are the id, so they survive a re-render.
    const again = await listPublicClaims(db, meetingId);
    assert.deepEqual(
      shown.claims.map((claim) => claim.anchor),
      again.claims.map((claim) => claim.anchor),
    );
    assert.equal(shown.claims[0].anchor, `claim-${first}`);
    assert.equal(shown.claims[0].source_path, `/source/${fixture.artifactSha}#offset-${OFFSET_ONE}`);
  });
});

describe("the review screen's API", () => {
  it("requires an operator session", async () => {
    await request(app).get("/api/admin/claims/queue").expect(401);
  });

  it("serves the queue with the quote in its artifact context", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Context" });
    const res = await request(app)
      .get(`/api/admin/claims/${claimId}`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    assert.equal(res.body.claim.id, claimId);
    assert.equal(res.body.render.approvable, true);
    assert.equal(res.body.render.version, RENDER_VERSION);
    assert.equal(res.body.citation.artifact_stored, true);
    assert.equal(res.body.citation.viewer_path, `/source/${fixture.artifactSha}#offset-${OFFSET_ONE}`);

    const context = res.body.citation.context;
    assert.ok(context, "the screen shows the quote with no context around it");
    assert.equal(context.text.slice(context.quote_start, context.quote_end), QUOTE_ONE);
    assert.equal(context.offset_matches_stored, true);
  });

  it("approves one claim, by id, with a reason", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Console" });
    await request(app)
      .post(`/api/admin/claims/${claimId}/approve`)
      .set("Cookie", fixture.cookie)
      .send({})
      .expect(400);

    const res = await request(app)
      .post(`/api/admin/claims/${claimId}/approve`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Read the quote in the stored minutes." })
      .expect(200);
    assert.equal(res.body.claim.status, "approved");
    assert.equal(res.body.claim.approved_by, fixture.operatorId);
  });

  it("counts and filters the queue", async () => {
    const listing = await listClaimQueue(db, {
      status: "held",
      meeting_id: fixture.publishedMeetingId,
    });
    assert.equal(
      listing.data.every((item) => item.claim.status === "held"),
      true,
    );
    assert.equal(listing.counts.approved > 0, true);
    assert.equal(listing.counts.retracted > 0, true);
  });

  it("offers no way to approve more than one claim at a time", async () => {
    // Structural, not a comment: a screen that approves forty claims in one
    // click publishes forty unread sentences about named people.
    const exported = Object.keys(claimsModule);
    assert.deepEqual(
      exported.filter((name) => /bulk|approveMany|approveAll/i.test(name)),
      [],
    );
    await request(app)
      .post("/api/admin/claims/approve")
      .set("Cookie", fixture.cookie)
      .send({ claim_ids: claimIds, reason: "All of them." })
      .expect(404);
  });

  it("reports a claim nobody has decided as still held", async () => {
    const claimId = await createClaim({ subjectName: "Commissioner Pending" });
    const item = await getClaimReview(db, claimId);
    assert.equal(item?.claim.status, "held");
    assert.equal(item?.claim.overdue, false);
    assert.equal(item?.render.pin, null);
  });
});

describe("publishing a meeting announces it", () => {
  it("emits meeting.published in the publishing transaction", async () => {
    const meetingId = await createMeeting(fixture.commissionId, { publishedAt: null });
    extraMeetingIds.push(meetingId);

    await request(app)
      .post(`/api/admin/pressroom/meetings/${meetingId}/publish`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Reviewed against the source document." })
      .expect(200);

    const events = await eventsFor(meetingId);
    assert.equal(events.length, 1, "publishing announced nothing");
    assert.equal(events[0].event_type, "meeting.published");
    assert.equal(events[0].jurisdiction_id, fixture.jurisdictionId);

    // Publishing again over a known defect is a real operation and is logged,
    // but it is not a second announcement to every subscriber.
    await request(app)
      .post(`/api/admin/pressroom/meetings/${meetingId}/publish`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Republished with the corrected location." })
      .expect(200);
    assert.equal((await eventsFor(meetingId)).length, 1);
  });

  it("emits one event per meeting on the bulk path", async () => {
    const first = await createMeeting(fixture.commissionId, { publishedAt: null });
    const second = await createMeeting(fixture.commissionId, { publishedAt: null });
    extraMeetingIds.push(first, second);

    await request(app)
      .post("/api/admin/pressroom/meetings/publish")
      .set("Cookie", fixture.cookie)
      .send({ meeting_ids: [first, second], reason: "Reviewed the sweep." })
      .expect(200);

    assert.equal((await eventsFor(first)).length, 1);
    assert.equal((await eventsFor(second)).length, 1);
  });
});
