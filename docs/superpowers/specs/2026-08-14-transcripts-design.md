# Meeting transcripts

> Design of record for roadmap §6. Written 2026-08-14.
>
> Read first: `docs/superpowers/specs/2026-08-14-system-roadmap-design.md` §6, and
> `docs/superpowers/plans/2026-08-14-design-phase-brief.md` §5.
>
> **The brief was a hypothesis and this document is the evidence.** Three of its statements did not
> survive probing. They are corrected in §1 and the corrections change the design, so read §1 before
> §2 even if you have read the brief.

## Verdict up front

Bozeman ships. `bozeman.granicus.com/videos/{clip_id}/captions.vtt` serves real, timestamped
WebVTT under the same posture as an agenda, and every one of the 1,135 archived meetings carries a
clip id. Transcripts roughly double the searchable corpus and give the citation path a second
artifact.

Gallatin does not ship, and the reason is not that we could not find the route. We found it: the
county publishes meeting **audio** through AV Capture All, and that platform is a Blazor WebAssembly
application behind an AWS WAF challenge. Obtaining its data means running the challenge script and
presenting the token it mints, which is defeating an access control. Per SKILL.md's hard line the
answer is a records request, not a client. §9.

---

## 1. What we probed and what we found

All probes 2026-08-14, honest user agent
`CommissionWatch/1.0 (+https://commissionwatch.bmux.sh/about; civic transparency research)`, one
request every ten seconds to `bozeman.granicus.com` — the `Crawl-delay` its own `robots.txt`
publishes — and never concurrent. Clip ids came from the fixture
`backend/test/fixtures/bozeman-granicus/viewpublisher-view1.html.gz`, captured 2026-08-09, so the
archive page was not re-fetched to run this. No evasion of any kind: no browser string, no proxy, no
challenge solved.

### 1a. The endpoint is real

```
clip=2775 http=200 size=396890 type=text/vtt;charset=UTF-8
          final=https://bozeman.granicus.com/videos/2775/captions.vtt

WEBVTT

00:29:38.500 --> 00:29:40.547
>> Good evening good afternoon and welcome to our early start
```

Thirty clips sampled. Twenty-one returned a transcript; the largest was clip 2548 at 479,929 bytes
and 8,160 cues.

### 1b. The absent rate is 30%, and it is not random — **this corrects the brief**

The brief says "5 of 14 sampled clips" as though absence were a failure rate. It is not. Absence is
almost perfectly era-shaped:

| Era | Clips sampled | Empty stub |
|---|---|---|
| 2013 – 2020 | 8 | **8 (100%)** |
| 2021 – 2026 | 22 | **1 (4.5%)** |
| all | 30 | 9 (30%) |

Absent: 1301 (2013-09-23), 1415 (2015-04-06), 1566 (2017-08-08), 1700 (2018-07-10), 1858
(2019-03-11), 2109 (2020-01-06), 2172 (2020-11-10), 32 (2020-12-15), **220 (2022-01-03)**.

Present, with byte sizes: 40 (2021-01-12, 299,269) · 92 (2021-05-25, 336,783) · 158 (2021-10-05,
141,907) · 201 (2021-12-07, 155,452) · 225 (2022-01-24, 107,942) · 326 (2022-07-06, 153,616) · 725
(2022-09-14, 138,219) · 1229 (2022-09-28, 171,353) · 1892 (2022-10-18, 232,499) · 1973 (2023-03-06,
267,584) · 2077 (2023-07-03, 129,254) · 2163 (2023-11-06, 226,168) · 2241 (2024-03-18, 135,896) ·
2325 (2024-07-17, 26,458) · 2395 (2024-12-05, 166,972) · 2464 (2025-04-10, 165,809) · 2548
(2025-08-19, 479,929) · 2626 (2026-01-06, 186,189) · 2710 (2026-04-15, 149,899) · 2775 (2026-07-21,
396,890) · 2786 (2026-08-06, 231,859).

Clip 220 is the one that stops this being a clean cutover date: 2022-01-03 is empty while 2022-01-24
is 107 KB. So the honest statement is **"Bozeman began captioning around January 2021, and there are
occasional gaps after that"**, not "captions exist from date D". The site must render the two eras
differently, because "the city has never captioned this meeting and never will" and "the city
usually captions and did not caption this one" are different facts about the record.

Note also that clip ids are **not chronological**: clip 32 is December 2020 and clip 1301 is
September 2013. The numbering restarts. Nothing may infer an era from a clip id.

### 1c. The empty stub is exactly eight bytes, and every stub is the same eight bytes

```
$ xxd vtt-1301.txt
00000000: 5745 4256 5454 0a0a                      WEBVTT..

$ printf 'WEBVTT\n\n' | sha256sum
8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c
```

Every stub in the sample hashes to that value. **This is the single most consequential probe result
in the document** and §3 is built on it: the content address that makes an unchanged re-fetch a
no-op also collapses a thousand distinct absences into one artifact row. Anyone can reproduce the
hash from that one-line `printf`, which is what makes an absence claim checkable.

### 1d. There is no ETag, no Last-Modified and no Content-Length

```
HTTP/1.1 200 OK
Date: Fri, 14 Aug 2026 22:20:55 GMT
Server: Apache
Access-Control-Allow-Origin: *
X-Granicus-Server: 10.3.33.177
Content-Security-Policy-Report-Only: ...
Content-Type: text/vtt;charset=UTF-8
```

`fetchDocument`'s conditional-request path in `adapters/bozeman-granicus.ts` sends
`If-None-Match` / `If-Modified-Since` and can never receive a 304 here. Deduplication rests entirely
on `artifacts.sha256`, and re-checking a clip costs a full download every time. §2c is the
consequence.

### 1e. An unknown clip is a **500**, not a 404

```
clip=999999 http=500 size=2512 type=text/html;charset=UTF-8
<html><head><title>Slim Application Error</title>...
```

So the fetch stage cannot treat "not a 200" as the only failure and cannot treat a 200 as success.
Both the status and the byte signature have to be checked, and the two failure shapes — a vendor
error page and an empty-but-valid caption file — must not collapse into one recorded state.

### 1f. `MediaPlayer.php` is not in an `href` — **this corrects the brief and the roadmap**

Roadmap §6 says `classifyGranicusDocument` returns `null` for `MediaPlayer.php` "today, correctly".
It does, but that is not why nothing happens. The classifier is **never called with that URL**. The
archive row writes the player link like this:

```html
<a href="javascript:void(0);"
   onClick="window.open('//bozeman.granicus.com/MediaPlayer.php?view_id=1&clip_id=2687','player',
            'toolbar=no,directories=no,status=yes,scrollbars=yes,resizable=yes,menubar=no')">
```

`parseRow` iterates `row.find('a[href]')` and reads `link.attr('href')`, which is
`javascript:void(0);`. `absolute()` builds a `javascript:` URL, `isAbsoluteHttpUrl` rejects it, and
the link is dropped before classification. **Changing `classifyGranicusDocument` alone would achieve
nothing.** The extraction path has to read the `onClick` attribute. §2a.

Counted over the fixture: 1,152 `tr.listingRow` rows, **1,135 carry a `clip_id`**, 956 carry a
`MinutesViewer.php` link, and all 956 of those also carry a clip id. Every archived meeting has a
clip.

### 1g. Cue clocks are media time, not wall-clock time

Clip 2775's first cue starts at `00:29:38.500`; clip 2786's starts at `00:01:44.459`. The recording
begins before the meeting does, by an amount that varies per clip. A citation may therefore say
"29:38 into the recording". It may **never** be converted to a time of day. The archive's own Date
cell is no help either — `GranicusRow.time`'s existing comment already records that it is the
clip's start, not the meeting's.

### 1h. Speaker information is inconsistent and, where present, unreliable

| clip | cues | lines starting `>>` | `Name:` prefixes |
|---|---|---|---|
| 2786 | 3,224 | 84 | **510** |
| 2775 | 5,169 | 492 | 0 |
| 2548 | 8,160 | 291 | 0 |
| 40 | 4,482 | 379 | 0 |
| 225 | 1,536 | 192 | 0 |

Four of five files carry no speaker information beyond `>>`. The fifth carries name prefixes, and
its names do not agree with themselves:

```
    131 Carson Taylor:        25 Greg Sullivan:          1 Taylor:
    120 Becky Franks:          9 Gregg Sullivan:         1 Campbell:
     82 Jan Strout:            4 Gregg Sulivan:
```

Three spellings of one person, plus bare surnames. And `>>` is not even reliably a cue-initial
token — clip 2786 contains the payload:

```
a color change isn't enough to designate whether or not it's >>
```

A parser that split on `>>` would cut that sentence in half and hand the tail to a new speaker. §5.

### 1i. Granicus publishes a media-time agenda index

Unlooked for and worth recording. `MediaPlayer.php?view_id=1&clip_id=2786` 302s to
`/player/clip/2786?view_id=1&redirect=true`, whose server-rendered HTML contains both

```js
cuepoints: [{"time":100,"type":"Agenda","id":"132727"},{"time":174,...},{"time":3282,...}]
```

and a `<section id="index">` of ten `div.index-point` elements carrying `time`, `data-id`, and the
agenda item's own lettered title (`A) Call…`, `D) Cons…`, `G) New…`). That is a custodian-published
mapping from media time to agenda item. §6 says what to do with it, which is: not yet.

### 1j. Gallatin County — the route exists, and it is closed

The brief says Gallatin's broadcast route is "genuinely unknown". It is now known. The dead ends,
recorded so nobody repeats them:

- `gallatinmt.granicus.com` and `gallatin.granicus.com` both resolve — but `*.granicus.com` is a
  wildcard `CNAME` to `cluster-1.granicus.com` (`69.5.90.4`), the same target `bozeman.granicus.com`
  has, so resolution proves nothing. `ViewPublisher.php?view_id=1` on both returns
  `http=404 → /core/error/NotFound.aspx`. **Gallatin is not a Granicus tenant.**
- `www.gallatinmt.gov` homepage, `/899/Public-Meetings`, `/964/Agendas-and-Meeting-Minutes`,
  `/316/Social-Media`: no YouTube, Vimeo, Swagit, Cablecast, BoxCast or Twitch link anywhere.
- `/sitemap.xml` (597 `<loc>`s) contains no video, watch, live or stream page.
- The CivicPlus `AgendaCenter` carries only three categories — Big Sky Meadow Trails, Study
  Commission, Weed Board. The County Commission is not in it.
- A sampled Weed District agenda mentions Zoom for remote *attendance*, with no published recording.

The route is on `/315/Gallatin-County-Public-Meeting-Minutes-a`, which states in its own words:

> Audio Live Streaming of the meetings are located on the "Streaming Live" tab/dropdown. Audio
> recordings of meetings already held are located on the "Recorded" tab/dropdown.

and embeds:

```html
<iframe id="avcaiFrame"
  src="//media.avcaptureall.cloud/?customerGuid=421e2fdb-496d-4481-9216-151a190d0dd2
       &departmentGuid=bf9325cf-d39b-48c8-ae33-ac7238b76cdd
       &departmentGuid=242dadb5-a247-4892-b248-d6cb801a0b44
       &departmentGuid=0aa992f9-b094-4878-8c42-1c69961a228c
       &target=foo&view=list&tabs=past|today|upcoming">
```

So: **Gallatin County publishes meeting audio, not video, through AV Capture All**, across three
departments. What that host serves an honest client:

- Every path returns the same 15,256-byte Blazor WebAssembly shell with `http=200` — `/api/sessions`,
  `/api/session/list`, `/sitemap.xml`, and `/robots.txt` included. There is no robots.txt to read
  and therefore no `Disallow` to respect or to except; there is also no server-rendered listing to
  parse.
- The shell loads `https://1c4270f28412.us-west-2.sdk.awswaf.com/1c4270f28412/651e85c5859e/challenge.js`,
  sets `window.awsWafCookieDomainList = ['avcaptureall.cloud']`, and defines
  `getAwsWafToken = function() { return AwsWafIntegration.getToken() }`. The application mints a WAF
  token in JavaScript and presents it to whatever endpoint holds the data.
- The player is configured `controlsList="nodownload"` with `oncontextmenu="return false;"`.
- The platform *does* support captions: `PlayRecordedAudio(recordedUrl, subtitlesUrl, startSeconds)`
  attaches a remote text track when `subtitlesUrl` is non-empty. **Whether Gallatin's sessions carry
  one is unknown and cannot be established without the token.**

Stated precisely, because this is the kind of claim that gets overstated: we did not attempt the
token, so we cannot say the API refuses an honest client. What we can say is that the only way to
find out is to run the challenge script and present what it mints, and that is the line SKILL.md
draws. **Do not build it.** §9.

---

## 2. The `transcript` document kind

### 2a. Getting the clip id out

New in `adapters/bozeman-granicus.ts`, alongside `classifyGranicusDocument` rather than inside it:

```ts
export const GRANICUS_CLIP_LINK = /MediaPlayer\.php\?[^'"]*?\bclip_id=(\d+)/i;
export function extractGranicusClipId(row: cheerio.Cheerio<AnyNode>): string | null
```

It reads `a[onclick]` (cheerio lowercases attribute names, so `onClick` in the source is `onclick`
on the node) and returns the first capture. `parseRow` calls it once per row and puts the result on
`GranicusRow.clipId: string | null`.

`classifyGranicusDocument` is **unchanged**. A player page is still not a file and must still return
`null`; nothing should be able to enqueue `MediaPlayer.php` as a document. What we emit is the
derived captions URL:

```ts
{
  sourceKey: 'bozeman-granicus',
  kind: 'transcript',
  title: `Captions (clip ${clipId})`,          // clamped to VARCHAR_255 like every other title
  url: `${BOZEMAN_ORIGIN}/videos/${clipId}/captions.vtt`,
  meetingExternalId: externalId,
  expectedContentType: 'text/vtt',
  metadata: { clipId, mediaPlayerUrl: `${BOZEMAN_ORIGIN}/MediaPlayer.php?view_id=1&clip_id=${clipId}` },
}
```

The ref's `url` must be the thing actually fetched, because the fetch stage locates the document row
with `where({ meeting_id, url: ctx.target.url })` and `meeting_documents` is unique on
`(meeting_id, url)` (migration 029). Emitting the player URL and rewriting it later would break that
join. `metadata` carries the player URL as a string so a reader has the custodian's own address for
the recording, and `DocumentRef.metadata` is contracted to string values only — no nesting.

`BOZEMAN_ORIGIN` is already in `allowedOrigins`, so `guard()` passes with no change to the declared
surface. `/videos/…` falls under the same `Disallow: /` the adapter already fetches through, so this
is the existing vendor-robots exception of 2026-08-04 and not a new one. **The Methodology page must
name captions among the fetched kinds** — the exception is valid only while disclosed, and a
disclosure that lists agendas and minutes while we also take transcripts is a disclosure that has
gone stale.

### 2b. The type union

`DocumentKind` in `adapters/types.ts` gains `'transcript'`, and `DOCUMENT_KINDS` gains it in the same
commit so `asDocumentKind` can validate one read back out of `ingestion_jobs.target`.

**No migration is needed for the kind itself.** `meeting_documents.document_type` is a plain
`varchar(255)` (migration 005) with no check constraint and no enum. Verify that before writing the
plan rather than trusting this sentence.

### 2c. Re-fetch policy, and why it needs one

There is no ETag (§1d), so every check is a full download. 1,135 clips at ~180 KB average, ten
seconds apart, is roughly 200 MB and 3.2 hours of wall clock for one pass — and a caption file for a
2015 meeting will never change.

The gate lives in the **discover handler**, which is the first place in the pipeline with a database
connection. A `transcript` ref is not enqueued for fetch when all of:

1. a `transcript_status` row exists for its `meeting_document_id`, and
2. that row's `state` is `published`, or its `state` is `absent` **and** the meeting date is more
   than `TRANSCRIPT_SETTLE_DAYS` in the past.

`TRANSCRIPT_SETTLE_DAYS` defaults to 30. The reason it exists at all is the thing §3 is about:
Granicus generates captions asynchronously, so a meeting held on Tuesday can be `absent` on
Wednesday and `published` on Friday. **`absent` is not permanent, and a design that recorded it once
and never looked again would publish a false absence.** After the settle window it is treated as
settled, and an operator can force a re-check.

A `transcript_status` row in state `unavailable` is always re-enqueued: that state describes our
failure, not their record, and we do not get to stop trying.

---

## 3. `transcript_absent` as a recorded state

### 3a. Why the artifact cannot carry it

Three independent reasons, each fatal on its own.

**The hash is shared.** Every empty stub is the same eight bytes and hashes to
`8eb5aec5…837c` (§1c). One `artifacts` row will represent every absence Bozeman ever publishes.

**`artifacts.source_url` will lie.** The fetch handler inserts `.onConflict("sha256").ignore()`, so
`source_url` records whichever clip was fetched *first* and no other. An operator inspecting the
artifact behind meeting B's absence would be shown meeting A's URL. Rendering that as provenance
would be a false statement about the record.

**`parse` never runs.** The fetch handler enqueues `parse` only `if (isNew)`. From the second stub
onward there is no parse job at all, so nothing downstream of fetch can record anything about that
meeting.

The rejected alternative, recorded so nobody proposes it: salting the stub bytes per clip to make
each hash unique. That falsifies the content address, and the content address is the product.

**Therefore `transcript_status` is written by the `fetch` handler, not the `parse` handler**, outside
the `isNew` branch. That is the single load-bearing sentence in this section.

### 3b. The table

Migration `080_create_transcript_status.ts` (see §8 on the number).

```
meeting_document_id  uuid  primary key  references meeting_documents(id) on delete cascade
state                text        not null
clip_id              text        not null
observed_sha256      char(64)    null
cue_count            integer     null
first_checked_at     timestamptz not null
last_checked_at      timestamptz not null
checks               integer     not null default 1
last_error           text        null
created_at / updated_at
```

```sql
CHECK (state IN ('published','absent','unavailable'))
CHECK (state = 'unavailable' OR observed_sha256 ~ '^[0-9a-f]{64}$')
CHECK (state = 'unavailable' OR cue_count IS NOT NULL)
CHECK (state <> 'published'   OR cue_count > 0)
CHECK (state <> 'absent'      OR cue_count = 0)
CHECK (state <> 'unavailable' OR (last_error IS NOT NULL AND cue_count IS NULL))
CHECK (last_checked_at >= first_checked_at)
CHECK (checks >= 1)
CREATE INDEX transcript_status_state ON transcript_status (state);
CREATE INDEX transcript_status_recheck ON transcript_status (last_checked_at);
```

The three states, and what each one is a statement *about*:

| state | what happened | who it describes |
|---|---|---|
| `published` | a `text/vtt` body with ≥ 1 parseable cue | the custodian's record |
| `absent` | a well-formed WebVTT file with zero cues | the custodian's record |
| `unavailable` | a non-200, or a 200 whose bytes are not WebVTT | **us** |

`absent` is the custodian saying, in a file they chose to serve, that there is nothing here.
`unavailable` is us failing to get an answer. The site may render the first as a fact about Bozeman
and must never render the second that way.

**`observed_sha256` is not a foreign key to `artifacts`.** Same reasoning migration 072 gives for
`minute_claims.artifact_sha256`: the row records what bytes were served on a date, and it must
survive the artifact being deleted or never having been stored. It joins to `artifacts.sha256` when
a row exists. Its practical value is that an absence claim becomes checkable by a stranger with one
command — `printf 'WEBVTT\n\n' | sha256sum` — which is the same discipline every other published
claim on this site is held to.

`meeting_document_id` rather than `meeting_id`, because Bozeman's archive genuinely files one sitting
as two rows ("City Commission Meeting pt 1"), each with its own clip.

### 3c. What the fetch handler does

For a ref whose `kind` is `transcript`, after the existing artifact insert and `recordDocumentVersion`
call and **regardless of `isNew`**:

```
bytes → parseWebVttCues(bytes)                        // pure, no I/O; see §4a
  signature ok, cues.length > 0  → published,   cue_count = n
  signature ok, cues.length == 0 → absent,      cue_count = 0
  signature bad                  → unavailable, last_error = "expected WebVTT, got <content-type>, first bytes …"
non-200 from the transport       → unavailable, last_error = "<status> from <url>"
```

Upsert on `meeting_document_id`: `first_checked_at` is written only on insert, `last_checked_at` is
`now()` on every pass, `checks` increments. "We re-checked on Friday and it is still empty" is a
statement the status page should be able to make, and it needs those three columns to make it.

`parse` is still enqueued only when `isNew`, unchanged. There is nothing to parse from bytes we have
already indexed.

### 3d. How the status page reads it

`buildPublicStatus` is per-*source* and stays that way — transcript coverage is not a property of a
sweep. A sibling endpoint, `GET /api/transcripts/coverage`, returns per body and per calendar year:

```
{ jurisdiction, body, year, published, absent, unavailable, unchecked, checked_through }
```

`unchecked` is meeting documents of kind `transcript` with no `transcript_status` row — a real
fourth state, and omitting it would let a body with 200 unswept meetings read as 100% covered.

It is computed **only over published meetings**, through the same `whereMeetingPublished` helper
`services/search.ts` uses. Ingestion-run metadata is outside the publication wall because it
describes us; transcript coverage is inside it, because it describes meetings.

The sentence this exists to let the site render, both halves sourced:

> Bozeman City Commission, 2026: 12 of 12 meetings have a published transcript.
> 2015: 0 of 24 — the city's video system serves an empty caption file for every meeting that year.

Cross-spec dependency: the `<Absence>` grammar in the vocabulary spec is
`not_run | empty | withheld | no_source`. Proposed mapping — `absent` → `empty` with the custodian
named in the copy, `unavailable` → `no_source`, `unchecked` → `not_run`. That spec owns the final
call; this one owns the requirement that the three not collapse into one.

Failure counting, grounded in `scheduler.ts`: `SUCCESS_KEYS = ["discovered","fetched","parsed","analyzed"]`
and `FAILURE_KEYS = ["failed","blocked"]`, and `failuresIn` sums only the latter. So the fetch
handler emits, on top of its existing counts:

- `transcripts_published`, `transcripts_absent` — descriptive, in neither list. **`absent` must not
  count as a failure.** Nothing failed; that is the record.
- `transcripts_unavailable` **and** `failed: 1` together. `unavailable` is a real failure to obtain a
  public record, and the public status page's `failures` figure and `classifyRun`'s `partial` verdict
  both have to see it. Two numbers because one is readable and one is already wired.

---

## 4. VTT into `artifact_texts`, into search, and into a citation

### 4a. The parser

`looksLikeWebVtt(bytes)` in `services/ingestion/document-text.ts`, alongside `looksLikePdf` and
`looksLikeHtml`, and dispatched the same way — on the bytes, never on the `Content-Type`, because
Gallatin already proved a server's claim about its own bytes can be wrong. The signature is the
WebVTT spec's own: an optional UTF-8 BOM, `WEBVTT`, then EOF, `\n`, `\r`, space or tab. Decidable on
the first 16 bytes. All thirty probed responses satisfy it, the eight-byte stub included.

```ts
export interface VttCue { startMs: number; endMs: number; text: string; }
export function parseWebVttCues(bytes: Uint8Array): VttCue[];
```

What the sample actually contains, so the parser is written against evidence: no cue identifiers, no
`NOTE` / `STYLE` / `REGION` blocks, no cue settings after the arrow, no inline tags (`<v>`, `<b>`),
single-line payloads, and timestamps always in the long `HH:MM:SS.mmm` form. Grep counts across
clips 2775 and 2786 for `<`, for `align|line|position|size` on a timestamp line, and for
`^(NOTE|STYLE|REGION)` were all zero.

It must nevertheless handle the general forms — a cue id line, `NOTE` blocks, cue settings, the short
`MM:SS.mmm` timestamp, multi-line payloads — because a parser written to today's exact encoder
output breaks silently the first time Granicus upgrades it. And where it cannot: **it throws with the
line number, and the job fails.** A cue whose timestamps do not parse is never skipped. A parser that
drops what it does not understand produces a transcript with a hole in it that reads exactly like a
transcript without one.

`parseWebVttCues` is pure and does no I/O, which is what lets both the fetch handler (§3c) and the
parse handler call it with no second implementation to drift.

### 4b. The projection into `artifact_texts.text`

`artifact_texts.text` is **the cue payloads, one per line, joined with `\n`, and nothing else.** No
timestamps, no cue numbers, no synthesised speaker labels, no normalisation beyond the join.

Three reasons, and the third is the binding one:

1. `ts_headline('english', at.text, …)` is the search snippet a reader sees. `00:29:38.500 -->
   00:29:40.547` in a snippet is noise nobody searched for.
2. A quote must be text the custodian's file contains. A timecode is metadata, and a model quoting
   one would produce a citation that verifies against a clock.
3. `services/extraction/run.ts` builds its document text as `lines.join("\n")` and
   `verify.ts`'s `locateQuote` returns a **character offset into that string**, which is what
   `minute_claims.quote_offset` stores. One projection idiom means one offset space and one verifier.
   A second shape would need a second `verify.ts`.

The `Name:` prefixes in clip 2786 **stay in the text**. Stripping them would edit the custodian's
record; keeping them means a search for "Carson Taylor" finds the cue and the reader sees a
quotation from a caption file rather than an assertion from us. What must not happen is promoting
them to a column — see §5.

### 4c. How the timestamps survive

Migration `081_create_transcript_cues.ts`:

```
artifact_id   uuid    not null  references artifacts(id) on delete cascade
cue_index     integer not null            -- 0-based, file order
start_ms      integer not null
end_ms        integer not null
text_offset   integer not null            -- character offset into artifact_texts.text
text_length   integer not null
primary key (artifact_id, cue_index)
```

```sql
CHECK (start_ms >= 0 AND end_ms >= start_ms)
CHECK (text_offset >= 0 AND text_length > 0)
CREATE UNIQUE INDEX transcript_cues_offset ON transcript_cues (artifact_id, text_offset);
CREATE INDEX transcript_cues_lookup ON transcript_cues (artifact_id, text_offset, cue_index);
```

`ON DELETE CASCADE`, matching `artifact_texts` and deliberately unlike `document_versions.artifact_id`:
this is derived data, reproducible from bytes we still hold, and an orphaned cue index would be a
timeline with nothing behind it. A version row is evidence and must fail loudly instead.

Written in the **same transaction** as `recordArtifactText`, so the text and the index that describes
it can never be two different projections. The invariant, and it gets a test:

```
substr(artifact_texts.text, text_offset + 1, text_length) = the cue's payload, for every row
```

Addressing a moment is then a query over stored facts rather than an assertion:

```sql
-- the cue a citation starts in
SELECT cue_index, start_ms, end_ms FROM transcript_cues
WHERE artifact_id = $1 AND text_offset <= $2
ORDER BY text_offset DESC LIMIT 1;
```

with the mirror query at `quote_offset + length` for the last cue it touches. A quote spanning three
cues cites the interval `[first.start_ms, last.end_ms]`, because an interval is what is true. A point
would be a rounding of the record.

And per §1g, the rendered form is **"29:38 into the recording"**. Converting to a time of day is
forbidden: the offset from wall clock varies per clip and is not published anywhere. A test should
assert that no formatter in the codebase turns `start_ms` into a clock time.

### 4d. The content-addressed no-op is unchanged

Nothing here weakens `artifacts_sha256_unique`, and the path through an unchanged re-fetch is worth
tracing because it is the rule the whole pipeline rests on:

identical bytes → same `artifacts` row → `recordDocumentVersion` collides on
`(meeting_document_id, artifact_id)` and creates nothing → `isNew` is false → no `parse` job →
`artifact_texts` and `transcript_cues` untouched. The only write is `transcript_status`'
`last_checked_at` / `checks` bump, which is an UPDATE and carries no new claim.

For an absence the same path runs from the second clip onward with `isNew` false on the *first*
fetch too, because the stub artifact already exists from some other meeting. That is exactly why
§3a puts the status write in fetch.

### 4e. Search

`documentsQuery` in `services/search.ts` already joins
`artifact_texts → artifacts → document_versions → meeting_documents → meetings → commissions →
jurisdictions`, enforces the wall on `m.published_at`, and selects `md.document_type`. **A transcript
becomes searchable with no change to that query at all** the moment `recordArtifactText` runs for it.

Two changes are needed elsewhere:

1. **The parse handler must index text for every readable kind, not only agendas.** Today it returns
   `{ parse_not_agenda: 1 }` and exits *before* calling `recordArtifactText`, so minutes are not
   body-searchable either. Restructure: extract text and call `recordArtifactText` for any kind
   `extractDocumentText` can read, and gate only `extractAgendaItems` / `upsertAgendaItems` /
   `recordVersionSnapshot` on `documentType === 'agenda'`. Extracting agenda items from minutes would
   still manufacture an agenda nobody published; indexing their words would not. **This fixes minutes
   as a side effect and that is worth stating out loud**, because it changes the corpus more than the
   transcripts do in the first week.
2. `/search`'s copy currently tells readers only agendas are body-searchable. It must change — and
   **not before the corpus does**, or the page makes a promise the data does not keep.

`DocumentResult` already carries `document_type`, so the frontend can label a transcript hit with no
type change.

**Search results carry no timecode in v1**, and the spec says so rather than half-designing it.
`ts_headline` returns a rendered snippet, not an offset, so there is nothing to look up
`transcript_cues` with. The timecode belongs on the claim path, where a real `quote_offset` exists.
Adding it to search means either a second `strpos` pass per hit or storing offsets alongside
headlines, and neither is worth doing before anyone has asked.

---

## 5. Speaker attribution

The rule, first, then the evidence for it.

**A transcript never supplies an identity. The minutes do.**

### What the system may say

- That the custodian's caption file, artifact `sha256`, contains a given string at a given character
  offset, within a cue spanning a given media-time interval.
- That the file marks a speaker *change* at a given cue.
- That the file's own text at a cue begins with the characters `Greg Sullivan:` — quoted, attributed
  to the file, never resolved to a person.

### What the system may not say

- That a named person spoke those words. Not from `>>`; not from a `Name:` prefix; not from voice,
  which we never process.
- Nothing may write a `speaker` column on `transcript_cues`, and the plan must not add one. That
  single schema change is the entire failure mode: a column named `speaker` will be read as an
  identity by every consumer that touches it, no matter what the comment above it says.

### Why, from §1h

`>>` is the CEA-608 **speaker-change** marker. It carries no identity by construction, and in these
files it is not even reliable as a change signal: 84 markers across 3,224 cues of a three-hour
meeting is an order of magnitude fewer than the real number of turns, and it appears mid-payload
(`…isn't enough to designate whether or not it's >>`), so splitting on it manufactures a speaker
boundary in the middle of a sentence.

The `Name:` prefixes are worse, because they look authoritative. One of five sampled files has them.
That one spells a single person three ways — `Greg Sullivan`, `Gregg Sullivan`, `Gregg Sulivan` —
and also emits bare surnames. Their provenance is undocumented; they are as likely to be a
diarisation guess as a human label. A pipeline that resolved them against `members` would produce
three matches, two near-misses and a confident-looking attribution, which is precisely the shape of
error that ends a transparency project.

### Where attribution actually comes from

`minute_claims` anchors on `(artifact_sha256, quote, quote_offset)` in the **minutes PDF**;
`verify.ts` gates on office resolution and direction-carrying action cues; hallucinated-name
detection is mechanical against `members` (roadmap §4). None of that changes.

A transcript is a **corroborating** artifact for the words and never the **originating** artifact for
the identity. Concretely: a claim "X moved to Y" cites the minutes. If a transcript cue in the same
meeting contains a matching quotation, the claim may carry a *second* citation
`(transcript_sha256, quote_offset, start_ms)` labelled "as captioned" — and the citation chip must
name which artifact each half came from, because the two have different evidentiary weight and a
chip that hides that difference is worse than one citation. The published-claim spec owns how that
renders; this spec owns the rule that the transcript never supplies the name.

**ASR stays out.** The roadmap already ruled it out except for a body that publishes video without
captions, and nothing here produces one. If it ever ships, an ASR transcript is *our* artifact, a
claim cited to it is cited to us, and the citation must say so on its face.

---

## 6. The video index — designed, deferred, and here is why

§1i found a custodian-published mapping from media time to agenda item: `cuepoints` in the player
JavaScript, and a server-rendered `<section id="index">` carrying `time`, `data-id` and the agenda
item's lettered title. Bozeman's `AgendaViewer.php` agendas are lettered too, and the adapter's
existing HTML extractor already reads them.

That is the bridge from "at 29:38 in the recording" to "during item G) New Business", derived from
the custodian's own file rather than inferred. It is genuinely valuable and it is genuinely a
different document kind — a `transcript_index` with its own fetch, its own artifact and its own
table.

**It is not in scope for this spec**, for one reason worth recording: `data-id` values
(`132727`, `132728`, …) appear nowhere in the corresponding `AgendaViewer.php` HTML — checked
against the stored fixture, which contains no six-digit ids at all. So the join to `agenda_items`
would have to be made on the lettered title, and matching "D) Cons…" (truncated in the index) to
"D. Consent" (as the agenda prints it) is a fuzzy match dressed as a lookup. This project does not
guess at identity; that is what `BOZEMAN_BODY_ALIASES` exists instead of.

Build it when someone has read both documents for a real meeting and can say what the exact join is.
Until then §4c's interval, expressed in media time, is the honest citation.

---

## 7. Failure disclosure

Per the invariant, every path lands in a row with error text and the public status page reads from
those rows. Concretely, for each way this can go wrong:

| what happens | where it lands |
|---|---|
| transport error, timeout, 5xx on a real clip | `HttpStatusError` from `fetchDocument` → `ingestion_jobs.last_error`, retried to `maxRetries`, then `status = 'failed'`; run goes `partial` via `classifyRun` |
| the deterministic 500 on an unknown clip (§1e) | `transcript_status.state = 'unavailable'` with status and content-type in `last_error`, **and** `counts.failed += 1` so `failuresIn` and `classifyRun` both see it. The job completes rather than burning three retries at ten seconds on an answer that will not change |
| 200 with `text/html` (a vendor error page) | same as above; the content-type and first bytes go in `last_error` |
| WebVTT that will not parse (§4a) | `parse` job throws with the line number → `ingestion_jobs.last_error`; nothing is written to `artifact_texts` or `transcript_cues` |
| the empty stub | `transcript_status.state = 'absent'`, `counts.transcripts_absent += 1`, **no failure recorded**, because none occurred |
| clip id not found in an archive row | `logger.warn` and `counts.transcripts_no_clip += 1` on discover. A row without a clip is a fact about the archive, not an error |

`buildPublicStatus`'s `PublicStatusRun.failures` is a count and never the text — `toPublicSource`'s
existing leak test asserts that an error string quoting an unpublished meeting does not reach the
response, and `transcript_status.last_error` must be held to the same rule if the coverage endpoint
ever surfaces it. It carries a URL and an HTTP status, so today it is safe; the plan must add it to
that test's hostile-input set anyway, because "today it is safe" is not a constraint.

---

## 8. Migrations

**The number is a rendezvous and it is currently contested.** As of this writing, 074 is the last on
disk and five sibling specs written the same day each claim one of 075–079: `075_create_events`
(event spine), `076_add_claim_publication` (published claim), `077_create_claim_verdicts` (governor),
`078_create_vote_events` (throughput), `079_create_places` (geography). Transcripts are Tier 3 in the
roadmap's order of work, behind all of them, so:

- `080_create_transcript_status.ts` — §3b
- `081_create_transcript_cues.ts` — §4c

Knex orders migrations by filename, so a collision is not a merge conflict, it is two files that both
run and one that fails on an existing relation. **The plan must re-read the migrations directory
immediately before writing these, not trust this paragraph.**

Nothing else needs a migration. `meeting_documents.document_type` is a free varchar (005);
`artifact_texts` and its GIN index already exist (035); `documentsQuery` already reaches transcripts
through the existing joins.

---

## 9. Gallatin: the answer is a records request

Given §1j, the disposition:

**Do not build an AV Capture All adapter.** Its data is behind an AWS WAF challenge that the client
solves in JavaScript. Presenting a token minted by running the vendor's challenge script is
defeating an access control, which SKILL.md forbids without qualification, and the finding is "not
accessible by acceptable means."

**Do not treat the absence as unknown.** It is now known and should be published. The regions module
(roadmap §2) gains a `vendor platform` value of `av-capture-all` for Gallatin County, and the public
status page should be able to say: *Gallatin County publishes meeting audio, not video, through AV
Capture All. That platform serves no machine-readable listing and is behind a bot challenge, so we do
not ingest it. The recordings are at [the county's own page].* An absence a reader can see is a
commitment; one they cannot is a quiet failure.

**Three non-evasive routes remain, all requiring a human.** They are ordered by cost:

1. **Ask.** Email AV Capture All and the Gallatin County Clerk: we are a civic transparency project,
   here is our user agent and contact, does a feed or an export exist. This is the same ask the
   roadmap's `/bot` page is built for, and `bozeman.granicus.com/robots.txt` already allowlists a
   named non-Google crawler (`search-one-scgov`), which is evidence that vendors in this space do
   grant per-tenant exceptions when asked.
2. **A records request** for the audio recordings of specified meetings, through
   `jurisdiction_records_law` / the regions module — which is the statutory channel this project
   already offers alongside every scraped source.
3. **ASR on lawfully obtained audio**, if and only if 1 and 2 produce files. That is a separate spec,
   it produces *our* artifact, and every claim cited to it must say so.

Note the platform does support captions — `PlayRecordedAudio(recordedUrl, subtitlesUrl, startSeconds)`
attaches a text track when one exists. So route 1 might return finished transcripts rather than raw
audio. Worth asking before assuming route 3.

---

## 10. Tests the plan must require

- `extractGranicusClipId` returns `2687` for the real `onClick` string in the fixture, and `null` for
  a row with no player link. **Assert against `viewpublisher-view1.html.gz`, not a hand-written
  string** — the escaping in that attribute is exactly what a hand-written fixture gets wrong.
- The adapter emits 1,135 `transcript` refs from the stored fixture, and none of their URLs is a
  `MediaPlayer.php` URL.
- `classifyGranicusDocument('…/MediaPlayer.php?…')` still returns `null`. It is a regression guard on
  a rule that has not changed.
- `looksLikeWebVtt`: true for `WEBVTT\n\n`, for a BOM-prefixed file, and for `WEBVTT - title\n`;
  false for a PDF, for HTML, and for `WEBVTTX`.
- `parseWebVttCues` on the eight-byte stub returns `[]` and does not throw. This is the one that
  makes `absent` a state rather than an error.
- `parseWebVttCues` throws, with a line number, on a malformed timestamp. It must not skip the cue.
- **The projection invariant**, over a real captured transcript:
  `substr(text, text_offset + 1, text_length)` equals each cue's payload, for every cue.
- Fetching the stub for two different meetings creates **one** `artifacts` row, two
  `document_versions` rows, and **two** `transcript_status` rows both in state `absent`. This is the
  §3a failure mode, asserted directly.
- Re-fetching an unchanged transcript creates no new artifact, no new version, no new cue rows, and
  bumps `checks` by exactly one.
- A 500 from the captions URL records `unavailable` with `last_error` non-null **and** increments
  `counts.failed`, and `classifyRun` returns `partial` for that run.
- `absent` does **not** increment `counts.failed`, and a sweep whose only transcripts were absent
  classifies as `succeeded`.
- A transcript on an unpublished meeting does not appear in `/api/search` results, and does not
  appear in `/api/transcripts/coverage` counts.
- Minutes text is indexed into `artifact_texts` after the §4e restructure, and **no agenda items are
  written from a minutes document.** Two assertions, because the change could break either way.
- Nothing anywhere converts `start_ms` to a time of day. Grep-shaped, in the idiom of
  `MethodologyPage.test.tsx`'s forbidden-wording assertion.
- `transcript_cues` has no `speaker` column. A schema assertion, and the comment above it should say
  why.

## 11. Open questions — what a human must decide

1. **The Methodology disclosure.** Adding captions to the fetched kinds means editing the published
   robots-exception disclosure. Per SKILL.md the exception is valid only while disclosed, so this is
   an operator edit that must land *before* the first transcript sweep, not after.

2. **Whether to backfill the pre-2021 archive at all.** Eight of eight sampled clips from 2013–2020
   are empty, so a full backfill is ~500 fetches, 1.4 hours of crawl and 4 KB of yield, to learn
   something we can already state with 95% confidence. Two defensible answers: sweep it once so the
   coverage page reports a checked fact rather than an inference, or state the inference and label it
   as one. This project's usual answer is the first. It is still a decision with a cost.

3. **`TRANSCRIPT_SETTLE_DAYS = 30`** is a guess. Nobody has measured how long after a Bozeman meeting
   the captions appear. One clean way to find out: probe the three most recent clips daily for two
   weeks and read the answer off the data. Until then the number is a placeholder and the plan should
   say so where it is defined.

4. **Clip 220.** A 2022 meeting with no captions in a year where everything else has them. Is that a
   Granicus processing failure, a meeting that was not recorded, or something the city withdrew? Not
   answerable by probing, and it is exactly the sort of thing worth one email to the clerk — the
   answer determines whether `absent` after the settle window should ever be re-checked.

5. **Does the transcript belong in `/api/data`'s bulk export and the OCD profile?** A 480 KB caption
   file per meeting is a different order of magnitude from the current export. Probably a separate
   download with its own manifest entry, but the export spec owns it.

6. **Gallatin's three `departmentGuid`s.** Which county departments they name is unknown, and knowing
   it would tell us whether the Commission's own audio is even in that widget. A human can read the
   rendered iframe in a browser in thirty seconds. Nobody should build anything on Gallatin audio
   until someone has.

7. **Who signs the Gallatin ask.** §9 route 1 is an email from a named person to a named clerk. It is
   the cheapest item in this document and the only one no agent can do.
