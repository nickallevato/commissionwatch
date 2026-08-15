import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before any delivery code resolves the key — `signInOperator`
// imports `src/app`, which pulls in the event spine's dispatcher config. Same
// reason `claims-review.test.ts` sets it at the top of the file.
process.env.CHANNEL_SECRET_KEY =
  process.env.CHANNEL_SECRET_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import request from "supertest";
import express from "express";

import db from "../src/config/database";
import { errorHandler } from "../src/middleware/errorHandler";
import { requireOperator } from "../src/middleware/requireOperator";
import placeLinksRouter from "../src/routes/admin/place-links";
import placesRouter from "../src/routes/places";
import { PLACE_PRECISIONS, linkPlace, recordPlace } from "../src/services/places";
import * as placeReview from "../src/services/review/place-links";
import {
  PRECISION_MEANING,
  approvePlaceLink,
  getPlaceLinkReview,
  listPlaceLinkQueue,
  rejectPlaceLink,
} from "../src/services/review/place-links";
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
 * The place-link review path.
 *
 * Migration 094 shipped `place_links.status` defaulting to `held` and nothing
 * wrote it, so `wherePlaceLinkPublic` — which requires `approved` — could never
 * match a row and the map was empty by construction. These tests hold the
 * properties that make the path that changed it safe to have built:
 *
 *  - the wall moves in **both** directions: a held link is invisible on
 *    `/api/places/near` and approving it makes the place appear. Absence alone
 *    would also hold for a feature that returns nothing ever;
 *  - an `inferred` link cannot be approved, because `wherePlaceLinkPublic`
 *    excludes it whatever its status and a row saying `approved` that shows
 *    nothing is a lie in the database;
 *  - neither decision is possible without a stated reason;
 *  - each decision appends exactly one `record_corrections` row — one audit log,
 *    not a second;
 *  - the queue shows the quote **in its context**, and the context genuinely
 *    contains the quote. A window that does not is the failure the whole
 *    "see it in situ" requirement exists to prevent;
 *  - no endpoint approves more than one link, asserted structurally.
 *
 * `record_corrections` is never cleaned up — migration 031 forbids DELETE, which
 * is the property it exists to prove — so every count here is scoped to a target
 * id this suite generated.
 */

const PREFIX = "place-review-test";

const ADDRESS = "133 Maus Lane";

/** The agenda line that names the address. The quote is the line, not the address. */
const QUOTE = `Ordinance 2145: annexation of the property at ${ADDRESS}, Bozeman.`;

const DOCUMENT_TEXT = [
  "CITY COMMISSION AGENDA",
  "Tuesday, August 4, 2026",
  "A. Call to order",
  QUOTE,
  "B. Public comment on the item above",
  "C. Adjournment",
].join("\n");

const QUOTE_OFFSET = DOCUMENT_TEXT.indexOf(QUOTE);

/** Bozeman City Hall, near enough — the same centre `places.test.ts` measures from. */
const CENTRE = { lat: 45.6796, lon: -111.0386 };
const RADIUS = 1000;

const SHA = sha256Of(`${PREFIX}-agenda`);
/** A content address with no `artifacts` row behind it. */
const MISSING_SHA = sha256Of(`${PREFIX}-not-stored`);

interface Fixture {
  jurisdictionId: string;
  commissionId: string;
  publishedMeetingId: string;
  withheldMeetingId: string;
  artifactId: string;
  operatorId: string;
  cookie: string;
}

let fixture: Fixture;

/** The operator console's app, mounted exactly as the orchestrator will mount it. */
const adminApp = express();
adminApp.use(express.json());
adminApp.use("/api/admin/place-links", requireOperator, placeLinksRouter);
adminApp.use(errorHandler);

/** The reader's side, for the wall assertions. */
const publicApp = express();
publicApp.use("/api/places", placesRouter);
publicApp.use(errorHandler);

let placeCounter = 0;

async function createPlace(): Promise<string> {
  placeCounter += 1;
  const place = await recordPlace(db, {
    jurisdiction_id: fixture.jurisdictionId,
    kind: "address",
    label: `${PREFIX} ${ADDRESS} #${placeCounter}`,
    // Every place sits on the centre: this suite is about the wall, and
    // `places.test.ts` is where the radius arithmetic is measured.
    lat: CENTRE.lat,
    lon: CENTRE.lon,
    precision: "block",
    geocoder: "us-census/Public_AR_Current",
    geocoded_at: new Date(),
  });
  return place.id;
}

interface LinkOptions {
  confidence?: "stated" | "matched" | "inferred";
  subjectId?: string;
  artifactSha256?: string | null;
  quote?: string | null;
  quoteOffset?: number | null;
}

async function createLink(options: LinkOptions = {}): Promise<{ placeId: string; linkId: string }> {
  const placeId = await createPlace();
  const confidence = options.confidence ?? "stated";
  const cited = confidence !== "inferred";
  const link = await linkPlace(db, {
    place_id: placeId,
    subject_kind: "meeting",
    subject_id: options.subjectId ?? fixture.publishedMeetingId,
    relation: "subject_of",
    confidence,
    artifact_sha256: options.artifactSha256 === undefined ? (cited ? SHA : null) : options.artifactSha256,
    quote: options.quote === undefined ? (cited ? QUOTE : null) : options.quote,
    quote_offset: options.quoteOffset === undefined ? (cited ? QUOTE_OFFSET : null) : options.quoteOffset,
  });
  return { placeId, linkId: link.id };
}

async function correctionsFor(linkId: string): Promise<Array<Record<string, unknown>>> {
  return db("record_corrections")
    .where({ target_table: "place_links", target_id: linkId })
    .orderBy("created_at", "asc")
    .select<Array<Record<string, unknown>>>("*");
}

function actor(): { id: string; email: string } {
  return { id: fixture.operatorId, email: `${PREFIX}@example.invalid` };
}

/** Ids returned by `/api/places/near` around the fixture centre. */
async function nearbyPlaceIds(): Promise<string[]> {
  const res = await request(publicApp)
    .get("/api/places/near")
    .query({ lat: CENTRE.lat, lon: CENTRE.lon, radius: RADIUS, limit: 100 })
    .expect(200);
  const body = res.body as { data: Array<{ id: string }> };
  return body.data.map((place) => place.id);
}

before(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA, MISSING_SHA]);

  const source = await createSource(PREFIX);
  const artifactId = await createArtifact(SHA, "https://example.invalid/place-review-agenda.pdf");
  await db("artifact_texts").insert({
    artifact_id: artifactId,
    text: DOCUMENT_TEXT,
    char_count: DOCUMENT_TEXT.length,
  });

  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-04",
  });
  const withheldMeetingId = await createMeeting(source.commissionId, {
    publishedAt: null,
    date: "2026-08-11",
  });

  const email = `${PREFIX}@example.invalid`;
  const cookie = await signInOperator(email, "Place Review Operator");
  const operator = await db("operators").where({ email }).first<{ id: string } | undefined>("id");
  assert.ok(operator, "the suite operator was not created");

  fixture = {
    jurisdictionId: source.jurisdictionId,
    commissionId: source.commissionId,
    publishedMeetingId,
    withheldMeetingId,
    artifactId,
    operatorId: operator.id,
    cookie,
  };
});

after(async () => {
  // `places` cascades from `jurisdictions` and `place_links` from `places`, so
  // the prefix cleanup takes the whole graph. `record_corrections` is left
  // alone: migration 031 forbids DELETE and that refusal is the feature.
  await db("artifact_texts").where({ artifact_id: fixture.artifactId }).del();
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA, MISSING_SHA]);
  await db("operators").where({ email: `${PREFIX}@example.invalid` }).del();
  await db.destroy();
});

/* ------------------------------------------------------------------------- */

describe("the wall, in both directions", () => {
  it("hides a held link's place and shows it once the link is approved", async () => {
    const { placeId, linkId } = await createLink();

    assert.equal(
      (await nearbyPlaceIds()).includes(placeId),
      false,
      "a held link put a place on the public map",
    );

    await request(adminApp)
      .post(`/api/admin/place-links/${linkId}/approve`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Address checked against the agenda line that names it." })
      .expect(200);

    assert.equal(
      (await nearbyPlaceIds()).includes(placeId),
      true,
      "an approved link left the place invisible",
    );
  });

  it("keeps a rejected link off the map by the same rule that keeps a held one off", async () => {
    const { placeId, linkId } = await createLink();
    await rejectPlaceLink(db, {
      linkId,
      reason: "The address belongs to a different item on the same page.",
      actor: actor(),
    });

    const item = await getPlaceLinkReview(db, linkId);
    assert.equal(item?.link.status, "rejected");
    assert.equal((await nearbyPlaceIds()).includes(placeId), false);
  });

  it("reports whether the subject is public without refusing the decision", async () => {
    const { placeId, linkId } = await createLink({ subjectId: fixture.withheldMeetingId });

    const before = await getPlaceLinkReview(db, linkId);
    assert.equal(before?.subject.is_public, false);
    assert.equal(before?.decision.approvable, true, "a withheld subject must not block approval");

    await approvePlaceLink(db, {
      linkId,
      reason: "The agenda names this address; the meeting is not published yet.",
      actor: actor(),
    });

    // Approved, and still invisible — the meeting wall, not this decision.
    assert.equal((await nearbyPlaceIds()).includes(placeId), false);
  });
});

describe("an inferred link", () => {
  it("cannot be approved, through the service or the route", async () => {
    const { linkId } = await createLink({ confidence: "inferred" });

    await assert.rejects(
      approvePlaceLink(db, { linkId, reason: "Looks right on the map.", actor: actor() }),
      /inferred/i,
    );

    await request(adminApp)
      .post(`/api/admin/place-links/${linkId}/approve`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "Looks right on the map." })
      .expect(409);

    const item = await getPlaceLinkReview(db, linkId);
    assert.equal(item?.link.status, "held");
    assert.equal(item?.decision.approvable, false);
    assert.match(String(item?.decision.blocked_reason), /inferred/i);
    // Refusing to approve is not refusing to decide: a lead may be dismissed.
    await rejectPlaceLink(db, { linkId, reason: "Not worth carrying as a lead.", actor: actor() });
    assert.equal((await getPlaceLinkReview(db, linkId))?.link.status, "rejected");
  });
});

describe("a decision without a reason", () => {
  it("is refused on both actions, by the service and by the route", async () => {
    const { linkId } = await createLink();

    await assert.rejects(
      approvePlaceLink(db, { linkId, reason: "   ", actor: actor() }),
      /reason is required/,
    );
    await assert.rejects(
      rejectPlaceLink(db, { linkId, reason: "", actor: actor() }),
      /reason is required/,
    );

    await request(adminApp)
      .post(`/api/admin/place-links/${linkId}/approve`)
      .set("Cookie", fixture.cookie)
      .send({})
      .expect(400);
    await request(adminApp)
      .post(`/api/admin/place-links/${linkId}/reject`)
      .set("Cookie", fixture.cookie)
      .send({ reason: "  " })
      .expect(400);

    assert.equal((await getPlaceLinkReview(db, linkId))?.link.status, "held");
    assert.equal((await correctionsFor(linkId)).length, 0);
  });
});

describe("the audit log", () => {
  it("appends exactly one row per approval", async () => {
    const { linkId } = await createLink();
    await approvePlaceLink(db, {
      linkId,
      reason: "The quote is the agenda line for this item.",
      actor: actor(),
    });

    const rows = await correctionsFor(linkId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, "status");
    assert.equal(rows[0].old_value, "held");
    assert.equal(rows[0].new_value, "approved");
    assert.equal(rows[0].operator_id, fixture.operatorId);
  });

  it("appends exactly one row per rejection", async () => {
    const { linkId } = await createLink();
    await rejectPlaceLink(db, {
      linkId,
      reason: "The geocoder matched a street with the same name in another town.",
      actor: actor(),
    });

    const rows = await correctionsFor(linkId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].new_value, "rejected");
  });

  it("writes nothing when the decision is refused", async () => {
    const { linkId } = await createLink({ confidence: "inferred" });
    await assert.rejects(
      approvePlaceLink(db, { linkId, reason: "A lead worth following.", actor: actor() }),
    );
    assert.equal((await correctionsFor(linkId)).length, 0);
  });
});

describe("what the operator is shown", () => {
  it("puts the quote in context, and the context contains the quote", async () => {
    const { linkId } = await createLink();
    const listing = await listPlaceLinkQueue(db, { status: "held" });
    const item = listing.data.find((entry) => entry.link.id === linkId);
    assert.ok(item, "the held link was not in the queue");

    const citation = item.citation;
    assert.ok(citation, "a stated link came back with no citation");
    assert.equal(citation.artifact_stored, true);
    assert.equal(citation.source_url, "https://example.invalid/place-review-agenda.pdf");
    assert.match(citation.viewer_path, /^\/source\/[0-9a-f]{64}\?offset=\d+&len=\d+$/);

    const context = citation.context;
    assert.ok(context, "the quote could not be located in the artifact text");
    // The window is the point of the feature: it must actually hold the quote,
    // at the offsets the highlight will use.
    assert.ok(context.text.includes(QUOTE), "the context window does not contain the quote");
    assert.equal(context.text.slice(context.quote_start, context.quote_end), QUOTE);
    assert.equal(context.offset_matches_stored, true);
    // And the address is in the line, which is what makes the quote evidence
    // about *this* item rather than about the address in the abstract.
    assert.ok(context.text.includes(ADDRESS));
  });

  it("says what the precision means, and covers every precision the schema allows", async () => {
    const { linkId } = await createLink();
    const item = await getPlaceLinkReview(db, linkId);
    assert.equal(item?.place.precision, "block");
    assert.equal(item?.place.precision_meaning, PRECISION_MEANING.block);
    assert.match(String(item?.place.precision_meaning), /block/i);

    // Iterating the constant rather than listing four strings again: a fifth
    // precision added to migration 094 fails here until somebody says what it
    // means, rather than reaching an operator as a bare column value.
    for (const precision of PLACE_PRECISIONS) {
      const meaning = PRECISION_MEANING[precision];
      assert.equal(typeof meaning, "string");
      assert.ok(meaning.trim().length > 0, `${precision} has no wording`);
    }
    assert.deepEqual(
      Object.keys(PRECISION_MEANING).sort(),
      [...PLACE_PRECISIONS].sort(),
      "PRECISION_MEANING and the schema's precisions disagree",
    );
  });

  it("names the subject and counts the queue by status", async () => {
    const { linkId } = await createLink();
    const item = await getPlaceLinkReview(db, linkId);
    assert.equal(item?.subject.kind, "meeting");
    assert.equal(item?.subject.id, fixture.publishedMeetingId);
    assert.equal(item?.subject.meeting_id, fixture.publishedMeetingId);
    assert.equal(item?.subject.is_public, true);

    const listing = await listPlaceLinkQueue(db, {});
    assert.ok(listing.counts.held >= 1);
    assert.ok(listing.counts.approved >= 1);
    assert.ok(listing.counts.rejected >= 1);
  });

  it("refuses a link whose cited bytes are not stored", async () => {
    const { linkId } = await createLink({ artifactSha256: MISSING_SHA });
    const item = await getPlaceLinkReview(db, linkId);
    assert.equal(item?.citation?.artifact_stored, false);
    assert.equal(item?.decision.approvable, false);

    await assert.rejects(
      approvePlaceLink(db, { linkId, reason: "The agenda says so.", actor: actor() }),
      /not stored/,
    );
  });
});

describe("there is no bulk approve", () => {
  it("exports no bulk writer and serves no collection endpoint", async () => {
    const exported = Object.keys(placeReview);
    assert.deepEqual(
      exported.filter((name) => /bulk|approveMany|approveAll/i.test(name)),
      [],
    );

    const { linkId: first } = await createLink();
    const { linkId: second } = await createLink();

    await request(adminApp)
      .post("/api/admin/place-links/approve")
      .set("Cookie", fixture.cookie)
      .send({ link_ids: [first, second], reason: "All of them." })
      .expect(404);

    for (const id of [first, second]) {
      assert.equal((await getPlaceLinkReview(db, id))?.link.status, "held");
    }
  });

  it("401s without an operator session", async () => {
    const { linkId } = await createLink();
    await request(adminApp)
      .post(`/api/admin/place-links/${linkId}/approve`)
      .send({ reason: "No session." })
      .expect(401);
  });
});
