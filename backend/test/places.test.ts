import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";

import db from "../src/config/database";
import { errorHandler } from "../src/middleware/errorHandler";
import placesRouter from "../src/routes/places";
import {
  PLACE_CONFIDENCE,
  PLACE_KINDS,
  PLACE_PRECISIONS,
  PLACE_RELATIONS,
  findPlace,
  linkPlace,
  parseCoordinate,
  parseRadius,
  placesNear,
  recordPlace,
  PlaceQueryError,
} from "../src/services/places";
import { collectNearEntries, parseFeedQuery, FeedQueryError } from "../src/services/feeds/query";
import { cleanupByPrefix, createArtifact, createMeeting, createSource, deleteArtifacts, sha256Of } from "./helpers/pressroom";

/**
 * Map stage 1 — points and radius.
 *
 * Four properties are asserted here, and each of them is a way the feature can
 * be wrong while still looking like it works.
 *
 * **The radius is a radius, not a bounding box.** `earth_box` is what the GiST
 * index answers and it over-selects at the corners. The suite therefore does
 * not merely check that a far point is absent — it uses a point that
 * `earth_box(centre, 1000)` *admits* and that is 1095 metres away, asserts the
 * admission directly in SQL, and then asserts `placesNear` excludes it. A test
 * that only used a point 5 km away would pass against a query with no
 * `earth_distance` filter at all.
 *
 * **The publication wall holds in both directions.** A link to an unpublished
 * meeting is invisible, and publishing the meeting makes it appear. Absence
 * alone would also hold for a feature that returns nothing ever.
 *
 * **An `inferred` link is never public.** Migration 094 lets it exist without a
 * citation precisely so it can be an operator-only lead, and an operator may
 * legitimately approve one as a lead worth following. Approval must not put it
 * on a map.
 *
 * **This maps decisions, not people.** Migration 043 dropped donor addresses
 * from this database on privacy grounds. The foreign keys of `places` and
 * `place_links` are enumerated from the catalogue and the suite fails if either
 * ever points at `members` or `minute_claims`.
 */

const PREFIX = "places-test";

/**
 * Bozeman City Hall, near enough. Every fixture coordinate is an offset from
 * this one and every distance below was measured against the real database
 * before it was written down — see the probe in `services/places.ts`.
 */
const CENTRE = { lat: 45.6796, lon: -111.0386 };

/** 501 m north. Inside a 1000 m radius by any measure. */
const NEAR = { lat: 45.6841, lon: -111.0386 };

/** 5009 m north. Outside the bounding box, so it never reaches the second filter. */
const FAR = { lat: 45.7246, lon: -111.0386 };

/**
 * 1095 m north-east — **inside** `earth_box(CENTRE, 1000)` and outside the
 * 1000 m radius. This is the point the second filter exists for.
 */
const CORNER = { lat: 45.68680, lon: -111.02900 };

const RADIUS = 1000;

const SHA = sha256Of(`${PREFIX}-artifact`);

interface Fixture {
  jurisdictionId: string;
  commissionId: string;
  publishedMeetingId: string;
  heldMeetingId: string;
  nearPlaceId: string;
  farPlaceId: string;
  cornerPlaceId: string;
  inferredPlaceId: string;
  heldSubjectPlaceId: string;
}

let fixture: Fixture;

const app = express();
app.use("/api/places", placesRouter);
app.use(errorHandler);

/** A citation good enough for `place_links_citation_check`. */
const CITATION = { artifact_sha256: SHA, quote: "1234 North Willson Avenue", quote_offset: 0 };

before(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA]);

  const source = await createSource(PREFIX);
  await createArtifact(SHA, "https://example.invalid/places-test.pdf");

  const publishedMeetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-04",
  });
  const heldMeetingId = await createMeeting(source.commissionId, {
    publishedAt: null,
    date: "2026-08-11",
  });

  const place = async (label: string, at: { lat: number; lon: number }): Promise<string> => {
    const row = await recordPlace(db, {
      jurisdiction_id: source.jurisdictionId,
      kind: "address",
      label: `${PREFIX} ${label}`,
      lat: at.lat,
      lon: at.lon,
      precision: "block",
    });
    return row.id;
  };

  const nearPlaceId = await place("near", NEAR);
  const farPlaceId = await place("far", FAR);
  const cornerPlaceId = await place("corner", CORNER);
  const inferredPlaceId = await place("inferred", NEAR);
  const heldSubjectPlaceId = await place("held-subject", NEAR);

  // Approved, cited, and pointing at a published meeting: the only combination
  // a reader may see.
  for (const placeId of [nearPlaceId, farPlaceId, cornerPlaceId]) {
    await linkPlace(db, {
      place_id: placeId,
      subject_kind: "meeting",
      subject_id: publishedMeetingId,
      relation: "located_at",
      confidence: "stated",
      status: "approved",
      ...CITATION,
    });
  }

  // Approved and inferred. The migration allows no citation here on purpose.
  await linkPlace(db, {
    place_id: inferredPlaceId,
    subject_kind: "meeting",
    subject_id: publishedMeetingId,
    relation: "located_at",
    confidence: "inferred",
    status: "approved",
  });

  // Approved and cited, but its meeting is withheld.
  await linkPlace(db, {
    place_id: heldSubjectPlaceId,
    subject_kind: "meeting",
    subject_id: heldMeetingId,
    relation: "located_at",
    confidence: "stated",
    status: "approved",
    ...CITATION,
  });

  fixture = {
    jurisdictionId: source.jurisdictionId,
    commissionId: source.commissionId,
    publishedMeetingId,
    heldMeetingId,
    nearPlaceId,
    farPlaceId,
    cornerPlaceId,
    inferredPlaceId,
    heldSubjectPlaceId,
  };
});

after(async () => {
  // `places` and `place_links` cascade from `jurisdictions`, so the standard
  // teardown reaches them.
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA]);
  await db.destroy();
});

async function nearIds(metres = RADIUS): Promise<string[]> {
  const rows = await placesNear(db, {
    lat: CENTRE.lat,
    lon: CENTRE.lon,
    metres,
    jurisdictionId: fixture.jurisdictionId,
  });
  return rows.map((row) => row.id);
}

describe("placesNear — the two filters", () => {
  it("returns the near point and excludes the one 5 km away", async () => {
    const ids = await nearIds();
    assert.ok(ids.includes(fixture.nearPlaceId), "the 501 m place is missing");
    assert.ok(!ids.includes(fixture.farPlaceId), "the 5009 m place leaked in");
  });

  it("reports the great-circle distance, not the bounding box", async () => {
    const rows = await placesNear(db, {
      lat: CENTRE.lat,
      lon: CENTRE.lon,
      metres: RADIUS,
      jurisdictionId: fixture.jurisdictionId,
    });
    const near = rows.find((row) => row.id === fixture.nearPlaceId);
    assert.ok(near, "the near place is missing");
    assert.equal(typeof near.distance_metres, "number");
    assert.ok(
      Math.abs(near.distance_metres - 501) < 5,
      `expected ~501 m, got ${near.distance_metres}`,
    );
  });

  it("excludes a corner point that earth_box admits", async () => {
    // First: prove the premise. If `earth_box` ever stops admitting this point
    // the next assertion becomes vacuous, and a vacuous test is worse than none.
    const admitted = await db
      .raw(
        "select (earth_box(ll_to_earth(?, ?), ?) @> ll_to_earth(?, ?)) as in_box, " +
          "earth_distance(ll_to_earth(?, ?), ll_to_earth(?, ?)) as metres",
        [
          CENTRE.lat, CENTRE.lon, RADIUS, CORNER.lat, CORNER.lon,
          CENTRE.lat, CENTRE.lon, CORNER.lat, CORNER.lon,
        ],
      )
      .then((result: { rows: Array<{ in_box: boolean; metres: number }> }) => result.rows[0]);

    assert.equal(admitted.in_box, true, "the corner point is no longer inside earth_box");
    assert.ok(
      Number(admitted.metres) > RADIUS,
      `the corner point is now inside the radius (${admitted.metres} m)`,
    );

    // Then: the query must still exclude it, which only the `earth_distance`
    // filter can do.
    const ids = await nearIds();
    assert.ok(
      !ids.includes(fixture.cornerPlaceId),
      "earth_box admitted a point past the radius and nothing filtered it out",
    );

    // And widening the radius past it brings it back, so the exclusion is the
    // distance and not some unrelated reason the row was missing.
    const wider = await nearIds(1500);
    assert.ok(wider.includes(fixture.cornerPlaceId), "the corner point never appears at all");
  });
});

describe("the publication wall", () => {
  it("hides a link to an unpublished meeting, and shows it once published", async () => {
    const before = await nearIds();
    assert.ok(
      !before.includes(fixture.heldSubjectPlaceId),
      "a place linked only to a withheld meeting was returned",
    );
    assert.equal(await findPlace(db, fixture.heldSubjectPlaceId), undefined);
    await request(app).get(`/api/places/${fixture.heldSubjectPlaceId}`).expect(404);

    await db("meetings").where({ id: fixture.heldMeetingId }).update({ published_at: new Date() });
    try {
      const after = await nearIds();
      assert.ok(
        after.includes(fixture.heldSubjectPlaceId),
        "publishing the meeting did not make its place visible",
      );
      const detail = await findPlace(db, fixture.heldSubjectPlaceId);
      assert.ok(detail, "the place is still invisible after publication");
      assert.equal(detail.links.length, 1);
      await request(app).get(`/api/places/${fixture.heldSubjectPlaceId}`).expect(200);
    } finally {
      // Restored, because the near-feed suite below relies on this meeting
      // being withheld.
      await db("meetings").where({ id: fixture.heldMeetingId }).update({ published_at: null });
    }
  });

  it("never shows an inferred link, even when it is approved", async () => {
    const row = await db("place_links")
      .where({ place_id: fixture.inferredPlaceId })
      .first<{ status: string; confidence: string } | undefined>("status", "confidence");
    assert.ok(row, "the inferred fixture is missing");
    assert.equal(row.status, "approved", "the fixture must be approved for this to prove anything");
    assert.equal(row.confidence, "inferred");

    const ids = await nearIds();
    assert.ok(!ids.includes(fixture.inferredPlaceId), "an approved inferred link was published");
    assert.equal(await findPlace(db, fixture.inferredPlaceId), undefined);
  });

  it("hides a link whose agenda item sits on an unpublished meeting", async () => {
    const [item] = await db("agenda_items")
      .insert({
        meeting_id: fixture.heldMeetingId,
        item_number: 1,
        title: `${PREFIX} rezone`,
      })
      .returning<Array<{ id: string }>>("id");

    const place = await recordPlace(db, {
      jurisdiction_id: fixture.jurisdictionId,
      kind: "address",
      label: `${PREFIX} agenda-item`,
      lat: NEAR.lat,
      lon: NEAR.lon,
      precision: "block",
    });
    await linkPlace(db, {
      place_id: place.id,
      subject_kind: "agenda_item",
      subject_id: item.id,
      relation: "subject_of",
      confidence: "stated",
      status: "approved",
      ...CITATION,
    });

    assert.ok(!(await nearIds()).includes(place.id), "an item on a withheld meeting leaked");

    await db("meetings").where({ id: fixture.heldMeetingId }).update({ published_at: new Date() });
    try {
      assert.ok(
        (await nearIds()).includes(place.id),
        "publishing the meeting did not reach the agenda item's link",
      );
    } finally {
      await db("meetings").where({ id: fixture.heldMeetingId }).update({ published_at: null });
      await db("place_links").where({ place_id: place.id }).del();
      await db("places").where({ id: place.id }).del();
      await db("agenda_items").where({ id: item.id }).del();
    }
  });

  it("hides a link to a finding that is not published", async () => {
    const [flag] = await db("anomaly_flags")
      .insert({
        meeting_id: fixture.publishedMeetingId,
        flag_type: "last_minute_agenda_change",
        description: `${PREFIX} flag`,
        severity: "low",
        review_state: "held",
      })
      .returning<Array<{ id: string }>>("id");

    const place = await recordPlace(db, {
      jurisdiction_id: fixture.jurisdictionId,
      kind: "address",
      label: `${PREFIX} finding`,
      lat: NEAR.lat,
      lon: NEAR.lon,
      precision: "block",
    });
    await linkPlace(db, {
      place_id: place.id,
      subject_kind: "finding",
      subject_id: flag.id,
      relation: "affects",
      confidence: "matched",
      status: "approved",
      ...CITATION,
    });

    assert.ok(!(await nearIds()).includes(place.id), "a held finding's location leaked");

    await db("anomaly_flags").where({ id: flag.id }).update({ review_state: "published" });
    try {
      assert.ok(
        (await nearIds()).includes(place.id),
        "publishing the finding did not reach its link",
      );
    } finally {
      await db("place_links").where({ place_id: place.id }).del();
      await db("places").where({ id: place.id }).del();
      await db("anomaly_flags").where({ id: flag.id }).del();
    }
  });

  it("hides a held link even when its subject is published", async () => {
    const place = await recordPlace(db, {
      jurisdiction_id: fixture.jurisdictionId,
      kind: "address",
      label: `${PREFIX} held-link`,
      lat: NEAR.lat,
      lon: NEAR.lon,
      precision: "block",
    });
    await linkPlace(db, {
      place_id: place.id,
      subject_kind: "meeting",
      subject_id: fixture.publishedMeetingId,
      relation: "located_at",
      confidence: "stated",
      // The migration's default, and the state everything arrives in.
      status: "held",
      ...CITATION,
    });

    try {
      assert.ok(!(await nearIds()).includes(place.id), "a held link was published");
    } finally {
      await db("place_links").where({ place_id: place.id }).del();
      await db("places").where({ id: place.id }).del();
    }
  });
});

describe("the routes", () => {
  it("400s a malformed coordinate rather than defaulting", async () => {
    for (const query of [
      "",
      "?lat=45.6796",
      "?lon=-111.0386",
      "?lat=north&lon=-111.0386",
      "?lat=&lon=-111.0386",
      "?lat=145.6796&lon=-111.0386",
      "?lat=45.6796&lon=-611.0386",
    ]) {
      const res = await request(app).get(`/api/places/near${query}`);
      assert.equal(res.status, 400, `expected 400 for "${query}", got ${res.status}`);
    }
  });

  it("400s an absurd radius rather than scanning the table", async () => {
    const res = await request(app)
      .get(`/api/places/near?lat=${CENTRE.lat}&lon=${CENTRE.lon}&radius=40000000`)
      .expect(400);
    assert.match(String(res.body.error), /radius/);

    await request(app)
      .get(`/api/places/near?lat=${CENTRE.lat}&lon=${CENTRE.lon}&radius=0`)
      .expect(400);
  });

  it("serves the near list, bounded and with the radius it applied", async () => {
    const res = await request(app)
      .get(
        `/api/places/near?lat=${CENTRE.lat}&lon=${CENTRE.lon}&radius=${RADIUS}` +
          `&jurisdiction_id=${fixture.jurisdictionId}`,
      )
      .expect(200);

    const body = res.body as {
      data: Array<{ id: string; distance_metres: number; precision: string }>;
      radius: number;
      limit: number;
    };
    assert.equal(body.radius, RADIUS);
    assert.ok(body.limit <= 100);
    const ids = body.data.map((row) => row.id);
    assert.ok(ids.includes(fixture.nearPlaceId));
    assert.ok(!ids.includes(fixture.cornerPlaceId));
    // Precision travels with every point, because a reader must never be shown
    // a pin drawn more precisely than the source supports.
    for (const row of body.data) assert.ok(row.precision.length > 0);
  });

  it("404s an unknown place and 400s a malformed id", async () => {
    await request(app).get("/api/places/not-a-uuid").expect(400);
    await request(app)
      .get("/api/places/00000000-0000-0000-0000-000000000000")
      .expect(404);
  });

  it("exposes no write route", async () => {
    // The stack that once left `POST /api/anomalies` unauthenticated. Places are
    // written by extraction and by operator action, never by a stranger.
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app)[method]("/api/places").send({});
      assert.ok(res.status === 404 || res.status === 405, `${method} /api/places was routed`);
    }
  });
});

describe("recordPlace and linkPlace are idempotent", () => {
  it("upserts on the external reference rather than duplicating", async () => {
    const input = {
      jurisdiction_id: fixture.jurisdictionId,
      kind: "facility" as const,
      label: `${PREFIX} library`,
      lat: NEAR.lat,
      lon: NEAR.lon,
      precision: "centroid" as const,
      external_source: `${PREFIX}-parcels`,
      external_ref: "R123456",
    };

    const first = await recordPlace(db, input);
    const second = await recordPlace(db, { ...input, label: `${PREFIX} library (renamed)` });

    assert.equal(second.id, first.id, "a re-import created a second row");
    assert.equal(second.label, `${PREFIX} library (renamed)`, "the re-import did not update");

    const count = await db("places")
      .where({ external_source: input.external_source, external_ref: input.external_ref })
      .count<[{ count: string }]>({ count: "id" });
    assert.equal(Number(count[0].count), 1);
  });

  it("relinks rather than duplicating, and does not reset an approval", async () => {
    const place = await recordPlace(db, {
      jurisdiction_id: fixture.jurisdictionId,
      kind: "address",
      label: `${PREFIX} relink`,
      lat: NEAR.lat,
      lon: NEAR.lon,
      precision: "block",
    });

    const key = {
      place_id: place.id,
      subject_kind: "meeting" as const,
      subject_id: fixture.publishedMeetingId,
      relation: "located_at" as const,
    };

    const first = await linkPlace(db, { ...key, confidence: "stated", status: "approved", ...CITATION });
    const second = await linkPlace(db, {
      ...key,
      confidence: "matched",
      ...CITATION,
      quote_offset: 42,
    });

    assert.equal(second.id, first.id, "a re-extract created a second link");
    assert.equal(second.confidence, "matched", "the citation was not updated");
    assert.equal(second.quote_offset, 42);
    assert.equal(
      second.status,
      "approved",
      "a re-extract reset an operator's approval — the review queue would have to be redone",
    );
  });
});

describe("the near feed", () => {
  it("parses near and radius, and refuses to compose with q", () => {
    const parsed = parseFeedQuery({ near: `${CENTRE.lat},${CENTRE.lon}`, radius: "500" });
    assert.deepEqual(parsed.near, CENTRE);
    assert.equal(parsed.radius, 500);

    assert.equal(parseFeedQuery({ near: `${CENTRE.lat},${CENTRE.lon}` }).radius, 500);

    assert.throws(
      () => parseFeedQuery({ near: `${CENTRE.lat},${CENTRE.lon}`, q: "rezone" }),
      FeedQueryError,
    );
    assert.throws(() => parseFeedQuery({ near: "north,west" }), FeedQueryError);
    assert.throws(() => parseFeedQuery({ near: `${CENTRE.lat}` }), FeedQueryError);
    assert.throws(() => parseFeedQuery({ radius: "500" }), FeedQueryError);
    assert.throws(
      () => parseFeedQuery({ near: `${CENTRE.lat},${CENTRE.lon}`, radius: "40000000" }),
      FeedQueryError,
    );
  });

  it("emits one cited entry per public link and nothing withheld", async () => {
    const entries = await collectNearEntries(db, "https://example.invalid", {
      lat: CENTRE.lat,
      lon: CENTRE.lon,
      metres: RADIUS,
      jurisdiction_id: fixture.jurisdictionId,
      limit: 50,
    });

    assert.ok(entries.length > 0, "the near feed is empty for a place that is public");
    for (const entry of entries) {
      assert.ok(entry.citation.url.length > 0, "an entry carried no citation");
      assert.match(entry.url, /^https:\/\/example\.invalid\//);
      // The precision is stated in the body, for the reason migration 094 gives.
      assert.match(entry.summary, /Location precision:/);
    }

    // The corner place is past the radius, the inferred one is never public, and
    // the held-subject one points at a withheld meeting.
    const labels = entries.map((entry) => entry.title).join("\n");
    assert.ok(!labels.includes("corner"), "a point past the radius reached the feed");
    assert.ok(!labels.includes("inferred"), "an inferred link reached the feed");
    assert.ok(!labels.includes("held-subject"), "a withheld meeting's location reached the feed");
  });
});

describe("this maps decisions, not people", () => {
  it("has no foreign key from places or place_links to members or minute_claims", async () => {
    const result = await db.raw(
      `select tc.table_name as source, ccu.table_name as target, tc.constraint_name as name
         from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
          and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_name in ('places', 'place_links')`,
    );
    const rows = (result as { rows: Array<{ source: string; target: string; name: string }> }).rows;

    // Enumerated, not asserted one at a time: a later migration adding an FK to
    // a person table must fail here whatever it is called.
    const forbidden = rows.filter((row) => row.target === "members" || row.target === "minute_claims");
    assert.deepEqual(
      forbidden,
      [],
      `migration 043 removed donor addresses from this database on privacy grounds; ` +
        `these tables map decisions, not people: ${JSON.stringify(forbidden)}`,
    );

    // And the targets that are permitted, so a *new* target is visible in the
    // diff rather than silently allowed.
    const targets = [...new Set(rows.map((row) => row.target))].sort();
    assert.deepEqual(targets, ["jurisdictions", "places"]);
  });

  it("keeps the service's vocabularies identical to the CHECK constraints", async () => {
    const expected: Array<[string, readonly string[]]> = [
      ["places_kind_check", PLACE_KINDS],
      ["places_precision_check", PLACE_PRECISIONS],
      ["place_links_relation_check", PLACE_RELATIONS],
      ["place_links_confidence_check", PLACE_CONFIDENCE],
    ];

    for (const [name, values] of expected) {
      const result = await db.raw(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = ?",
        [name],
      );
      const rows = (result as { rows: Array<{ def: string }> }).rows;
      assert.equal(rows.length, 1, `${name} is missing from the database`);

      const quoted = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      assert.deepEqual(
        quoted.slice().sort(),
        values.slice().sort(),
        `${name} and the constant in services/places.ts have drifted`,
      );
    }
  });

  it("still refuses a swapped coordinate and a parcel precision", async () => {
    await assert.rejects(
      recordPlace(db, {
        jurisdiction_id: fixture.jurisdictionId,
        kind: "address",
        label: `${PREFIX} swapped`,
        // Bozeman's longitude in the latitude column — the classic geodata bug.
        lat: -111.0386,
        lon: 45.6796,
        precision: "block",
      }),
      /places_coords_check/,
    );

    await assert.rejects(
      db("places").insert({
        jurisdiction_id: fixture.jurisdictionId,
        kind: "address",
        label: `${PREFIX} parcel`,
        lat: NEAR.lat,
        lon: NEAR.lon,
        // Stage 2. A reader is never shown a precision we cannot honour.
        precision: "parcel",
      }),
      /places_precision_check/,
    );
  });
});

describe("parsing", () => {
  it("refuses a coordinate rather than inventing one", () => {
    assert.throws(() => parseCoordinate("", "-111.0386"), PlaceQueryError);
    assert.throws(() => parseCoordinate("  ", "-111.0386"), PlaceQueryError);
    assert.throws(() => parseCoordinate(undefined, "-111.0386"), PlaceQueryError);
    assert.throws(() => parseCoordinate("45.6796", "not-a-number"), PlaceQueryError);
    assert.throws(() => parseCoordinate("91", "0"), PlaceQueryError);
    assert.deepEqual(parseCoordinate("45.6796", "-111.0386"), CENTRE);
  });

  it("defaults the radius to 500 m and bounds it at 5 km", () => {
    assert.equal(parseRadius(undefined), 500);
    assert.equal(parseRadius("250"), 250);
    assert.equal(parseRadius(5000), 5000);
    assert.throws(() => parseRadius("5001"), PlaceQueryError);
    assert.throws(() => parseRadius("-1"), PlaceQueryError);
    assert.throws(() => parseRadius("wide"), PlaceQueryError);
  });
});
