# Bozeman City Commission — Source Access Spike

> **Superseded in part, 2026-08-09.** The adapter is written and has run
> (`backend/src/services/ingestion/adapters/bozeman-granicus.ts`). This document remains the
> record of how the source was found and why `bozemanmt.gov` stays closed, and its access
> analysis held up exactly. Several of its **counts did not**, and §7 items 2 and 4 were
> overtaken by an operator decision. Corrections are marked inline and collected in §8.
> Where this document and `backend/test/fixtures/bozeman-granicus/PROVENANCE.md` disagree,
> PROVENANCE.md is the one written against bytes that still exist.

**Status:** Investigation complete. No adapter code written.
**Probed:** 2026-08-04 / 2026-08-05 UTC
**Egress IP during probing:** `184.166.213.70` (residential, not a datacenter range)
**Question:** Can Bozeman City Commission agendas and minutes be fetched at all, by acceptable means?

**Answer in one line:** Yes — the documents are fully reachable, but *not* at `bozemanmt.gov`. They live on
**Granicus** (`bozeman.granicus.com`), which serves the entire 2013–2026 archive to an honest client
with no evasion of any kind. The catch is that Granicus's `robots.txt` is `Disallow: /` for every
non-search-engine agent, so under this project's own stated rule ("Respect `robots.txt`") we may not
ship an automated crawler against it **until the City Clerk grants written permission**. That
permission request is cheap, well-grounded in Montana law, and is the recommendation below.

---

## 1. Does a real browser get through to bozemanmt.gov? No.

`www.bozeman.net` 301s to `www.bozemanmt.gov`. Every request to that host is denied at the Akamai edge,
including `/robots.txt`. This is **not** a headless-browser detection problem — a real Chromium engine
gets exactly the same response as `curl`.

### Literal responses

`curl` on `https://www.bozemanmt.gov/robots.txt`:

```
HTTP/2 403
server: AkamaiGHost
mime-version: 1.0
content-type: text/html
content-length: 385
x-reference-error: 18.47d02e17.1785904704.858a4fd6

<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http://www.bozemanmt.gov/robots.txt" on this server.
Reference #18.47d02e17.1785904704.858a4fd6
https://errors.edgesuite.net/18.47d02e17.1785904704.858a4fd6
</BODY></HTML>
```

Playwright Chromium (`playwright@1.59.1`, the version already installed for
`agents/meeting-monitor`), real browser engine, real TLS stack, default UA, full JS:

```
=== https://www.bozemanmt.gov/
status: 403
final url: https://www.bozemanmt.gov/
UA: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.7727.15 Safari/537.36
hdr server: AkamaiGHost
hdr x-reference-error: 18.47d02e17.1785904781.8592ed1a
title: Access Denied
bodylen: 197
body: Access Denied You don't have permission to access "http://www.bozemanmt.gov/" on this server.
```

Navigating to the legacy host in the same browser follows the redirect and lands on the same wall:

```
=== https://www.bozeman.net/
status: 403
final url: https://www.bozemanmt.gov/
```

### UA matrix — the block is UA-independent

| Client | User agent | Result |
|---|---|---|
| `curl` | default `curl/8.x` | `403` |
| `curl` | Chrome 140 desktop UA | `403` |
| `curl` | `CommissionWatch/0.1 (+civic transparency; contact …)` | `403` |
| Playwright Chromium | Chromium default | `403` |
| `curl` | any of the above, over plain `http://` | `403` |

Denied paths include `/`, `/robots.txt`, and `/departments/city-commission`.

**Conclusion:** No amount of legitimate client behaviour changes the outcome. Getting through would
require fingerprint/TLS manipulation or proxy rotation. Per the project's ethical boundary, that ends
the inquiry for this host: **`bozemanmt.gov` is not accessible by acceptable means.** No such
technique was implemented, tested, or benchmarked during this spike.

---

## 2. Where the documents actually live: Granicus

The decisive clue was DNS, not HTTP.

```
$ getent hosts www.bozemanmt.gov
2600:1409:9800:ac::172e:e4b2  e26614.dscb.akamaiedge.net
                              www.bozemanmt.gov
                              www.bozemanmt.gov.granicusgovaccess.net
                              san-e1.granicusgovaccess.net.edgekey.net
```

The city website is a **Granicus govAccess** property fronted by Akamai. Granicus also runs the city's
meeting portal on its own hostname — and that hostname is **not** behind the same WAF policy.

### `bozeman.granicus.com` responds normally

Same egress IP, same minute, honest project user agent, no evasion:

```
$ curl -A "CommissionWatch/0.1 (+civic transparency; contact …)" \
    "https://bozeman.granicus.com/ViewPublisher.php?view_id=1"
http=200  bytes=5865941
```

5.86 MB of **server-rendered HTML** — no JavaScript required, so `cheerio` is sufficient and Playwright
is not needed for this source. The page opens with:

> Meetings are arranged by date, with the most recent at the top of the list. Click Video to listen to
> the meeting and view agenda documents, or Agenda or Minutes to see just the documents.

### Coverage — one page holds the whole archive

Parsed from that single response:

| Metric | Value as parsed 2026-08-04 | **Re-measured 2026-08-09** |
|---|---|---|
| City Commission meetings listed | **520** | **519** |
| Date range | **2013 → 2026** | Confirmed. 2013 ×18 … 2025 ×180, 2026 ×126 (all bodies) |
| Rows with an agenda link | **507** | 507 was City-Commission-only. Across all bodies: **1,102** of 1,135 |
| Rows with a minutes link | **434** | Likewise: **956** across all bodies |
| Other public bodies on the same page | 20+ | **16 bodies in total**, City Commission included — not 20+ others |
| Upcoming meetings section | Yes | Confirmed, 17 rows. But it names bodies differently from the archive: "Tax Increment Finance Advisory Board" vs the panel's "Tax Increment Financing Board", and "Library Board of Trustees" has no panel at all |

There is only one `view_id` in use: **`view_id=1`**.

### URL structure

| Artifact | URL template | Verified response |
|---|---|---|
| Archive index | `https://bozeman.granicus.com/ViewPublisher.php?view_id=1` | `200`, 5.86 MB `text/html` |
| Agenda (past meeting) | `//bozeman.granicus.com/AgendaViewer.php?view_id=1&clip_id={clip_id}` | **`302`** → `granicus_production_attachments.s3.amazonaws.com`, then `200`, 36 KB `text/html`. Re-verified 2026-08-09; the redirect is why that S3 host is a declared origin in the adapter |
| Agenda (upcoming meeting) | `//bozeman.granicus.com/AgendaViewer.php?view_id=1&event_id={event_id}` | `200` `text/html` |
| Minutes | `//bozeman.granicus.com/MinutesViewer.php?view_id=1&clip_id={clip_id}&doc_id={uuid}` | `200`, 212 KB **`application/pdf`** (older rows `302` to the document) |
| Agenda packet | `https://d3n9y02raazwpg.cloudfront.net/bozeman/{uuid-chain}-{epoch}.pdf` | `200`, **28.4 MB, 439-page** PDF |
| Video player | `https://bozeman.granicus.com/player/clip/{clip_id}?view_id=1&redirect=true` | `200` `text/html` |
| Agenda mirror (S3) | `https://granicus_production_attachments.s3.amazonaws.com/bozeman/{hash}.html` | `200`, 31 KB `text/html` |

Concrete verified examples (City Commission, 2026-08-04 and 2026-07-21):

```
AgendaViewer.php?view_id=1&clip_id=2784                                    -> 200 text/html   36,422 B
MinutesViewer.php?view_id=1&clip_id=2775&doc_id=018ff04e-87a1-11f1-bb61-005056a89546
                                                                           -> 200 application/pdf 211,593 B
d3n9y02raazwpg.cloudfront.net/bozeman/17af417c-b814-11ef-ab4b-005056a89546-…-1785423206.pdf
                                                                           -> 200 application/pdf 28,373,419 B (439 pages)
```

### The agenda HTML is genuinely good source material

`AgendaViewer.php` returns clean structured HTML — lettered/numbered agenda items with sponsor names in
parentheses, exactly the shape the existing parser wants. Extracted text from `clip_id=2784`:

```
THE CITY COMMISSION OF BOZEMAN, MONTANA
REGULAR MEETING  AGENDA
Tuesday, August  4, 2026
…
A.   Call to Order - EARLY START TIME of 2:00 PM - Commission Room, City Hall, 121 North Rouse
B.   Pledge of Allegiance and a Moment of Silence or Mindfulness
C.   Changes to the Agenda
D.   Public Service Announcements
E.   FYI
F.   Commission Disclosures
G.   Consent
G.1  Formal Cancellation of the August 11, 2026, Regular City Commission Meeting (Maas)
```

Note this also corrects a stale default in the current config: the 2026-08-04 meeting had an **early
start of 2:00 PM**, and upcoming Commission meetings are listed at **6:00 PM**, not the `18:00` +
fixed-location assumption baked into `BOZEMAN_CONFIG.defaults`. Meeting time must be read per-row, not
defaulted.

> **Corrected 2026-08-09.** Half right, and the wrong half matters. The **Upcoming Events** table
> states a scheduled start and that is a real fact about the meeting. The **archive** table's time
> column is the *video clip's* start: the 2026-08-04 City Commission row reads 1:17 PM while that
> same meeting's agenda states the early start of 2:00 PM quoted above. Reading it "per-row" and
> publishing it as the meeting time would put a wrong time on 1,135 meetings. The adapter emits a
> time only for an upcoming meeting, and none at all for an archived one.

### RSS feeds exist

Six feeds are linked from the archive page, all under `view_id=1`:

```
https://bozeman.granicus.com/ViewPublisherRSS.php?view_id=1&mode=agendas   -> 200, 80,266 B, text/xml
https://bozeman.granicus.com/ViewPublisherRSS.php?view_id=1&mode=minutes
https://bozeman.granicus.com/ViewPublisherRSS.php?view_id=1&mode=podcast
https://bozeman.granicus.com/ViewPublisherRSS.php?view_id=1&mode=vpodcast
```

The agenda feed carries a stable `guid`, a title with body + date, a direct `AgendaViewer` link, and a
`gran:pubDateParts` element with pre-split date fields — an ideal cheap change-detection poll:

```xml
<item>
  <guid isPermaLink="false">98c81cfa-dce9-11ef-a9e2-005056a89546</guid>
  <title>Study Commission - Aug 06, 2026</title>
  <link>https://bozeman.granicus.com/AgendaViewer.php?view_id=1&amp;event_id=1517</link>
  <pubDate>Mon, 03 Aug 2026 02:23:21 -0700</pubDate>
  <gran:pubDateParts yr='2026' mo='08' day='03' hr='14' min='23' …/>
</item>
```

---

## 3. The blocker: Granicus `robots.txt` disallows us

```
$ curl https://bozeman.granicus.com/robots.txt
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

Three named search engines are allowed everything except `/JSON.php`, at a 10-second crawl delay.
**Everyone else is disallowed from the entire site.**

The project rule in `.claude/skills/commissionwatch-development/SKILL.md` is unambiguous:

> Fetch politely: a real browser at low rate, an honest user agent, aggressive caching, and no
> re-fetching of unchanged documents. **Respect `robots.txt`.**

So the technical availability of the Granicus archive does **not** by itself authorise ingestion. This
is precisely the distinction that made Gallatin ship first — for contrast, `gallatinmt.gov/robots.txt`
blocks only Baiduspider and Yandex outright and otherwise disallows only admin/search paths
(`/admin`, `/activedit`, `/search.aspx`, …), leaving the AgendaCenter content open to `*`.

### Probing conduct during this spike

Roughly 20 requests total, manually issued, spaced ~2 s apart, with either the default `curl` UA or an
honest `CommissionWatch/0.1` UA identifying the project and a contact address. No fingerprint spoofing,
no TLS/JA3 manipulation, no CAPTCHA solving, no proxy rotation, no header forgery was implemented,
tested, or attempted. `/JSON.php` was deliberately **not** probed, since it is disallowed even for the
allowed crawlers. This was a one-off manual reconnaissance to answer the access question; it is not a
precedent for running a scheduled crawler, which is exactly what the permission request below is for.

---

## 4. Alternative sources checked

| Candidate | Result |
|---|---|
| **Granicus** `bozeman.granicus.com` | ✅ **Present and complete.** 520 Commission meetings 2013–2026, agendas + minutes + packets + video + RSS. Blocked by `robots.txt`, not by technology. |
| **Legistar** `bozeman.legistar.com/Calendar.aspx` | ❌ False positive. Returns HTTP `200` but the body is 19 bytes: `Invalid parameters!` — no Legistar tenant exists. |
| **NovusAgenda** `bozeman.novusagenda.com` | ❌ HTTP `500`. |
| **PrimeGov** `bozeman.primegov.com/public/portal` | ❌ Connection failure (`000`), no such host. |
| **CivicPlus AgendaCenter** | ❌ Bozeman is a Granicus govAccess city, not CivicPlus. (Gallatin is the CivicPlus one.) |
| **YouTube** `@CityofBozeman` | ⚠️ Exists — 131 subscribers, **121 videos** — but it is public-information/outreach content ("Within Reach", "Lunch & Learn", "What's it called? Light rail!"), *not* the Commission meeting archive. 520 meetings vs 121 mixed videos: not a substitute, and it carries no agendas or minutes. Commission video lives on Granicus. |
| **CloudFront packet CDN** `d3n9y02raazwpg.cloudfront.net` | ✅ Serves agenda-packet PDFs directly, `200`. Origin-linked from Granicus; inherits the same permission question. |
| **S3 attachment mirror** `granicus_production_attachments.s3.amazonaws.com` | ✅ Serves agenda HTML, `200`. Bucket root `robots.txt` is `403 AccessDenied` (i.e. **no** robots policy published for that host). |
| **RSS feeds** | ✅ Four working feeds, but hosted on `bozeman.granicus.com` — same `robots.txt`. |
| **State open-records portal** | ❌ Montana has no central portal that republishes municipal meeting minutes. CERS (`mt-cers`) is campaign finance only and is irrelevant to agendas/minutes. |

---

## 5. Montana public-records route

Montana's right of access is constitutional and statutory, and it is strong.

- **Mont. Const. Art. II, § 9** — the "right to know": documents of all public bodies are open to
  inspection, subject only to individual privacy exceeding the merits of public disclosure.
- **MCA 2-6-1003** — every person has a right to examine and obtain a copy of any public information of
  this state. Agendas and approved minutes of a public governing body are squarely public information;
  no exemption plausibly applies.
- **MCA 2-6-1006** — public information requests and fees:
  - An agency may charge **up to $25/hour** for searching, gathering, reviewing, processing and
    providing information, plus actual copying/media/postage costs.
  - For a **complex** request: a filing fee of up to **$5**, then the hourly rate **after the first
    free hour**.
  - **Local governments** (this includes the City of Bozeman) must respond **"in a timely manner"** by
    either making the information available or providing a fee and timeline estimate. The stricter
    5-business-day acknowledgment clock is written for state agencies rather than local government.
  - Where information is not readily available, fulfilment runs to **90 days** from acknowledgment, or
    up to **6 months** with a written explanation of infeasibility.
  - Fee estimates may be required to be paid up front.

### What a request to the City Clerk actually involves

The Clerk's office is already named in the agenda boilerplate as the contact point:

> For more information please contact the City Clerks' Office at **406.582.2320**.
> …send an email to **comments@bozemanmt.gov**
> (agenda ADA contact: David Arnado, 406.582.3232)

Because the records are *already published electronically*, the correct ask is **permission and access,
not paper**. A well-formed request should:

1. Cite Mont. Const. Art. II § 9 and MCA 2-6-1003.
2. State plainly that the requester is a civic-transparency project that will re-publish with
   attribution, and that it identifies itself with a named user agent and a contact address.
3. Ask for **three specific things**, cheapest first:
   - a. **Written permission** to poll `bozeman.granicus.com` `view_id=1` — specifically
     `ViewPublisherRSS.php` (agendas/minutes modes), `ViewPublisher.php`, `AgendaViewer.php` and
     `MinutesViewer.php` — at a stated polite rate (e.g. ≤1 request per 10 s, honouring the published
     `Crawl-delay: 10`, with conditional requests and no re-fetch of unchanged documents),
     notwithstanding the blanket `robots.txt` rule. The Clerk can grant this, or forward it to
     Granicus, or ask Granicus to amend `robots.txt` to name our agent.
   - b. **Granicus Open Platform / API credentials**, if the city's Granicus contract includes them.
     This is the cleanest long-term answer and removes the `robots.txt` question entirely.
   - c. **Akamai allow-listing** of the `CommissionWatch/0.1` user agent for `www.bozemanmt.gov`,
     noting that the WAF currently returns `403` even on `/robots.txt`, which is almost certainly
     unintended and which the city may want to know about regardless. Include an Akamai reference
     number so their vendor can locate the deny event, e.g.
     `Reference #18.47d02e17.1785904704.858a4fd6`.
4. Include, as a **fallback**, a conventional records request for the agendas and approved minutes of
   the City Commission for a defined date range in native electronic format (PDF), delivered by
   download link or email — explicitly requesting a fee waiver or estimate under MCA 2-6-1006 on the
   grounds that the records are already in electronic form and require no meaningful search time.

Cost expectation: item 3 costs nothing and is likely to be granted, since the city already publishes
these records to the open internet and is paying Granicus to do so. Item 4 should be at or near zero
under the "first free hour" provision, since no search is required.

---

## 6. Is Gallatin-style ingestion possible for Bozeman?

**Technically: yes, and it would be easier than Gallatin.** Everything the pipeline needs is present,
server-rendered, and stably addressable:

- One index URL yields 520 Commission meetings across 13 years, plus 20+ other public bodies.
- Agendas are structured HTML, not PDF — better input than a scanned packet.
- Minutes are direct PDFs, already the shape `pdfjs-dist` handles.
- RSS gives cheap incremental change detection with stable GUIDs.
- Upcoming meetings are published in advance, which the meeting-monitor needs.
- No JavaScript execution required — `cheerio` suffices, and Playwright can stay unused for this source.
- IDs (`clip_id`, `event_id`, `doc_id` UUID) are stable primary keys for deduplication.

**Contractually: no, not yet.** `Disallow: /` for `*` blocks it under our own published standard. The
gap is a permission email, not an engineering problem.

The `bozemanmt.gov` host itself remains **not accessible by acceptable means** and should be treated as
permanently unavailable for automated fetching unless the city allow-lists us. It should not be
retried, worked around, or used as a fallback.

---

## 7. Recommendation

1. **Do not write a Bozeman adapter against `bozemanmt.gov`. Ever.** The Akamai deny is total and
   UA-independent; getting through requires techniques this project has ruled out. Delete the stale
   `bozeman.net` base URL and the three unvalidated stacked fallback selectors in
   `agents/meeting-monitor/src/scraper/bozeman-commission.ts` rather than leaving them to look
   maintained — they encode a site that no longer exists and selectors that were never true.

2. ~~**Do not ship an automated Granicus crawler until permission is in hand.**~~ **Overtaken by the
   operator decision of 2026-08-04**, which this document predates. The rule is no longer "respect
   `robots.txt`" without qualification: where a **vendor's** blanket `Disallow: /` would withhold
   records a government custodian is obliged to publish, the project fetches anyway, under stated
   conditions — one request every few seconds, never concurrent, an honest user agent, no re-fetch
   of unchanged documents, the public-records route offered alongside, and **the practice disclosed
   on the Methodology page**. See `.claude/skills/commissionwatch-development/SKILL.md` §"Scraping
   conduct".

   The adapter shipped 2026-08-09 under that exception, at the 10-second `Crawl-delay` the file
   itself publishes, and the Methodology page carries the disclosure in the same release. Nothing
   here changes for a custodian who asks us to stop: we stop.

3. **Send the City Clerk request this week** (§5 above). Ask for Granicus polling permission, an Open
   Platform API key, and Akamai allow-listing, with a conventional MCA 2-6-1003 records request as the
   fallback. This is a days-to-weeks unblock with a strong statutory footing, not a research project.

4. ~~**Meanwhile, keep Bozeman in the `blocked` health state.**~~ Superseded with item 2: the source
   registers `healthy` and **disabled**, which is where every new source starts. The paragraph
   below is still the right description of what `blocked` is for. Its closing note was acted on —
   the adapter registered under `bozeman-granicus`, not the migration comment's `bozeman-akamai`.

   Original text: **Meanwhile, keep Bozeman in the `blocked` health state.** `backend/migrations/016_create_ingestion_sources.ts`
   already models this as first-class and non-exceptional — "an adapter whose live fetching is
   unavailable (Bozeman) sits here while every downstream stage keeps running against stored
   artifacts." That is exactly the right posture; nothing in the schema needs to change. When
   permission lands, the adapter registers under an accurate key such as `bozeman-granicus`. The
   placeholder `bozeman-akamai` named in the migration comment describes the *blocker*, not the source,
   and should be renamed when the adapter is actually written.

5. **Ship Gallatin first, as planned.** Its `robots.txt` permits us, its content paths are open, and
   nothing here changes that sequencing. Bozeman's unblock is an email, and it can land in parallel
   without holding up the pipeline.

6. **When the adapter is eventually written**, design notes worth carrying forward: poll
   `ViewPublisherRSS.php?view_id=1&mode=agendas|minutes` for change detection rather than re-fetching
   the 5.86 MB index; honour the published `Crawl-delay: 10`; key on `clip_id`/`event_id`/`doc_id`;
   parse meeting time per-row instead of defaulting to `18:00`; and expect agenda packets in the tens
   of megabytes and hundreds of pages (one verified packet was 28.4 MB / 439 pages), so stream and cache
   them rather than holding them in memory.

---

## 8. Corrections, 2026-08-09

Re-probed while writing the adapter, same egress IP, same honest user agent, ~6 requests spaced
three seconds apart. The access findings all held: Granicus answers 200 with no evasion, and
`bozemanmt.gov` was not touched and must not be. What changed:

| § | This document said | Actually |
|---|---|---|
| 2 | 520 City Commission meetings | 519 |
| 2 | "20+ other public bodies" | 16 bodies in total |
| 2 | 507 agendas / 434 minutes | Those are City-Commission-only. All bodies: 1,102 / 956, out of 1,135 rows |
| 2 | Agenda URL returns `200` `text/html` | Returns `302` to S3 first |
| 2 | Read meeting time per-row | Only the Upcoming table's time is the meeting's. The archive's is the video clip's start |
| 6 | "IDs (`clip_id`, `event_id`, `doc_id`) are stable primary keys for deduplication" | Stable, but not usable as the meeting's key: a meeting carries an `event_id` while upcoming and a `clip_id` once past, so keying on them makes one meeting two rows. The adapter keys on body and date |
| 7.2 | Do not ship a crawler until permission is in hand | Superseded by the operator's vendor-robots exception |
| 7.4 | Keep Bozeman `blocked` | Registers `healthy` and disabled |

Two recommendations from §6 were **not** taken and are still open work, recorded so they are not
lost: polling `ViewPublisherRSS.php` for change detection rather than re-fetching the 5.9 MB index
every sweep, and streaming agenda packets rather than holding them in memory. The adapter fetches
the index each sweep and does not fetch packets at all by default.

The public-records recommendation in §5 stands on its own merits and is unaffected: the statutory
route should still be offered alongside, which is P7's job.
