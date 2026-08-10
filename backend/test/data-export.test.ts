import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import { EXPORT_DATASETS } from "../src/services/export/datasets";
import { csvField, cellToText } from "../src/services/export/serialize";
import {
  cleanupByPrefix,
  createArtifact,
  createMeeting,
  createSource,
  deleteArtifacts,
  sha256Of,
} from "./helpers/pressroom";

/**
 * The bulk export, and the one property that matters about it.
 *
 * An export is the largest public surface this product has. Every other public
 * path takes a meeting id, so a reader who cannot guess one cannot reach a
 * withheld record; P6's search takes a word, which is why it got its own wall
 * test. **The export takes nothing at all** — it hands over whole tables — so a
 * single missed predicate would empty the review queue onto the internet in one
 * file, and nobody would notice because the file would look exactly right.
 *
 * So the suite builds two of everything: one meeting an operator has published
 * and one they have not, with an identical agenda item, document, artifact,
 * vote and finding hanging off each. Then it walks **every dataset in both
 * formats** and asserts the withheld ids are absent and the published ids are
 * present. Both directions, because absence alone would also hold for a query
 * that is simply broken, and a broken query is indistinguishable from a correct
 * one on an empty database.
 *
 * The second property, asserted alongside: provenance. A row without its
 * artifact reference is a claim without a source, so the meeting, its agenda
 * items, its documents and its votes all carry the sha256 of the stored bytes
 * they came from.
 */

const PREFIX = "data-export-test";

/** Content addresses this suite owns, torn down by hand: artifacts do not cascade. */
const PUBLISHED_SHA = sha256Of(`${PREFIX}-published-agenda`);
const WITHHELD_SHA = sha256Of(`${PREFIX}-withheld-agenda`);
const PUBLISHED_MINUTES_SHA = sha256Of(`${PREFIX}-published-minutes`);

interface Ids {
  publishedMeeting: string;
  withheldMeeting: string;
  publishedItem: string;
  withheldItem: string;
  publishedDocument: string;
  withheldDocument: string;
  publishedVote: string;
  withheldVote: string;
  publicFinding: string;
  heldFinding: string;
  publishedArtifact: string;
  withheldArtifact: string;
  member: string;
}

const ids = {} as Ids;

async function insertReturningId(
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const [inserted] = await db(table).insert(row).returning<Array<{ id: string }>>("id");
  return inserted.id;
}

/** A meeting with the full apparatus underneath it: item, document, artifact, vote, finding. */
async function buildMeeting(
  commissionId: string,
  memberId: string,
  options: { published: boolean; sha: string; minutesSha?: string },
): Promise<{
  meeting: string;
  item: string;
  document: string;
  vote: string;
  finding: string;
  artifact: string;
}> {
  const meeting = await createMeeting(commissionId, {
    publishedAt: options.published ? new Date() : null,
    date: "2026-08-04",
    location: options.published ? "Published Chamber" : "Withheld Chamber",
  });

  const item = await insertReturningId("agenda_items", {
    meeting_id: meeting,
    item_number: 1,
    title: options.published ? `${PREFIX} published item` : `${PREFIX} withheld item`,
    description: "A resolution, with a comma and a \"quote\" in it.",
  });

  const document = await insertReturningId("meeting_documents", {
    meeting_id: meeting,
    title: `${PREFIX} agenda`,
    document_type: "agenda",
    url: `https://example.invalid/${options.sha.slice(0, 8)}/agenda.pdf`,
  });

  const artifact = await createArtifact(options.sha, `https://example.invalid/${options.sha}.pdf`);
  await db("document_versions").insert({
    meeting_document_id: document,
    artifact_id: artifact,
    version_no: 1,
    item_snapshot: null,
  });

  if (options.minutesSha !== undefined) {
    const minutesDocument = await insertReturningId("meeting_documents", {
      meeting_id: meeting,
      title: `${PREFIX} minutes`,
      document_type: "minutes",
      url: `https://example.invalid/${options.minutesSha.slice(0, 8)}/minutes.pdf`,
    });
    const minutesArtifact = await createArtifact(
      options.minutesSha,
      `https://example.invalid/${options.minutesSha}.pdf`,
    );
    await db("document_versions").insert({
      meeting_document_id: minutesDocument,
      artifact_id: minutesArtifact,
      version_no: 1,
      item_snapshot: null,
    });
  }

  const vote = await insertReturningId("votes", {
    meeting_id: meeting,
    agenda_item_id: item,
    member_id: memberId,
    vote: "yes",
  });

  const finding = await insertReturningId("anomaly_flags", {
    meeting_id: meeting,
    flag_type: "missing_minutes",
    severity: "low",
    description: options.published
      ? `${PREFIX} a published finding`
      : `${PREFIX} a held finding`,
    // Deliberately `published` on **both** meetings, including the withheld
    // one. That is the hostile case: a flag an operator approved sitting on a
    // meeting they have not published. Filtering on `review_state` alone would
    // export it, disclosing the withheld meeting's existence and a sentence of
    // its content — the hole `whereFindingPublic` was written to close. A held
    // finding on a published meeting is asserted separately below.
    review_state: "published",
    source: "auto",
  });

  return { meeting, item, document, vote, finding, artifact };
}

async function fetchJson(dataset: string): Promise<{
  rows: Array<Record<string, unknown>>;
  row_count: number;
  columns: string[];
}> {
  const res = await request(app).get(`/api/data/${dataset}.json`).expect(200);
  const text = res.text;
  return JSON.parse(text) as {
    rows: Array<Record<string, unknown>>;
    row_count: number;
    columns: string[];
  };
}

async function fetchCsv(dataset: string): Promise<string> {
  const res = await request(app).get(`/api/data/${dataset}.csv`).expect(200);
  return res.text;
}

describe("the bulk data export", () => {
  let commissionId = "";

  before(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([PUBLISHED_SHA, WITHHELD_SHA, PUBLISHED_MINUTES_SHA]);

    const fixture = await createSource(PREFIX);
    commissionId = fixture.commissionId;

    ids.member = await insertReturningId("members", {
      jurisdiction_id: fixture.jurisdictionId,
      name: `${PREFIX} Official`,
      title: "Commissioner",
      term_start: "2025-01-01",
    });

    const published = await buildMeeting(commissionId, ids.member, {
      published: true,
      sha: PUBLISHED_SHA,
      minutesSha: PUBLISHED_MINUTES_SHA,
    });
    const withheld = await buildMeeting(commissionId, ids.member, {
      published: false,
      sha: WITHHELD_SHA,
    });

    ids.publishedMeeting = published.meeting;
    ids.publishedItem = published.item;
    ids.publishedDocument = published.document;
    ids.publishedVote = published.vote;
    ids.publicFinding = published.finding;
    ids.publishedArtifact = published.artifact;

    ids.withheldMeeting = withheld.meeting;
    ids.withheldItem = withheld.item;
    ids.withheldDocument = withheld.document;
    ids.withheldVote = withheld.vote;
    ids.heldFinding = withheld.finding;
    ids.withheldArtifact = withheld.artifact;
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await deleteArtifacts([PUBLISHED_SHA, WITHHELD_SHA, PUBLISHED_MINUTES_SHA]);
    await db.destroy();
  });

  /* ------------------------------------------------------------- the wall */

  it("never exports a row belonging to an unpublished meeting, in JSON", async () => {
    const cases: Array<[string, string, string]> = [
      ["meetings", ids.publishedMeeting, ids.withheldMeeting],
      ["agenda_items", ids.publishedItem, ids.withheldItem],
      ["meeting_documents", ids.publishedDocument, ids.withheldDocument],
      ["votes", ids.publishedVote, ids.withheldVote],
      ["findings", ids.publicFinding, ids.heldFinding],
      ["artifacts", ids.publishedArtifact, ids.withheldArtifact],
    ];

    for (const [dataset, present, absent] of cases) {
      const body = await fetchJson(dataset);
      const rowIds = body.rows.map((row) => row.id);
      assert.ok(
        rowIds.includes(present),
        `${dataset}: the published row is missing, so absence proves nothing`,
      );
      assert.ok(
        !rowIds.includes(absent),
        `${dataset}: a withheld row reached the public export`,
      );
      assert.equal(body.row_count, body.rows.length);
    }
  });

  it("never exports a row belonging to an unpublished meeting, in CSV", async () => {
    const cases: Array<[string, string, string]> = [
      ["meetings", ids.publishedMeeting, ids.withheldMeeting],
      ["agenda_items", ids.publishedItem, ids.withheldItem],
      ["meeting_documents", ids.publishedDocument, ids.withheldDocument],
      ["votes", ids.publishedVote, ids.withheldVote],
      ["findings", ids.publicFinding, ids.heldFinding],
      ["artifacts", ids.publishedArtifact, ids.withheldArtifact],
    ];

    for (const [dataset, present, absent] of cases) {
      const csv = await fetchCsv(dataset);
      assert.ok(csv.includes(present), `${dataset}: the published row is missing from the CSV`);
      assert.ok(!csv.includes(absent), `${dataset}: a withheld row reached the public CSV`);
    }
  });

  it("never exports the content address of a withheld meeting's document", async () => {
    // The sharpest version of the leak. `artifacts.source_url` on a withheld
    // meeting's document carries that meeting's URL, and a Granicus URL carries
    // its title in the query string — so an unfiltered artifacts table would
    // disclose the withheld record through a dataset that looks like hashes.
    for (const dataset of ["artifacts", "artifact_references"]) {
      const csv = await fetchCsv(dataset);
      assert.ok(csv.includes(PUBLISHED_SHA), `${dataset}: the published artifact is missing`);
      assert.ok(!csv.includes(WITHHELD_SHA), `${dataset}: a withheld content address was exported`);
    }
  });

  it("publishing the meeting makes its whole record appear", async () => {
    await db("meetings").where({ id: ids.withheldMeeting }).update({ published_at: new Date() });
    try {
      for (const [dataset, id] of [
        ["meetings", ids.withheldMeeting],
        ["agenda_items", ids.withheldItem],
        ["meeting_documents", ids.withheldDocument],
        ["votes", ids.withheldVote],
        ["findings", ids.heldFinding],
        ["artifacts", ids.withheldArtifact],
      ] as Array<[string, string]>) {
        const body = await fetchJson(dataset);
        assert.ok(
          body.rows.some((row) => row.id === id),
          `${dataset}: publishing the meeting did not surface its row, so the filter is not the wall`,
        );
      }
    } finally {
      await db("meetings").where({ id: ids.withheldMeeting }).update({ published_at: null });
    }
  });

  it("holds a finding back even when its meeting is published", async () => {
    await db("anomaly_flags").where({ id: ids.publicFinding }).update({ review_state: "held" });
    try {
      const body = await fetchJson("findings");
      assert.ok(
        !body.rows.some((row) => row.id === ids.publicFinding),
        "a held finding reached the export through a published meeting",
      );
    } finally {
      await db("anomaly_flags")
        .where({ id: ids.publicFinding })
        .update({ review_state: "published" });
    }
  });

  /* ------------------------------------------------------------ provenance */

  it("carries the source artifact's content address on every derived row", async () => {
    const meetings = await fetchJson("meetings");
    const meeting = meetings.rows.find((row) => row.id === ids.publishedMeeting);
    assert.ok(meeting);
    assert.equal(meeting.source_artifact_sha256, PUBLISHED_SHA);

    const items = await fetchJson("agenda_items");
    const item = items.rows.find((row) => row.id === ids.publishedItem);
    assert.ok(item);
    assert.equal(item.source_artifact_sha256, PUBLISHED_SHA);

    const documents = await fetchJson("meeting_documents");
    const document = documents.rows.find((row) => row.id === ids.publishedDocument);
    assert.ok(document);
    assert.equal(document.source_artifact_sha256, PUBLISHED_SHA);

    // A vote is read out of minutes where minutes exist, so it cites those and
    // not the agenda.
    const votes = await fetchJson("votes");
    const vote = votes.rows.find((row) => row.id === ids.publishedVote);
    assert.ok(vote);
    assert.equal(vote.source_artifact_sha256, PUBLISHED_MINUTES_SHA);
  });

  it("maps every stored document version to its artifact and original URL", async () => {
    const body = await fetchJson("artifact_references");
    const row = body.rows.find((entry) => entry.sha256 === PUBLISHED_SHA);
    assert.ok(row, "the published agenda has no provenance row");
    assert.equal(row.meeting_id, ids.publishedMeeting);
    assert.equal(row.document_type, "agenda");
    assert.equal(row.version_no, 1);
    assert.equal(typeof row.source_url, "string");
  });

  it("never exports the MinIO object key", async () => {
    // `storage_key` is an internal address for bytes this project does not
    // redistribute. The useful half of an artifact row is the content address
    // and the URL the government published it at.
    const body = await fetchJson("artifacts");
    assert.ok(!body.columns.includes("storage_key"));
    const csv = await fetchCsv("artifacts");
    assert.ok(!csv.includes("storage_key"));
    assert.ok(!csv.includes("artifacts/"));
  });

  /* -------------------------------------------------------------- manifest */

  it("describes itself, computed rather than maintained", async () => {
    const res = await request(app).get("/api/data").expect(200);
    const manifest = res.body as {
      datasets: Array<{ name: string; columns: string[]; row_count: number }>;
      license: { dataset: { name: string }; code: { name: string } };
      schema_migration: string | null;
      publication_rule: string;
    };

    assert.equal(manifest.datasets.length, EXPORT_DATASETS.length);
    assert.equal(manifest.license.dataset.name, "CC BY 4.0");
    assert.equal(manifest.license.code.name, "MIT");
    assert.ok(manifest.schema_migration !== null, "the manifest states no schema version");
    assert.match(manifest.publication_rule, /published/i);

    // The declared columns are the published contract. A query that grows a
    // column and a manifest that does not are a disagreement no reader can see.
    for (const dataset of manifest.datasets) {
      const body = await fetchJson(dataset.name);
      assert.deepEqual(body.columns, dataset.columns, `${dataset.name}: column drift`);
      assert.equal(body.row_count, dataset.row_count, `${dataset.name}: row count drift`);
      for (const row of body.rows) {
        assert.deepEqual(
          Object.keys(row),
          dataset.columns,
          `${dataset.name}: a row does not match the declared columns`,
        );
      }
    }
  });

  it("refuses an unknown dataset and says what exists", async () => {
    const res = await request(app).get("/api/data/operators.json").expect(404);
    const body = res.body as { datasets: string[] };
    assert.ok(!body.datasets.includes("operators"));
    assert.ok(body.datasets.includes("meetings"));
    await request(app).get("/api/data/meetings.xml").expect(404);
  });

  it("does not export a table holding subscriber or operator identity", async () => {
    const names = EXPORT_DATASETS.map((dataset) => dataset.name);
    for (const withheld of [
      "operators",
      "operator_sessions",
      "alert_subscriptions",
      "notifications",
      "delivery_channels",
      "deliveries",
      "record_disputes",
      "records_requests",
      "document_embeddings",
      "http_cache",
    ]) {
      assert.ok(!names.includes(withheld), `${withheld} is in the public export`);
    }
  });

  /* ------------------------------------------------------------- RFC 4180 */

  it("quotes a CSV field the way RFC 4180 says to", () => {
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField("a,b"), '"a,b"');
    assert.equal(csvField('say "no"'), '"say ""no"""');
    assert.equal(csvField("line\nbreak"), '"line\nbreak"');
    assert.equal(csvField(null), "");
    assert.equal(csvField(undefined), "");
  });

  it("renders a timestamp as UTC ISO 8601, never in the server's zone", () => {
    assert.equal(cellToText(new Date("2026-08-04T19:30:00Z")), "2026-08-04T19:30:00.000Z");
    assert.equal(cellToText({ level: "low" }), '{"level":"low"}');
  });

  it("keeps a comma in an agenda item title inside one CSV field", async () => {
    const csv = await fetchCsv("agenda_items");
    const line = csv.split("\r\n").find((row) => row.startsWith(ids.publishedItem));
    assert.ok(line, "the published agenda item is not in the CSV");
    assert.ok(
      line.includes('"A resolution, with a comma and a ""quote"" in it."'),
      "the description was not quoted and escaped",
    );
  });
});
