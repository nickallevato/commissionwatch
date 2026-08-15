import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import request from "supertest";
import app from "../src/app";
import db from "../src/config/database";
import {
  BOZEMAN_ORIGIN,
  classifyGranicusDocument,
  createBozemanGranicusAdapter,
  extractGranicusClipId,
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
import { transcriptCoverage } from "../src/services/transcript-coverage";
import {
  locateCueInterval,
  readTranscript,
  transcriptFetchSettled,
} from "../src/services/ingestion/transcripts";
import {
  looksLikeWebVtt,
  parseVttTimestamp,
  parseWebVttCues,
  projectTranscript,
  WebVttParseError,
} from "../src/services/ingestion/webvtt";

/**
 * Meeting transcripts, end to end, with Granicus replaced by fixtures.
 *
 * The suite is built around one failure mode that a casual implementation
 * reproduces exactly: **every empty caption file Bozeman serves is the same eight
 * bytes and therefore the same sha256.** `artifacts.sha256` is uniquely indexed,
 * so one artifact row represents every absence the city will ever publish,
 * `artifacts.source_url` names whichever clip was fetched first, and `parse` is
 * enqueued only when a fetch is new — so from the second absence onward there is
 * no downstream job at all. `two absences are two records` below is the test that
 * catches it, and it fails against any design that writes the state anywhere but
 * the fetch handler, outside its `isNew` branch.
 *
 * The second thing this suite is for is the line the project does not cross:
 * **a transcript never supplies an identity.** `>>` is the CEA-608 speaker-change
 * marker and carries no name; the one sampled file with `Name:` prefixes spells a
 * single person three ways. The rule is enforced by the schema having nowhere to
 * put a name, and `the schema cannot attach a person to a cue` asserts that
 * directly rather than trusting a comment.
 */

const PREFIX = "transcripts-test";
const JURISDICTION_NAME = `${PREFIX} County`;
const ADAPTER_KEY = "transcripts-test-adapter";
const BODY_KEY = "transcripts-test-board";
const BODY_NAME = "Transcripts Test Board";
const ORIGIN = "https://transcripts.invalid";

const FIXTURE_DIR = join(__dirname, "fixtures", "bozeman-granicus");

/**
 * The real thing: clip 2325, the City Commission meeting of 2024-07-17, captured
 * 2026-08-15 in one polite request. 349 cues, 26 KB — the smallest non-empty
 * caption file in the probe sample. See that directory's PROVENANCE.md.
 */
const REAL_VTT = new Uint8Array(readFileSync(join(FIXTURE_DIR, "captions-clip2325.vtt")));

/**
 * The empty stub, built rather than stored.
 *
 * Eight bytes, and the hash below is reproducible by anyone:
 *   $ printf 'WEBVTT\n\n' | sha256sum
 *   8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c
 * That single shared hash is the entire reason `transcript_status` exists.
 */
const STUB_VTT = new TextEncoder().encode("WEBVTT\n\n");
const STUB_SHA256 = "8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c";

/** What an unknown clip id really answers on this host: 500, with HTML. */
const VENDOR_ERROR_HTML = new TextEncoder().encode(
  "<html><head><title>Slim Application Error</title></head><body>" +
    "<p>The application could not run because of the following error:</p></body></html>",
);

const CAPTIONS_REAL = `${ORIGIN}/videos/2325/captions.vtt`;
const CAPTIONS_STUB_A = `${ORIGIN}/videos/1301/captions.vtt`;
const CAPTIONS_STUB_B = `${ORIGIN}/videos/1415/captions.vtt`;
const CAPTIONS_MISSING = `${ORIGIN}/videos/999999/captions.vtt`;
const CAPTIONS_HTML = `${ORIGIN}/videos/2109/captions.vtt`;

/** A term invented for this suite, so a hit proves this fixture and no other. */
const SEARCH_PHRASE = "FINANCE REPORT";

// ---------------------------------------------------------------------------
// Part 1 — the parser. No database, no network.
// ---------------------------------------------------------------------------

describe("looksLikeWebVtt", () => {
  it("accepts the eight-byte empty stub", () => {
    assert.equal(looksLikeWebVtt(STUB_VTT), true);
  });

  it("accepts a BOM-prefixed file and a signature with a trailing title", () => {
    assert.equal(looksLikeWebVtt(new TextEncoder().encode("\uFEFFWEBVTT\n\n")), true);
    assert.equal(looksLikeWebVtt(new TextEncoder().encode("WEBVTT - title\n")), true);
  });

  it("accepts the real captured caption file", () => {
    assert.equal(looksLikeWebVtt(REAL_VTT), true);
  });

  it("rejects a PDF, HTML and a near-miss signature", () => {
    assert.equal(looksLikeWebVtt(new TextEncoder().encode("%PDF-1.4\n")), false);
    assert.equal(looksLikeWebVtt(VENDOR_ERROR_HTML), false);
    // `WEBVTTX` is not WebVTT. Accepting it would let any file whose first six
    // bytes happen to match be stored as a transcript.
    assert.equal(looksLikeWebVtt(new TextEncoder().encode("WEBVTTX\n\n")), false);
  });
});

describe("parseVttTimestamp", () => {
  it("reads both the long and short forms", () => {
    assert.equal(parseVttTimestamp("00:29:38.500"), 29 * 60_000 + 38_500);
    assert.equal(parseVttTimestamp("29:38.500"), 29 * 60_000 + 38_500);
    assert.equal(parseVttTimestamp("01:00:00.000"), 3_600_000);
  });

  it("refuses anything else rather than guessing", () => {
    assert.equal(parseVttTimestamp("00:29:38"), null);
    assert.equal(parseVttTimestamp("00:29:38,500"), null);
    assert.equal(parseVttTimestamp("garbage"), null);
  });
});

describe("parseWebVttCues", () => {
  it("returns no cues for the empty stub, and does not throw", () => {
    // This is the assertion that makes `absent` a recordable state about the
    // custodian's record rather than an error about ours.
    assert.deepEqual(parseWebVttCues(STUB_VTT), []);
  });

  it("reads every cue in the real captured file", () => {
    const cues = parseWebVttCues(REAL_VTT);
    assert.equal(cues.length, 349);
    assert.deepEqual(cues[0], {
      startMs: 61_633,
      endMs: 63_633,
      text: ">> LET'S CALL THE MEETING TO ORDER.",
    });
    // Media time, not a clock: the recording began about a minute before the
    // first word. The offset varies per clip and is published nowhere.
    assert.ok(cues[0].startMs > 0);
  });

  it("keeps '>>' and any 'Name:' prefix in the payload, verbatim", () => {
    // Stripping them would edit the custodian's record. Promoting them to a
    // field would claim who spoke. Neither happens: they are just text.
    const [cue] = parseWebVttCues(
      new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n>> Gregg Sulivan: hello\n"),
    );
    assert.equal(cue.text, ">> Gregg Sulivan: hello");
  });

  it("handles cue identifiers, NOTE blocks, cue settings and multi-line payloads", () => {
    const cues = parseWebVttCues(
      new TextEncoder().encode(
        [
          "WEBVTT",
          "",
          "NOTE this comment is not a cue",
          "and neither is this line",
          "",
          "cue-1",
          "00:00:01.000 --> 00:00:02.000 align:start position:10%",
          "first line",
          "second line",
          "",
          "01:02.500 --> 01:03.500",
          "short form",
          "",
        ].join("\n"),
      ),
    );
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "first line\nsecond line");
    assert.equal(cues[1].startMs, 62_500);
  });

  it("throws with the line number on a malformed timestamp, and skips nothing", () => {
    // A parser that dropped the cue it could not read would produce a transcript
    // with a hole in it that reads exactly like a transcript without one.
    const bad = new TextEncoder().encode(
      ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "fine", "", "00:00:03 --> 00:00:04.000", "broken", ""].join(
        "\n",
      ),
    );
    assert.throws(
      () => parseWebVttCues(bad),
      (error: unknown) =>
        error instanceof WebVttParseError && error.line === 6 && /line 6/.test(error.message),
    );
  });

  it("throws rather than ignoring a block it cannot classify", () => {
    assert.throws(
      () => parseWebVttCues(new TextEncoder().encode("WEBVTT\n\nnot a cue at all\n")),
      WebVttParseError,
    );
  });
});

describe("projectTranscript", () => {
  it("holds the substring invariant for every cue of the real file", () => {
    // substr(text, offset + 1, length) — the SQL form — must be the cue payload.
    // One projection, one offset space: `services/extraction/verify.ts` locates a
    // quotation as a character offset into exactly this string.
    const projection = projectTranscript(parseWebVttCues(REAL_VTT));
    const cues = parseWebVttCues(REAL_VTT);
    assert.equal(projection.spans.length, 349);
    for (const span of projection.spans) {
      assert.equal(
        projection.text.slice(span.offset, span.offset + span.length),
        cues[span.cueIndex].text,
      );
    }
  });

  it("carries no timestamps into the indexed text", () => {
    const projection = projectTranscript(parseWebVttCues(REAL_VTT));
    assert.equal(/\d\d:\d\d:\d\d\.\d\d\d/.test(projection.text), false);
    assert.equal(projection.text.includes("-->"), false);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — getting the clip id out of the archive. Real fixture bytes.
// ---------------------------------------------------------------------------

describe("extractGranicusClipId", () => {
  const archiveHtml = gunzipSync(
    readFileSync(join(FIXTURE_DIR, "viewpublisher-view1.html.gz")),
  ).toString("utf-8");
  const archive = parseGranicusArchive(archiveHtml);
  const archiveRows = archive.panels.flatMap((panel) => panel.rows);

  it("reads the clip id out of the onclick handler in the captured page", () => {
    // Asserted against the stored fixture and never a hand-written string: the
    // escaping in that attribute is exactly what a hand-written one gets wrong.
    const boardOfEthics = archive.panels.find((panel) => panel.name === "Board of Ethics");
    assert.ok(boardOfEthics, "expected the Board of Ethics panel in the fixture");
    assert.equal(boardOfEthics.rows[0].clipId, "2687");
  });

  it("returns null for a row with no player link", () => {
    // The Upcoming Events table has no video column at all — a meeting that has
    // not happened has no recording — so all 17 of its rows read null. That is
    // the honest negative case, and it is why the ref is only emitted when the
    // clip id is present rather than derived from a meeting id.
    assert.equal(archive.upcoming.length, 17);
    assert.deepEqual([...new Set(archive.upcoming.map((row) => row.clipId))], [null]);
  });

  it("finds a clip on every archive row: 1,135, matching the 2026-08-14 probe", () => {
    assert.equal(archiveRows.length, 1135);
    assert.equal(archiveRows.filter((row) => row.clipId !== null).length, 1135);
  });

  it("is defensive about a row that is not an anchor at all", () => {
    const empty = parseGranicusArchive("<html><body></body></html>");
    assert.deepEqual(empty.panels, []);
  });

  it("still classifies MediaPlayer.php as not-a-document", () => {
    // A regression guard on a rule that has not changed. A player page is not a
    // file, and nothing may enqueue it as one. What the adapter emits instead is
    // the derived captions URL.
    assert.equal(
      classifyGranicusDocument(`${BOZEMAN_ORIGIN}/MediaPlayer.php?view_id=1&clip_id=2687`),
      null,
    );
  });

  it("emits a transcript ref per archive row with a clip, and never a player URL", async () => {
    const decoder = new TextDecoder("utf-8");
    const adapter = createBozemanGranicusAdapter({
      now: () => new Date("2026-08-09T12:00:00Z"),
      logger: { warn: (): void => undefined },
      transport: async (req) => {
        const bytes = req.url.endsWith("/robots.txt")
          ? new Uint8Array(readFileSync(join(FIXTURE_DIR, "robots.txt")))
          : new TextEncoder().encode(archiveHtml);
        return {
          status: 200,
          bytes,
          headers: { "content-type": "text/html" },
          finalUrl: req.url,
        };
      },
    });
    // Since 2013, so the whole archive is in scope.
    const meetings = await adapter.discoverMeetings(new Date("2000-01-01T00:00:00Z"));
    const transcripts = meetings
      .flatMap((meeting) => meeting.documents)
      .filter((document) => document.kind === "transcript");

    assert.ok(transcripts.length > 1000, `expected the whole archive, got ${transcripts.length}`);
    for (const ref of transcripts) {
      assert.equal(ref.url.includes("MediaPlayer.php"), false);
      assert.match(ref.url, /^https:\/\/bozeman\.granicus\.com\/videos\/\d+\/captions\.vtt$/);
      assert.equal(ref.expectedContentType, "text/vtt");
      // The player URL is recorded as the custodian's own address for the
      // recording — carried, never fetched.
      assert.match(String(ref.metadata?.mediaPlayerUrl), /MediaPlayer\.php\?view_id=1&clip_id=\d+$/);
    }
    assert.ok(decoder.decode(STUB_VTT).startsWith("WEBVTT"));
  });
});

describe("DocumentKind", () => {
  it("carries 'transcript' in both the type union and the runtime list", () => {
    // Both in the same change, or `asDocumentKind` refuses a kind read back out
    // of `ingestion_jobs.target` and every transcript fetch job is invalid.
    assert.ok(DOCUMENT_KINDS.includes("transcript"));
    assert.equal(asDocumentKind("transcript"), "transcript");
  });
});

describe("readTranscript", () => {
  it("keeps a vendor error page and an empty caption file apart", () => {
    // The two failure shapes must not collapse. One describes us; the other
    // describes the custodian's record.
    assert.equal(readTranscript(STUB_VTT, "text/vtt").state, "absent");
    assert.equal(readTranscript(VENDOR_ERROR_HTML, "text/html").state, "unavailable");
    assert.equal(readTranscript(REAL_VTT, "text/vtt").state, "published");
  });

  it("decides on the bytes, not on the Content-Type a server claims", () => {
    assert.equal(readTranscript(VENDOR_ERROR_HTML, "text/vtt;charset=UTF-8").state, "unavailable");
    assert.equal(readTranscript(REAL_VTT, "text/html").state, "published");
  });

  it("reports the content type and first bytes so a human can act on it", () => {
    const reading = readTranscript(VENDOR_ERROR_HTML, "text/html");
    assert.match(String(reading.lastError), /text\/html/);
    assert.match(String(reading.lastError), /Slim Application Error/);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the pipeline, against a real database.
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

interface FixtureResponse {
  bytes: Uint8Array;
  contentType: string;
}

const bytesByUrl = new Map<string, FixtureResponse>([
  [CAPTIONS_REAL, { bytes: REAL_VTT, contentType: "text/vtt;charset=UTF-8" }],
  [CAPTIONS_STUB_A, { bytes: STUB_VTT, contentType: "text/vtt;charset=UTF-8" }],
  [CAPTIONS_STUB_B, { bytes: STUB_VTT, contentType: "text/vtt;charset=UTF-8" }],
  [CAPTIONS_HTML, { bytes: VENDOR_ERROR_HTML, contentType: "text/html;charset=UTF-8" }],
]);

let meetings: MeetingRef[] = [];

function transcriptRef(url: string, clipId: string, externalId: string): DocumentRef {
  return {
    sourceKey: ADAPTER_KEY,
    kind: "transcript",
    title: `Captions (clip ${clipId})`,
    url,
    meetingExternalId: externalId,
    expectedContentType: "text/vtt",
    metadata: { clipId, mediaPlayerUrl: `${ORIGIN}/MediaPlayer.php?view_id=1&clip_id=${clipId}` },
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
    if (entry === undefined) {
      // The real behaviour of an unknown clip id: a **500**, not a 404.
      throw new HttpStatusError(ref.url, 500);
    }
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

let sourceId: string;
let jurisdictionId: string;
let commissionId: string;
let scheduler: SourceScheduler;

const FIXTURE_SHAS = [sha256Hex(REAL_VTT), STUB_SHA256, sha256Hex(VENDOR_ERROR_HTML)];

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

async function statusFor(url: string): Promise<Record<string, unknown> | undefined> {
  const row: unknown = await db("transcript_status as ts")
    .join("meeting_documents as md", "md.id", "ts.meeting_document_id")
    .where("md.url", url)
    .first(
      "ts.state",
      "ts.clip_id",
      "ts.observed_sha256",
      "ts.cue_count",
      "ts.checks",
      "ts.last_error",
      "ts.first_checked_at",
      "ts.last_checked_at",
    );
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
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
  const artifacts = new MemoryArtifacts();
  const queue = new IngestionQueue(db, { maxAttempts: 1 });
  const worker = new IngestionWorker(db, queue, {
    handlers: createIngestionHandlers({ db, registry, artifacts, logger: silentLogger }),
    artifacts: createArtifactStore(artifacts.read),
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

describe("the empty stub is a record, not a collision", () => {
  it("gives two absences two rows, from one artifact", async () => {
    // THE test. Two different clips, two different meetings, identical eight
    // bytes. The content address makes them one `artifacts` row and makes the
    // second fetch `isNew === false`, so nothing downstream of fetch runs for it
    // at all. If `transcript_status` were written by `parse`, or inside the
    // `isNew` branch, meeting B would have no record of its own absence and the
    // site could not say the city published nothing for it.
    meetings = [
      meetingRef("stub-a", "2013-09-23", [transcriptRef(CAPTIONS_STUB_A, "1301", "stub-a")]),
      meetingRef("stub-b", "2015-04-06", [transcriptRef(CAPTIONS_STUB_B, "1415", "stub-b")]),
    ];
    const counts = await sweep();

    const artifacts = await db("artifacts").where({ sha256: STUB_SHA256 }).select("id");
    assert.equal(artifacts.length, 1, "the eight-byte stub is one artifact by construction");

    const versions = await db("document_versions").where({ artifact_id: artifacts[0].id }).select("id");
    assert.equal(versions.length, 2, "one version per document, both citing the same bytes");

    const a = await statusFor(CAPTIONS_STUB_A);
    const b = await statusFor(CAPTIONS_STUB_B);
    assert.equal(a?.state, "absent");
    assert.equal(b?.state, "absent");
    assert.equal(a?.clip_id, "1301");
    assert.equal(b?.clip_id, "1415");
    // Each row names the bytes it saw, and a stranger can check the claim:
    //   printf 'WEBVTT\n\n' | sha256sum
    assert.equal(a?.observed_sha256, STUB_SHA256);
    assert.equal(b?.observed_sha256, STUB_SHA256);
    assert.equal(Number(a?.cue_count), 0);

    assert.equal(counts.transcripts_absent, 2);
  });

  it("does not count an absence as a failure, and the sweep succeeds", async () => {
    // Nothing failed. The city served a well-formed file saying there is nothing
    // here, which is a fact about an era of its own practice — 8 of 8 sampled
    // clips from 2013-2020 say exactly that. Counting it as a failure would make
    // the archive read as a broken fetcher.
    meetings = [
      meetingRef("stub-a", "2013-09-23", [transcriptRef(CAPTIONS_STUB_A, "1301", "stub-a")]),
    ];
    const counts = await sweep();
    assert.equal(counts.failed, undefined);
    assert.equal(counts.blocked, undefined);
    assert.equal(classifyRun(counts, false), "succeeded");

    const run = await db("ingestion_runs")
      .where({ source_id: sourceId })
      .orderBy("started_at", "desc")
      .first("status");
    assert.equal(run.status, "succeeded");
  });

  it("writes no cue rows and no empty text row for an absence", async () => {
    meetings = [
      meetingRef("stub-a", "2013-09-23", [transcriptRef(CAPTIONS_STUB_A, "1301", "stub-a")]),
    ];
    await sweep();
    const artifact = await db("artifacts").where({ sha256: STUB_SHA256 }).first("id");
    assert.equal((await db("transcript_cues").where({ artifact_id: artifact.id })).length, 0);
    assert.equal((await db("artifact_texts").where({ artifact_id: artifact.id })).length, 0);
  });
});

describe("a real transcript", () => {
  const publishedMeeting = (): MeetingRef[] => [
    meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")]),
  ];

  it("is indexed into artifact_texts with the cue index beside it", async () => {
    meetings = publishedMeeting();
    const counts = await sweep();
    assert.equal(counts.transcripts_published, 1);

    const status = await statusFor(CAPTIONS_REAL);
    assert.equal(status?.state, "published");
    assert.equal(Number(status?.cue_count), 349);

    const artifact = await db("artifacts").where({ sha256: sha256Hex(REAL_VTT) }).first("id");
    const text = await db("artifact_texts").where({ artifact_id: artifact.id }).first("text");
    assert.ok(text, "the transcript reached the one text-indexing path");
    assert.ok(String(text.text).includes(SEARCH_PHRASE));
    // No timecodes in the searchable text: a snippet a reader sees must be words
    // the custodian's file contains, and a quotable timecode is metadata.
    assert.equal(/-->/.test(String(text.text)), false);

    const cues = await db("transcript_cues").where({ artifact_id: artifact.id }).count();
    assert.equal(Number(cues[0].count), 349);
  });

  it("holds the substring invariant in the database, for every cue", async () => {
    meetings = publishedMeeting();
    await sweep();
    const artifact = await db("artifacts").where({ sha256: sha256Hex(REAL_VTT) }).first("id");
    // Asked of Postgres rather than of JavaScript: the invariant that matters is
    // the one the stored rows satisfy.
    const mismatched = await db.raw(
      `SELECT count(*)::int AS n
         FROM transcript_cues tc
         JOIN artifact_texts at ON at.artifact_id = tc.artifact_id
        WHERE tc.artifact_id = ?
          AND length(substr(at.text, tc.text_offset + 1, tc.text_length)) <> tc.text_length`,
      [artifact.id],
    );
    assert.equal(mismatched.rows[0].n, 0);

    const first = await db("transcript_cues")
      .where({ artifact_id: artifact.id, cue_index: 0 })
      .first();
    const text = await db("artifact_texts").where({ artifact_id: artifact.id }).first("text");
    assert.equal(
      String(text.text).substr(first.text_offset, first.text_length),
      ">> LET'S CALL THE MEETING TO ORDER.",
    );
    assert.equal(Number(first.start_ms), 61_633);
  });

  it("resolves a character offset to a media-time interval, never a clock", async () => {
    meetings = publishedMeeting();
    await sweep();
    const artifact = await db("artifacts").where({ sha256: sha256Hex(REAL_VTT) }).first("id");
    const text = await db("artifact_texts").where({ artifact_id: artifact.id }).first("text");
    const offset = String(text.text).indexOf(SEARCH_PHRASE);
    assert.ok(offset >= 0);

    const interval = await locateCueInterval(db, artifact.id, offset, SEARCH_PHRASE.length);
    assert.ok(interval, "a stored quote offset resolves to stored cues");
    assert.ok(interval.startMs >= 0 && interval.endMs >= interval.startMs);
    // An interval, because an interval is what is true. A quote spanning three
    // cues cites [first.start_ms, last.end_ms]; a point would be a rounding.
    assert.ok(interval.lastCue >= interval.firstCue);
  });

  it("re-fetching an unchanged transcript changes nothing but the check count", async () => {
    meetings = publishedMeeting();
    await sweep();
    const before = await statusFor(CAPTIONS_REAL);
    const artifact = await db("artifacts").where({ sha256: sha256Hex(REAL_VTT) }).first("id");
    const cuesBefore = await db("transcript_cues").where({ artifact_id: artifact.id }).count();

    // The discover gate would normally suppress a re-fetch of a `published`
    // transcript entirely. Cleared here so the fetch path itself is exercised —
    // the point being that even a redundant fetch writes no new claim.
    await db("transcript_status")
      .whereIn(
        "meeting_document_id",
        db("meeting_documents").where({ url: CAPTIONS_REAL }).select("id"),
      )
      .update({ state: "unavailable", cue_count: null, last_error: "forced re-check" });

    await sweep();
    const after = await statusFor(CAPTIONS_REAL);
    assert.equal(Number(after?.checks), Number(before?.checks) + 1);
    assert.equal(after?.state, "published");
    assert.equal(after?.last_error, null);
    // `first_checked_at` is written on insert and never restated.
    assert.deepEqual(after?.first_checked_at, before?.first_checked_at);

    assert.equal((await db("artifacts").where({ sha256: sha256Hex(REAL_VTT) })).length, 1);
    assert.equal((await db("document_versions").where({ artifact_id: artifact.id })).length, 1);
    const cuesAfter = await db("transcript_cues").where({ artifact_id: artifact.id }).count();
    assert.deepEqual(cuesAfter, cuesBefore);
  });

  it("stops asking once the transcript is published", async () => {
    meetings = publishedMeeting();
    await sweep();
    const documentId = await db("meeting_documents").where({ url: CAPTIONS_REAL }).first("id");
    assert.equal(
      await transcriptFetchSettled(db, documentId.id, "2024-07-17", new Date("2026-08-15")),
      true,
    );
    const counts = await sweep();
    assert.equal(counts.transcripts_settled, 1);
  });

  it("keeps asking about an absence until the settle window closes", async () => {
    // Granicus generates captions asynchronously: a meeting held on Tuesday can
    // be empty on Wednesday and present on Friday. An `absent` recorded once and
    // never revisited would publish a false absence.
    meetings = [
      meetingRef("stub-a", "2026-08-10", [transcriptRef(CAPTIONS_STUB_A, "1301", "stub-a")]),
    ];
    await sweep();
    const documentId = await db("meeting_documents").where({ url: CAPTIONS_STUB_A }).first("id");
    assert.equal(
      await transcriptFetchSettled(db, documentId.id, "2026-08-10", new Date("2026-08-15")),
      false,
    );
    assert.equal(
      await transcriptFetchSettled(db, documentId.id, "2026-08-10", new Date("2026-10-15")),
      true,
    );
  });
});

describe("a failure to obtain a transcript is disclosed", () => {
  it("records a 500 as unavailable, counts it as a failure, and stores no artifact", async () => {
    meetings = [
      meetingRef("missing", "2026-01-06", [transcriptRef(CAPTIONS_MISSING, "999999", "missing")]),
    ];
    const counts = await sweep();

    const status = await statusFor(CAPTIONS_MISSING);
    assert.equal(status?.state, "unavailable");
    assert.match(String(status?.last_error), /500/);
    assert.match(String(status?.last_error), /captions\.vtt/);
    assert.equal(status?.cue_count, null);

    assert.equal(counts.transcripts_unavailable, 1);
    // `unavailable` is a real failure to obtain a public record, so the public
    // status page's failure figure and `classifyRun` both have to see it.
    assert.equal(counts.failed, 1);
    assert.equal(classifyRun(counts, false), "partial");
  });

  it("refuses to store an HTML error page as a transcript", async () => {
    meetings = [
      meetingRef("htmlerr", "2020-01-06", [transcriptRef(CAPTIONS_HTML, "2109", "htmlerr")]),
    ];
    const counts = await sweep();

    const status = await statusFor(CAPTIONS_HTML);
    assert.equal(status?.state, "unavailable");
    assert.match(String(status?.last_error), /text\/html/);
    assert.equal(counts.transcripts_unavailable, 1);
    assert.equal(counts.failed, 1);

    // The bytes are still held — they are what was served, and holding them is
    // how the failure stays checkable — but they are not a transcript: no text,
    // no cues, and nothing searchable.
    const artifact = await db("artifacts")
      .where({ sha256: sha256Hex(VENDOR_ERROR_HTML) })
      .first("id");
    assert.ok(artifact, "the response is stored as evidence of the failure");
    assert.equal((await db("transcript_cues").where({ artifact_id: artifact.id })).length, 0);
  });

  it("leaves the failure in an ingestion_jobs row a human can read", async () => {
    meetings = [
      meetingRef("missing", "2026-01-06", [transcriptRef(CAPTIONS_MISSING, "999999", "missing")]),
    ];
    await sweep();
    // The job itself completes rather than burning three retries at ten seconds
    // on an answer that will not change; the disclosure is the run's counts and
    // the `transcript_status` row, both of which name what happened.
    const run: unknown = await db("ingestion_runs")
      .where({ source_id: sourceId })
      .orderBy("started_at", "desc")
      .first("status", "counts");
    const row = run as { status: string; counts: Record<string, number> };
    assert.equal(row.status, "partial");
    assert.equal(row.counts.failed, 1);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — the publication wall.
// ---------------------------------------------------------------------------

describe("the publication wall holds for transcripts", () => {
  beforeEach(async () => {
    meetings = [meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")])];
    await sweep();
  });

  it("withholds a transcript on an unpublished meeting, then shows it once published", async () => {
    // Both halves. A test that only proved absence would also pass against a
    // search that returned nothing at all.
    const isOurTranscript = (result: { kind: string; document_type?: string; sha256?: string }) =>
      result.kind === "document" &&
      result.document_type === "transcript" &&
      result.sha256 === sha256Hex(REAL_VTT);

    const withheld = await request(app).get("/api/search").query({ q: SEARCH_PHRASE });
    assert.equal(withheld.status, 200);
    assert.equal(
      withheld.body.data.some(isOurTranscript),
      false,
      "an unpublished meeting's transcript is not searchable",
    );

    await db("meetings")
      .where({ commission_id: commissionId })
      .update({ published_at: new Date() });

    const published = await request(app).get("/api/search").query({ q: SEARCH_PHRASE });
    assert.equal(published.status, 200);
    assert.equal(
      published.body.data.some(isOurTranscript),
      true,
      "once published, the transcript body is searchable like any other document",
    );
  });

  it("counts no unpublished meeting in the coverage figures, and counts it once published", async () => {
    const ours = (rows: Awaited<ReturnType<typeof transcriptCoverage>>) =>
      rows.filter((row) => row.jurisdiction === JURISDICTION_NAME);

    assert.deepEqual(ours(await transcriptCoverage(db)), []);

    await db("meetings")
      .where({ commission_id: commissionId })
      .update({ published_at: new Date() });

    const [row] = ours(await transcriptCoverage(db));
    assert.ok(row, "a published meeting appears in coverage");
    assert.equal(row.year, 2024);
    assert.equal(row.published, 1);
    assert.equal(row.absent, 0);
    assert.equal(row.unavailable, 0);
    assert.equal(row.unchecked, 0);
    assert.ok(row.checked_through);
  });

  it("reports a meeting nobody has swept as unchecked, not as covered", async () => {
    // The fourth state, and the one that would otherwise flatter us: omitting it
    // would let a body with two hundred unswept meetings read as 100% covered.
    await db("transcript_status")
      .whereIn(
        "meeting_document_id",
        db("meeting_documents").where({ url: CAPTIONS_REAL }).select("id"),
      )
      .del();
    await db("meetings").where({ commission_id: commissionId }).update({ published_at: new Date() });

    const [row] = (await transcriptCoverage(db)).filter(
      (candidate) => candidate.jurisdiction === JURISDICTION_NAME,
    );
    assert.equal(row.unchecked, 1);
    assert.equal(row.published, 0);
    assert.equal(row.checked_through, null);
  });

  it("never exposes transcript error text on the public coverage figures", async () => {
    // `transcript_status.last_error` carries a URL and an HTTP status today, and
    // "today it is safe" is not a constraint. The coverage endpoint reports counts.
    await db("meetings").where({ commission_id: commissionId }).update({ published_at: new Date() });
    const rows = await transcriptCoverage(db);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).includes("last_error"), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 4b — per-meeting transcript state on GET /api/meetings/:id.
// ---------------------------------------------------------------------------

/**
 * What a meeting page may say about *this* meeting's transcript.
 *
 * Before this existed the only public read of `transcript_status` was
 * `/api/transcripts/coverage`, aggregated by body and calendar year, so a page
 * could speak only when a whole year was unanimous. The obvious substitute —
 * "there is a `transcript` document row, so there is a transcript" — is false:
 * the row is written at discovery, before a byte is fetched, and the eight-byte
 * empty caption file produces exactly the same row.
 */
describe("a meeting reports its own transcript state", () => {
  async function meetingId(externalId: string): Promise<string> {
    const row = await db("meetings")
      .where({ commission_id: commissionId, external_id: externalId })
      .first("id");
    assert.ok(row, `expected a meeting row for ${externalId}`);
    return String(row.id);
  }

  async function publishAll(): Promise<void> {
    await db("meetings").where({ commission_id: commissionId }).update({ published_at: new Date() });
  }

  /** All four states in one sweep: published, absent, unavailable, unchecked. */
  async function sweepFourStates(): Promise<void> {
    meetings = [
      meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")]),
      meetingRef("stub-a", "2013-09-23", [transcriptRef(CAPTIONS_STUB_A, "1301", "stub-a")]),
      meetingRef("htmlerr", "2020-01-06", [transcriptRef(CAPTIONS_HTML, "2109", "htmlerr")]),
      meetingRef("stub-b", "2015-04-06", [transcriptRef(CAPTIONS_STUB_B, "1415", "stub-b")]),
    ];
    await sweep();
    // The fourth state is the absence of a row, so it is made by removing one.
    // A meeting nobody has swept must not read as one the city answered about.
    await db("transcript_status")
      .whereIn(
        "meeting_document_id",
        db("meeting_documents").where({ url: CAPTIONS_STUB_B }).select("id"),
      )
      .del();
  }

  it("withholds the state on an unpublished meeting, then reports it once published", async () => {
    // Both halves. A test that only proved absence would also pass against a
    // route that returned nothing to anybody.
    meetings = [meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")])];
    await sweep();
    const id = await meetingId("real");

    const withheld = await request(app).get(`/api/meetings/${id}`);
    assert.equal(withheld.status, 404, "an unpublished meeting is a 404, transcript and all");

    await publishAll();
    const published = await request(app).get(`/api/meetings/${id}`);
    assert.equal(published.status, 200);
    assert.equal(published.body.transcript.published, 1);
    assert.equal(published.body.transcript.documents[0].state, "published");
    assert.equal(published.body.transcript.documents[0].cue_count, 349);
    assert.equal(published.body.transcript.documents[0].clip_id, "2325");
    // The bytes are named, so a stranger can check the claim.
    assert.equal(published.body.transcript.documents[0].observed_sha256, sha256Hex(REAL_VTT));
    assert.ok(published.body.transcript.checked_through);
  });

  it("tells all four states apart, and folds none into another", async () => {
    await sweepFourStates();
    await publishAll();

    const stateOf = async (externalId: string): Promise<string> => {
      const res = await request(app).get(`/api/meetings/${await meetingId(externalId)}`);
      assert.equal(res.status, 200);
      return String(res.body.transcript.documents[0].state);
    };

    assert.equal(await stateOf("real"), "published");
    // The custodian served a well-formed file with nothing in it.
    assert.equal(await stateOf("stub-a"), "absent");
    // We could not read what was served. This one describes us.
    assert.equal(await stateOf("htmlerr"), "unavailable");
    // Nobody has asked yet, which is not the same as being told there is nothing.
    assert.equal(await stateOf("stub-b"), "unchecked");
  });

  it("says zero cues for an absence and nothing at all where it does not know", async () => {
    // `cue_count: 0` on an absence is a fact about the custodian's file. `null`
    // on the other two is the honest answer, and a JSON renderer that turned
    // either into the other would restate our silence as theirs.
    await sweepFourStates();
    await publishAll();

    const cuesOf = async (externalId: string): Promise<unknown> => {
      const res = await request(app).get(`/api/meetings/${await meetingId(externalId)}`);
      return res.body.transcript.documents[0].cue_count;
    };

    assert.equal(await cuesOf("stub-a"), 0);
    assert.equal(await cuesOf("htmlerr"), null);
    assert.equal(await cuesOf("stub-b"), null);
    assert.equal(await cuesOf("real"), 349);
  });

  it("returns null, not a row of zeroes, for a meeting with no transcript document", async () => {
    // A fifth thing, and it is not `unchecked`. `unchecked` names a document we
    // have not asked about; here there is no document to ask about.
    meetings = [meetingRef("nodocs", "2026-03-03", [])];
    await sweep();
    await publishAll();
    const res = await request(app).get(`/api/meetings/${await meetingId("nodocs")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.transcript, null);
  });

  it("never puts transcript error text in the response", async () => {
    // `last_error` carries a URL, an HTTP status and the first bytes of whatever
    // was served — a vendor stack trace, on this host. Coverage withholds it
    // deliberately and reading the same column one meeting at a time changes
    // nothing about that.
    await sweepFourStates();
    await publishAll();

    for (const externalId of ["real", "stub-a", "htmlerr", "stub-b"]) {
      const res = await request(app).get(`/api/meetings/${await meetingId(externalId)}`);
      const body = JSON.stringify(res.body);
      assert.equal(body.includes("last_error"), false, `${externalId} leaked the error column`);
      assert.equal(body.includes("Slim Application Error"), false);
      assert.equal(body.includes("expected WebVTT"), false);
    }

    // And the stored error really is there to be leaked, so the assertions above
    // are testing withholding rather than an empty column.
    const stored = await statusFor(CAPTIONS_HTML);
    assert.match(String(stored?.last_error), /text\/html/);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — the rule the schema has to enforce.
// ---------------------------------------------------------------------------

describe("the schema cannot attach a person to a cue", () => {
  it("has no column on transcript_cues that could name a speaker", async () => {
    // `>>` is the CEA-608 speaker-*change* marker and carries no identity. The
    // one sampled file with `Name:` prefixes spells a single person three ways —
    // Greg Sullivan, Gregg Sullivan, Gregg Sulivan — plus bare surnames of
    // undocumented provenance. A column named `speaker` would be read as an
    // identity by every consumer that touched it no matter what the comment above
    // it said, so the rule is enforced by the column not existing.
    const columns = await db("information_schema.columns")
      .where({ table_name: "transcript_cues" })
      .pluck("column_name");
    assert.deepEqual(
      columns.filter((name: string) => /speaker|member|person|official|name|voice/i.test(name)),
      [],
      `transcript_cues must carry no identity column; found ${columns.join(", ")}`,
    );
  });

  it("has no foreign key from either transcript table to a person", async () => {
    // Enumerated from the catalogue rather than read off the migration, because
    // the migration is what someone would edit.
    const result = await db.raw(
      `SELECT tc.table_name, ccu.table_name AS references_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('transcript_cues', 'transcript_status')`,
    );
    const referenced: string[] = result.rows.map(
      (row: { references_table: string }) => row.references_table,
    );
    for (const table of referenced) {
      assert.equal(
        /^(members|officials|people|persons)$/.test(table),
        false,
        `a transcript table must not reference ${table}: attribution comes from the minutes`,
      );
    }
    assert.deepEqual([...new Set(referenced)].sort(), ["artifacts", "meeting_documents"]);
  });

  it("refuses a 'published' row that carries no cues", async () => {
    // The two record states are told apart by the cue count and nothing else, so
    // the database refuses a row that says 'published' about an empty file.
    meetings = [meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")])];
    await sweep();
    await assert.rejects(
      db("transcript_status")
        .whereIn(
          "meeting_document_id",
          db("meeting_documents").where({ url: CAPTIONS_REAL }).select("id"),
        )
        .update({ state: "published", cue_count: 0 }),
    );
  });

  it("refuses an 'unavailable' row with no error text", async () => {
    meetings = [meetingRef("real", "2024-07-17", [transcriptRef(CAPTIONS_REAL, "2325", "real")])];
    await sweep();
    await assert.rejects(
      db("transcript_status")
        .whereIn(
          "meeting_document_id",
          db("meeting_documents").where({ url: CAPTIONS_REAL }).select("id"),
        )
        .update({ state: "unavailable", cue_count: null, last_error: null }),
    );
  });
});

describe("media time is never rendered as a time of day", () => {
  it("has no formatter anywhere that turns a cue clock into a wall clock", () => {
    // The recording starts before the meeting does, by an amount that varies per
    // clip — 00:29:38 for clip 2775, 00:01:44 for 2786 — and is published
    // nowhere. The only honest rendering is "29:38 into the recording". This is
    // grep-shaped on purpose, in the idiom of MethodologyPage.test.tsx's
    // forbidden-wording assertion: the defect it guards against is somebody
    // adding a convenience helper, not somebody changing this module.
    const hits = execFileSync(
      "grep",
      [
        "-rn",
        "-E",
        "start_ms|startMs",
        "--include=*.ts",
        join(__dirname, "..", "src"),
      ],
      { encoding: "utf-8" },
    )
      .split("\n")
      .filter((line) => /toLocaleTimeString|toTimeString|Intl\.DateTimeFormat|timeZone/.test(line));
    assert.deepEqual(hits, [], `a cue clock is being converted to a time of day:\n${hits.join("\n")}`);
  });
});

describe("the stub hash a reader can reproduce", () => {
  it("is the one this design is built on", () => {
    // If this ever fails, Granicus changed its empty-file bytes and every
    // absence claim on the site needs re-checking.
    assert.equal(createHash("sha256").update(Buffer.from(STUB_VTT)).digest("hex"), STUB_SHA256);
  });
});
