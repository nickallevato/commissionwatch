# Feature parity — CommissionWatch against the civic-transparency field

**Written 2026-08-16 during the third autonomous loop, at the operator's instruction** to research
other civic platforms "and document that so future agents can find work." The candidate work list is
at the end; everything before it is the evidence for it.

**How to read the confidence markers.** `[probed]` means this loop issued the request and read the
response — primary evidence, and it overrides anything below it. `[verified]` means a research agent
checked a primary source (a repo, an official doc) and reported the date or text. `[reported]` means
a single web source said so and it was not cross-checked. `[unverified]` means it could not be
confirmed and is recorded only so nobody re-derives it from scratch.

---

## The headline

**No platform found combines LLM extraction from local-government documents with a mandatory human
review gate before anything naming a person publishes.** That specific combination — the thing this
project's invariants are built around — appears to be genuinely novel rather than a reinvention.

That is a finding about *the field*, not a compliment. The reason to write it down is that a future
agent looking for prior art on the review gate will not find any, and should stop looking rather than
assume they searched badly.

---

## The probe that overrode the research

The research surfaced an attractive lead: Legistar (Granicus) exposes a **public, keyless REST/OData
Web API** at `webapi.legistar.com/v1/{client}/...` covering bodies, events, matters and votes. Since
Bozeman runs on Granicus and our adapter parses **HTML**, that read as a missed opportunity — and a
significant one, because `bozeman.granicus.com/robots.txt` is `Disallow: /` for everything but
Googlebot, so fetching it relies on this project's documented vendor-robots exception. A structured
API on a different host could have removed the need for that exception entirely.

It was probed rather than assumed. `[probed 2026-08-16]`

| Request | Result |
|---|---|
| `webapi.legistar.com/v1/seattle/bodies?$top=2` | **200**, 1,141 bytes of real JSON |
| `webapi.legistar.com/v1/seattle/events?$top=1` | **200**, structured event rows |
| `webapi.legistar.com/v1/bozeman/bodies` | **500** — *"LegistarConnectionString setting is not set up in InSite for client: bozeman"* |
| `webapi.legistar.com/v1/nyc/bodies` | **403** |
| `seattle.legistar.com/Calendar.aspx` | **200**, 1,106,618 bytes |
| `bozeman.legistar.com/Calendar.aspx` | **200**, **19 bytes** — `Invalid parameters!` |
| `bozemanmt.legistar.com/Calendar.aspx` | **200**, **19 bytes** — `Invalid parameters!` |

**Conclusion: the API is real, keyless and structured — and Bozeman is not on it.** There is no
Legistar InSite instance for Bozeman under either plausible client id; the 19-byte shell is what
Legistar serves for a client that does not exist. Bozeman uses Granicus's document-hosting side
(`bozeman.granicus.com/services/legistar/download/pdf/...`), not a Legistar portal.

So the HTML parsing in `bozeman-granicus.ts` is **not** a shortcut past an available API. It is the
only route, and the robots exception remains necessary rather than merely convenient. A future agent
who reads "Legistar has a public API" and files a ticket to migrate the adapter should read this
table first.

The seattle control matters as much as the bozeman result: without a request that *succeeds*, the
500 would have been indistinguishable from the API being dead everywhere, and the wrong conclusion
was available in both directions.

---

## The matrix

Columns are the capabilities this project actually has. `—` means not found; per the sourcing note
above, that is "not found in searched sources", not proof of absence.

| Platform | Scope | Open source | LLM extraction | Human review gate | Anomaly / diff | Open data | Feeds | MCP | Records requests | Corrections log | Finance link |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **CommissionWatch** | 2 local bodies, MT | MIT | ✅ | ✅ **mandatory** | ✅ | ✅ | ✅ | ✅ (dark) | ✅ | ✅ | partial, disabled |
| Open States / Plural | State legislatures | MIT `[verified]` | paid, bill text | — | — | ✅ | — | — | — | — | — |
| Councilmatic (DataMade) | City councils | MIT | ✅ Chicago, ordinance summaries `[verified]` | — none confirmed | — | ✅ Datasette | — | — | — | — | — |
| City Scrapers (City Bureau) | Chicago meetings | MIT `[verified]` | — | — | — | — | — | — | — | — | — |
| Documenters (City Bureau) | 20+ cities | CC BY 4.0 content | — deliberately | ✅ **human throughout** | — | — | — | — | — | — | — |
| MuckRock | National FOIA | AGPL-3.0 `[verified]` | aid, not publish | — | — | ✅ | — | — | ✅ **core** | — | — |
| LittleSis | Power mapping | GPL-3.0 `[verified]` | — | wiki editing | — | ✅ | — | — | — | — | ✅ relationships |
| OpenSecrets | Federal money | ✗ | — | — | — | ✅ | — | — | — | — | ✅ **core** |
| FollowTheMoney / NIMSP | State + local money | ✗ | — | — | — | ✅ | — | — | — | — | ✅ **state/local** |
| LegiScan | State legislatures | ✗ | — | — | — | ✅ | — | — | — | — | — |
| Legistar / Granicus | Vendor | ✗ | — | — | — | API where enabled | ✅ | — | — | — | — |
| CivicPlus AgendaCenter | Vendor | ✗ | — | — | — | — | ✅ | — | — | — | — |
| BoardDocs (Diligent) | Vendor | ✗ | staff minutes `[reported]` | — | — | — | — | — | — | — | — |
| Municode (CivicPlus) | Vendor | ✗ | — | — | code-text alerts | — | — | — | — | — | — |

### What the matrix does not show, and should

Three things are flattered by a tick in that table and deserve saying plainly:

- **Our scope is two bodies.** Open States covers 50 states; MuckRock covers ~22,000 agencies.
  Feature parity is not coverage parity, and this document is about features.
- **Several of our ticks are dark.** MCP, prerendering and the delivery surfaces are built and
  switched off. `dated_export_archive` is off, so the archive holds nothing. A tick means the code
  exists and passes tests.
- **Our finance linkage is the weakest cell in our own row.** The CERS adapter exists and is
  registered disabled; `members` holds seed fixtures, not a sourced roster; and
  `2026-08-16-finance-coverage-drift-design.md` records that the site currently tells readers it does
  not read CERS. FollowTheMoney does the state-and-local money that would actually answer here.

---

## What others do that we do not

The useful half of a parity matrix.

1. **Documenters' human model.** `[verified]` City Bureau pays trained residents to attend meetings
   and take notes, with a human fact-check before publication, and has publicly argued AI will not
   replace that. This is not a feature to copy — it is the honest alternative to our approach, and
   its existence is the strongest available argument that an LLM pipeline needs its review gate to be
   *mandatory* rather than advisory. It is worth citing on the Methodology page for exactly that
   reason.
2. **MuckRock's scale and its request tracking.** `[verified]` Our records-request generator drafts a
   letter; MuckRock tracks a request's lifecycle across ~22,000 agencies and publishes the responses.
   The gap that matters is **tracking**, not drafting: we generate a letter and then know nothing
   about what happened to it.
3. **FollowTheMoney's state-and-local coverage.** `[verified]` Merged into OpenSecrets in 2021 and
   described as sunsetting as a standalone site, but it is the only source found that covers the tier
   of money relevant to a city commissioner. Relevant to the specced-only W6 funding layer.
4. **LittleSis's relationship graph.** `[verified]` Crowd-edited rather than extracted, which is a
   different trust model — and one worth studying before W6 is built, since our own funding-layer
   spec already refuses a lobbying cross-reference detector on the grounds it "would manufacture
   accusations out of lawful behavior."
5. **Councilmatic's Datasette export.** `[verified]` A queryable database over the published record,
   which is a genuinely lower-friction thing than a CSV download for the researcher audience.
6. **BetaNYC's four MCP servers.** `[verified]` NYC Council legislation, Charter/Admin Code, City
   Record, Checkbook NYC. Apparently the only other local-government MCP work in existence, which
   makes it the only available prior art for the design of ours.

## What we do that nobody found does

- **A mandatory review gate on LLM output before anything naming a person publishes.** Chicago
  Councilmatic's summarizer is the only confirmed LLM extraction over local-government documents, and
  no human-review gate before display was confirmed. `[verified]`
- **Anomaly detection and agenda diffing over local meetings.** Municode's `eNotify` watches *code
  text* for changes, which is a different thing. `[verified]`
- **A corrections and disputes log** as a first-class published surface.
- **A records-request generator** wired to the same jurisdiction data as the monitoring.

## Two cautionary data points about our own promises

Both are about sustainability, and both are worth more than any feature in the matrix.

- **The ProPublica Congress API is dead.** `[verified]` ProPublica's own docs say it is no longer
  available and no new keys are issued. A well-resourced newsroom could not keep a government-data
  API alive.
- **Open States has been absorbed into commercial Plural and is deprecating public tooling.**
  `[verified]`

This project publishes an open-data export, feeds, and an MCP endpoint, and asks people to build on
them. Those two facts are what the promise looks like when it lapses. **If any of our public
endpoints is ever withdrawn, it should be announced on the corrections log rather than 404'd**, which
is a thing to decide now rather than at the moment of withdrawal.

## The standards gap

`[verified]` **Open Civic Data (OCD)** is the only standard aimed at this domain, and it does cover
meeting *events* with agenda-item metadata. But its schema has been effectively frozen for years, its
flagship implementation is state-legislature-centric, and no maintained public system uses it to
standardise city or county meeting agendas.

Everything else is out of scope: Popolo is people/orgs/votes only; Akoma Ntoso covers legislative
document text but shows no US municipal adoption; USLM is federal-only; schema.org's
`GovernmentService` is service discovery. There is no GTFS-for-meetings.

**So there is no standard combining local-meeting event metadata with structured agenda and minutes
content.** Our per-vendor adapters are not failing to converge on a spec — there is no spec to
converge on. We ship an OCD export, and it is worth being clear-eyed that this conforms to something
stable and quiet rather than joining a thriving ecosystem.

---

## Candidate work, for the agent who comes looking

Ordered by ratio of value to risk. **None of these is authorised** — the ones touching publication
are marked, and the operator decides those.

1. **Request-outcome tracking for the records generator.** We draft a letter and lose sight of it.
   A status field and a place to record the response is a genuinely missing loop, and it publishes
   nothing new about a person. *No publication impact.* Closest thing to shovel-ready here.
2. **A Datasette-style queryable view over the published export.** Councilmatic's approach; operates
   entirely on already-published rows. *No new publication, but it changes reach* — read
   `2026-08-16-finance-coverage-drift-design.md` on why reach is its own decision.
3. **Study BetaNYC's MCP servers against ours** before the MCP endpoint is ever switched on. The only
   prior art that exists.
4. **Cite Documenters on the Methodology page** as the human alternative to our pipeline. A
   transparency project that names the strongest argument against its own method is more credible,
   not less.
5. **FollowTheMoney as a finance source** for the specced-only W6 layer — but note it is described as
   sunsetting, so probe it before designing against it. *Publication impact: high, names people.*
6. **Decide the endpoint-withdrawal policy** described above, before it is needed.

### Explicitly not work

- **Migrating the Bozeman adapter to the Legistar Web API.** Probed and closed above. Bozeman has no
  Legistar InSite instance.
- **Adopting a local-meeting standard.** There is not one.
- **Building an LLM pipeline without the review gate**, on the grounds that Councilmatic ships
  summaries without one. Their output summarises already-published legislative text; ours makes
  claims about what named officials did.

---

## Sourcing and its limits

Compiled by research agents using WebSearch and WebFetch on 2026-08-16, with GitHub push dates
checked directly where marked `[verified]`. The vendor-platform section is `[reported]` — grounded in
vendor documentation but not cross-checked by a second pass — **except** the Legistar findings, which
this loop probed directly and which therefore supersede the reported version.

One unverified lead recorded so it is not lost: Montana and Hawaii state ethics offices are said to
use AI to flag anomalies in officials' disclosure filings for human confirmation — structurally the
closest analogue to our flag-then-review model, and in Montana specifically. It was found in a single
secondhand summary and **could not be corroborated against a primary source.** `[unverified]` Worth
someone's time; not worth citing until it is confirmed.
