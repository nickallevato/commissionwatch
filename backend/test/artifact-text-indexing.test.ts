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
  backfillArtifactText,
  findUnindexedArtifacts,
} from "../src/services/ingestion/backfill-artifact-text";
import {
  createArtifactStore,
  createIngestionHandlers,
  type ArtifactWriter,
} from "../src/services/ingestion/handlers";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { registerSource } from "../src/services/ingestion/registration";
import { SourceScheduler } from "../src/services/ingestion/scheduler";
import { IngestionWorker } from "../src/services/ingestion/worker";
import { rebuildMatters } from "../src/services/matters";

/**
 * Minutes are indexed, and the archive that was fetched before they were can be
 * caught up.
 *
 * The `parse` handler used to return `parse_not_agenda` before it reached
 * `recordArtifactText`, so `artifact_texts` — the table `services/search.ts`
 * reads for document bodies — held agendas and nothing else. Minutes are the
 * substance of the record and were the one class guaranteed to be missing.
 *
 * The whole sweep runs here against a real database and a real PDF with no
 * network, in the idiom `ingestion-handlers.test.ts` established.
 */

const JURISDICTION_NAME = "Text Indexing Test County";
const ADAPTER_KEY = "text-indexing-test-adapter";
const BODY_KEY = "text-indexing-test-board";
const BODY_NAME = "Text Indexing Test Board";
const AGENDA_URL = "https://example.invalid/AgendaCenter/ViewFile/Agenda/_06022025-2";
/** The same fixture bytes served as minutes. Only the declared kind differs. */
const MINUTES_URL = "https://example.invalid/AgendaCenter/ViewFile/Minutes/_06022025-2";

const FIXTURE_DIR = join(__dirname, "fixtures", "gallatin");
const DOCUMENT_PDF = new Uint8Array(readFileSync(join(FIXTURE_DIR, "viewfile-agenda-06022025-2.pdf")));

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

function createFixtureAdapter(meetings: MeetingRef[]): SourceAdapter {
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
      return meetings;
    },
    async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
      return {
        bytes: DOCUMENT_PDF,
        contentType: "application/pdf",
        sourceUrl: ref.url,
        sha256: sha256Hex(DOCUMENT_PDF),
        byteSize: DOCUMENT_PDF.length,
        fetchedAt: new Date().toISOString(),
        ref,
      };
    },
  };
}

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
let artifacts: MemoryArtifacts;

/**
 * Citing rows before cited ones. `document_versions.artifact_id` has no
 * `ON DELETE CASCADE`, so the artifact is only unreferenced once the
 * jurisdiction cascade has taken the meetings and their versions with it.
 */
async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
  await db("artifacts").where({ sha256: sha256Hex(DOCUMENT_PDF) }).del();
}

async function sweep(meetings: MeetingRef[]): Promise<void> {
  const adapter = createFixtureAdapter(meetings);
  const registry = createAdapterRegistry([adapter]);
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
  await scheduler.sweepSource(sourceId);
}

async function textRowFor(url: string): Promise<{ char_count: number; text: string } | undefined> {
  const row: unknown = await db("artifact_texts as at")
    .join("artifacts as a", "a.id", "at.artifact_id")
    .where("a.source_url", url)
    .first("at.char_count", "at.text");
  return typeof row === "object" && row !== null
    ? (row as { char_count: number; text: string })
    : undefined;
}

before(async () => {
  await removeFixtures();
  artifacts = new MemoryArtifacts();
  const registered = await registerSource(db, createFixtureAdapter([]), { enabled: true });
  sourceId = registered.sourceId;
  jurisdictionId = registered.jurisdictionId;
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_runs").where({ source_id: sourceId }).del();
  const commissions = await db("commissions")
    .where({ jurisdiction_id: jurisdictionId })
    .select("id");
  for (const commission of commissions) {
    await db("meetings").where({ commission_id: commission.id }).del();
  }
  await db("artifacts").where({ sha256: sha256Hex(DOCUMENT_PDF) }).del();
  // Deleting the meetings above cascades their agenda items and the appearance
  // links, but not the `matters` rows themselves — nothing cascades to a
  // projection, and no rebuild runs between one test and the next to notice.
  // `rebuildMatters` does prune (see the pruning test below); it simply has not
  // been asked to yet at this point, so the rows are cleared here rather than
  // left to make the next test's precondition lie.
  await db("matters")
    .whereIn("commission_id", db("commissions").where({ jurisdiction_id: jurisdictionId }).select("id"))
    .del();
  artifacts = new MemoryArtifacts();
});

describe("parse indexes document text regardless of document kind", () => {
  it("indexes a minutes document, which the parse_not_agenda return used to skip", async () => {
    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(MINUTES_URL, "minutes", "June 2 Minutes"),
      ]),
    ]);

    const indexed = await textRowFor(MINUTES_URL);
    assert.ok(indexed, "minutes must be indexed into artifact_texts");
    assert.ok(
      indexed.char_count > 0,
      `expected real extracted text, got ${indexed.char_count} chars`,
    );
  });

  it("still indexes an agenda, and still extracts its items", async () => {
    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(AGENDA_URL, "agenda", "June 2 Agenda"),
      ]),
    ]);

    const indexed = await textRowFor(AGENDA_URL);
    assert.ok(indexed, "agenda text must still be indexed");

    const items = await db("agenda_items as ai")
      .join("meetings as m", "m.id", "ai.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .where("c.jurisdiction_id", jurisdictionId)
      .count<{ count: string }[]>();
    assert.ok(Number(items[0].count) > 0, "an agenda must still produce agenda items");
  });

  it("does not manufacture agenda items out of minutes", async () => {
    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(MINUTES_URL, "minutes", "June 2 Minutes"),
      ]),
    ]);

    const items = await db("agenda_items as ai")
      .join("meetings as m", "m.id", "ai.meeting_id")
      .join("commissions as c", "c.id", "m.commission_id")
      .where("c.jurisdiction_id", jurisdictionId)
      .count<{ count: string }[]>();
    assert.equal(
      Number(items[0].count),
      0,
      "minutes must never become an agenda that was never published",
    );
  });
});

/**
 * Matters are a projection of `agenda_items`, and a projection nothing calls is
 * an empty table. `rebuildMatters` shipped exported and wired to nothing; this
 * asserts the sweep is what calls it, and that the call is real rather than a
 * function reference nobody reaches.
 */
describe("a sweep projects matters from the agenda items it wrote", () => {
  async function mattersForFixture(): Promise<Array<{ title: string; designator: string | null }>> {
    const rows = await db("matters as mt")
      .join("commissions as c", "c.id", "mt.commission_id")
      .where("c.jurisdiction_id", jurisdictionId)
      .select<Array<{ title: string; designator: string | null }>>("mt.title", "mt.designator");
    return rows;
  }

  it("creates matters for the agenda it just parsed", async () => {
    assert.equal((await mattersForFixture()).length, 0, "precondition: no matters yet");

    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(AGENDA_URL, "agenda", "June 2 Agenda"),
      ]),
    ]);

    const matters = await mattersForFixture();
    assert.ok(
      matters.length > 0,
      "the sweep must project matters; rebuildMatters is wired into sweepLocked",
    );

    // Every matter must be reachable from a real appearance. A matter with no
    // link is a row nothing explains.
    const orphans = await db("matters as mt")
      .join("commissions as c", "c.id", "mt.commission_id")
      .leftJoin("matter_appearances as ma", "ma.matter_id", "mt.id")
      .where("c.jurisdiction_id", jurisdictionId)
      .whereNull("ma.matter_id")
      .count<{ count: string }[]>();
    assert.equal(Number(orphans[0].count), 0, "no matter may exist without an appearance");
  });

  /**
   * A rebuild that only ever adds is not a rebuild.
   *
   * Nothing cascades from `meetings` to `matters` — a matter is a projection,
   * not a child record — so the only thing that can remove one is the next
   * rebuild noticing it has no appearances left. That path is easy to lose in a
   * refactor and impossible to see from the outside, because a stale matter
   * still renders as an ordinary row with an empty timeline.
   *
   * The realistic trigger is not a deleted meeting: `upsertAgendaItems` merges
   * on `(meeting_id, item_number)`, so a county revising an agenda can retitle
   * an item, which moves its appearance to a different matter and can leave the
   * old one with nothing.
   */
  it("prunes a matter whose last appearance is gone", async () => {
    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(AGENDA_URL, "agenda", "June 2 Agenda"),
      ]),
    ]);
    assert.ok((await mattersForFixture()).length > 0, "precondition: matters exist");

    // Take the agenda items away and rebuild. Nothing else changes.
    await db("agenda_items")
      .whereIn(
        "meeting_id",
        db("meetings")
          .join("commissions as c", "c.id", "meetings.commission_id")
          .where("c.jurisdiction_id", jurisdictionId)
          .select("meetings.id"),
      )
      .del();
    await rebuildMatters(db);

    assert.equal(
      (await mattersForFixture()).length,
      0,
      "a matter with no appearances must not survive a rebuild",
    );
  });

  it("does not accumulate matters when the same agenda is swept twice", async () => {
    const meetings = [
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(AGENDA_URL, "agenda", "June 2 Agenda"),
      ]),
    ];
    await sweep(meetings);
    const first = (await mattersForFixture()).length;

    await sweep(meetings);
    const second = (await mattersForFixture()).length;

    // Identity is the content, so a re-sweep finds the rows that already say
    // the same thing rather than writing new ones.
    assert.equal(second, first, "a repeated sweep must project the same matters");
  });
});

describe("backfillArtifactText", () => {
  /**
   * Reproduces the state the old handler left behind: an artifact reachable
   * from a meeting document, with a `document_versions` row, and no text.
   */
  async function sweepThenStripText(): Promise<void> {
    await sweep([
      meetingRef("06022025-2", "2025-06-02", [
        documentRef(MINUTES_URL, "minutes", "June 2 Minutes"),
      ]),
    ]);
    await db("artifact_texts")
      .whereIn("artifact_id", db("artifacts").where({ sha256: sha256Hex(DOCUMENT_PDF) }).select("id"))
      .del();
  }

  it("finds and indexes an artifact the old handler left unindexed", async () => {
    await sweepThenStripText();

    assert.equal(await textRowFor(MINUTES_URL), undefined, "precondition: text was stripped");

    const candidates = await findUnindexedArtifacts(db, 100);
    assert.ok(
      candidates.some((candidate) => artifacts.objects.has(candidate.storage_key)),
      "the stripped artifact must be a candidate",
    );

    const result = await backfillArtifactText(db, {
      read: artifacts.read,
      logger: silentLogger,
    });

    assert.ok(result.indexed >= 1, `expected at least one indexed, got ${result.indexed}`);
    assert.ok(result.chars > 0, "expected characters written");
    const indexed = await textRowFor(MINUTES_URL);
    assert.ok(indexed, "the backfill must index the stripped artifact");
  });

  it("is idempotent — a second pass finds nothing to do", async () => {
    await sweepThenStripText();
    await backfillArtifactText(db, { read: artifacts.read, logger: silentLogger });

    const second = await backfillArtifactText(db, {
      read: artifacts.read,
      logger: silentLogger,
    });
    assert.equal(second.indexed, 0, "an already-indexed artifact must not be re-read");
  });

  it("counts an unreadable object rather than stranding the rest of the archive", async () => {
    await sweepThenStripText();

    const result = await backfillArtifactText(db, {
      read: async (key: string) => {
        throw new Error(`storage lost ${key}`);
      },
      logger: silentLogger,
    });

    assert.ok(result.unreadable >= 1, "a missing object must be counted");
    assert.equal(result.indexed, 0, "nothing can be indexed from bytes that are gone");
  });
});
