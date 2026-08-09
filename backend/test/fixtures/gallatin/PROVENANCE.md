# Gallatin County fixture provenance

Every file here is a verbatim capture of a live response. Nothing was hand-written,
trimmed, or reformatted. The parser in `src/adapters/gallatin-civicplus.ts` is written
against these bytes, not against an idea of what CivicPlus emits.

Captured **2026-08-04** with:

```
curl -A 'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)'
```

at no more than one request every two seconds.

| File | Request | Notes |
|---|---|---|
| `robots.txt` | `GET https://www.gallatinmt.gov/robots.txt` | `AgendaCenter` is not disallowed. `/Search` is — that prefix does **not** match `/AgendaCenter/Search/`. |
| `agendacenter-index.html` | `GET https://www.gallatinmt.gov/AgendaCenter` | The discovery entry point. Renders one year per category plus the year links for every other year. |
| `updatecategorylist-cat4-2025.html` | `POST https://www.gallatinmt.gov/AgendaCenter/UpdateCategoryList` body `year=2025&catID=4` | The `<span id="section4">` fragment the site's own year switcher requests. Ten rows, each with agenda **and** minutes. |
| `updatecategorylist-cat14-2026-empty.html` | `POST https://www.gallatinmt.gov/AgendaCenter/UpdateCategoryList` body `year=2026&catID=14` | A category with no agendas. The endpoint answers with a **whole page** rather than the `span#section{catID}` fragment every other category returns. This capture carries no agenda rows at all, but parsing is scoped to that span so an unexpected page can never be read as the requested category's meetings. |
| `viewfile-agenda-06022025-2.pdf` | `GET https://www.gallatinmt.gov/AgendaCenter/ViewFile/Agenda/_06022025-2` | Big Sky Meadow Trails, Recreation & Parks Special District, June 2 2025 agenda. `application/pdf`, 74045 bytes, sha256 `3b53b21b970f6cfd791ed0b537aedc551cbe248ee9c646d793a1bfc40ee1f00e`. |

## What the capture disproved

- **The AgendaCenter search endpoint is not a discovery mechanism.**
  `GET /AgendaCenter/Search/?term=&CIDs=all&startDate=01/01/2025&endDate=12/31/2026`
  returned 8 rows — the same 8 the bare index returns. Weed Board alone has 10 more rows
  in 2025. Search narrows *which year* each category shows; it does not flatten years.
  A parser written against it would have silently dropped every meeting outside each
  category's most recent year.
- **There is no eSCRIBE.** The "eSCRIBE reference on the homepage" is `aria-describedby`
  matching a case-insensitive search for `escribe`.
- **The County Commission is not in AgendaCenter.** Category 14, "Commission", is empty:
  `/AgendaCenter/Commission-14` renders no rows. Commission agendas, minutes and audio are
  served from an AV Capture All iframe on `https://www.gallatinmt.gov/315/...`
  (`//media.avcaptureall.cloud/?customerGuid=421e2fdb-496d-4481-9216-151a190d0dd2&...`).
  That is a different source and needs its own adapter.
- **A `ViewFile` URL is not necessarily a PDF.**
  `GET /AgendaCenter/ViewFile/Agenda/_08062026-108` returns
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Its Download
  drop-down link is `class="html"`, not `class="pdf"`. The adapter therefore claims
  `expectedContentType: 'application/pdf'` only for links the source itself classes `pdf`.
- **No cache validators.** Neither the HTML pages nor the PDFs return `ETag` or
  `Last-Modified` (only `cache-control: private, s-maxage=600`). Conditional requests are
  still sent when a validator is known, but on this source the no-re-fetch guarantee comes
  from the adapter's per-URL document cache and from `artifacts.sha256` downstream.
