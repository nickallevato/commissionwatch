# MT CERS fixtures — provenance

**Fetched:** 2026-08-10, recorded at `2026-08-10T05:28:15.261Z` UTC
**Host:** `https://cers-ext.mt.gov/CampaignTracker`
**Publisher:** Montana Commissioner of Political Practices — Campaign Electronic Reporting System
**Recorded by:** `backend/test/fixtures/mt-cers/record.ts`, which drives the real
`mt-cers` adapter against the real host. Re-record with:

```bash
cd backend && npx tsx test/fixtures/mt-cers/record.ts
```

**User agent:** `CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)`
**Conduct:** 30 requests, one at a time, never concurrent, 2.5 s apart. No fingerprint spoofing,
no TLS/JA3 manipulation, no CAPTCHA solving, no proxy rotation, no browser-identity forgery — none
was needed, and none is implemented. `cers-ext.mt.gov` publishes **no `robots.txt`** (`/robots.txt`
is a Tomcat 404, not a `Disallow`), so no access exception is claimed for this source. The
filer-side application (`/CampaignTracker/app/*`, Okta) was never touched.

Access analysis, with URLs and status codes: `docs/exploration/mt-cers-spike.md`.

## What was captured

One narrow slice — the office this project actually watches — not a mirror of the source:

| | |
|---|---|
| Sweep target | `candidateTypeCode=CN` (County), `officeCode=29` (County Commissioner), `countyCode=3257` (Gallatin) |
| Roster | **42** Gallatin County Commissioner candidacies, election years 2000–2026 |
| Candidates walked | 2, election year ≥ 2026 — `22048` Brown, Zach J and `22095` Finn, Ryan J |
| Reports walked | 2 per candidate, newest first |
| Schedules | `individual` and `expendOther` |
| Distinct exchanges | **21** |

## The tape, and why it is keyed the way it is

`exchanges.json` is a tape, not a URL→file map. **A CERS response is not a function of its
request.** `financeRepDetailList` with `listName=individual` returns whichever report was last
opened *in the same session* — the criteria live in server-side session state, not in the request.
So each exchange is keyed on `cersExchangeKey(position, request)`: the search last run, the
candidate selected, the report opened, then the method, path, page offset and body.

A fixture keyed on the request alone would have served one candidate's contributions for every
candidate, and every test would have passed. `test/helpers/cers-tape.ts` replays the tape using
`advanceSession` — **the same function the adapter uses** — so the harness cannot model a protocol
the adapter does not follow.

Filenames carry a 12-character digest of that key. An earlier recording truncated the key to build
the name, and because every key here begins with the same long search body, two different exchanges
produced the same filename and one silently overwrote the other. The digest is not decoration.

## Exchanges

| Status | Method | Path | Bytes | File |
|---|---|---|---|---|
| 302 | GET | `/public/search/candidateSearch` | 0 | `get-candidateSearch-07582b07284a.html` |
| 200 | GET | `/public/search;jsessionid=…` | 159,217 | `get-search-da490927067d.html` |
| 200 | POST | `/public/searchResults/searchCandidates` | 115,053 | `post-searchCandidates-e6e3853dc8b4.html` |
| 200 | GET | `/public/searchResults/listCandidateResults` | 200,080 | `get-listCandidateResults-882a4e3d10a3.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` (22048) | 0 | `post-retrieveCampaignReports-d19b68e588e4.html` |
| 200 | GET | `/public/publicReportList` | 39,968 | `get-publicReportList-578199869d7e.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` (22048) | 27,592 | `get-listFinanceReports-0159ab444c58.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` (22095) | 0 | `post-retrieveCampaignReports-8b391ec8fe6e.html` |
| 200 | GET | `/public/publicReportList` | 39,961 | `get-publicReportList-5c61a85c651b.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` (22095) | 5,669 | `get-listFinanceReports-fb38b6b21e4c.json` |
| 200 | POST | `/public/searchResults/searchCandidates` (re-run under fetch) | 115,053 | `post-searchCandidates-af2401ecc650.html` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` (80259) | 93,209 | `post-retrieveReport-e175acdf6ce3.html` |
| 200 | POST | `financeRepDetailList` `individual` (80259) | 9,519 | `post-financeRepDetailList-1efebe5f3471.json` |
| 200 | POST | `financeRepDetailList` `expendOther` (80259) | 4,390 | `post-financeRepDetailList-50ba77d35ce0.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` (79145) | 93,201 | `post-retrieveReport-264d507edc7c.html` |
| 200 | POST | `financeRepDetailList` `individual` (79145) | 6,387 | `post-financeRepDetailList-e390ca685778.json` |
| 200 | POST | `financeRepDetailList` `expendOther` (79145) | 3,353 | `post-financeRepDetailList-47a0016eb2c3.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` (22095) | 0 | `post-retrieveCampaignReports-c432a0016666.html` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` (80406) | 93,160 | `post-retrieveReport-660cd3af4e7e.html` |
| 200 | POST | `financeRepDetailList` `individual` (80406) | 2 | `post-financeRepDetailList-23dcca0f63c7.json` |
| 200 | POST | `financeRepDetailList` `expendOther` (80406) | 2 | `post-financeRepDetailList-a8b6c83aea14.json` |

**The two 2-byte responses are `[]`, and they are kept deliberately.** A filed report with no
itemised contributions is a real and common state, and a fixture set containing only populated
schedules would let an adapter that silently dropped empty results go green.

## Two things a reader should know about this data

**It contains personal information that is part of a public filing but is not automatically
publishable.** The roster's `personDTO` carries candidates' home addresses, personal email
addresses and home and mobile telephone numbers. Every contribution row carries the donor's street
address, occupation and employer. Storing it is right — provenance is the product — and
republishing a home telephone number is a separate decision that belongs to an operator, not to a
default projection. Nothing in the campaign-finance schema publishes any of it.

**The roster bytes are not byte-stable between sweeps.** Two recordings twenty minutes apart both
returned exactly 200,080 bytes with different SHA-256 digests, so the content address will not
deduplicate the roster and each sweep will store a new artifact for it. That is a property of the
source, not a defect here, and it is recorded rather than worked around: the schedules — the rows
that actually matter — deduplicate correctly.
