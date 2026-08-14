# Server rendering and reach

> Design of record for roadmap §8. Written 2026-08-14.
>
> Depends on `2026-08-14-vocabulary-and-ui-design.md` — the routes change there, and rendering
> pages at URLs that are about to be renamed wastes the work and the crawl budget.

## Where this stands

The crawler door is open, and verified in production on 2026-08-14: `robots.txt` returns
`text/plain` naming retrieval crawlers separately from training crawlers, `sitemap.xml` returns
`application/xml` with 15 URLs behind the publication wall, and `/nope.xml` 404s instead of falling
through to the SPA.

Behind that door, **every page returns the same 525-byte shell.** The React app renders on the
client. Measured against roughly 500M crawler fetches (Vercel/MERJ), GPTBot requests JavaScript in
11.5% of its fetches and ClaudeBot in 23.8%, and **neither executes it**. So a crawler that follows
our sitemap gets an empty div with a script tag, for every URL we invited it to.

We have built an invitation to a blank page.

## What this spec is not

It is not "add Next.js". The stack is React + Vite + Tailwind, `docs/spec/architecture.md` misstated
that for months, and swapping the frontend framework to fix a rendering problem is a rewrite
disguised as a feature.

## 1. Prerender, not SSR

The decision, and the reasoning.

This site's content changes when an operator publishes something. That is a handful of events per
day at most. Rendering every page on every request — with its database queries — to serve content
that changed hours ago is work done in the wrong place.

**Prerender static HTML per published object at publish time, driven by the event spine.** The
`meeting.published`, `finding.published`, `claim.approved` and `*.retracted` events already exist,
already fire only for public objects, and are already durable and replayable. A prerender consumer
subscribes to them and writes HTML to disk. That consumer is the seventh reader of the event log,
and it needs no publication logic of its own — which is the entire argument for the spine.

Consequences:

- Zero database work on a crawler hit. nginx serves a file.
- A prerender failure is visible (an ops event, a status-page row) rather than a slow page.
- Rebuild-all is `dispatched_at = NULL` over the prerender consumer's cursor — replay, already
  specified.
- No Node rendering process in the request path, so no new failure mode in front of the site.

The cost is staleness between publish and render, bounded by the drain tick (seconds), and a
disk-backed artifact to deploy. Both are acceptable; a stale-by-seconds page that exists beats a
fresh page that is blank.

**The SPA stays.** Prerendered HTML hydrates into the same React app, so an interactive reader gets
what they get today and a crawler gets the record. Where a page cannot be prerendered — `/search`,
`/map` — the fallback is the shell **plus** a server-rendered `<noscript>` block containing the
primary links, so a JS-less agent still finds the corpus rather than a dead end.

## 2. One URL per object, with real head content

Per the vocabulary spec's routes, and per the published-claim spec's rule that a claim is *not* its
own page:

| Object | URL | Prerendered |
|---|---|---|
| Meeting | `/meetings/{id}` | yes |
| Agenda item | `/meetings/{id}#item-{n}` — and, where it carries its own decision, `/items/{id}` | yes |
| Finding | `/findings/{id}` | yes |
| Claim | `#claim-{id}` inside the two pages above | in its parent |
| Source | `/source/{sha256}` | yes |
| Official | `/officials/{id}` | yes |
| Place | `/places/{id}` | yes |

Every prerendered page carries, server-side and in the bytes:

- **`<title>`** — specific and distinguishing. "Bozeman City Commission — 12 March 2026", not
  "CommissionWatch". The title is what a crawler and a search result show, and a site where 500
  pages share one title is a site with one page as far as any index is concerned.
- **`<meta name="description">`** — assembled deterministically from the record. No generated prose;
  the published-claim rule applies to metadata too, because a description is published text.
- **an absolute self-referencing `<link rel="canonical">`.** Absolute, because a relative canonical
  under a proxy is a canonical pointing at the wrong host.
- **`<meta name="robots">`** — `noindex` on tombstones and on the retraction pages, per the
  published-claim spec.
- Open Graph and Twitter card tags, which is how a link posted in a Discord channel or a newsroom
  Slack renders as something a person clicks.

## 3. JSON-LD, server-rendered

There is already `Dataset` JSON-LD — **inside a React component**, which means it is behind the same
JavaScript wall as everything else and will likely never be seen by the crawlers it was written for.
Move it into the server-rendered head.

Per page type:

- `/data` → `Dataset`, with `distribution` entries for each export, `license`, `creator`, and
  `temporalCoverage`.
- `/meetings/{id}` → `Event`, with `startDate`, `location`, `organizer`, and `subjectOf` pointing at
  the source documents.
- `/officials/{id}` → `Person` with `roleName` and `memberOf` — and **only** what the public record
  states. No birth date, no address, no image scraped from anywhere. The published-claim spec's
  caution applies with more force in structured data, because structured data is *designed* to be
  aggregated.
- `/findings/{id}` → `Claim`/`ClaimReview` shape with `citation` pointing at `/source/{sha}`.
- `/places/{id}` → `Place`, with geometry at the precision the record supports.

**Validate in CI.** A JSON-LD block that does not parse, or that references an undefined type, is
worse than none — it is a signal of carelessness in exactly the machine-readable layer we are asking
to be trusted. A test that parses every emitted block and checks required fields is cheap.

## 4. The OCD export, validated

Open Civic Data is the established schema for exactly this data: `Event`, `EventAgendaItem`,
`VoteEvent`. The corpus-throughput spec adds `vote_events` for independent reasons and should follow
OCD's shape rather than invent one, which makes this export nearly free.

`GET /api/data/ocd.json` (and a per-jurisdiction variant), validated **in CI against the published
OCD JSON Schema**, not against our own idea of it. OCD's `sources` array has `minItems: 1`, which is
a schema-level restatement of this project's own invariant — no unsourced claim — and validating
against it means the export cannot silently drift into publishing an uncited record.

This is the piece that makes the data *reusable* rather than merely visible. A second organisation
can ingest it without writing an adapter for us.

## 5. `/bot` — the page for machines

A single human-readable page that states, in plain language: what this dataset is, what it covers,
where the machine-readable forms are (`/sitemap.xml`, `/feed.xml`, `/api/data/*`, `ocd.json`, the
MCP endpoint), what the licence is, how citations are addressed (`/source/{sha256}`), and how to
report an error.

It exists because the retrieval crawlers named in `robots.txt` are being invited in, and an
invitation should say what is inside. Linked from `robots.txt` as a comment and from the footer.

## 6. Rate limiting the crawl layer — 429 and `Retry-After`

Two directions, and both are currently missing in the wrong place.

**Inbound.** The public API and the feeds must return 429 with `Retry-After` under load rather than
degrading. `services/rate-limit.ts` exists; the feeds and the query feed are new surfaces and must be
covered, particularly `/feed.xml?q=…`, which accepts arbitrary query text and is the obvious load
generator.

**Outbound.** `services/ingestion/` does **not** handle 429 or `Retry-After`, though the SMS and
OpenRouter clients both do. That is the wrong way round: the crawl layer is the one place where
ignoring a `Retry-After` is not merely impolite but is a breach of the conduct this project
publishes on its Methodology page. The vendor-exception in `SKILL.md` is valid only under "one
request every few seconds at most, never concurrent" and full disclosure; a crawler that ignores a
server asking it to slow down has left that agreement.

Requirements: honour `Retry-After` in both seconds and HTTP-date forms; exponential backoff with a
cap; a per-host concurrency of 1; and the delay floor taken from
`jurisdiction_access_policy.crawl_delay_seconds`, which migration 074 already stores per
jurisdiction. **A repeated 429 from a source is an ops event and a status-page row**, not a retry
loop — a source telling us to stop is information, and the answer may be the records-request route.

## 7. Deployment

Prerendered HTML is an artifact. Options, and the choice:

- Write into a volume the frontend nginx container serves, with `try_files $uri $uri/ /index.html`
  already in place — a prerendered file is found, everything else falls through to the SPA. This is
  the smallest change and it fits the existing config exactly.
- Bake into the image at build time — rejected, because publishing would then require a deploy.

nginx precedence needs the same care the sitemap needed. The existing
`location ~* \.(txt|xml|json|csv|ics|map|webmanifest)$` regex block is tried **before** plain prefix
locations, which is why `/api/` had to become `^~`. Any new location added here gets a
container-run curl test across every path — `nginx -t` proves the config parses, not that it routes.

## Tests the plan must require

- An unpublished meeting has no prerendered file, and its URL 404s. Publish, then assert the file
  exists and contains the meeting title in the HTML bytes.
- Unpublishing removes the file and the URL 404s or serves the tombstone.
- Every prerendered page has a unique `<title>` — asserted across the whole set, not per page.
- Canonical URLs are absolute and self-referencing.
- Every JSON-LD block parses and carries its required fields.
- The OCD export validates against the published schema in CI, and an event with an empty `sources`
  array fails validation.
- A curl of `/api/data/meetings.csv`, `/sitemap.xml`, `/feed.xml`, `/robots.txt` and a prerendered
  meeting page, against nginx **running in a container**, returns the right content type for each.
- The ingestion fetcher honours `Retry-After` in both formats, and a repeated 429 records an ops
  event rather than looping.

## Open questions

**Do prerendered pages include claims, or only the meeting record?** Specified as included — a
meeting page without its approved claims is the page a crawler would index, and it would omit the
substance. But it means the prerender consumer must re-render a meeting page on `claim.approved` and
on `claim.retracted`, not only on `meeting.published`. The dependency graph is small and the plan
must state it, because a stale prerendered page showing a retracted claim is the worst failure this
system can produce.

**Is `/items/{id}` worth having?** An agenda item that carries its own decision is a genuinely
citable atom and the thing a reader usually wants to link to. It is also close to the thin-page
concern that kept claims off their own URLs. The distinguishing test: an agenda item has a matter, a
history across meetings, and usually multiple votes — it is a record, not a sentence. Recommendation:
build it, and revisit if the pages turn out to be one line each.
