import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import express from "express";

import db from "../src/config/database";
import { errorHandler } from "../src/middleware/errorHandler";
import placesRouter from "../src/routes/places";
import { extractDocumentText } from "../src/services/ingestion/document-text";
import { extractAgendaItems } from "../src/services/ingestion/agenda-items";
import { upsertAgendaItems } from "../src/services/ingestion/handlers";
import { placesNear } from "../src/services/places";
import { extractAddresses, relationFor, STREET_SUFFIXES } from "../src/services/locate/addresses";
import {
  censusPrecision,
  geocodeQuery,
  readCensusResponse,
  CENSUS_EXTERNAL_SOURCE,
  CENSUS_GEOCODER_NAME,
  type GeocodeResult,
  type Geocoder,
} from "../src/services/locate/census";
import { citeInArtifact, locateAgendaPlaces } from "../src/services/locate/run";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * Reading locations out of a real agenda, and refusing to invent one.
 *
 * `places` and `place_links` shipped with `recordPlace` and `linkPlace` having
 * no callers anywhere in `src/` — a working map over an empty table, and a
 * "within 500 metres of this address" subscription that returned nothing,
 * forever, without saying so. This suite covers the code that fills them.
 *
 * It runs against the **real** captured Bozeman City Commission agenda for
 * 2026-08-04, through the real HTML reader and the real agenda-item extractor,
 * because the whole feature turns on what titles actually look like. The
 * fixture's substantive land-use items read:
 *
 *   "Resolution, Adoption of the 133 Maus Lane Annexation, Annexing 5.13 acres
 *    Including Adjacent Right-of-Way, Application 25213"
 *   "Resolution, Adoption of the 1071 Story Mill Road Annexation, Annexing 1.173
 *    acres, Application 25525"
 *
 * and the traps sitting beside them read "Annexing 5.13 acres", "Task Order 5
 * with Cushing Terrell", "Program Year 3 Annual Action Plan" and "the 2024
 * Street and Utility Improvements Project". A regex tuned on imagined titles
 * pins all four.
 *
 * **Nothing here calls the network.** The geocoder arrives as an injected
 * `Geocoder`, the way `extraction.test.ts` injects `fetchImpl` into the
 * OpenRouter client. Its canned answers are the literal responses recorded from
 * the US Census geocoder on 2026-08-15, so the coordinates and the precision
 * under test are the ones the real service returns.
 */

const PREFIX = "place-extraction-test";

const AGENDA_PATH = join(
  __dirname,
  "fixtures",
  "bozeman-granicus",
  "agendaviewer-clip2784.html",
);

const SHA = sha256Of(`${PREFIX}-agenda`);

/**
 * Real responses, recorded 2026-08-15 from
 * `geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current`.
 *
 * Every one of them carries a `tigerLine`, which is what makes them `block` and
 * never `exact`: the service interpolates a house number along a street segment
 * from its address range. It does not do rooftop matching, and a map that drew
 * these as rooftop pins would be lying at a resolution the reader cannot see.
 */
const CENSUS_ANSWERS: Record<string, GeocodeResult> = {
  "133 Maus Lane": {
    lat: 45.701959309284,
    lon: -111.043593591292,
    precision: "block",
    matchedAddress: "133 MAUS LN, BOZEMAN, MT, 59715",
    geocoder: CENSUS_GEOCODER_NAME,
  },
  "1071 Story Mill Road": {
    lat: 45.705155001374,
    lon: -111.021294126745,
    precision: "block",
    matchedAddress: "1071 STORY MILL RD, BOZEMAN, MT, 59715",
    geocoder: CENSUS_GEOCODER_NAME,
  },
  "5211 Baxter Lane": {
    lat: 45.700223477954,
    lon: -111.111044957614,
    precision: "block",
    matchedAddress: "5211 BAXTER LN, BOZEMAN, MT, 59718",
    geocoder: CENSUS_GEOCODER_NAME,
  },
};

/** The verbatim body the probe returned for "133 Maus Lane, Bozeman, MT". */
const CENSUS_BODY = {
  result: {
    input: { address: { address: "133 Maus Lane, Bozeman, MT" } },
    benchmark: { id: "4", benchmarkName: "Public_AR_Current", isDefault: true },
    addressMatches: [
      {
        tigerLine: { side: "L", tigerLineId: "640478172" },
        coordinates: { x: -111.043593591292, y: 45.701959309284 },
        addressComponents: {
          zip: "59715",
          streetName: "MAUS",
          city: "BOZEMAN",
          state: "MT",
          fromAddress: "101",
          toAddress: "199",
          suffixType: "LN",
        },
        matchedAddress: "133 MAUS LN, BOZEMAN, MT, 59715",
      },
    ],
  },
};

/** The verbatim body for "99999 Nowhere Boulevard, Bozeman, MT": HTTP 200, no matches. */
const CENSUS_NO_MATCH = {
  result: {
    input: { address: { address: "99999 Nowhere Boulevard, Bozeman, MT" } },
    benchmark: { id: "4", benchmarkName: "Public_AR_Current", isDefault: true },
    addressMatches: [],
  },
};

/**
 * The geocoder, stubbed on the address rather than the whole query.
 *
 * Keyed on the part before the first comma so the suite is not also a test of
 * how `geocodeQuery` spells a jurisdiction — that has its own assertions below,
 * against its own probe evidence.
 */
class StubGeocoder implements Geocoder {
  readonly queries: string[] = [];

  async locate(query: string): Promise<GeocodeResult | null> {
    this.queries.push(query);
    const address = query.split(",")[0].trim();
    return CENSUS_ANSWERS[address] ?? null;
  }
}

interface Fixture {
  jurisdictionId: string;
  meetingId: string;
  documentText: string;
  titles: string[];
}

let fixture: Fixture;

const app = express();
app.use("/api/places", placesRouter);
app.use(errorHandler);

before(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA]);

  const source = await createSource(PREFIX);
  await createArtifact(SHA, "https://bozeman.granicus.com/AgendaViewer.php?clip_id=2784");

  const meetingId = await createMeeting(source.commissionId, {
    publishedAt: new Date(),
    date: "2026-08-04",
  });

  // The real reader over the real bytes, joined exactly as `handlers.ts` joins
  // them before writing `artifact_texts`. The offsets this suite asserts on are
  // therefore in the same space every other citation in this database uses.
  const bytes = readFileSync(AGENDA_PATH);
  const text = await extractDocumentText(bytes, "text/html");
  const documentText = text.lines.join("\n");

  const extraction = extractAgendaItems(text.lines);
  await upsertAgendaItems(db, meetingId, extraction.items);

  fixture = {
    jurisdictionId: source.jurisdictionId,
    meetingId,
    documentText,
    titles: extraction.items.map((item) => item.title),
  };
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await deleteArtifacts([SHA]);
  await db.destroy();
});

function titleContaining(needle: string): string {
  const found = fixture.titles.find((title) => title.includes(needle));
  assert.ok(found, `the fixture agenda no longer contains a title mentioning "${needle}"`);
  return found;
}

describe("the address pattern, against real agenda titles", () => {
  it("reads the address out of a Bozeman annexation title", () => {
    const title = titleContaining("133 Maus Lane");
    const mentions = extractAddresses(title);

    assert.deepEqual(
      mentions.map((mention) => mention.text),
      ["133 Maus Lane"],
      // The whole point of rule 2 in `addresses.ts`: the greedy reading is
      // "133 Maus Lane Annexation", and a place labelled that is a place
      // nothing can geocode.
      `expected exactly the address, got ${JSON.stringify(mentions)} from "${title}"`,
    );
    assert.equal(title.slice(mentions[0].index, mentions[0].index + 13), "133 Maus Lane");
  });

  it("reads a two-word street name and stops at the suffix", () => {
    const title = titleContaining("1071 Story Mill Road");
    assert.deepEqual(
      extractAddresses(title).map((mention) => mention.text),
      ["1071 Story Mill Road"],
    );
  });

  it("finds nothing in the titles that merely contain numbers", () => {
    // Every one of these is real text from the same agenda, and every one of
    // them is a pin on the map if the suffix list is loose or the decimal guard
    // is missing.
    const traps = [
      "Authorize the City Manager to Sign Task Order 5 with Cushing Terrell for Analysis of a Housing Site in the Turnrow Subdivision",
      "Authorize the Mayor to Approve the CDBG Program Year 3 Annual Action Plan and Sign the Program Year 3 Allocation.",
      "Resolution Authorizing Change Order No. 5 with CK May Excavating, Inc. For the 2024 Street and Utility Improvements Project",
      "Formal Cancellation of the August 11, 2026, Regular City Commission Meeting",
      "Annexing 5.13 acres Including Adjacent Right-of-Way, Application 25213",
      "Annexing 1.173 acres, Application 25525",
      "Ordinance Final Adoption Dissolving Department of Strategic Services and Creating Department of Communications & Engagement",
    ];
    for (const trap of traps) {
      assert.deepEqual(extractAddresses(trap), [], `a false address came out of "${trap}"`);
    }
  });

  it("collapses the same address named twice in one title", () => {
    const twice =
      "Ordinance, Provisional Adoption, Establishing Zoning for the 133 Maus Lane " +
      "Annexation, Rezoning 133 Maus Lane";
    assert.deepEqual(
      extractAddresses(twice).map((mention) => mention.text),
      ["133 Maus Lane"],
    );
  });

  it("keeps `Project` and `Acres` out of the suffix list", () => {
    // Stated as an assertion rather than a comment, because adding one of these
    // is a one-word edit that would pin a dozen capital projects at once.
    for (const forbidden of ["Project", "Acres", "Plan", "District", "Park"]) {
      assert.ok(
        !(STREET_SUFFIXES as readonly string[]).includes(forbidden),
        `"${forbidden}" is a street suffix now, and every "... Year 3 Annual Action Plan" is an address`,
      );
    }
  });

  it("reserves subject_of for a title carrying a designator", () => {
    // `parseDesignator` in services/matters.ts, reused rather than reimplemented.
    assert.equal(relationFor("Ordinance 2145 rezoning 133 Maus Lane"), "subject_of");
    // And the honest result on the real corpus: Bozeman writes "Application
    // 25213" and "Resolution, Adoption of ...", neither of which that parser
    // matches, so its annexation items land on the weaker relation.
    assert.equal(relationFor(titleContaining("133 Maus Lane")), "affects");
  });
});

describe("the citation", () => {
  it("locates the address in the artifact and quotes the line around it", () => {
    const citation = citeInArtifact(fixture.documentText, "133 Maus Lane");
    assert.ok(citation, "the address does not locate in the agenda it was read from");

    // The invariant `place_links_citation_check` exists to make true: the offset
    // addresses the bytes, exactly.
    assert.equal(
      fixture.documentText.slice(citation.offset, citation.offset + citation.quote.length),
      citation.quote,
      "the stored offset does not address the stored quote",
    );
    assert.ok(
      citation.quote.includes("133 Maus Lane"),
      `the citation does not contain the address it cites: ${JSON.stringify(citation.quote)}`,
    );
    assert.ok(citation.quote.trim().length > 0);
  });

  it("returns null for a phrase the document does not contain", () => {
    assert.equal(citeInArtifact(fixture.documentText, "404 Nowhere Boulevard"), null);
  });
});

describe("the geocoder client, without touching the network", () => {
  it("reads the recorded Census response and never calls it exact", () => {
    const result = readCensusResponse(CENSUS_BODY);
    assert.ok(result, "the recorded Census body no longer parses");
    // x is longitude, y is latitude. Reversed, this is the Indian Ocean.
    assert.equal(result.lat, 45.701959309284);
    assert.equal(result.lon, -111.043593591292);
    assert.equal(result.matchedAddress, "133 MAUS LN, BOZEMAN, MT, 59715");
    assert.equal(result.geocoder, CENSUS_GEOCODER_NAME);

    // The honest mapping. A TIGER address-range interpolation is a block, and
    // this service does no rooftop matching at all, so `exact` is unreachable.
    assert.equal(result.precision, "block");
    assert.notEqual(result.precision, "exact");
    assert.equal(censusPrecision(CENSUS_BODY.result.addressMatches[0]), "block");
    assert.equal(censusPrecision({ coordinates: { x: -111, y: 45 } }), "centroid");
  });

  it("reads a 200 with no matches as no match", () => {
    // The probed shape for an address that is not real: the service does not
    // 404, so "not found" is a body to read rather than a status to catch.
    assert.equal(readCensusResponse(CENSUS_NO_MATCH), null);
    assert.equal(readCensusResponse(null), null);
    assert.equal(readCensusResponse({ result: {} }), null);
  });

  it("refuses to pick between two different matches", () => {
    const ambiguous = {
      result: {
        addressMatches: [
          { ...CENSUS_BODY.result.addressMatches[0] },
          {
            ...CENSUS_BODY.result.addressMatches[0],
            matchedAddress: "133 MAUS LN, BELGRADE, MT, 59714",
          },
        ],
      },
    };
    assert.equal(readCensusResponse(ambiguous), null);
  });

  it("omits a county name from the query and keeps a city", () => {
    // Probed 2026-08-15: "133 Maus Lane, Gallatin County, MT" returned zero
    // matches, and "5211 Baxter Lane, MT" returned the same match as the
    // city-qualified query. Sending the county as the city is the difference
    // between a county's agenda producing pins and producing nothing.
    assert.equal(
      geocodeQuery("133 Maus Lane", { name: "Gallatin County", state: "MT" }),
      "133 Maus Lane, MT",
    );
    assert.equal(
      geocodeQuery("133 Maus Lane", { name: "City of Bozeman", state: "MT" }),
      "133 Maus Lane, Bozeman, MT",
    );
  });
});

describe("locating a real agenda", () => {
  it("writes a cited, held link per address and nothing for the rest", async () => {
    const geocoder = new StubGeocoder();
    const tally = await locateAgendaPlaces(db, geocoder, {
      meetingId: fixture.meetingId,
      artifactSha256: SHA,
      documentText: fixture.documentText,
    });

    assert.ok(tally.items > 10, `only ${tally.items} agenda items were read`);
    assert.ok(tally.links > 0, "a real agenda full of annexations produced no place link");
    assert.equal(tally.uncited, 0, "an address was found that does not locate in its own agenda");

    const links = await db("place_links as pl")
      .join("places as p", "p.id", "pl.place_id")
      .where("p.jurisdiction_id", fixture.jurisdictionId)
      .select<
        Array<{
          status: string;
          confidence: string;
          artifact_sha256: string | null;
          quote: string | null;
          quote_offset: number | null;
          label: string;
          precision: string;
          geocoder: string | null;
          geocoded_at: Date | null;
          external_source: string | null;
          external_ref: string | null;
        }>
      >(
        "pl.status",
        "pl.confidence",
        "pl.artifact_sha256",
        "pl.quote",
        "pl.quote_offset",
        "p.label",
        "p.precision",
        "p.geocoder",
        "p.geocoded_at",
        "p.external_source",
        "p.external_ref",
      );

    assert.equal(links.length, tally.links);
    for (const link of links) {
      assert.equal(link.status, "held", "a place link auto-published");
      assert.notEqual(link.confidence, "inferred");
      assert.equal(link.artifact_sha256, SHA);
      assert.ok(link.quote && link.quote.trim().length > 0);
      assert.ok(typeof link.quote_offset === "number" && link.quote_offset >= 0);
      // The offset addresses the artifact, not some other rendering of it.
      assert.equal(
        fixture.documentText.slice(link.quote_offset, link.quote_offset + link.quote.length),
        link.quote,
      );

      // Never more precise than the geocoder supports, and always accountable.
      assert.equal(link.precision, "block");
      assert.notEqual(link.precision, "exact");
      assert.equal(link.geocoder, CENSUS_GEOCODER_NAME);
      assert.ok(link.geocoded_at instanceof Date);
      assert.equal(link.external_source, CENSUS_EXTERNAL_SOURCE);
      assert.ok(link.external_ref && link.external_ref.length > 0);
    }

    const labels = links.map((link) => link.label);
    assert.ok(labels.includes("133 Maus Lane"), `no Maus Lane link: ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("1071 Story Mill Road"));

    // Silently and correctly: the geocoder was never asked about the acreage,
    // the task order or the program year.
    for (const query of geocoder.queries) {
      assert.match(query, /^\d/, `the geocoder was asked about "${query}"`);
    }
  });

  it("is invisible on /api/places/near until an operator approves it", async () => {
    const near = async (): Promise<string[]> => {
      const rows = await placesNear(db, {
        lat: 45.701959309284,
        lon: -111.043593591292,
        metres: 500,
        jurisdictionId: fixture.jurisdictionId,
      });
      return rows.map((row) => row.label);
    };

    assert.deepEqual(await near(), [], "a held link was published");

    const res = await request(app)
      .get(
        "/api/places/near?lat=45.701959309284&lon=-111.043593591292&radius=500" +
          `&jurisdiction_id=${fixture.jurisdictionId}`,
      )
      .expect(200);
    assert.deepEqual((res.body as { data: unknown[] }).data, []);

    const suitePlaces = db("places")
      .where({ jurisdiction_id: fixture.jurisdictionId })
      .select("id");

    const approved = await db("place_links")
      .whereIn(
        "place_id",
        db("places").where({ jurisdiction_id: fixture.jurisdictionId, label: "133 Maus Lane" }).select("id"),
      )
      .update({ status: "approved" });
    // Two, on this agenda: the annexation resolution and the zoning ordinance
    // that follows it both name the same address, and both are links to the one
    // place.
    assert.ok(approved > 0, "the Maus Lane link is missing");

    try {
      assert.deepEqual(await near(), ["133 Maus Lane"], "approval did not publish the link");
    } finally {
      await db("place_links").whereIn("place_id", suitePlaces).update({ status: "held" });
    }
  });

  it("writes no duplicate when it runs over the same artifact again", async () => {
    const count = async (table: "places" | "place_links"): Promise<number> => {
      const query =
        table === "places"
          ? db("places").where({ jurisdiction_id: fixture.jurisdictionId })
          : db("place_links as pl")
              .join("places as p", "p.id", "pl.place_id")
              .where("p.jurisdiction_id", fixture.jurisdictionId);
      const rows = await query.count<[{ count: string }]>({ count: "*" });
      return Number(rows[0].count);
    };

    const placesBefore = await count("places");
    const linksBefore = await count("place_links");
    assert.ok(placesBefore > 0, "the first pass wrote nothing, so this proves nothing");

    const second = await locateAgendaPlaces(db, new StubGeocoder(), {
      meetingId: fixture.meetingId,
      artifactSha256: SHA,
      documentText: fixture.documentText,
    });

    assert.equal(await count("places"), placesBefore, "a re-run minted new place rows");
    assert.equal(await count("place_links"), linksBefore, "a re-run duplicated the held links");
    assert.equal(second.links, linksBefore);
  });
});

describe("the database refuses an uncited link", () => {
  it("rejects a stated link with no artifact, no quote or no offset", async () => {
    const [place] = await db("places")
      .insert({
        jurisdiction_id: fixture.jurisdictionId,
        kind: "address",
        label: `${PREFIX} uncited`,
        lat: 45.6796,
        lon: -111.0386,
        precision: "block",
      })
      .returning<Array<{ id: string }>>("id");

    const base = {
      place_id: place.id,
      subject_kind: "agenda_item",
      subject_id: "00000000-0000-0000-0000-000000000001",
      relation: "affects",
      confidence: "stated",
      status: "held",
    };

    // No citation at all.
    await assert.rejects(
      db("place_links").insert({ ...base }),
      /place_links_citation_check/,
      "a stated link with no citation was accepted",
    );

    // A quote and an offset, but nothing to resolve them against.
    await assert.rejects(
      db("place_links").insert({ ...base, quote: "133 Maus Lane", quote_offset: 12 }),
      /place_links_citation_check/,
    );

    // An artifact and an offset, but a blank quote — an offset into nothing.
    await assert.rejects(
      db("place_links").insert({
        ...base,
        artifact_sha256: SHA,
        quote: "   ",
        quote_offset: 12,
      }),
      /place_links_citation_check/,
    );

    // An artifact and a quote, but no offset: unlocatable, so uncitable.
    await assert.rejects(
      db("place_links").insert({ ...base, artifact_sha256: SHA, quote: "133 Maus Lane" }),
      /place_links_citation_check/,
    );

    await db("places").where({ id: place.id }).del();
  });
});
