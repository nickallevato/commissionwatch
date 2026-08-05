# W6 — Funding Network Layer

> Status: approved 2026-08-04
> Depends on W2 (ingestion queue) and W3 (review gate). Shares its schema with W5 (campaign finance).

## Goal

Map who funds whom across every entity class that touches Bozeman and Gallatin County government — nonprofits, businesses, PACs, unions, trade associations, individuals — and detect patterns worth a human's attention, without ever publishing an unsourced or unfalsifiable claim.

## Non-partisanship is a design constraint, not a value statement

This is deliberately **not** an "NGO detection layer." There is one node type and one set of detectors. A private developer's LLC, a labor union, a business PAC, and a community foundation are all `entities`, and every detector applies to all of them identically.

This is enforced structurally: no detector may take an entity class as a parameter, and no query may filter by `subsection_code` or entity type to select targets. A pattern is a pattern regardless of who it implicates. Beyond being the project's stated first principle, uniform treatment is the only thing that makes a finding defensible when someone alleges the site is biased.

## Verified data availability (probed 2026-08-04)

| Source | Endpoint | What it yields |
|---|---|---|
| **IRS 990 e-file bulk** | `apps.irs.gov/pub/epostcard/990/xml/{year}/{year}_TEOS_XML_{NN}{A\|B}.zip` | Schedule I (grants paid, per recipient, with EIN + amount + stated purpose), Schedule R (related orgs), Schedule L (insider transactions), Part VII (officers/directors), Part VIII (revenue) |
| **IRS filing index** | `apps.irs.gov/pub/epostcard/990/xml/{year}/index_{year}.csv` | 77 MB CSV: `RETURN_ID, FILING_TYPE, EIN, TAX_PERIOD, SUB_DATE, TAXPAYER_NAME, RETURN_TYPE, DLN, OBJECT_ID` |
| **ProPublica Nonprofit Explorer** | `projects.propublica.org/nonprofits/api/v2/` | No API key. Org identity, NTEE code, subsection, financial rollups. **No grant detail.** |
| **MT CERS** | `cers-ext.mt.gov/CampaignTracker` | Montana campaign contributions (W5) |

**Confirmed dead ends — do not attempt:**
- `s3.amazonaws.com/irs-form-990` — bucket retired, returns empty listing
- Per-`OBJECT_ID` XML fetches (`{object_id}_public.xml`) — 302/404 on both hosts

Bulk zip bundles are the only route to Schedule I. There is no per-filing API.

## Data model

Four tables. All in Postgres — at a few thousand nodes, recursive CTEs outperform the operational cost of a graph database.

### `entities`
The unified node. Columns: `id`, `entity_type` (`organization` | `person` | `business` | `pac` | `government_body`), `canonical_name`, `first_seen_at`, `last_refreshed_at`.

`entity_type` is descriptive metadata for display. **It must never appear in a detector's WHERE clause as a target selector.**

### `entity_identifiers`
Resolution attaches here rather than mutating the node: `entity_id`, `identifier_type` (`ein` | `cers_committee_id` | `mt_registration` | `normalized_name` | `address_hash`), `value`, `confidence`, `source_artifact_id`.

Merging two entities is inserting identifiers, never destroying rows — every merge is reversible.

### `funding_edges`
Directed, typed, dated, sourced: `from_entity_id`, `to_entity_id`, `edge_type` (`grant` | `contribution` | `contract` | `insider_transaction` | `related_party`), `amount_cents`, `period_start`, `period_end`, `stated_purpose`, `source_artifact_id` (**NOT NULL**), `source_locator`.

The not-null constraint on `source_artifact_id` is the schema-level expression of the project's publication invariant. An edge nobody can trace cannot exist.

### `entity_roles`
Person ↔ organization, from Part VII: `person_entity_id`, `org_entity_id`, `role_title`, `term_start`, `term_end`, `source_artifact_id`. This is what makes board-overlap detection possible.

## Ingestion

Three adapters on the **existing** W2 queue. No new queue, no new worker.

**`irs-990-bulk`** — fetches the yearly index CSV, then downloads bundles and **streams** the XML, extracting only filers on the relevance frontier plus their Schedule I recipients. Filtering during the stream is what keeps this tractable: parse a great deal, store very little. Bundles are content-hashed so an unchanged bundle is never reprocessed.

**`propublica-nonprofits`** — on-demand identity and financial lookup when an unrecognized name appears. Fills gaps between bulk runs.

**`mt-cers`** — W5's adapter, writing `contribution` edges into the same table.

### Frontier expansion

Its own job type, so graph growth is bounded and inspectable rather than emergent.

- **Seeds:** entities with a demonstrable local nexus — headquartered in Gallatin County, receiving city or county money, appearing in meeting records, or tied to a candidate or commissioner.
- **Expansion:** each pass walks one hop upstream through Schedule I and enqueues newly-discovered funders.
- **Depth: 2. Hard bound.** Not configurable at runtime — changing it is a code change with a review, because depth 3 is a different-sized system.

A `frontier_nodes` table records why each entity entered the graph, so any node's presence is explainable.

## Detectors

Each is a pure function over the graph returning candidate signals with a computed strength. **Never a verdict.** They emit into the existing `anomaly_flags` pipeline and inherit its severity, dedup, and review queue.

1. **Convergence & capture** — organizations active on the same local issue sharing an upstream funder; and single-funder dependence, where an entity draws most of its revenue from one source.
2. **Conduits & timing** — an entity receives money and re-grants most of it onward within a short window; or money lands close to a related vote, contract award, or program launch.
3. **People & shells** — officer and board overlap between funder and recipient, or between an entity and a vendor holding a public contract; shared addresses and registered agents; entities formed shortly before the matter they participate in.
4. **Public-money conflicts** — an entity receiving city or county money that also funds candidates, or shares officers with someone voting on its award.
5. **Insider transactions and related-party flows** — Schedule L transactions with officers, directors, their families and controlled companies; Schedule R transfers within a controlled group. Lowest false-positive rate of the five, because the organization is itself the source of the disclosure.

### False-positive discipline

A wrong funding claim is the most damaging thing this site could publish. Three rules, each enforced in code:

1. **Every signal states its null hypothesis.** Two organizations sharing a funder is unremarkable if that funder makes 400 grants a year. Convergence is scored against the funder's grant breadth, never raw co-occurrence.
2. **Timing correlation requires a stated mechanism.** "Grant landed 9 days before the vote" is a signal only if the recipient had a demonstrable interest in that vote. With no mechanism, the detector stays silent.
3. **Base rates publish alongside the finding.** If a pattern holds in 3 of 40 comparable cases, the finding says so. A pattern that cannot survive its own base rate does not publish.

### Explicitly rejected detector

Cross-referencing Schedule C lobbying disclosures against appearance frequency in meeting minutes. Public comment at a city meeting generally is not "lobbying" under the tax code, so the detector would manufacture accusations of false filing out of lawful behavior. Not built.

## Surface

A graph explorer, distinct from the front page: entity at center, edges outward, filterable by edge type and date range, every edge clicking through to its source document. Findings link into the specific subgraph they describe. Visual language is the approved editorial system — serif headlines, tabular numerals, citation chips.

## Testing

- **Fixture-driven parsing.** Real 990 XML committed as fixtures — one filing with Schedule I grants, one with Schedule L insider transactions, one with Schedule R related orgs, one malformed. No network in the parser tests.
- **Detector unit tests over synthetic graphs.** Each detector gets a graph that should trigger it and a graph that should not, with the near-miss case designed to catch over-firing.
- **Base-rate tests.** A detector fed a funder with 400 grantees must not report convergence.
- **The provenance invariant.** A test asserting `funding_edges` rejects an insert with a null `source_artifact_id`.
- **The non-partisanship invariant.** A test asserting no detector query references `entity_type` or `subsection_code` as a selector.
- **Frontier bound.** A test asserting expansion terminates at depth 2.

## Sequencing

W6 lands after Launch 2. The schema ships alongside W5 — CERS contributions are the same edge type, and building two schemas would be waste.

## Out of scope

- Federal grant data (USAspending) — the API exists but adds a domain without serving the local question
- Foreign funding analysis (Schedule F)
- Depth-3+ graph expansion
- Automated publication of any funding finding. Every one goes through the operator review queue.
