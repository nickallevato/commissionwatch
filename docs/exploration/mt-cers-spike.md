# Montana CERS — Campaign Finance Source Access Spike

**Status:** Investigation complete. Source is **accessible by acceptable means**.
**Probed:** 2026-08-10 UTC
**Egress IP during probing:** residential, not a datacenter range
**Question:** Can Montana campaign-finance records — specifically for **Gallatin County** and
**Bozeman** local offices — be fetched at all, by acceptable means, and is there a structured route?

**Answer in one line:** Yes. CERS is a **Spring/Tomcat application with a server-side DataTables
JSON API**, entirely unauthenticated, with **no `robots.txt` at all**, and it serves **itemised
contributions — donor name, street address, occupation, employer, date and amount — for Gallatin
County Commissioner and Bozeman City Council candidates**. No evasion of any kind was required or
attempted. Earlier project notes calling CERS "a structured system, not PDF scraping" are
**confirmed**, with one correction: the structure is a session-scoped JSON API, **not** a bulk
download or a published API. No CSV export, no bulk file, no documented API was found.

---

## 1. What was assumed, and what is actually there

| | Assumed before this spike | Actually |
|---|---|---|
| Entry point | `cers-ext.mt.gov/CampaignTracker/public/search/searchResults` | **Wrong path.** Reproduced 2026-08-10: `http=404 size=26117`. That is a real in-app 404 (`resourceNotFound`), not a WAF block |
| Structured route | "a structured system, not PDF scraping" | **Confirmed.** DataTables server-side JSON + `$.post` JSON detail lists. But session-scoped, not bulk |
| Bulk download / CSV / API | Hoped for | **None found.** No export control anywhere on the public surface; the only "Print" is `window.print()` |
| Local coverage | Unknown | **Present and deep.** Gallatin County Commissioner candidates 2000→2026; Bozeman City Council/Mayor 2018→2025 |
| Access controls | Unknown | **None.** No login, no CAPTCHA, no challenge, no UA discrimination |

### The 404 that started this

```
GET https://cers-ext.mt.gov/CampaignTracker/public/search/searchResults
 -> http=404 size=26117 type=text/html;charset=ISO-8859-1
```

The 26 KB body is the application's own styled error page — the site chrome plus:

> **Requested resource not found.** Sorry, we did not find the resource you were looking for.

So the host was always alive; only the path was invented. `searchResults` **is** a real path
segment, but it sits one level higher than the guess — see §3.

---

## 2. Entry points, redirects and `robots.txt`

```
GET https://cers-ext.mt.gov/robots.txt
 -> http=404 size=762  type=text/html;charset=utf-8
    Apache Tomcat/9.0.102 — "The requested resource [/robots.txt] is not available"

GET https://cers-ext.mt.gov/
 -> http=200 size=87434 type=text/html;charset=UTF-8
    final=https://cers-ext.mt.gov/CampaignTracker/dashboard;jsessionid=…

GET https://cers-ext.mt.gov/CampaignTracker/
 -> http=200 size=87434  (same dashboard)
```

**There is no `robots.txt` on this host.** It is not `Disallow: /`; it does not exist. Nothing is
disallowed, so the vendor-robots exception of 2026-08-04 is **not engaged here** and does not need
to be disclosed for this source. This is the cleanest access posture of any source in the project —
cleaner than Gallatin's AgendaCenter and far cleaner than Granicus.

`politicalpractices.mt.gov` (the Commissioner of Political Practices' own site, linked from the
dashboard) could not be fetched: `curl: (60) SSL certificate problem: unable to get local issuer
certificate` — an incomplete certificate chain on their end. Not pursued; CERS is the record.

### What the dashboard links to

Six public search pages, all under `/CampaignTracker/public/search/`:

```
candidateSearch                committeeSearch
searchCandidateContributions   searchCommitteeContributions
searchCandidateExpenditures    searchCommitteeExpenditures
```

All six render the **same** page (`/CampaignTracker/public/search`, 159,217 bytes) with a different
tab pre-opened. There is also `/CampaignTracker/app/welcome` and a `mtgov.okta.com` sign-in — that
is the **filer** side, for candidates and treasurers submitting reports. Nothing in this spike
touched it and nothing in the adapter may.

---

## 3. The real API — how a search actually works

The four search forms all `POST` to a **relative** action, resolved against the document URL
`/CampaignTracker/public/search`. Relative resolution drops the last segment, so
`searchResults/searchCandidates` becomes `/CampaignTracker/public/**searchResults**/searchCandidates`
— **not** `/public/search/searchResults/…`, which is exactly the original wrong guess and which
returns the 404 above. This one detail is the whole reason the source looked dead.

The flow is three legs, and **criteria are held in the HTTP session**, not passed to the list call:

```
1. GET  /CampaignTracker/public/search/candidateSearch        -> 200, sets JSESSIONID
2. POST /CampaignTracker/public/searchResults/searchCandidates -> 200 text/html (empty table shells)
3. GET  /CampaignTracker/public/searchResults/listCandidateResults?<DataTables params>
                                                                -> 200 application/json
```

Leg 2's HTML contains no data at all — every table is an empty `<thead>`. Leg 3 is where the
records are. A crawler that read leg 2 and stopped would conclude the site holds nothing.

### Endpoints

| Purpose | Method | Path (all under `/CampaignTracker/public/`) |
|---|---|---|
| Candidate registration search | POST | `searchResults/searchCandidates` |
| Committee registration search | POST | `searchResults/searchCommittees` |
| Financial search (`financialSearchType=CONTR｜EXPEND`) | POST | `searchResults/searchFinancials` |
| Candidate result rows | GET | `searchResults/listCandidateResults` → JSON |
| Committee result rows | GET | `searchResults/listCommitteeResults` → JSON |
| Financial-search candidate rows | GET | `searchResults/listFinancialCandidateResults` → JSON |
| Financial-search committee rows | GET | `searchResults/listFinancialCommitteeResults` → JSON |
| Transactions for a selected entity | GET | `searchResults/listViewFinancialEntityResults` → JSON |
| Contributor-side rows (candidate) | GET | `searchResults/listFinancialEntityCandResults` → JSON |
| Contributor-side rows (committee) | GET | `searchResults/listFinancialEntityCommResults` → JSON |
| Select a candidate, open their filings | POST | `publicReportList/retrieveCampaignReports` |
| That candidate's filed reports | GET | `publicReportList/listFinanceReports` → JSON |
| Open one filed report | POST | `viewFinanceReport/retrieveReport` → HTML |
| **Itemised schedule inside a report** | POST | `viewFinanceReport/financeRepDetailList` (`listName=…`) → JSON |
| Report attachments | POST | `viewFinanceReport/attachmentList` → JSON |

`financeRepDetailList` takes exactly one parameter, `listName`, one of:

```
candidate  loan  fundraisers  refunds  committee  individual
pettyCash  expendOther  expendIndependent  debtLoan  payment
```

and `attachmentList` takes `listName=attachments`.

The list endpoints are **DataTables 1.9 server-side** and honour `iDisplayStart` / `iDisplayLength`,
returning `{ aaData, iTotalRecords, iTotalDisplayRecords, sEcho }`. `iDisplayLength=100` was
accepted. Pagination is therefore first-class and the adapter does not have to guess.

### Session state is ordinary, and is not an access control

The list calls carry no criteria — they read what leg 2 put in the session. That means the adapter
must hold a cookie jar and issue the legs in order. **This is not session replay and not credential
reuse.** The session is anonymous, is minted on demand to anybody who asks, requires no login, and
is the application's own pagination mechanism. Nothing is being defeated, impersonated or replayed.
It is the same category of state as a `?page=2` query parameter, kept server-side by a 2014-era
Spring app.

---

## 4. Conduct during this spike, and the hard line

Roughly 45 requests total, issued **one at a time, never concurrent, with a 3-second floor between
them**, from a scripted client with the honest user agent:

```
CommissionWatch/0.1 (+civic transparency research; https://commissionwatch.bmux.sh)
```

**No fingerprint spoofing, no TLS/JA3 manipulation, no CAPTCHA solving, no proxy rotation, no
browser-identity forgery, and no header forgery was implemented, tested, benchmarked or attempted.**
None was needed. Every request above succeeded on the first try with the project's own user agent.
The filer-side (`/CampaignTracker/app/*`, Okta) was never touched.

**The hard line is not reached.** For the record, each named technique and why it does not apply:

| Technique | Required here? |
|---|---|
| Fingerprint spoofing | No. The honest project UA is served identically to `curl/8.x` |
| TLS / JA3 manipulation | No. Default Python `ssl` and default `curl` both work |
| CAPTCHA solving | No. No CAPTCHA exists anywhere on the public surface |
| Session replay | No. Sessions are anonymous, self-minted, and required only for pagination |
| Proxy rotation | No. ~45 requests from one residential IP, zero throttling or challenge |

One observation worth recording: the host sets two **F5 BIG-IP ASM cookies** (`TS019606d9`,
`TS01d6b3be`) alongside `JSESSIONID`. A WAF is present. It issued those cookies silently and never
challenged, blocked or rate-limited this spike. **If that ever changes — if a challenge page, a JS
interstitial or a fingerprint check appears — that is the hard line and the adapter must stop and
report, not adapt.** The adapter treats an unexpected non-JSON body as a failure, not as something
to work around.

### One real operational limit, and it is not a block

An **unbounded** contributor-side search (`contrSearchTypeCode=CONTRIBUTOR`, all County
Commissioner candidates, election year 2022, no contributor name) **timed out after 60 seconds**
with no response. That is an expensive query on their side, not a defence. Narrow searches
answer in well under a second. The consequence for design is firm: **scope every query by candidate
or committee.** Never ask CERS an open question.

---

## 5. Local coverage — the thing that actually matters

This is why CERS matters more than OpenFEC for this project: a Gallatin County Commissioner and a
Bozeman City Commissioner have no federal filings at all, and every record below is a local one.

### Gallatin-resident candidates by campaign type

Searched with `countyCode=3257` (Gallatin) and no year filter, 2026-08-10:

| `candidateTypeCode` | Meaning | Records |
|---|---|---|
| `CN` | County | **143** |
| `CT` | City | **342** |
| `SC` | School | **216** |
| `SD` | State District | 438 |
| `SW` | Statewide | 30 |

### Gallatin County Commissioner specifically

`candidateTypeCode=CN`, `officeCode=29` (County Commissioner), `countyCode=3257`:

```
iTotalRecords: 42   election years 2000 … 2026 (5 candidates already filed for 2026)
```

Example row, scalar fields only (nested `personDTO` omitted):

```json
{ "candidateId": 11894, "entId": 184832,
  "candidateName": "Blum, Barbara  O",
  "candidateAddress": "109 Sunset Blvd., Bozeman, MT 59715",
  "officeCode": "29", "officeTitle": "County Commissioner",
  "candidateTypeCode": "CN", "candidateTypeDescr": "County",
  "resCountyCode": "3257", "resCountyDescr": "Gallatin",
  "partyCode": "FP", "partyDescr": "Republican",
  "electionYear": "2014",
  "candidateStatusCode": "AC", "candidateStatusDescr": "Active",
  "filingStatusDescr": "Will spend more than $500",
  "c3FiledInd": "No",
  "amendedDate": 1378499119000, "createdDate": 1378498688000 }
```

### City offices in Gallatin County

`candidateTypeCode=CT`, `countyCode=3257`: **342** records, election years 2018→2025. Office titles
in the first 100 by name: City Council ×56, Mayor ×21, Councilman ×15, City Judge ×7,
Exploratory ×1.

### Itemised contributions — verified end to end

Chain: Boyer, Jennifer A (`candidateId=17738`, Gallatin County Commissioner, 2022) → **24 filed
reports** (`C5` periodic/closing/initial, plus `C7`/`C7E` initial incorporated) → report
`reportId=61258` (C-5 Periodic, 09/16/2022–10/14/2022, status Filed) → `financeRepDetailList`:

```
listName=individual  -> 200 application/json,  52 rows, cash total $6,935.00
listName=committee   -> 200 application/json,   0 rows
listName=expendOther -> 200 application/json,   9 rows
```

A representative individual-contribution row, verbatim:

```json
{ "entityName": "Breuer, Abigail",
  "entityAddress": "502 N. 11th Ave, Bozeman, MT 59715",
  "occupationDescr": "Program Officer",
  "employerDescr": "Center for Large Landscape Conservation",
  "datePaid": 1664172000000,
  "cashAmt": 100.0, "inKindAmt": 0.0, "totalAmt": 100.0,
  "amountTypeDescr": "General",
  "totalToDateGeneral": 100.0,
  "lineItemCompositeDescr": "Individual Contributions" }
```

**Donor name, street address, occupation, employer, date, amount, and running total to date, as
structured JSON.** This is the raw material a donor-to-vote join needs, and it exists for local
offices.

An expenditure row from the same report, for contrast:

```json
{ "entityName": "CVS Pharmacy",
  "entityAddress": "115 North 19th Ave, Bozeman , MT 59715",
  "datePaid": 1663308000000, "cashAmt": 84.96,
  "purposeDescr": "Candy for parade",
  "expenditurePaidCommQuantity": "4 large bags",
  "lineItemCompositeDescr": "All Other Expenditures" }
```

### Committees

`searchCommittees` with `electionYear=2025`: **277** committees. Types in the first 100:
Incidental ×81, **Incidental – Local Government ×12**, Ballot Issue ×6, Undetermined ×1. Fifteen
carry a Bozeman address, including `Affordable Bozeman Coalition` (Ballot Issue),
`Bozeman Tenants United`, `Bozeman Area Chamber of Commerce`, and
`Cottonwood Environmental Law Center`. Local-government ballot and incidental committees — the
entities that spend on city and county questions — are **in scope and reachable**.

---

## 6. Identifiers — what could later join a donor to a vote

| Identifier | Where it appears | Stability |
|---|---|---|
| `candidateId` | candidate rows, report list, report view | Stable per **candidacy** — one person running twice has two |
| `entId` | on the candidate and on every entity | **The person/organisation key.** This is the join key |
| `committeeId` | committee rows | Stable per committee registration |
| `reportId` | `listFinanceReports` | Stable per filed report; an amendment is a **new** `reportId` |
| `addrId`, `emailId`, `phoneId` | inside `personDTO` | Stable per contact record |
| `entIdFrom` | contributor-side rows | The **contributor's** `entId` — the donor-side join key |
| `epassEncryptedHandle` | report rows (a UUID) | Present; purpose not established |

**`entId` is the identifier that matters.** A contribution row's `entIdFrom` and a candidate's
`entId` live in the same namespace, so "did this donor give to this official" is an integer
comparison rather than a name match. Name matching across `entityName` would be hopeless — the data
carries `THREE FORKS` / `Three Forks` / `three forks` and `RETIRED ` with a trailing space.

### Two limitations to record honestly

**There is no city or municipality field.** CERS models a city candidate as
`candidateTypeCode=CT` plus a **residence county** plus a free-text office title. The 275-entry
office list contains no city names — no "Bozeman" anywhere. Isolating *City of Bozeman* therefore
requires reading the city out of the candidate's residence address, and that is a **heuristic, not
a key**: the Gallatin `CT` results include candidates addressed in Belgrade, West Yellowstone,
Three Forks, Manhattan and Gallatin Gateway, and at least one row shows a Belgrade address against
a "Councilman" candidacy. Any Bozeman attribution derived this way must be recorded as derived, and
must not be published as though CERS asserted it.

**The public search exposes candidates' personal contact details.** `personDTO` carries home
address, personal email and home/cell phone numbers. These are part of a public filing, but
republishing a home phone number is not the same act as publishing a donor total. Contribution
rows likewise carry each donor's street address. Storage is fine — provenance is the product — but
this is a **publication** decision, and it belongs in the review queue, not in a default projection.

---

## 7. Is there a structured route? Yes, with a caveat

**Verified:** every record above arrived as `application/json`, from a documented-by-inspection,
paginated, server-side API. There is no PDF scraping on this path and no HTML table parsing on the
data path.

**Refuted:** the hoped-for *bulk* route. There is no CSV export, no Excel export, no zip bundle,
no `/api` namespace, no OData, no documented API, and no download control anywhere on the public
surface. The only export affordance in the entire application is the report view's **Print**
button, which is `window.print()`. Attachments have a download button, but that fetches a filed
PDF, not a dataset.

So "a structured system, not PDF scraping" is **true**, and "Montana has published a bulk feed
before" is **not confirmed by anything on this host**. The adapter must walk the API entity by
entity, politely, and store what it gets. That is the honest reading.

---

## 8. Recommendation

1. **Build the adapter.** The source is accessible by acceptable means, with the cleanest access
   posture of any source in this project — no `robots.txt` to respect or except, no login, no
   WAF challenge, no evasion.
2. **Scope every query.** Never issue an unbounded search; one timed out at 60 s. Sweep by
   candidate and by committee, seeded from a registration search that is itself scoped by county
   and campaign type.
3. **Store the JSON bytes as artifacts.** A structured feed still gets its bytes content-addressed
   into `artifacts`, exactly as a PDF would. Provenance is the product, and a JSON response is a
   document.
4. **Key on `entId`**, never on names.
5. **Treat Bozeman attribution as derived**, from the residence-address city, and label it as such.
6. **Do not publish donor or candidate contact details by default.** Store them; hold them.
7. **If a WAF challenge ever appears, stop.** Do not adapt to it. That is the hard line, and the
   answer would be a public-records request to the Commissioner of Political Practices.

---

## 9. Corrections and additions, from writing the adapter — 2026-08-10

The access findings above all held. Three things the manual probe could not have found, because
`curl` and Python's `urllib` both hide them behind a cookie jar that does the right thing:

**`JSESSIONID` is set on the 302, not on the 200.** `GET /public/search/candidateSearch` answers
`302` with three `Set-Cookie` headers and a `Location` carrying a rewritten `;jsessionid=…`. A
client that lets `fetch` follow the redirect sees only the final response's headers and never
receives the session. The consequence is not an error: every subsequent search runs in a fresh
session and answers **`iTotalRecords: 0` under HTTP 200**. A silent zero is the worst failure mode
a transparency source can have, and it is the reason the adapter walks redirect hops itself.

**A response can set three cookies at once.** `JSESSIONID`, `TS019606d9` and `TS01d6b3be` arrive
together. Any client that flattens headers into a string map keeps one of them, and it is not the
session.

**CERS answers 200 with a zero-byte body** — not `[]` — for a schedule that does not apply, e.g.
`expendIndependent` on an ordinary candidate C-5. Distinguishing "nothing to parse" from "something
unparseable" matters, because the second is what a WAF interstitial looks like.

One count in §5 was incomplete rather than wrong: the roster endpoint pages, and a single 100-row
request against the 342-record city target returns 100. The first real sweep wrote 142 filers where
384 exist, with `iTotalRecords` saying so in the same response.

### The first real sweep — 2026-08-10

Rate-limited, one request every two seconds, never concurrent, honest user agent, against the live
host. Run status **`succeeded`**.

| | |
|---|---|
| `cf_filers` | **384** — 42 Gallatin County Commissioner candidacies + 342 city candidacies resident in Gallatin |
| `cf_reports` | **35** filed reports |
| `cf_transactions` | **127** — 70 contributions totalling **$18,910.00**, 57 expenditures totalling $18,948.00 |
| `artifacts` | **45**, content-addressed, 2,161,386 bytes, bytes in MinIO |
| `ingestion_jobs` | 137, all terminal |
| `meetings` | **0**, and `commissions` under *State of Montana* is **0** — no body was invented to make a filing fit |
| `derived_jurisdiction` | **0 of 384 set** — nothing inferred was stored |
| Citations | all 127 transactions cite one of 30 stored artifacts |

Largest single contribution landed: **Gallatin County Republican Central Committee, $2,250.00,
2025-08-22**. This is the kind of row the project could not previously hold for any official it
watches, and it came from a local county filing that has no federal counterpart.

`residence_city` was read for 381 of 384; the other three addresses did not match the
`…, City, ST ZIP` shape and were left NULL rather than guessed at.

## 10. Reproduction

Every request in this document was issued by an ad-hoc scripted client holding a cookie jar, with a
3-second floor between requests and no concurrency. The responses the adapter is tested against are
recorded under `backend/test/fixtures/mt-cers/`, with fetch dates and exact URLs in its
`PROVENANCE.md`.
