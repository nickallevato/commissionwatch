import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import db from "../src/config/database";
import { createAdapterRegistry } from "../src/services/ingestion/adapters/registry";
import {
  sha256Hex,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type SourceAdapter,
  type SourceDescriptor,
} from "../src/services/ingestion/adapters/types";
import {
  artifactStorageKey,
  createArtifactStore,
  createIngestionHandlers,
  parseDocumentRefMetadata,
  type ArtifactWriter,
} from "../src/services/ingestion/handlers";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { registerSource } from "../src/services/ingestion/registration";
import { SourceScheduler } from "../src/services/ingestion/scheduler";
import { IngestionWorker } from "../src/services/ingestion/worker";

/**
 * The full sweep, end to end, with the county replaced by a fixture.
 *
 * The adapter serves the Gallatin agenda PDF captured on 2026-08-04 out of
 * `test/fixtures/gallatin/` and a Word document's leading bytes, so the whole
 * pipeline — discover, fetch, artifact, parse, agenda items — runs against a
 * real database and a real PDF with no network at all.
 */

const JURISDICTION_NAME = "Handler Test County";
const ADAPTER_KEY = "handler-test-adapter";
const BODY_KEY = "handler-test-board";
const BODY_NAME = "Handler Test Board";
const AGENDA_URL = "https://example.invalid/AgendaCenter/ViewFile/Agenda/_06022025-2";
const WORD_URL = "https://example.invalid/AgendaCenter/ViewFile/Agenda/_08062026-108";

const FIXTURE_DIR = join(__dirname, "fixtures", "gallatin");
const AGENDA_PDF = new Uint8Array(readFileSync(join(FIXTURE_DIR, "viewfile-agenda-06022025-2.pdf")));
/** `PK\x03\x04` — the first bytes of any OOXML file. Gallatin really serves these. */
const WORD_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);

const WORD_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function meetingRef(externalId: string, date: string, documents: DocumentRef[]): MeetingRef {
  return {
    sourceKey: ADAPTER_KEY,
    bodyKey: BODY_KEY,
    date,
    timezone: "America/Denver",
    status: "completed",
    title: `Regular Meeting ${date}`,
    externalId,
    sourceUrl: "https://example.invalid/AgendaCenter",
    documents,
  };
}

function documentRef(url: string, kind: DocumentRef["kind"], title: string): DocumentRef {
  return { sourceKey: ADAPTER_KEY, kind, title, url };
}

interface FixtureAdapterOptions {
  meetings: MeetingRef[];
  bytesByUrl: Map<string, { bytes: Uint8Array; contentType: string }>;
}

function createFixtureAdapter(options: FixtureAdapterOptions): SourceAdapter {
  return {
    key: ADAPTER_KEY,
    describeSource(): SourceDescriptor {
      return {
        key: ADAPTER_KEY,
        jurisdiction: { name: JURISDICTION_NAME, state: "MT", type: "county" },
        bodies: [
          { key: BODY_KEY, name: BODY_NAME, listingUrl: "https://example.invalid/AgendaCenter" },
        ],
        baseUrls: ["https://example.invalid"],
        politeness: {
          minDelayMs: 2000,
          maxConcurrency: 1,
          userAgent: "CommissionWatch/0.1 (test)",
          respectRobotsTxt: true,
          maxRetries: 1,
        },
        supportsLiveFetch: true,
      };
    },
    async discoverMeetings(): Promise<MeetingRef[]> {
      return options.meetings;
    },
    async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
      const entry = options.bytesByUrl.get(ref.url);
      if (entry === undefined) throw new Error(`no fixture bytes for ${ref.url}`);
      return {
        bytes: entry.bytes,
        contentType: entry.contentType,
        sourceUrl: ref.url,
        sha256: sha256Hex(entry.bytes),
        byteSize: entry.bytes.length,
        fetchedAt: new Date().toISOString(),
        ref,
      };
    },
  };
}

/** An object store in memory: no MinIO required to exercise the fetch stage. */
class MemoryArtifacts implements ArtifactWriter {
  readonly objects = new Map<string, Buffer>();
  async write(key: string, bytes: Uint8Array, _contentType: string | null): Promise<void> {
    this.objects.set(key, Buffer.from(bytes));
  }
  read = async (key: string): Promise<Buffer> => {
    const found = this.objects.get(key);
    if (!found) throw new Error(`no bytes at ${key}`);
    return found;
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let sourceId: string;
let jurisdictionId: string;

/**
 * Order matters since migration 034. `document_versions.artifact_id` has no
 * `ON DELETE CASCADE` — a version row losing its evidence silently would leave
 * a citation pointing at nothing — so the citing rows come out first. Dropping
 * the jurisdiction cascades commissions, meetings, documents and their
 * versions; only then is the artifact unreferenced.
 */
async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
  const shas = [sha256Hex(AGENDA_PDF), sha256Hex(WORD_BYTES)];
  await db("artifacts").whereIn("sha256", shas).del();
}

interface Harness {
  scheduler: SourceScheduler;
  artifacts: MemoryArtifacts;
}

function buildHarness(adapter: SourceAdapter): Harness {
  const registry = createAdapterRegistry([adapter]);
  const artifacts = new MemoryArtifacts();
  const queue = new IngestionQueue(db, { maxAttempts: 1 });
  const worker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({ db, registry, artifacts, logger: silentLogger }),
    artifacts: createArtifactStore(artifacts.read),
    batchSize: 1,
    logger: silentLogger,
  });
  const scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry,
    logger: silentLogger,
    enabled: true,
    sweepTimeoutMs: 30_000,
  });
  return { scheduler, artifacts };
}

const bytesByUrl = new Map([
  [AGENDA_URL, { bytes: AGENDA_PDF, contentType: "application/pdf" }],
  [WORD_URL, { bytes: WORD_BYTES, contentType: WORD_CONTENT_TYPE }],
]);

const ONE_MEETING = [
  meetingRef("06022025-2", "2025-06-02", [documentRef(AGENDA_URL, "agenda", "June 2 Agenda")]),
];

before(async () => {
  await removeFixtures();
  const registered = await registerSource(db, createFixtureAdapter({ meetings: [], bytesByUrl }), {
    enabled: true,
  });
  sourceId = registered.sourceId;
  jurisdictionId = registered.jurisdictionId;
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_runs").where({ source_id: sourceId }).del();
  // Meetings before artifacts: deleting a meeting cascades to its documents and
  // their `document_versions`, which is what releases the artifact. See
  // `removeFixtures`.
  const commissions = await db("commissions").where({ jurisdiction_id: jurisdictionId }).select("id");
  for (const commission of commissions) {
    await db("meetings").where({ commission_id: commission.id }).del();
  }
  await db("artifacts")
    .whereIn("sha256", [sha256Hex(AGENDA_PDF), sha256Hex(WORD_BYTES)])
    .del();
});

describe("registerSource", () => {
  it("creates the jurisdiction, commission and source from the descriptor alone", async () => {
    const jurisdiction = await db("jurisdictions").where({ id: jurisdictionId }).first();
    assert.equal(jurisdiction.name, JURISDICTION_NAME);
    const commission = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: BODY_NAME })
      .first();
    assert.ok(commission, "expected a commission for the declared body");
    const source = await db("ingestion_sources").where({ id: sourceId }).first();
    assert.equal(source.adapter_key, ADAPTER_KEY);
    assert.equal(source.cron_expression, "17 7 * * *");
  });

  it("is idempotent — a second call adds nothing", async () => {
    const before_ = await db("ingestion_sources").where({ jurisdiction_id: jurisdictionId }).count();
    await registerSource(db, createFixtureAdapter({ meetings: [], bytesByUrl }), { enabled: true });
    const after_ = await db("ingestion_sources").where({ jurisdiction_id: jurisdictionId }).count();
    assert.deepEqual(after_, before_);
  });
});

describe("parseDocumentRefMetadata", () => {
  it("round-trips a document ref through a job target", () => {
    const ref = documentRef(AGENDA_URL, "agenda", "June 2 Agenda");
    assert.deepEqual(parseDocumentRefMetadata({ ref }), ref);
  });

  it("refuses an unknown document kind rather than passing it to an adapter", () => {
    assert.throws(
      () => parseDocumentRefMetadata({ ref: { ...documentRef(AGENDA_URL, "agenda", "x"), kind: "video" } }),
      TypeError,
    );
  });

  it("refuses metadata with no ref at all", () => {
    assert.throws(() => parseDocumentRefMetadata({}), TypeError);
  });
});

describe("artifactStorageKey", () => {
  it("shards on the content address so one prefix never holds everything", () => {
    const sha = "a".repeat(64);
    assert.equal(artifactStorageKey(sha), `artifacts/aa/${sha}`);
  });
});

describe("a full sweep", () => {
  it("lands meetings, documents, an artifact and agenda items", async () => {
    const adapter = createFixtureAdapter({ meetings: ONE_MEETING, bytesByUrl });
    const { scheduler, artifacts } = buildHarness(adapter);

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    assert.equal(outcome.status, "succeeded", `run error: ${outcome.error}`);

    const commission = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: BODY_NAME })
      .first();
    const meetings = await db("meetings").where({ commission_id: commission.id });
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].external_id, "06022025-2");
    assert.equal(meetings[0].agenda_url, AGENDA_URL);

    const documents = await db("meeting_documents").where({ meeting_id: meetings[0].id });
    assert.equal(documents.length, 1);
    assert.equal(documents[0].document_type, "agenda");

    const artifact = await db("artifacts").where({ sha256: sha256Hex(AGENDA_PDF) }).first();
    assert.ok(artifact, "expected the fetched bytes to be recorded");
    assert.equal(artifact.storage_key, artifactStorageKey(sha256Hex(AGENDA_PDF)));
    assert.ok(artifacts.objects.has(artifact.storage_key), "expected the bytes to be stored");

    const items = await db("agenda_items").where({ meeting_id: meetings[0].id });
    assert.ok(items.length > 0, "expected agenda items from a real agenda PDF");
    assert.equal(outcome.counts.agenda_items_written, items.length);
  });

  it("is idempotent — a second sweep duplicates nothing", async () => {
    const adapter = createFixtureAdapter({ meetings: ONE_MEETING, bytesByUrl });
    const { scheduler } = buildHarness(adapter);

    await scheduler.sweepSource(sourceId);
    const first = await db("agenda_items").count({ total: "*" }).first();
    const second = await scheduler.sweepSource(sourceId);

    const commission = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: BODY_NAME })
      .first();
    const meetings = await db("meetings").where({ commission_id: commission.id });
    assert.equal(meetings.length, 1, "a nightly re-sweep must not duplicate the meeting");
    const documents = await db("meeting_documents").where({ meeting_id: meetings[0].id });
    assert.equal(documents.length, 1, "nor the document");
    const after_ = await db("agenda_items").count({ total: "*" }).first();
    assert.deepEqual(after_, first, "nor the agenda items");

    // The unchanged document collides on artifacts.sha256, so it is never
    // re-parsed. That is the politeness rule expressed as a constraint.
    assert.equal(second.kind, "ran");
    if (second.kind !== "ran") return;
    assert.equal(second.counts.artifacts_unchanged, 1);
    assert.equal(second.counts.artifacts_stored, undefined);
  });

  it("records an unreadable content type as a skip, not a failure", async () => {
    const meetings = [
      meetingRef("08062026-108", "2026-08-06", [
        documentRef(WORD_URL, "agenda", "August 6 Agenda"),
      ]),
    ];
    const { scheduler } = buildHarness(createFixtureAdapter({ meetings, bytesByUrl }));

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    // Gallatin genuinely serves Word documents behind ViewFile/Agenda paths.
    // The bytes are held and the gap is counted; nothing failed.
    assert.equal(outcome.status, "succeeded", `run error: ${outcome.error}`);
    assert.equal(outcome.counts.parse_unsupported, 1);
    assert.equal(outcome.counts.failed, undefined);
    const artifact = await db("artifacts").where({ sha256: sha256Hex(WORD_BYTES) }).first();
    assert.ok(artifact, "the document is still stored even though it cannot be parsed");
  });

  it("does not attribute a meeting to a body no commission exists for", async () => {
    const stray = { ...ONE_MEETING[0], bodyKey: "a-body-nobody-configured" };
    const { scheduler } = buildHarness(
      createFixtureAdapter({ meetings: [stray], bytesByUrl }),
    );

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    assert.equal(outcome.counts.meetings_unattributed, 1);
    // A zero delta is not merged into the run's tallies, so the absence of the
    // key is how "nothing was inserted" reads.
    assert.equal(outcome.counts.meetings_inserted ?? 0, 0);
    const commission = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: BODY_NAME })
      .first();
    const meetings = await db("meetings").where({ commission_id: commission.id });
    assert.equal(meetings.length, 0, "a body nobody configured must not invent a commission");
  });

  it("reports a partial run when one document fails and the rest succeed", async () => {
    const meetings = [
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(AGENDA_URL, "agenda", "June 2 Agenda"),
        documentRef("https://example.invalid/missing.pdf", "minutes", "June 2 Minutes"),
      ]),
    ];
    const { scheduler } = buildHarness(createFixtureAdapter({ meetings, bytesByUrl }));

    const outcome = await scheduler.sweepSource(sourceId);
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    // Work happened AND something broke. That is 'partial', and the enum is not
    // allowed to collapse it into either neighbour.
    assert.equal(outcome.status, "partial");
    assert.match(String(outcome.error), /no fixture bytes/);

    const commission = await db("commissions")
      .where({ jurisdiction_id: jurisdictionId, name: BODY_NAME })
      .first();
    const meetingRows = await db("meetings").where({ commission_id: commission.id });
    assert.equal(meetingRows.length, 1, "the meeting still landed");
    const items = await db("agenda_items").where({ meeting_id: meetingRows[0].id });
    assert.ok(items.length > 0, "and so did the agenda that did fetch");
  });
});
