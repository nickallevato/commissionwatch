# Plan — P4 · Bozeman Granicus adapter

> Date: 2026-08-09
> Spec: `docs/superpowers/specs/2026-08-09-phase-2-design.md` §P4
> Exploration: `docs/exploration/bozeman-access-spike.md` (probed 2026-08-04/05)
> Branch: `feat/archive-salvage`

## What the live probe found on 2026-08-09

Probed with `curl -A 'CommissionWatch/0.1 (civic transparency project;
+https://commissionwatch.bmux.sh)'`, one request every three seconds, no evasion of any kind.
**Everything below is what the site served today, not what the spike recorded four days ago.**

| Claim in `bozeman-access-spike.md` | What 2026-08-09 actually returned |
|---|---|
| `ViewPublisher.php?view_id=1` → 200, 5.86 MB | **Confirmed.** 200, 5,874,595 bytes, `text/html` |
| robots.txt is `Disallow: /` for `*` | **Confirmed**, byte for byte |
| 520 City Commission meetings | **519** rows under the City Commission panel |
| "20+ other public bodies" | **16 bodies total**, City Commission included |
| 507 with agendas / 434 with minutes | Across *all* bodies: 1135 rows, 1102 with an agenda link, 956 with minutes, 724 with an agenda packet |
| Agenda at `AgendaViewer.php?...&clip_id=` returns 200 text/html | **302**, to `granicus_production_attachments.s3.amazonaws.com`, which then returns 200 / 36,422 B `text/html` |
| Minutes at `MinutesViewer.php` returns PDF | **Confirmed** — 302 to `DocumentViewer.php?file=…`, 200 `application/pdf`, 211,593 B |
| "Meeting time must be read per-row" | **Amended.** The past-meeting Date column carries the *video clip* start (1:17 PM on 2026-08-04), while the agenda for that meeting states an early start of 2:00 PM. It is not the meeting's start time and must not be published as one. Only the Upcoming Events table states a scheduled start. |

Two further facts the spike did not record, both load-bearing:

1. **The archive is one flat page.** Every year of every body is already in the response;
   the year tabs are client-side only. There is no per-year AJAX endpoint to walk, unlike
   Gallatin. One request discovers everything.
2. **(body, date) is not unique.** 9 of 1135 rows share a body and a date with another row
   (City Commission alone has 5 such days, e.g. 2020-01-13).

## The robots.txt decision, restated

`bozeman.granicus.com/robots.txt` is `Disallow: /` for every agent that is not Googlebot,
Slurp, msnbot or `search-one-scgov`. That is a **vendor** file, and the operator decision of
2026-08-04 recorded in `.claude/skills/commissionwatch-development/SKILL.md` covers exactly
this case: where a vendor's blanket disallow would withhold records a custodian is legally
obliged to publish, we fetch anyway, under strict conditions — one request every few seconds,
never concurrent, an honest user agent, no re-fetch of unchanged documents, **and public
disclosure on the Methodology page**.

`bozeman-access-spike.md` §7.2 predates that decision and says the opposite. It is corrected
by this work rather than left to contradict the skill.

The disclosure does not exist on the Methodology page yet. **Shipping the adapter without
shipping the disclosure would put the project in breach of its own published standard**, so
the disclosure is part of this change, not a follow-up.

No fingerprint spoofing, TLS/JA3 manipulation, CAPTCHA solving or proxy rotation is used or
needed. The honest user agent gets 200s.

## Design

### Politeness

`Crawl-delay: 10` is the only rate the file publishes, for the agents it allows. We honour the
strictest published number rather than inventing a gentler-sounding one: **10,000 ms between
requests, concurrency 1**. That is five times slower than Gallatin.

### Identity

`externalId` is `${bodyKey}-${date}`, with `-2`, `-3` … appended for a second row of the same
body on the same day (page order, which is newest-first and stable).

The alternative — Granicus's own `clip_id` / `event_id` — was rejected. A meeting appears in
Upcoming Events under an `event_id` and, once it has happened, in Past Meetings under a
`clip_id`. Keyed on those, one real meeting becomes two rows in `meetings`, one of them
permanently stuck at `scheduled`. On a transparency site that is a false statement about the
record. Keyed on body and date, the upcoming row is *revised* into the completed one by the
existing `onConflict(['commission_id','external_id'])` upsert, which is the correct behaviour.
The cost is that the 0.8% of days carrying two meetings of the same body depend on page order
to stay distinct. That is documented in the module and in `PROVENANCE.md`.

### Documents

| Source column | `DocumentKind` | Expected type |
|---|---|---|
| Agenda (`AgendaViewer.php`) | `agenda` | `text/html` |
| Minutes (`MinutesViewer.php`) | `minutes` | `application/pdf` |
| Agenda Packet (CloudFront) | `packet` | `application/pdf` |

**Packets are off by default.** One verified packet is 28.4 MB / 439 pages, and 724 rows carry
one. A first sweep that pulled them would push multiple gigabytes onto a t4g.medium's disk and
into MinIO for no gain the agenda does not already give. `includePackets` is an adapter option,
default `false`, and the reason is in the code.

### Origins

Declared surface is three hosts, because the adapter's requests genuinely land on three:
`https://bozeman.granicus.com`, `https://granicus_production_attachments.s3.amazonaws.com`
(where `AgendaViewer` redirects) and, when packets are enabled,
`https://d3n9y02raazwpg.cloudfront.net`.

### Parsing agenda items out of HTML

Bozeman's agenda is **HTML**, not PDF, and it is the best structured input either source has.
`handlers.parse` only knows `extractPdfText`, which would raise `UnsupportedDocumentError` and
record `parse_unsupported` for every Bozeman agenda — bytes stored, zero agenda items. The spec's
acceptance criterion asks for agenda items, so two small, shared changes ship with the adapter:

- `services/ingestion/document-text.ts` — dispatches on the bytes: `%PDF-` → the existing
  `extractPdfText`; an HTML document → a new `extractHtmlText` built on cheerio, which
  reconstructs lines at block boundaries. Anything else still raises `UnsupportedDocumentError`,
  so Gallatin's Word documents behave exactly as they do today.
- `agenda-items.ts` — `MARKED_LINE` learns the dotted marker `G.1`, `H.12`, `1.2`. Bozeman's
  sub-items are all of that form and are currently dropped on the floor. The separator stays
  **required** for the existing single-token markers, so "I will move to approve" does not
  become an agenda item.

## Tasks

Each is a commit. The tree must be green at every one.

### T1 — the false sweep line (frontend + a public status endpoint)

`Layout.tsx` hardcodes `"Last sweep 12 min ago"`. Real rows now exist, so it is a false
statement rather than a placeholder.

- `backend/src/routes/ingestion.ts` — `GET /api/ingestion/status` →
  `{ lastSuccessfulSweepAt: string | null }`, read from
  `max(ingestion_runs.finished_at) where status in ('succeeded','partial')`. Public and
  read-only, like the rest of `/api`.
- `backend/src/app.ts` — mount at `/api/ingestion`.
- `backend/test/ingestion-status.test.ts`, **registered in `package.json`'s `test` script**.
- `frontend/src/hooks/useIngestionStatus.ts`, `frontend/src/mocks/handlers.ts`.
- `Layout.tsx` renders a relative age from that value, and **"No sweep yet"** when it is null or
  the request fails. No invented number in any state.
- `Layout.test.tsx` gains cases for a real timestamp, for null, and for a failed request.

### T2 — the adapter

- `backend/src/services/ingestion/adapters/http.ts` — the transport, robots parser and document
  cache lifted verbatim out of `gallatin-civicplus.ts`, which re-exports them so its own 68
  contract tests keep passing unchanged.
- `backend/src/services/ingestion/adapters/bozeman-granicus.ts`.
- `backend/test/fixtures/bozeman-granicus/` + `PROVENANCE.md` (fetch date, exact URL, sha256).
- `backend/test/adapters/bozeman-granicus.test.ts` running `runAdapterContract`, registered in
  `package.json`.
- `backend/src/services/ingestion/index.ts` — `createDefaultRegistry()` gains the adapter.
  Registration already creates every source **disabled**; nothing else is needed to keep
  production from sweeping.

### T3 — HTML agenda text

- `document-text.ts` + `html-text.ts`, `handlers.ts` calls the dispatcher.
- `agenda-items.ts` dotted markers.
- `backend/test/document-text.test.ts`, registered in `package.json`.

### T4 — the documents that must not lag the code

- `MethodologyPage.tsx` — the vendor-robots disclosure, with a test.
- `docs/exploration/bozeman-access-spike.md` — corrected counts, corrected §7.2.
- `docs/superpowers/specs/2026-08-09-phase-2-design.md` — P4 amended where implementation
  disagreed with it.
- `docs/STATUS.md`.

### T5 — a real sweep

`npm run sweep -- --adapter bozeman-granicus --lookback-days 14`, locally, against the live
site, at 10 s per request. Report the row counts it actually landed. The source stays disabled
on the live host.

## Verification gate

```
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
```

Baseline not to regress: backend 497 tests / 137 suites, frontend 150 / 22, zero lint errors.
