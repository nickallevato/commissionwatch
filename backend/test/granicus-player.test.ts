import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  formatRecordingLength,
  granicusMediaId,
  looksLikeGranicusPlayer,
  readGranicusPlayer,
} from "../src/services/ingestion/granicus-player";
import { parseWebVttCues } from "../src/services/ingestion/webvtt";
import { readRecording } from "../src/services/ingestion/recordings";

/**
 * Reading the custodian's player page. Pure functions, real captured bytes, no
 * database and no network.
 *
 * The suite is built around one claim, because the table is built around one
 * claim: **the City published a recording of this meeting and it is this long.**
 * That claim is published without our ever having heard the recording — we cannot
 * obtain it — so the whole of its credibility rests on the length being derivable
 * from bytes whose hash anyone can reproduce.
 *
 * So the load-bearing test here is not that the regex matches. It is
 * `corroborates its own reading against a second document`: the page states 1678
 * seconds and the caption file for the same clip, captured independently from a
 * different endpoint, ends its final cue at 1676.633. Two documents, 1.4 seconds
 * apart. Everything else in this file is scaffolding around that.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "bozeman-granicus");

/**
 * Clip 2325's player page, captured 2026-08-15 in one polite request. Gzipped on
 * disk for the reason `viewpublisher-view1.html.gz` is, and the digest below is
 * of the response body as it arrived:
 *
 *   $ gunzip -c mediaplayer-clip2325.html.gz | sha256sum
 *   84c775076b5b130ce20ff846be5c309bd728f7ce8a4a85ccdacf8ed8c9c35a80
 */
const PLAYER_SHA256 = "84c775076b5b130ce20ff846be5c309bd728f7ce8a4a85ccdacf8ed8c9c35a80";
const REAL_PLAYER = new Uint8Array(
  gunzipSync(readFileSync(join(FIXTURE_DIR, "mediaplayer-clip2325.html.gz"))),
);

/** The caption file for the same clip, captured from a different endpoint. */
const REAL_VTT = new Uint8Array(readFileSync(join(FIXTURE_DIR, "captions-clip2325.vtt")));

const MEDIA_URL =
  "https://archive-stream.granicus.com/OnDemand/_definst_/mp4:archive/bozeman/" +
  "bozeman_fa3dbfab-286a-4bb1-8643-fb050de5c02a.mp4/playlist.m3u8";
const MEDIA_ID = "bozeman_fa3dbfab-286a-4bb1-8643-fb050de5c02a";

const VENDOR_ERROR_HTML = new TextEncoder().encode(
  "<html><head><title>Slim Application Error</title></head><body>" +
    "<p>The application could not run because of the following error:</p></body></html>",
);

describe("the player fixture is the bytes Granicus served", () => {
  it("has not been edited in place", () => {
    // A fixture quietly changed is a parser written against something nobody
    // received. Same guard `viewpublisher-view1.html.gz` carries.
    assert.equal(createHash("sha256").update(REAL_PLAYER).digest("hex"), PLAYER_SHA256);
  });
});

describe("looksLikeGranicusPlayer", () => {
  it("accepts the real captured page", () => {
    assert.equal(looksLikeGranicusPlayer(REAL_PLAYER), true);
  });

  it("rejects a vendor error page, a caption file and a PDF", () => {
    // Decided on the bytes and never on the Content-Type: a vendor error page is
    // `200 text/html` too, and Gallatin already proved a server's claim about its
    // own bytes can be wrong.
    assert.equal(looksLikeGranicusPlayer(VENDOR_ERROR_HTML), false);
    assert.equal(looksLikeGranicusPlayer(REAL_VTT), false);
    assert.equal(looksLikeGranicusPlayer(new TextEncoder().encode("%PDF-1.4\n")), false);
  });
});

describe("readGranicusPlayer", () => {
  it("reads the media id, the stream URL, the length and the index", () => {
    const reading = readGranicusPlayer(REAL_PLAYER);
    assert.equal(reading.error, null);
    assert.deepEqual(reading.facts, {
      mediaId: MEDIA_ID,
      mediaUrl: MEDIA_URL,
      durationMs: 1_678_000,
      indexPointCount: 9,
    });
  });

  it("corroborates its own reading against a second document", () => {
    // **The test this table exists to pass.** The page says 1,678 seconds. The
    // caption file for the same clip — a different endpoint, a different format,
    // captured in a separate request — ends its last cue at 1,676.633 seconds.
    //
    // Nothing else in this project checks a number we publish against a second
    // custodian-published document. It is the difference between "our parser
    // found a number near the word length" and "the recording is 27 minutes
    // 58 seconds long".
    const facts = readGranicusPlayer(REAL_PLAYER).facts;
    assert.ok(facts !== null);
    const cues = parseWebVttCues(REAL_VTT);
    const lastCueEndMs = cues[cues.length - 1].endMs;
    assert.equal(lastCueEndMs, 1_676_633);
    assert.ok(
      facts.durationMs >= lastCueEndMs && facts.durationMs - lastCueEndMs < 10_000,
      `page says ${facts.durationMs}ms, captions end at ${lastCueEndMs}ms`,
    );
  });

  it("names what is missing rather than guessing a length", () => {
    // A recording whose length we invented is worse than one whose length we do
    // not publish, so every failure is a named absence and never a default.
    const noVideo = readGranicusPlayer(new TextEncoder().encode("<html>let maxValInSec = 10;</html>"));
    assert.equal(noVideo.facts, null);
    assert.match(String(noVideo.error), /no video_url/);

    const noLength = readGranicusPlayer(
      new TextEncoder().encode(`<script>video_url="${MEDIA_URL}"</script>`),
    );
    assert.equal(noLength.facts, null);
    assert.match(String(noLength.error), /no maxValInSec/);
    assert.match(String(noLength.error), new RegExp(MEDIA_ID));
  });

  it("refuses a zero length, which is what a live stream reports", () => {
    // Recording it would publish a public meeting of no duration.
    const live = readGranicusPlayer(
      new TextEncoder().encode(`<script>video_url="${MEDIA_URL}"</script>let maxValInSec = 0;`),
    );
    assert.equal(live.facts, null);
    assert.match(String(live.error), /length of 0s/);
  });

  it("counts no cue points as zero rather than as a failure", () => {
    // A custodian who indexed no agenda items has told us something true.
    const reading = readGranicusPlayer(
      new TextEncoder().encode(`<script>video_url="${MEDIA_URL}"</script>let maxValInSec = 60;`),
    );
    assert.equal(reading.facts?.indexPointCount, 0);
    assert.equal(reading.facts?.durationMs, 60_000);
  });

  it("reports the size and first bytes of something that is not a player page", () => {
    const reading = readGranicusPlayer(VENDOR_ERROR_HTML);
    assert.match(String(reading.error), /Slim Application Error/);
    assert.match(String(reading.error), new RegExp(String(VENDOR_ERROR_HTML.length)));
  });
});

describe("granicusMediaId", () => {
  it("reads the media file's own name out of the stream path", () => {
    assert.equal(granicusMediaId(MEDIA_URL), MEDIA_ID);
    assert.equal(granicusMediaId("https://host/a/b/thing.mp4"), "thing");
  });

  it("returns null rather than inventing one", () => {
    assert.equal(granicusMediaId("https://host/playlist.m3u8"), null);
    assert.equal(granicusMediaId(""), null);
  });
});

describe("readRecording", () => {
  it("has two states, and the failure one describes us", () => {
    // There is deliberately no `absent`. A meeting the custodian did not record
    // has no `recording` document at all — the archive row carries no clip id —
    // so giving our parse failure and their unrecorded meeting the same word
    // would be the mistake `transcript_status` was built to avoid next door.
    const ok = readRecording(REAL_PLAYER);
    assert.equal(ok.state, "available");
    assert.equal(ok.durationMs, 1_678_000);
    assert.equal(ok.lastError, null);

    const bad = readRecording(VENDOR_ERROR_HTML);
    assert.equal(bad.state, "unreadable");
    assert.equal(bad.durationMs, null);
    assert.equal(bad.mediaId, null);
    assert.ok(bad.lastError !== null);
  });
});

describe("a recording's length is media time and never a clock", () => {
  it("renders hours and minutes, with no time of day anywhere in it", () => {
    // Per the transcripts probe, the recording starts before the meeting by an
    // amount that varies per clip (29:38 for clip 2775, 01:44 for 2786) and is
    // published nowhere. So "the meeting ran until 9:47pm" is not a rendering of
    // this number, it is an invention with a timestamp on it.
    assert.equal(formatRecordingLength(22_788_000), "6h 19m");
    assert.equal(formatRecordingLength(10_595_000), "2h 56m");
    assert.equal(formatRecordingLength(1_678_000), "27m 58s");
    assert.equal(formatRecordingLength(0), "0s");
    for (const ms of [0, 1_678_000, 22_788_000]) {
      const rendered = formatRecordingLength(ms);
      assert.equal(/[ap]m/i.test(rendered), false, rendered);
      assert.equal(rendered.includes(":"), false, rendered);
    }
  });

  it("has no formatter anywhere that turns a recording length into a wall clock", () => {
    // Grep-shaped, in the idiom the transcripts suite uses for `start_ms`. The
    // rule is only worth having if nothing in the tree can quietly break it.
    const roots = [join(__dirname, "..", "src")];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (!/duration_ms|durationMs|recorded_ms/.test(source)) continue;
        for (const line of source.split("\n")) {
          if (!/duration_ms|durationMs|recorded_ms/.test(line)) continue;
          if (/toLocaleTimeString|toTimeString|\bhour12\b/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`);
          }
        }
      }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(offenders, [], "a recording length was rendered as a time of day");
  });
});
