# MT CERS fixtures — provenance

> ## The contribution rows were scrubbed on 2026-08-10. Do not "restore" them.
>
> **The four `post-financeRepDetailList-*.json` files no longer hold the donor
> `entityAddress`, `occupationDescr` and `employerDescr` values CERS served.** 52 values were
> replaced with clearly synthetic ones — 22 addresses, 15 occupations and 15 employers — across
> those four files, by operator directive: *we must not ingest PII.* A fixture committed to a
> repository is the most durable form of ingesting it, because it outlives the database it was
> swept into.
>
> **This is not corruption and the fixture is not stale.** If you find `123 Example Ave,
> Fixtureville, MT 00000` or `Example Employer 110` and conclude the recording went wrong, it did
> not — that is the scrub, and re-recording to "fix" it would put real people's home addresses back
> into a public repository. `record.ts` now scrubs on the way to disk (`scrubLineItemPii`), so a
> re-record produces synthetic values too; the adapter under recording still sees the live bytes,
> so the tape continues to prove the adapter handles the real protocol.
>
> Everything else is untouched and verified so: row counts, key order, field names, types and
> populated-ness are identical to the recording, and an empty value stayed empty so the "no
> occupation filed" path still gets exercised. **Donor names, dates and amounts are as filed** —
> they are the disclosure, `vote_donor_conflict` cannot correlate anything without them, and the
> tests assert on them.
>
> The columns these values were loaded into are gone: migration **043** dropped
> `cf_transactions.entity_address`, `.occupation`, `.employer` and `cf_filers.residence_city`, and
> the adapter's `CersLineItem` no longer parses the fields at all. `test/finance-pii-guard.test.ts`
> fails if either the columns or unscrubbed fixture values come back.
>
> The `byteSize` figures in `exchanges.json` and in the exchange table below were updated to the
> scrubbed file sizes, so the tape describes what a replay actually serves. Every scrubbed file is
> marked ⚑ in that table — four from this pass, nine more from the one below.
>
> ## The candidate and treasurer contact details were scrubbed on 2026-08-10 too. Do not "restore" them.
>
> The first pass left the roster's `personDTO` alone as out of scope and flagged it here. It is
> now gone, along with three more places the same data turned out to be sitting. **1,190 JSON
> values and 16 rendered HTML values were replaced with synthetic ones**, across seven files:
>
> | Kind | JSON values | Where |
> |---|---|---|
> | Address components and renderings | 770 | `addrLn1`, `city`, `zip5`, `zip4`, `cityStateZip`, `addrCityStateZip`, `entityAddress`, `entityCity`, `candidateAddress` |
> | Email addresses | 129 | `email`, `emailAddress`, and one typed into a candidacy's `comments` |
> | Telephone numbers | 290 | `phoneNum`, `phoneNumFormatted` — home, work and mobile |
> | Free-text expenditure purpose | 1 | an email address inside a `purposeDescr` |
>
> Behind those 1,190 values are 42 distinct street lines, 7 cities, 10 ZIPs, 35 email addresses
> and 53 telephone numbers. The affected files are the roster
> `get-listCandidateResults-9a8c8f9ec18c.json`, **both** `get-listFinanceReports-*.json` (which
> embed the same `personDTO` inside `candidateDTO` — a fact the first pass did not notice),
> `post-financeRepDetailList-bd28ba599286.json`, both `get-publicReportList-*.html` and all three
> `post-retrieveReport-*.html`.
>
> **The HTML reports carried more than the candidate's own details.** The rendered C-5 prints the
> candidate's mailing address, email address and telephone number, *and the campaign treasurer's
> home address*. The treasurer is a private individual who is not the subject of this project at
> all. The campaign bank's branch address was scrubbed alongside it, though a bank branch is not a
> person: "no address-shaped string survives in this fixture set" is an invariant a guard can
> hold, and "no address except the ones we judged institutional" is an invariant that decays into
> an argument.
>
> **Nothing was dropped; everything was replaced.** No key was removed and no field changed type.
> A null stayed null, an empty string stayed empty, and a populated field stayed populated — the
> one address record with no `addrLn1`, no `city` and no `zip5` still has all three as `null`, so
> the parser's "not filed" paths run exactly as often as before. Key order is unchanged. The
> substitution is one-to-one and stable across files, so a candidate who appears in the roster and
> again inside a report still carries the same synthetic address in both, and a test that
> correlates them still correlates something.
>
> **Names, dates and amounts are untouched**, on the same reasoning as the donor scrub: a
> candidate's name is the disclosure. So are `resCountyDescr`, party, office and election year.
>
> The synthetic vocabulary, so it is recognisable on sight: `NNN Example Ave`,
> `Fixtureville`, `MT 00000`, `personN@example.invalid`, and `(406) 555-01NN` — the 555-01xx block
> reserved for fiction. The one remaining thing in these files that *looks* like a telephone number
> is `(999) 999-9999`, a jQuery input-mask template on every CERS page. It is markup, not a number.
>
> `record.ts` now scrubs **every** recorded response rather than only the schedule endpoint, and by
> shape rather than only by field name (`scrubResponsePii`), so a re-record produces synthetic
> contact details wherever they appear. The adapter under recording still sees the live bytes.

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
| 200 | GET | `/public/searchResults/listCandidateResults` | ⚑ 201,761 | `get-listCandidateResults-9a8c8f9ec18c.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` `candidateId=22048` | 0 | `post-retrieveCampaignReports-948c6adc0a39.html` |
| 200 | GET | `/public/publicReportList` | ⚑ 39,967 | `get-publicReportList-75505b65343e.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` | ⚑ 27,628 | `get-listFinanceReports-4877e49806ad.json` |
| 302 | POST | `/public/publicReportList/retrieveCampaignReports` `candidateId=22095` | 0 | `post-retrieveCampaignReports-0fcb60b8cce7.html` |
| 200 | GET | `/public/publicReportList` | ⚑ 39,965 | `get-publicReportList-d4821923a9ab.html` |
| 200 | GET | `/public/publicReportList/listFinanceReports` | ⚑ 5,696 | `get-listFinanceReports-349392e3ab28.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22048` `reportId=80259` | ⚑ 93,214 | `post-retrieveReport-e792869162a2.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | ⚑ 9,734 | `post-financeRepDetailList-adb3ca5d26b2.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | ⚑ 4,382 | `post-financeRepDetailList-d2b436e41223.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22048` `reportId=79145` | ⚑ 93,206 | `post-retrieveReport-5cfd9a2e8b6d.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | ⚑ 6,489 | `post-financeRepDetailList-3b8dd35e8113.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | ⚑ 3,338 | `post-financeRepDetailList-bd28ba599286.json` |
| 200 | POST | `/public/viewFinanceReport/retrieveReport` `candidateId=22095` `reportId=80406` | ⚑ 93,165 | `post-retrieveReport-0469d2716aaf.html` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=individual` | 2 | `post-financeRepDetailList-50b793686b2c.json` |
| 200 | POST | `/public/viewFinanceReport/financeRepDetailList` `listName=expendOther` | 2 | `post-financeRepDetailList-f7b2e5c34d8a.json` |

## Four things a reader should know about this data

**It contained personal information that is part of a public filing, and all of it has been
removed.** The original recording carried, on every contribution row, the donor's street address,
occupation and employer; in the roster's and the report list's `personDTO`, candidates' mailing and
home addresses, personal email addresses and home, work and mobile telephone numbers; and in the
rendered C-5 HTML, the candidate's contact details and the campaign treasurer's home address.

The first draft of this note argued that storing it was right — *provenance is the product* — and
that republishing was the separate decision. That argument was wrong by half. It conflated **what
we may publish** with **what we may hold**, and only the first was ever in question. Being entitled
to read a donor's home address off a public filing is not the same as being right to keep a copy of
it, and a copy in a git repository is the least revocable copy there is. The operator's ruling is
that we do not: the donor fields are scrubbed (see the notices at the top of this file) and
migration 043 dropped the columns that received them. The candidate and treasurer contact details
went in the second pass, and a candidate being a public figure did not save them — a candidate's
home telephone number is not public-interest data and this project has no use for it.

**These bytes are still in this repository's git history.** Scrubbing the working tree does not
unpublish what was committed on 2026-08-10. Purging history is the operator's decision and was
deliberately not taken here; no commit has been rewritten, rebased or force-pushed.

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
