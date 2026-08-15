# Bozeman Granicus fixture provenance

Every file here is a verbatim capture of a live response. Nothing was hand-written,
trimmed, or reformatted. The parser in `src/services/ingestion/adapters/bozeman-granicus.ts`
is written against these bytes, not against an idea of what Granicus emits.

Captured **2026-08-09** with:

```
curl -A 'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)'
```

at no more than one request every three seconds, ~6 requests in total. No fingerprint
spoofing, no TLS/JA3 manipulation, no CAPTCHA solving, no proxy rotation, no header forgery
was implemented, tested, or attempted. `/JSON.php` was deliberately not probed: it is
disallowed even for the crawlers `robots.txt` does allow. **`bozemanmt.gov` was not
touched.**

| File | Request | Response |
|---|---|---|
| `robots.txt` | `GET https://bozeman.granicus.com/robots.txt` | `200`, 241 B. `Disallow: /` for `*` — see below. sha256 `ac520e96489c10c6864a2b2fcc4a21120f954baa06b6e544a7ecdcc9eb8fff05` |
| `viewpublisher-view1.html.gz` | `GET https://bozeman.granicus.com/ViewPublisher.php?view_id=1` | `200`, `text/html`, **5,874,595 bytes**. The whole archive in one response. |
| `agendaviewer-clip2784.html` | `GET https://bozeman.granicus.com/AgendaViewer.php?view_id=1&clip_id=2784` | **`302`** → `https://granicus_production_attachments.s3.amazonaws.com/bozeman/4b286c0963f81a34dcb7ddb2d2548bc20.html`, then `200`, `text/html`, 36,422 B. City Commission, 2026-08-04. sha256 `adf92bf54e009434f99ca310ec7aa648741952c6f0df7bc8ca7662c29881e741` |
| `minutesviewer-clip2775.pdf` | `GET https://bozeman.granicus.com/MinutesViewer.php?view_id=1&clip_id=2775&doc_id=018ff04e-87a1-11f1-bb61-005056a89546` | **`302`** → `https://bozeman.granicus.com/DocumentViewer.php?file=bozeman_9929ef707e2bb0ed8f20a3185e1668d2.pdf&view=1`, then `200`, `application/pdf`, 211,593 B. City Commission, 2026-07-21. sha256 `f2d3c1af3a8aacd88b28a002068518a0ed3339578e6ff7fc0fd075a83df67ab0` |

## The one file that is not stored byte-for-byte on disk

`viewpublisher-view1.html.gz` is the verbatim response **gzipped**, because 5.9 MB of HTML
in a 12 MB repository is not a reasonable trade for bytes that compress to 148 KB. The
capture itself is unaltered and provable:

```
$ gunzip -c viewpublisher-view1.html.gz | sha256sum
25224b8d66b59562f4392130734fbf7ebbadcc62ccdf2bc201ec7d1b5cbd03b3
```

That is the sha256 of the response body as it arrived. The test decompresses it and
asserts that digest before parsing anything, so a fixture edited in place fails loudly
rather than quietly changing what the parser is written against.

## robots.txt, verbatim

```
User-agent: Googlebot
Disallow: /JSON.php
Crawl-delay: 10
User-agent: Slurp
Disallow: /JSON.php
Crawl-delay: 10
User-agent: msnbot
Disallow: /JSON.php
Crawl-delay: 10
User-agent: search-one-scgov
Disallow: /JSON.php
User-agent: *
Disallow: /
```

Three named search engines plus one vendor crawler get everything except `/JSON.php`, at a
10-second crawl delay. Everyone else is disallowed from the entire site.

The adapter fetches anyway, under the operator's vendor-robots exception of 2026-08-04
(`.claude/skills/commissionwatch-development/SKILL.md`), at the 10-second delay this file
publishes, with the project's honest user agent, and **disclosed on the Methodology page**.
If that disclosure comes down, the adapter is switched off with it.

## What this capture proved about the source

- **One request is the whole archive.** 1,135 past meetings across 16 bodies, 2013→2026,
  plus 17 upcoming. The year tabs (`li.TabbedPanelsTab`) are client-side; every year's rows
  are already in the response. There is no per-year endpoint, which is the opposite of
  Gallatin's AgendaCenter.
- **The panel tab is the only place a body is named.** The row's Name cell is a per-meeting
  title: the City Commission panel carries "City Commission" (220), "City Commission
  Meeting" (38), "City Commission Special Meeting" (12), "City Commission Meeting pt 1",
  "City Commission original", and 240-odd one-off titles that embed a date. Parsing
  `tr.listingRow` across the page and trusting the Name cell would invent bodies by the
  dozen.
- **Agendas are HTML, minutes are PDF.** `AgendaViewer.php` 302s to an S3-hosted HTML
  agenda — clean, lettered, sponsor names in parentheses, better input than any scanned
  packet. That redirect is why `granicus_production_attachments.s3.amazonaws.com` is a
  declared origin.
- **Only three link families in a row are documents**: `AgendaViewer.php` (1,104 rows),
  `MinutesViewer.php` (945) and a CloudFront packet PDF (724). The fourth is
  `javascript:void(0)` opening `MediaPlayer.php`, which is a video player, not a file.

## What this capture disproved, in `docs/exploration/bozeman-access-spike.md`

The spike was accurate about access and wrong about several counts. Corrected there too.

| Spike said (2026-08-04) | Live on 2026-08-09 |
|---|---|
| 520 City Commission meetings | **519** rows in the City Commission panel |
| "20+ other public bodies on the same page" | **16 bodies in total**, City Commission included |
| 507 with agendas, 434 with minutes | Those were City-Commission-only figures. Across all bodies: 1,102 agendas, 956 minutes, 724 packets |
| Agenda URL "verified `200`, 36 KB `text/html`" | `302` first, to S3. The 36 KB is what S3 serves |
| "Meeting time must be read per-row, not defaulted to 18:00" | Half right. The **Upcoming** table states a scheduled start (6:00 PM for Commission). The **archive** table's time is the *video clip's* start: the 2026-08-04 row says 1:17 PM while that meeting's own agenda states an early start of 2:00 PM. It is not the meeting's start time and the adapter does not publish it as one |

## What the capture forced in the design

- **`(body, date)` is not unique.** 9 of 1,135 rows share a body and a date with another
  row — City Commission alone on 2014-09-25, 2015-06-15, 2017-09-26, 2019-09-16 and
  2020-01-13. The adapter's `externalId` is `${bodyKey}-${date}` with an ordinal suffix for
  the second and later rows of a day, in page order.
  The alternative, Granicus's own `clip_id` / `event_id`, was rejected: a meeting is listed
  under an `event_id` while it is upcoming and under a `clip_id` once it has happened, so
  keying on those makes one real meeting two rows in `meetings`, one permanently
  `scheduled`. The cost of the chosen key is that those 9 same-day pairs depend on page
  order — newest-first, stable across this capture — to stay distinct.
- **The Upcoming table names bodies differently from the archive.** "Tax Increment Finance
  Advisory Board" vs the panel's "Tax Increment Financing Board"; "Urban Parks and Forestry
  Board" vs "Urban Parks & Forestry Board"; and "Library Board of Trustees" and the two
  Gallatin Valley MPO committees have no panel at all. Unmatched names are skipped and
  logged, never guessed at.
- **Agenda packets are not fetched by default.** One verified packet from this capture's
  page is 28.4 MB / 439 pages, and 724 rows carry one.

## `captions-clip2325.vtt` — captured 2026-08-15

One request, honest user agent, no evasion:

```
$ curl -sS -A 'CommissionWatch/1.0 (+https://commissionwatch.bmux.sh/about; civic transparency research)' \
    -L 'https://bozeman.granicus.com/videos/2325/captions.vtt'
http=200 size=26458 type=text/vtt;charset=UTF-8
sha256 5afecbc5bb50f938aa3cc4b57b1bd3fcdfd54672963b9d6828cf86246a700429
```

Clip 2325 is the City Commission meeting of 2024-07-17 and is the **smallest non-empty**
caption file in the 2026-08-14 probe sample — 349 cues, 26 KB, against a 480 KB maximum.
Chosen for that reason: the fixture has to be a real file the city served, and a fixture
nobody wants to store is a fixture that gets replaced by a hand-written one.

It confirms the design spec's evidence still held on 2026-08-15: the byte size is exactly
the 26,458 recorded on 2026-08-14, the file uses no cue identifiers, no `NOTE`/`STYLE`/
`REGION` blocks, no cue settings and no inline tags, its timestamps are all long-form
`HH:MM:SS.mmm`, and its first cue starts at `00:01:01.633` — media time, not a clock.

**The empty stub is not stored as a fixture and must not be.** It is eight bytes,
`WEBVTT\n\n`, and the tests build it with a one-line `printf`-equivalent so the reader can
check the hash themselves:

```
$ printf 'WEBVTT\n\n' | sha256sum
8eb5aec53542eaedb7502b22fb677161abba1e265b1338f1af1369a1f689837c
```

That single shared hash is why `transcript_status` exists — see `migrations/089`.

## `mediaplayer-clip2325.html.gz` — captured 2026-08-15

One request, honest user agent, no evasion, to the same clip the caption fixture above
came from — deliberately, so the two can be checked against each other:

```
$ curl -sS -A 'CommissionWatch/1.0 (+https://commissionwatch.bmux.sh/about; civic transparency research)' \
    -L 'https://bozeman.granicus.com/MediaPlayer.php?view_id=1&clip_id=2325'
http=200 size=75807 type=text/html; charset=UTF-8
final=https://bozeman.granicus.com/player/clip/2325?view_id=1&redirect=true
```

Gzipped on disk for the same reason `viewpublisher-view1.html.gz` is — 76 KB of player
markup against 14 KB compressed — and provable the same way:

```
$ gunzip -c mediaplayer-clip2325.html.gz | sha256sum
84c775076b5b130ce20ff846be5c309bd728f7ce8a4a85ccdacf8ed8c9c35a80
```

**Byte-stable.** Clip 2775's page was fetched twice, seven minutes apart on 2026-08-15, and
hashed identically both times. That is what makes `meeting_recordings.observed_sha256` a
hash a stranger can reproduce rather than a hash of whatever we happened to receive.

What it states, and the corroboration:

| Read from the page | Value |
|---|---|
| `video_url` | `https://archive-stream.granicus.com/OnDemand/_definst_/mp4:archive/bozeman/bozeman_fa3dbfab-286a-4bb1-8643-fb050de5c02a.mp4/playlist.m3u8` |
| `maxValInSec` | `1678` — the ceiling the page sets on its own embed end-time input, i.e. the clip's length |
| `cuepoints` | a media-time index of agenda items, `[{"time":…,"type":"Agenda","id":"…"}, …]` |

`captions-clip2325.vtt`, captured independently from a different endpoint, ends its last
cue at **1676 seconds**. Two seconds from the page's 1678. The duration this project
publishes is therefore corroborated by a second document rather than merely parsed out of
one.

## The recording itself is not fetched, and here is the probe that decided it

`docs/superpowers/specs/2026-08-14-audio-transcription-design.md` §5 left it open whether
Bozeman's media is fetchable under the same posture as the captions. Probed 2026-08-15:

```
$ curl -sS -A 'CommissionWatch/1.0 (+https://commissionwatch.bmux.sh/about; …)' -I -L \
    'https://archive-video.granicus.com/bozeman/bozeman_a1f0657c-7758-43c1-bb2c-a8450f107cb3.mp4'
HTTP/2 403      server: CloudFront      x-cache: Error from cloudfront

$ curl -sS -I -L <same url>                          # curl's own default user agent
HTTP/2 403

$ curl -sS -A 'Mozilla/5.0 (X11; Linux x86_64) … Chrome/127.0.0.0 …' -I -L <same url>
HTTP/2 200      content-length: 6008707697      server: AmazonS3      accept-ranges: bytes
```

The custodian's own download link, `bozeman.granicus.com/DownloadFile.php?view_id=1&clip_id=2775`,
redirects onto that host and inherits the 403. The single browser-UA request above was a
diagnostic run once to establish *why* the honest request failed; nothing was downloaded, and
no fetch in this codebase sends a browser user-agent string.

So the media is reachable only by claiming to be a browser, which is browser-fingerprint
spoofing and is the line `SKILL.md` draws. **The finding is "not accessible by acceptable
means" and the route is a public-records request.** `archive-video.granicus.com` and
`archive-stream.granicus.com` are not in the adapter's `allowedOrigins` and must not be added.

Two further facts from the same probe, recorded so nobody re-derives them:

- `bozeman.granicus.com/podcast.php?view_id=1` returns a valid RSS channel with
  `<gran:podCastEnabled/>` and **zero items**. There is no audio podcast feed to subscribe to.
- `ASX.php?view_id=1&clip_id=N` answers `200 video/x-ms-asf` to an honest client and yields
  only an `rtmp://69.5.90.100/...` reference — the same media, over a protocol retired years
  ago, on a host that is equally not ours to reach around.
