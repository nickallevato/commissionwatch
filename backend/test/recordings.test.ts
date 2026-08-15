import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import db from "../src/config/database";
import {
  BOZEMAN_ORIGIN,
  classifyGranicusDocument,
  createBozemanGranicusAdapter,
  granicusPlayerUrl,
  parseGranicusArchive,
} from "../src/services/ingestion/adapters/bozeman-granicus";
import { HttpStatusError } from "../src/services/ingestion/adapters/http";
import { createAdapterRegistry } from "../src/services/ingestion/adapters/registry";
import {
  DOCUMENT_KINDS,
  asDocumentKind,
  sha256Hex,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type SourceAdapter,
  type SourceDescriptor,
} from "../src/services/ingestion/adapters/types";
import {
  createArtifactStore,
  createIngestionHandlers,
  type ArtifactWriter,
} from "../src/services/ingestion/handlers";
import { IngestionQueue } from "../src/services/ingestion/queue";
import { registerSource } from "../src/services/ingestion/registration";
import { SourceScheduler, classifyRun } from "../src/services/ingestion/scheduler";
import { IngestionWorker } from "../src/services/ingestion/worker";
import { recordingFetchSettled } from "../src/services/ingestion/recordings";
import {
  meetingRecordings,
  recordingCoverage,
  totalRecordingCoverage,
} from "../src/services/recording-coverage";
import { verifyRecordings } from "../src/services/recording-verification";

/**
 * The recording index, end to end, with Granicus replaced by fixtures.
 *
 * ## What this feature is, and what it is instead of
 *
 * `docs/superpowers/specs/2026-08-14-audio-transcription-design.md` asked for
 * audio ingestion and self-hosted ASR. Its own §5 open question — *whether the
 * media itself is fetchable* — was probed on 2026-08-15 before any of it was
 * written, and the answer was no: `archive-video.granicus.com` answers a Chrome
 * user-agent string with `200 content-length: 6008707697` and answers this
 * project's honest one, and curl's own default, with `403`. Reaching the media
 * means claiming to be a browser. Nothing here does, nothing here transcribes, and
 * `archive-video.granicus.com` is not a declared origin.
 *
 * What is built instead is the smaller true thing: the custodian's player page is
 * fetchable under the posture already disclosed, and it states the recording's
 * media id and its length. So the site can say *a 2h 56m recording of this meeting
 * exists and has no transcript* — which is the sentence that makes a records
 * request worth making, rather than a silence that reads like a meeting nobody
 * recorded.
 *
 * ## The two tests that carry the feature
 *
 * `the published length is re-derivable from the bytes it names` and its
 * companion, which tampers with a stored row and requires the verifier to notice.
 * We publish a duration for a recording nobody here has heard; the only thing that
 * makes that defensible is that the number re-derives from bytes whose hash a
 * stranger can reproduce against Granicus. A verifier that cannot fail is not a
 * verifier, so it is proved to bite.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "bozeman-granicus");
const REAL_PLAYER = new Uint8Array(
  gunzipSync(readFileSync(join(FIXTURE_DIR, "mediaplayer-clip2325.html.gz"))),
);
const REAL_PLAYER_TEXT = new TextDecoder().decode(REAL_PLAYER);
const REAL_MEDIA_ID = "bozeman_fa3dbfab-286a-4bb1-8643-fb050de5c02a";

/**
 * A second, different recording, made by editing the captured page.
 *
 * Derived from the real bytes rather than hand-written, so it carries the same
 * markup, the same escaping and the same surprises — the thing a hand-written
 * player-page fixture gets wrong. Only the two facts under test are changed.
 */
function playerPageFor(mediaId: string, seconds: number): Uint8Array {
  return new TextEncoder().encode(
    REAL_PLAYER_TEXT.replace(new RegExp(REAL_MEDIA_ID, "g"), mediaId).replace(
      /maxValInSec\s*=\s*\d+/,
      `maxValInSec = ${seconds}`,
    ),
  );
}

/** A long one: 2h 56m, the length of clip 1301 — a 2013 meeting with no captions. */
const OLD_PLAYER = playerPageFor("bozeman_00000000-0000-4000-8000-000000000001", 10_595);

/** What an unknown clip really answers on this host: a 500 with a vendor error page. */
const VENDOR_ERROR_HTML = new TextEncoder().encode(
  "<html><head><title>Slim Application Error</title></head><body>error</body></html>",
);

const PREFIX = "recordings-test";
const JURISDICTION_NAME = `${PREFIX} County`;
const ADAPTER_KEY = "recordings-test-adapter";
const BODY_KEY = "recordings-test-board";
const BODY_NAME = "Recordings Test Board";
const ORIGIN = "https://recordings.invalid";

const PLAYER_REAL = `${ORIGIN}/MediaPlayer.php?view_id=1&clip_id=2325`;
const PLAYER_OLD = `${ORIGIN}/MediaPlayer.php?view_id=1&clip_id=1301`;
const PLAYER_BROKEN = `${ORIGIN}/MediaPlayer.php?view_id=1&clip_id=4242`;
const PLAYER_MISSING = `${ORIGIN}/MediaPlayer.php?view_id=1&clip_id=999999`;
const CAPTIONS_REAL = `${ORIGIN}/videos/2325/captions.vtt`;

const REAL_VTT = new Uint8Array(readFileSync(join(FIXTURE_DIR, "captions-clip2325.vtt")));

// ---------------------------------------------------------------------------
// Part 1 — the contract and the adapter. No database.
// ---------------------------------------------------------------------------

describe("DocumentKind", () => {
  it("carries 'recording' in both the type union and the runtime list", () => {
    // Both in the same change, or `asDocumentKind` refuses a kind read back out
    // of `ingestion_jobs.target` and every queued job fails as invalid.
    assert.ok(DOCUMENT_KINDS.includes("recording"));
    assert.equal(asDocumentKind("recording"), "recording");
  });
});

describe("the Bozeman adapter emits a recording index", () => {
  const archiveHtml = gunzipSync(
    readFileSync(join(FIXTURE_DIR, "viewpublisher-view1.html.gz")),
  ).toString("utf-8");

  it("still classifies MediaPlayer.php as not-a-document", () => {
    // Unchanged, and the guard still means something. Classification answers
    // "what kind of file is at this href?", and a player page is a page. The
    // recording ref is *derived from the clip id*, exactly as the captions ref
    // is, rather than found as a link — the row's only player anchor is
    // `javascript:void(0)`.
    assert.equal(
      classifyGranicusDocument(`${BOZEMAN_ORIGIN}/MediaPlayer.php?view_id=1&clip_id=2687`),
      null,
    );
  });

  it("emits one recording ref per archived clip, alongside the captions ref", async () => {
    const adapter = createBozemanGranicusAdapter({
      now: () => new Date("2026-08-09T12:00:00Z"),
      logger: { warn: (): void => undefined },
      transport: async (req) => ({
        status: 200,
        bytes: req.url.endsWith("/robots.txt")
          ? new Uint8Array(readFileSync(join(FIXTURE_DIR, "robots.txt")))
          : new TextEncoder().encode(archiveHtml),
        headers: { "content-type": "text/html" },
        finalUrl: req.url,
      }),
    });
    const meetings = await adapter.discoverMeetings(new Date("2000-01-01T00:00:00Z"));
    const documents = meetings.flatMap((meeting) => meeting.documents);
    const recordings = documents.filter((document) => document.kind === "recording");
    const transcripts = documents.filter((document) => document.kind === "transcript");

    // 1,135 archive rows, every one of them carrying a clip id — the count the
    // 2026-08-14 probe established and the transcripts suite also asserts.
    assert.equal(recordings.length, 1135);
    assert.equal(recordings.length, transcripts.length, "one recording per captions ref");

    for (const ref of recordings) {
      assert.match(ref.url, /MediaPlayer\.php\?view_id=1&clip_id=\d+$/);
      assert.equal(ref.url.startsWith(BOZEMAN_ORIGIN), true);
      assert.equal(ref.expectedContentType, "text/html");
      assert.ok((ref.metadata?.clipId ?? "") !== "");
      assert.equal(ref.url, granicusPlayerUrl(ref.metadata?.clipId ?? ""));
    }
  });

  it("declares no media origin, so the recording itself can never be fetched", () => {
    // The media is on `archive-video.granicus.com` / `archive-stream.granicus.com`,
    // which refuse this project's user agent and answer a browser string. Adding
    // either to the declared surface would be the first step of exactly the thing
    // this feature exists to refuse, so its absence is asserted rather than
    // trusted to a comment.
    const adapter = createBozemanGranicusAdapter({
      now: () => new Date("2026-08-09T12:00:00Z"),
      logger: { warn: (): void => undefined },
      transport: async () => {
        throw new Error("no network in this test");
      },
    });
    for (const origin of adapter.describeSource().baseUrls) {
      assert.equal(/archive-(video|stream)\.granicus\.com/.test(origin), false, origin);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the pipeline, against a real database.
// ---------------------------------------------------------------------------

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
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
  error: (): undefined => undefined,
};

const bytesByUrl = new Map<string, { bytes: Uint8Array; contentType: string }>([
  [PLAYER_REAL, { bytes: REAL_PLAYER, contentType: "text/html; charset=UTF-8" }],
  [PLAYER_OLD, { bytes: OLD_PLAYER, contentType: "text/html; charset=UTF-8" }],
  [PLAYER_BROKEN, { bytes: VENDOR_ERROR_HTML, contentType: "text/html; charset=UTF-8" }],
  [CAPTIONS_REAL, { bytes: REAL_VTT, contentType: "text/vtt;charset=UTF-8" }],
]);

let meetings: MeetingRef[] = [];

function recordingRef(url: string, clipId: string, externalId: string): DocumentRef {
  return {
    sourceKey: ADAPTER_KEY,
    kind: "recording",
    title: `Recording index (clip ${clipId})`,
    url,
    meetingExternalId: externalId,
    expectedContentType: "text/html",
    metadata: { clipId },
  };
}

function transcriptRef(url: string, clipId: string, externalId: string): DocumentRef {
  return {
    sourceKey: ADAPTER_KEY,
    kind: "transcript",
    title: `Captions (clip ${clipId})`,
    url,
    meetingExternalId: externalId,
    expectedContentType: "text/vtt",
    metadata: { clipId },
  };
}

function meetingRef(externalId: string, date: string, documents: DocumentRef[]): MeetingRef {
  return {
    sourceKey: ADAPTER_KEY,
    bodyKey: BODY_KEY,
    date,
    timezone: "America/Denver",
    status: "completed",
    title: `Meeting ${date}`,
    externalId,
    sourceUrl: `${ORIGIN}/archive`,
    documents,
  };
}

const fixtureAdapter: SourceAdapter = {
  key: ADAPTER_KEY,
  describeSource(): SourceDescriptor {
    return {
      key: ADAPTER_KEY,
      jurisdiction: { name: JURISDICTION_NAME, state: "MT", type: "county" },
      bodies: [{ key: BODY_KEY, name: BODY_NAME, listingUrl: `${ORIGIN}/archive` }],
      baseUrls: [ORIGIN],
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
    const entry = bytesByUrl.get(ref.url);
    if (entry === undefined) throw new HttpStatusError(ref.url, 500);
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

const FIXTURE_SHAS = [
  sha256Hex(REAL_PLAYER),
  sha256Hex(OLD_PLAYER),
  sha256Hex(VENDOR_ERROR_HTML),
  sha256Hex(REAL_VTT),
];

let sourceId: string;
let jurisdictionId: string;
let commissionId: string;
let scheduler: SourceScheduler;
let artifactStore: MemoryArtifacts;

async function removeFixtures(): Promise<void> {
  const rows = await db("jurisdictions").where({ name: JURISDICTION_NAME }).select("id");
  for (const row of rows) {
    await db("jurisdictions").where({ id: row.id }).del();
  }
  // `document_versions.artifact_id` has no cascade, so the citing rows go first.
  await db("artifacts").whereIn("sha256", FIXTURE_SHAS).del();
}

async function sweep(): Promise<Record<string, number>> {
  await scheduler.sweepSource(sourceId);
  const run: unknown = await db("ingestion_runs")
    .where({ source_id: sourceId })
    .orderBy("started_at", "desc")
    .first("counts");
  const counts =
    typeof run === "object" && run !== null ? (run as { counts: unknown }).counts : {};
  return (typeof counts === "object" && counts !== null ? counts : {}) as Record<string, number>;
}

async function recordingFor(url: string): Promise<Record<string, unknown> | undefined> {
  const row: unknown = await db("meeting_recordings as mr")
    .join("meeting_documents as md", "md.id", "mr.meeting_document_id")
    .where("md.url", url)
    .first(
      "mr.meeting_document_id",
      "mr.state",
      "mr.clip_id",
      "mr.media_id",
      "mr.media_url",
      "mr.duration_ms",
      "mr.index_point_count",
      "mr.observed_sha256",
      "mr.checks",
      "mr.last_error",
      "mr.first_checked_at",
      "mr.last_checked_at",
    );
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
}

async function publishAll(): Promise<void> {
  await db("meetings").where({ commission_id: commissionId }).update({ published_at: db.fn.now() });
}

before(async () => {
  await removeFixtures();
  const registered = await registerSource(db, fixtureAdapter, { enabled: true });
  sourceId = registered.sourceId;
  jurisdictionId = registered.jurisdictionId;
  const commission: unknown = await db("commissions")
    .where({ jurisdiction_id: jurisdictionId })
    .first("id");
  commissionId = (commission as { id: string }).id;

  const registry = createAdapterRegistry([fixtureAdapter]);
  artifactStore = new MemoryArtifacts();
  const queue = new IngestionQueue(db, { maxAttempts: 1 });
  const worker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({ db, registry, artifacts: artifactStore, logger: silentLogger }),
    artifacts: createArtifactStore(artifactStore.read),
    batchSize: 5,
    logger: silentLogger,
  });
  scheduler = new SourceScheduler(db, {
    queue,
    worker,
    registry,
    logger: silentLogger,
    enabled: true,
    sweepTimeoutMs: 60_000,
  });
});

after(async () => {
  await removeFixtures();
  await db.destroy();
});

beforeEach(async () => {
  meetings = [];
  await db("ingestion_runs").where({ source_id: sourceId }).del();
  await db("meetings").where({ commission_id: commissionId }).del();
  await db("artifacts").whereIn("sha256", FIXTURE_SHAS).del();
});

describe("a recording is recorded, and the media is not fetched", () => {
  it("reads the custodian's own page for its length and media id", async () => {
    meetings = [
      meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")]),
    ];
    const counts = await sweep();

    const row = await recordingFor(PLAYER_REAL);
    assert.equal(row?.state, "available");
    assert.equal(row?.clip_id, "2325");
    assert.equal(row?.media_id, REAL_MEDIA_ID);
    assert.equal(Number(row?.duration_ms), 1_678_000);
    assert.equal(Number(row?.index_point_count), 9);
    assert.equal(row?.last_error, null);
    // The row names the exact bytes it read, which is the whole of what makes
    // the published duration checkable by someone who does not trust us.
    assert.equal(row?.observed_sha256, sha256Hex(REAL_PLAYER));
    assert.equal(counts.recordings_available, 1);
    assert.equal(counts.failed ?? 0, 0);
  });

  it("stores the stream URL and never fetches it", async () => {
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();
    const row = await recordingFor(PLAYER_REAL);
    // Published so a reader has the custodian's address for the recording. The
    // host it names refuses this project's user agent, and the honest response
    // to that is to publish the address and stop — so nothing was written to the
    // object store for it.
    assert.match(String(row?.media_url), /^https:\/\/archive-stream\.granicus\.com\//);
    for (const key of artifactStore.objects.keys()) {
      assert.equal(key.includes("mp4"), false, key);
    }
  });

  it("never indexes a player page into the search corpus", async () => {
    // 76 KB of stylesheet, jQuery and player configuration. Indexed, a reader
    // searching for a phrase said at a meeting would get hits on `flowplayer`
    // and `durationInputInSecs`. The document's substance lives in
    // `meeting_recordings`; the bytes stay stored, addressed and citable.
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    const counts = await sweep();

    const artifact = await db("artifacts").where({ sha256: sha256Hex(REAL_PLAYER) }).first("id");
    assert.ok(artifact);
    const texts = await db("artifact_texts").where({ artifact_id: artifact.id }).select("artifact_id");
    assert.equal(texts.length, 0, "a player page must never reach artifact_texts");
    assert.equal(counts.recordings_not_indexed, 1);
  });

  it("re-fetching an unchanged page changes nothing but the check count", async () => {
    // Dated today, so the settle gate has not closed on it yet and the second
    // sweep really does ask again. An older meeting is skipped at discovery,
    // which is the next test.
    const today = new Date().toISOString().slice(0, 10);
    meetings = [meetingRef("real", today, [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();
    const first = await recordingFor(PLAYER_REAL);
    await sweep();
    const second = await recordingFor(PLAYER_REAL);

    assert.equal(Number(first?.checks), 1);
    assert.equal(Number(second?.checks), 2);
    // `first_checked_at` is written once and never moved. "We looked again on
    // Friday and it still says 27m 58s" needs all three columns to be sayable.
    assert.deepEqual(second?.first_checked_at, first?.first_checked_at);
    const artifacts = await db("artifacts").where({ sha256: sha256Hex(REAL_PLAYER) }).select("id");
    assert.equal(artifacts.length, 1);
    const versions = await db("document_versions").where({ artifact_id: artifacts[0].id }).select("id");
    assert.equal(versions.length, 1);
  });

  it("gives two meetings two rows, each naming its own recording", async () => {
    meetings = [
      meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")]),
      meetingRef("old", "2013-09-23", [recordingRef(PLAYER_OLD, "1301", "old")]),
    ];
    await sweep();
    const a = await recordingFor(PLAYER_REAL);
    const b = await recordingFor(PLAYER_OLD);
    assert.equal(Number(a?.duration_ms), 1_678_000);
    assert.equal(Number(b?.duration_ms), 10_595_000);
    assert.notEqual(a?.media_id, b?.media_id);
  });
});

describe("a failure to read the page is ours, and is disclosed", () => {
  it("records a vendor error page as unreadable and counts it as a failure", async () => {
    // Unlike an absent transcript, this is a real failure. An absence is the
    // custodian's record; a page we could not read is ours, and `failuresIn` and
    // `classifyRun` both have to see it.
    meetings = [
      meetingRef("broken", "2024-01-10", [recordingRef(PLAYER_BROKEN, "4242", "broken")]),
    ];
    const counts = await sweep();

    const row = await recordingFor(PLAYER_BROKEN);
    assert.equal(row?.state, "unreadable");
    assert.equal(row?.duration_ms, null);
    assert.equal(row?.media_id, null);
    assert.match(String(row?.last_error), /no video_url/);
    assert.equal(counts.recordings_unreadable, 1);
    assert.equal(counts.failed, 1);

    const run: unknown = await db("ingestion_runs")
      .where({ source_id: sourceId })
      .orderBy("started_at", "desc")
      .first("counts");
    assert.equal(
      classifyRun((run as { counts: Record<string, number> }).counts, false),
      "partial",
    );
  });

  it("leaves a 500 in a job row a human can read, and stores nothing", async () => {
    meetings = [
      meetingRef("missing", "2024-02-14", [recordingRef(PLAYER_MISSING, "999999", "missing")]),
    ];
    await sweep();
    assert.equal(await recordingFor(PLAYER_MISSING), undefined);
    const job: unknown = await db("ingestion_jobs")
      .where({ stage: "fetch" })
      .whereRaw("target->>'url' = ?", [PLAYER_MISSING])
      .first("status", "last_error");
    assert.match(String((job as { last_error: string }).last_error), /500/);
  });
});

describe("the re-fetch gate", () => {
  it("stops asking once an old meeting's recording is read", async () => {
    // No ETag on this host, so a re-check is a full 76 KB download at one request
    // per ten seconds. 1,135 clips is about 86 MB and 3.2 hours for one pass, and
    // a 2013 player page will never change again.
    meetings = [meetingRef("old", "2013-09-23", [recordingRef(PLAYER_OLD, "1301", "old")])];
    await sweep();
    const counts = await sweep();
    assert.equal(counts.recordings_settled, 1);
  });

  it("keeps asking about a recent meeting, and about one it could not read", async () => {
    const row = await db("meeting_documents").first("id");
    assert.ok(row);
    const today = new Date();
    const recent = today.toISOString().slice(0, 10);
    // An unknown document is never settled — there is nothing recorded to settle.
    assert.equal(await recordingFetchSettled(db, String(row.id), recent, today), false);

    meetings = [
      meetingRef("broken", "2024-01-10", [recordingRef(PLAYER_BROKEN, "4242", "broken")]),
    ];
    await sweep();
    const second = await sweep();
    // `unreadable` describes our failure, not their record, and we do not get to
    // stop trying.
    assert.equal(second.recordings_settled ?? 0, 0);
    assert.equal(second.recordings_unreadable, 1);
  });
});

describe("the published length is re-derivable from the bytes it names", () => {
  it("re-derives every column from the stored page", async () => {
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();

    const results = await verifyRecordings(db, artifactStore.read);
    const mine = results.filter((result) => result.clip_id === "2325");
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0].problems, []);
    assert.equal(mine[0].stored_sha256, sha256Hex(REAL_PLAYER));
    assert.equal(mine[0].duration_ms, 1_678_000);
    // And the command a stranger runs against the custodian, not against us.
    assert.match(mine[0].reproduce, /^curl -sSL -A 'CommissionWatch/);
    assert.match(mine[0].reproduce, /sha256sum$/);
    assert.ok(mine[0].reproduce.includes(PLAYER_REAL));
  });

  it("notices a duration that did not come from those bytes", async () => {
    // A verifier that cannot fail is not a verifier. The row is edited behind the
    // pipeline's back — the shape of a hand-fixed number, a bad migration, or a
    // length salvaged from a different clip — and the check has to catch it.
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();
    const row = await recordingFor(PLAYER_REAL);
    await db("meeting_recordings")
      .where({ meeting_document_id: String(row?.meeting_document_id) })
      .update({ duration_ms: 99_000_000 });

    const results = await verifyRecordings(db, artifactStore.read, {
      meetingDocumentId: String(row?.meeting_document_id),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].problems.length, 1);
    assert.match(results[0].problems[0], /duration re-derives to 1678000ms, row says 99000000ms/);
  });

  it("says so when the bytes behind a row are gone, rather than passing it", async () => {
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();
    const row = await recordingFor(PLAYER_REAL);
    const results = await verifyRecordings(
      db,
      async () => {
        throw new Error("object missing from storage");
      },
      { meetingDocumentId: String(row?.meeting_document_id) },
    );
    assert.equal(results.length, 1);
    assert.match(results[0].problems.join(" "), /stored bytes unreadable/);
  });
});

describe("recording coverage", () => {
  it("counts nothing on an unpublished meeting, and everything once published", async () => {
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    await sweep();

    const withheld = (await recordingCoverage(db)).filter((row) => row.body === BODY_NAME);
    assert.deepEqual(withheld, [], "an unpublished meeting is behind the wall");

    await publishAll();
    const shown = (await recordingCoverage(db)).filter((row) => row.body === BODY_NAME);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].year, 2024);
    assert.equal(shown[0].available, 1);
    assert.equal(shown[0].recorded_ms, 1_678_000);
    assert.ok(shown[0].checked_through !== null);
  });

  it("counts a recording with no transcript, which is the headline figure", async () => {
    // A year with no transcripts and no recordings is a body that met unrecorded.
    // A year with no transcripts and sixty-one hours of recording is sixty-one
    // hours of public meeting that exists and cannot be searched. The site must
    // be able to tell those apart, and this is the number that does it.
    meetings = [
      meetingRef("old", "2013-09-23", [recordingRef(PLAYER_OLD, "1301", "old")]),
      meetingRef("real", "2024-07-17", [
        recordingRef(PLAYER_REAL, "2325", "real"),
        transcriptRef(CAPTIONS_REAL, "2325", "real"),
      ]),
    ];
    await sweep();
    await publishAll();

    const rows = (await recordingCoverage(db)).filter((row) => row.body === BODY_NAME);
    const totals = totalRecordingCoverage(rows);
    assert.equal(totals.available, 2);
    // The 2013 recording has no transcript; the 2024 one does, matched on the
    // clip id **within the same meeting** rather than on the meeting alone.
    assert.equal(totals.without_transcript, 1);
    const old = rows.find((row) => row.year === 2013);
    assert.equal(old?.without_transcript, 1);
    const recent = rows.find((row) => row.year === 2024);
    assert.equal(recent?.without_transcript, 0);
  });

  it("reports a meeting nobody has swept as unchecked, not as unrecorded", async () => {
    meetings = [meetingRef("real", "2024-07-17", [recordingRef(PLAYER_REAL, "2325", "real")])];
    // Discovery only: the document row exists, nothing was fetched.
    await scheduler.sweepSource(sourceId);
    await db("ingestion_jobs").where({ stage: "fetch" }).del();
    await publishAll();
    await db("meeting_recordings").del();

    const rows = (await recordingCoverage(db)).filter((row) => row.body === BODY_NAME);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unchecked, 1);
    assert.equal(rows[0].available, 0);
    assert.equal(rows[0].recorded_ms, 0);
  });

  it("never exposes our error text through a public projection", async () => {
    // `meeting_recordings.last_error` carries a URL and the first bytes of a
    // response. `toPublicSource`'s leak rule applies the moment a public
    // projection reads the same column, whether or not today's text is safe.
    meetings = [
      meetingRef("broken", "2024-01-10", [recordingRef(PLAYER_BROKEN, "4242", "broken")]),
    ];
    await sweep();
    await publishAll();
    const rows = (await recordingCoverage(db)).filter((row) => row.body === BODY_NAME);
    assert.equal(rows[0].unreadable, 1);
    assert.equal(JSON.stringify(rows).includes("video_url"), false);
    assert.equal(JSON.stringify(rows).includes("Slim"), false);

    const meeting = await db("meetings").where({ commission_id: commissionId }).first("id");
    const perMeeting = await meetingRecordings(db, String(meeting?.id));
    assert.equal(perMeeting.length, 1);
    assert.equal(perMeeting[0].state, "unreadable");
    assert.equal(JSON.stringify(perMeeting).includes("Slim"), false);
  });

  it("renders one meeting's recording as media time with the sha beside it", async () => {
    meetings = [meetingRef("old", "2013-09-23", [recordingRef(PLAYER_OLD, "1301", "old")])];
    await sweep();
    const meeting = await db("meetings").where({ commission_id: commissionId }).first("id");
    const [recording] = await meetingRecordings(db, String(meeting?.id));
    assert.equal(recording.state, "available");
    assert.equal(recording.length, "2h 56m");
    assert.equal(recording.observed_sha256, sha256Hex(OLD_PLAYER));
    // Never a clock. The offset between a recording's start and the meeting's is
    // published nowhere and varies per clip.
    assert.equal(/[ap]m/i.test(String(recording.length)), false);
  });
});

describe("the schema cannot attach a person to a recording", () => {
  it("has no column on meeting_recordings that could name one", async () => {
    // The audio spec's Rule 3, applied to a recording index. Voice is not
    // something this project identifies, and a column here would be read as an
    // identity by every consumer that touched it however the comment above it
    // read. Asserted against the live schema, not against the migration source.
    const columns = await db("information_schema.columns")
      .where({ table_schema: "public", table_name: "meeting_recordings" })
      .pluck("column_name");
    assert.ok(columns.length > 0, "expected the table to exist");
    for (const column of columns) {
      assert.equal(
        /speaker|person|member|official|name|voice|attendee/i.test(String(column)),
        false,
        `meeting_recordings.${String(column)} could be read as an identity`,
      );
    }
  });

  it("has no foreign key from meeting_recordings to a person table", async () => {
    const rows = await db.raw<{ rows: Array<{ target: string }> }>(
      `select cl.relname as target
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_class cl on cl.oid = c.confrelid
        where c.contype = 'f' and t.relname = 'meeting_recordings'`,
    );
    assert.deepEqual(
      rows.rows.map((row) => row.target).filter((name) => /member|operator|official|person/.test(name)),
      [],
    );
  });
});

describe("the database refuses a row that states less than it claims", () => {
  it("refuses an 'available' recording with no length", async () => {
    const document = await db("meeting_documents").first("id");
    assert.ok(document);
    await assert.rejects(
      db("meeting_recordings").insert({
        meeting_document_id: document.id,
        state: "available",
        clip_id: "1",
        media_id: "x",
        media_url: "https://example.invalid/x.mp4",
        duration_ms: null,
        index_point_count: 0,
        observed_sha256: "a".repeat(64),
        first_checked_at: new Date(),
        last_checked_at: new Date(),
      }),
      /meeting_recordings_available_check/,
    );
  });

  it("refuses an 'unreadable' recording with no error text", async () => {
    const document = await db("meeting_documents").first("id");
    assert.ok(document);
    await assert.rejects(
      db("meeting_recordings").insert({
        meeting_document_id: document.id,
        state: "unreadable",
        clip_id: "1",
        observed_sha256: "a".repeat(64),
        first_checked_at: new Date(),
        last_checked_at: new Date(),
      }),
      /meeting_recordings_unreadable_check/,
    );
  });

  it("refuses a row that names no bytes at all", async () => {
    // Every row states which page it was read out of, failure state included:
    // "we could not read this page" is a claim about a specific page.
    const document = await db("meeting_documents").first("id");
    assert.ok(document);
    await assert.rejects(
      db("meeting_recordings").insert({
        meeting_document_id: document.id,
        state: "unreadable",
        clip_id: "1",
        last_error: "unreadable",
        observed_sha256: "not-a-hash",
        first_checked_at: new Date(),
        last_checked_at: new Date(),
      }),
      /meeting_recordings_sha_check/,
    );
  });
});
