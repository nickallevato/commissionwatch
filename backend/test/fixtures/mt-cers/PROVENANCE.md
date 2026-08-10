# MT CERS fixtures — provenance

**Fetched:** 2026-08-10, recorded at `2026-08-10T05:33:51.497Z` UTC
**Host:** `https://cers-ext.mt.gov/CampaignTracker`
**Publisher:** Montana Commissioner of Political Practices — Campaign Electronic Reporting System
**Recorded by:** `backend/test/fixtures/mt-cers/record.ts`, which drives the real
`mt-cers` adapter against the real host. Re-record with:

```bash
cd backend && npx tsx test/fixtures/mt-cers/record.ts
```

**User agent:** `CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)`
**Conduct:** ~30 requests, one at a time, never concurrent, 2.5 s apart. No fingerprint spoofing,
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
| Distinct exchanges | **19** |

## The tape, and why it is keyed the way it is

`exchanges.json` is a tape, not a URL→file map. **A CERS response is not a function of its
request.** `financeRepDetailList` with `listName=individual` returns whichever report was last
opened *in the same session* — the criteria live in server-side session state, not in the request.
So each exchange is keyed on `cersExchangeKey(position, request)`, which adds to the request
**only** the session state that endpoint actually reads: the search last run for
`listCandidateResults`, the candidate selected for `listFinanceReports`, the candidate *and* the
report for `financeRepDetailList`, and nothing at all for the POSTs that set that state.

The "only" is load-bearing and was learned by getting it wrong. Keying on the whole position made
the tape depend on the order the recorder happened to walk in — fetching the same roster twice, or
opening candidate B's report before candidate A's, produced keys that had never been recorded even
though the responses were identical.

A fixture keyed on the request alone would have gone the other way and served one candidate's
contributions for every candidate, with every test passing. `test/helpers/cers-tape.ts` replays the
tape using `advanceSession` — **the same function the adapter uses** — so the harness cannot model a
protocol the adapter does not follow.

Filenames carry a 12-character digest of that key. An earlier recording truncated the key to build
the name, and because every key here begins with the same long search body, two different exchanges
produced the same filename and one silently overwrote the other. The digest is not decoration.

## Exchanges

| Status | Method | Path | Bytes | File |
|---|---|---|---|---|
| 302 | GET | `/public/search/candidateSearch` | 0 | `get-candidateSearch-34cdcb6f59a6.html` |
| 200 | GET | `/public/search;jsessionid=…` | 159,217 | `get-search-d884ef730aa2.html` |
| 200 | POST | `/public/searchResults/searchCandidates` | 115,053 | `post-searchCandidates-513914c6b3ea.html` |
| 200 | GET | `/public/searchResults/listCandidateResults` | 200,080 | `get-listCandidateResults-9a8c8f9ec18c.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` `candidateId=22048` | 0 | `post-retrieveCampaignReports-948c6adc0a39.html` |
| 200 | GET | `/public/publicReportList` | 39,968 | `get-publicReportList-75505b65343e.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` | 27,592 | `get-listFinanceReports-4877e49806ad.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` `candidateId=22095` | 0 | `post-retrieveCampaignReports-0fcb60b8cce7.html` |
| 200 | GET | `/public/publicReportList` | 39,961 | `get-publicReportList-d4821923a9ab.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` | 5,669 | `get-listFinanceReports-349392e3ab28.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22048` `reportId=80259` | 93,209 | `post-retrieveReport-e792869162a2.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | 9,519 | `post-financeRepDetailList-adb3ca5d26b2.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | 4,390 | `post-financeRepDetailList-d2b436e41223.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22048` `reportId=79145` | 93,201 | `post-retrieveReport-5cfd9a2e8b6d.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | 6,387 | `post-financeRepDetailList-3b8dd35e8113.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | 3,353 | `post-financeRepDetailList-bd28ba599286.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22095` `reportId=80406` | 93,160 | `post-retrieveReport-0469d2716aaf.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | 2 | `post-financeRepDetailList-50b793686b2c.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | 2 | `post-financeRepDetailList-f7b2e5c34d8a.json` |

## Four things a reader should know about this data

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

**The 2-byte responses are `[]`, and they are kept deliberately.** A filed report with no itemised
contributions is a real and common state, and a fixture set containing only populated schedules
would let an adapter that silently dropped empty results go green. Note that `[]` is *not* the only
empty answer CERS gives: the first live sweep found a **zero-byte** 200 for `expendIndependent` on
an ordinary C-5. That case is covered by unit assertions rather than by a recorded exchange, because
recording it would mean walking a schedule this fixture set does not otherwise need.

**This capture holds one roster page.** The 42 Gallatin County Commissioner candidacies fit inside a
single 100-row request. The city target, which does not, has 342 and pages — a fact the first live
sweep found the hard way by writing 142 filers where 384 exist.
