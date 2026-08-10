# Writing an adapter: pointing CommissionWatch at your jurisdiction

Ingestion used to be a Bozeman-shaped function. It is now an interface. One module per source, each implementing `SourceAdapter`, each passing the same contract suite. **Adding a jurisdiction never touches core code.**

This guide is the contract, two worked examples, the fixture discipline, the conduct rules, and — first, because it is the part people are misled about — an honest account of what is *not* configuration yet.

---

## What is not config, and will cost you time

The pitch is "point it at your commission in an afternoon". That is achievable for a source that publishes a clean listing page. It is not a config-file exercise, and these are the specific reasons.

**Body lists are hardcoded constants in the adapter.** `GALLATIN_BODIES` (twelve `{ catId, name }` entries) in `gallatin-civicplus.ts`; `BOZEMAN_BODIES` (nineteen names) plus `BOZEMAN_BODY_ALIASES` in `bozeman-granicus.ts`. A city standing up a new committee needs a code change and a deploy. Moving these into the database has been attempted and declined twice, for reasons recorded in `docs/STATUS.md` — adapter construction is synchronous, boot-time and database-free, and making it read config means making the registry async.

**`ingestion_sources.config` is written once and never updated.** `registerSource()` returns early when the row exists. So an existing deployment's `config` is frozen at first boot, and no deploy will ever change it. It is also lossy: `config.bodies` is `descriptor.bodies.map(b => b.key)` — slugs only. Gallatin's `catId` is dropped entirely and `urban-parks-forestry-board` cannot regenerate `Urban Parks & Forestry Board`. **Do not treat that column as a round trip.** It is a record of what the adapter declared, not an input.

**Jurisdictions are created by the registration path, not by a config file.** `registerSource()` upserts `jurisdictions` (matched on `name, state`) and `commissions` (matched on `jurisdiction_id, name`) from the adapter's own descriptor. One source registered a jurisdiction by migration instead — migration 037 for MT CERS — and that is the exception rather than the pattern.

**There are two registration points and one of them is a decoy.** `adapterRegistry`, exported from `adapters/registry.ts` and described as "the process-wide registry", is permanently empty and referenced nowhere outside its own file. The live list is the literal array in `createDefaultRegistry()` in `backend/src/services/ingestion/index.ts`. Register there.

**The test runner takes an explicit file list.** A new `test/adapters/<key>.test.ts` that is not added to the `test` script in `backend/package.json` silently never runs, which looks exactly like coverage.

**Some columns are narrower than you expect.** `meeting_documents.title` and `.url` are `VARCHAR(255)`; an over-long URL is dropped entirely rather than truncated, because a truncated URL is a broken citation. `jurisdictions.state` is `VARCHAR(2)`. `jurisdiction_type` admits `city`, `county` and `state` only.

---

## The contract

`backend/src/services/ingestion/adapters/types.ts`. Three methods, nothing else:

```ts
export interface SourceAdapter {
  readonly key: string;                                   // 'gallatin-civicplus'
  describeSource(): SourceDescriptor;                     // pure, no network
  discoverMeetings(since: Date): Promise<MeetingRef[]>;   // discovery only
  fetchDocument(ref: DocumentRef): Promise<FetchedArtifact>;
}
```

Every field name and value domain in that file is pinned to the database schema, which is the source of truth: `SourceAdapter.key` → `ingestion_sources.adapter_key`, `MeetingRef.status` → the `meeting_status` enum, `FetchedArtifact.*` → the `artifacts` columns.

### Module shape

Follow both existing adapters:

```ts
export const YOURCITY_ADAPTER_KEY = 'yourcity-vendor';

export interface YourCityAdapterOptions {
  transport?: HttpTransport;      // injected in tests; the fixture transport
  bodies?: readonly Body[];       // so a test can narrow the list
  now?: () => Date;               // frozen clock
  respectRobotsTxt?: boolean;
}

export function createYourCityAdapter(options: YourCityAdapterOptions = {}): SourceAdapter { … }
```

Export the constants and the pure parse helpers by name too — the adapter's own test file imports them directly, and a selector helper that cannot be tested in isolation will not be tested.

Then add one line to `createDefaultRegistry()` in `backend/src/services/ingestion/index.ts`.

### What the registry enforces

`register()` calls `assertValidAdapter`, which requires: a non-empty key, at most 100 characters, matching `/^[a-z0-9]+(-[a-z0-9]+)*$/`, and `describeSource().key === adapter.key`. `get()` throws `UnknownAdapterKeyError` rather than returning `undefined`, so a typo is a named failure and not a silent no-op.

---

## The contract suite

`runAdapterContract(adapter, fixtures)` lives in **`backend/test/adapters/contract.ts`** — deliberately *not* `contract.test.ts`. When it was a test file, importing it from another test file under `node --test` produced partial, silently-green registration: 34 or 42 of 68 tests, depending on timing. **Import it from `./contract`, no `.test`.**

Your test file:

```ts
import { runAdapterContract } from './contract';

runAdapterContract(
  createYourCityAdapter({ transport: createFixtureTransport().transport, now: () => FROZEN }),
  { since: new Date('2026-01-01T00:00:00Z'), minMeetings: 3 },
);
```

Then add the file to the `test` script in `backend/package.json`.

### What it asserts

**`describeSource()`**
- `descriptor.key === adapter.key`, and `assertValidAdapter` passes.
- Jurisdiction: non-empty trimmed `name`; `state` matches `/^[A-Z]{2}$/`; `type` is `city` or `county`; `websiteUrl`, if present, is an absolute http(s) URL.
- At least one body. Each `key` is lowercase kebab, each `name` non-empty, each `listingUrl` absolute. Keys unique.
- `baseUrls` non-empty and absolute, and **every body's `listingUrl` origin must appear in `baseUrls`**.
- Politeness: `minDelayMs >= 500`, `maxConcurrency >= 1`, `maxRetries >= 0`, `respectRobotsTxt` boolean.
- **`userAgent` must match `/CommissionWatch/i` and must carry a contact** (`@` or a URL). An anonymous crawler is not permitted by the contract, let alone by the conduct rules.
- **Purity**: two calls are deep-equal, *and* `bodies` and `baseUrls` are not the same object reference. Returning a cached descriptor object fails. Rebuild it each call.

**`discoverMeetings(since)`**
- At least `minMeetings` results.
- Every ref: `sourceKey === adapter.key`; `bodyKey` is one of the declared keys; `date` is `YYYY-MM-DD` and a real calendar date (2025-02-30 is rejected); `time`, if present, is 24-hour `HH:MM`; `timezone` is an IANA zone this runtime knows.
- Nothing older than `since` minus a day of slack.
- `status` is one of the three enum values; `sourceUrl` is absolute on every ref.
- No duplicates within a sweep — identity is `externalId ?? bodyKey|date|time`.
- Documents: `sourceKey` matches, `kind` is one of the seven `DOCUMENT_KINDS`, `title` non-empty, `url` absolute.

**`fetchDocument(ref)`**
- `bytes` is a non-empty `Uint8Array` and `byteSize === bytes.length`.
- `contentType` is `null` or a non-empty string — `null` is a real answer.
- `artifact.ref.url === ref.url`; `fetchedAt` round-trips exactly through `new Date(...).toISOString()`.
- **`sha256` equals `sha256Hex(artifact.bytes)`** and matches the 64-hex pattern.
- Fetching the same ref twice returns identical bytes and the same address.

---

## Fixtures, and `PROVENANCE.md`

**Every test runs against bytes captured from the live source and stored in the repository.** Not a hand-written HTML snippet that resembles the page. A hand-written fixture tests your parser against your own idea of the source, which is the one thing you already know.

Layout: `backend/test/fixtures/<source>/`. Files are named after the endpoint they captured — `agendacenter-index.html`, `updatecategorylist-cat4-2025.html`, `viewfile-agenda-06022025-2.pdf`, `viewpublisher-view1.html.gz`, `robots.txt`.

The test builds a **fixture transport** that returns the captured bytes for exactly the URLs and methods that were captured, and **throws `No captured fixture for ${method} ${url}`** for anything else. That is the point: when a selector change makes the parser request a URL nobody captured, the suite fails loudly instead of quietly returning nothing and reporting zero meetings as a successful sweep.

Where a fixture is compressed on disk (Bozeman's 5.9 MB archive page → 148 KB gzipped), the test **asserts the sha256 of the decompressed bytes before parsing them**. Do this. Without it, an edited fixture silently changes what the parser is written against, and the test that was proving your parser reads the county's page is now proving it reads yours.

### `PROVENANCE.md`

One per fixture directory, alongside the bytes. It is the document that makes the fixtures evidence rather than test data. Both existing files carry:

- **A statement that the capture is verbatim** — nothing hand-written, trimmed or reformatted — and the name of the parser file the bytes were written against.
- **The capture date, the exact command, and the rate.** The real `curl -A '<the project user agent>' …`, and the delay observed between requests.
- **A table of every file**: the request that produced it, and the response — status, content type, byte size, sha256.
- **An explicit no-evasion statement**: no fingerprint spoofing, no TLS/JA3 manipulation, no CAPTCHA solving, no proxy rotation, no header forgery. And what was deliberately *not* probed.
- **`robots.txt`, verbatim**, where the source's robots file is part of the story.
- **What the capture proved, and what it disproved.** This section is the most valuable one. Bozeman's records where the access spike had been wrong — 519 City Commission meetings, not 520; sixteen bodies, not "20+ others" — and Gallatin's records that category 14, "Commission", is served by a different vendor entirely and needs its own adapter.

Write the "disproved" section honestly. It is the only durable record of what you believed before you looked.

---

## Scraping conduct

All targeted material is public record. Fetching it is still done politely.

### The floor

- **One request at a time.** `maxConcurrency` is 1 in both adapters and there is no reason for it to be anything else.
- **A real delay.** The contract's floor is 500 ms; the practice is 2 seconds (Gallatin) and 10 seconds (Bozeman, matching the `Crawl-delay` that source's own `robots.txt` publishes). Politeness lives in the transport (`createPoliteTransport` in `adapters/http.ts`) and there is deliberately **no switch to skip it**. Tests get speed by injecting a fixture transport, not by turning the delay off.
- **An honest user agent.** `CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)`. Never a spoofed browser identity. The contract test enforces both the name and the contact.
- **Aggressive caching.** A document whose bytes have not changed is never re-fetched — that falls out of `artifacts.sha256` being unique, so it is a property of the pipeline rather than a discipline anyone has to remember.
- **Every stage after `fetch` reads a stored artifact, never the live web.** Parsing and analysis therefore develop at full speed against a source that is blocked, offline or rate-limiting.

### `robots.txt`, and the one exception

**Respect it by default.** `respectRobotsTxt` defaults to `true`, and Gallatin runs that way.

There is one deliberate exception, decided by the operator on 2026-08-04. Where a **vendor's** blanket `Disallow: /` would block access to records a government custodian is legally obliged to publish, this project fetches anyway, under strict conditions, all of which must hold:

- one request every few seconds at most, never concurrent — at the `Crawl-delay` the file itself publishes, where it publishes one;
- an honest user agent naming the project, never a spoofed browser identity;
- aggressive caching, so an unchanged document is never re-fetched;
- **the practice is disclosed publicly on the Methodology page**, not hidden;
- the public-records-request route is offered alongside it, so anyone can obtain the same documents through the statutory channel.

The reasoning: a blanket vendor robots file is written to manage search-engine crawlers, not to withdraw public records from public access, and the custodian's legal obligation does not transfer to its hosting vendor's convention.

This applies to **vendor** files. **A custodian who directly asks us to stop is a different matter — we stop.**

**The exception is valid only while it is disclosed.** A transparency project must not carry a published policy it knowingly breaks. If that disclosure ever comes off the Methodology page, the exception ends with it, and the adapter must be disabled in the same change — `respectRobotsTxt: true` makes it obey the file and discover nothing, which is the switch. Three tests currently fail if the disclosure wording is removed.

One more mechanical note: `parseRobotsTxt` implements a small subset of REP — prefix rules, `*` and `$`, longest match wins, `Allow` breaks ties, a group naming this agent beats `*`. **`Crawl-delay` is parsed by nobody.** The delay is a hand-copied constant in the adapter, so if you rely on a source's published crawl delay, copy it in and say where it came from.

### The hard line

If a source requires **fingerprint spoofing, TLS/JA3 manipulation, CAPTCHA solving, or proxy rotation**, that is not politeness with an asterisk — it is defeating an access control. **Stop and ask the operator. Do not build it.** The finding is "not accessible by acceptable means" and the answer is a public-records request, which this project has a generator for.

Worked example: `bozemanmt.gov` returns a blanket Akamai 403 to real Chromium from a residential IP, including for its own `robots.txt`. That is a wall, not bot detection, and that door stays closed. The records were found instead at `bozeman.granicus.com`, reachable with no evasion at all, **by following the DNS CNAME chain rather than attacking the HTTP endpoint**. When HTTP probing dead-ends, look at DNS.

---

## The two worked examples

### `gallatin-civicplus` — a paginated listing, one request per body-year

CivicPlus AgendaCenter. The index at `https://www.gallatinmt.gov/AgendaCenter` lists categories; each category-year is a separate `POST /AgendaCenter/UpdateCategoryList` returning an HTML fragment. `robots.txt` is permissive, so `respectRobotsTxt` is `true` and the adapter obeys it. 2-second delay, 3 retries, `supportsLiveFetch: true`.

Two things the live sweep taught, both now in the notes:

- **The site had been reorganised.** It served three categories where `GALLATIN_BODIES` names twelve. An unknown category is skipped with a warning, so the failure mode is safe — but the constant is mostly wrong about what the site serves.
- **Not every document is a PDF.** `/AgendaCenter/ViewFile/Agenda/_08062026-108` is a Word document. `expectedContentType: 'application/pdf'` is therefore set **only** when the source itself classes the link as a PDF. Parse records `parse_unsupported` and completes; the bytes are still stored and still citable, and that meeting has zero agenda items with the reason recorded.

Category 14, "Commission", is empty on AgendaCenter because it is served by AV Capture All — a different vendor needing its own adapter. That absence is recorded in the notes rather than left to be rediscovered.

### `bozeman-granicus` — the whole archive in one request

Granicus. `ViewPublisher.php?view_id=1` is 5.9 MB holding 1,135 meetings across 16 bodies, 2013→2026, plus 17 upcoming. **The year tabs are client-side; there is no per-year endpoint.** The opposite shape from Gallatin.

Four things it taught:

- **The robots exception is in force here**, at the 10-second `Crawl-delay` the file publishes, disclosed on the Methodology page. `respectRobotsTxt` defaults to `false` for this adapter and the descriptor reports the live value, not a constant, so the console shows what is actually happening.
- **The archive's time column is the video clip's start, not the meeting's.** The 2026-08-04 City Commission row says 1:17 PM; that meeting's own agenda states an early start of 2:00 PM. So `time` is emitted for **upcoming rows only**. Inventing a start time from a clip is exactly the sort of plausible false statement this project exists to catch.
- **Agendas are HTML, not PDF.** The parse stage originally read PDFs only, so every Bozeman agenda would have landed `parse_unsupported` with zero items. `document-text.ts` now dispatches on the bytes rather than on the URL.
- **The vendor's own ids are not stable.** A meeting changes `clip_id`/`event_id` between "upcoming" and "archived", so keying `externalId` on them would leave a permanently-`scheduled` duplicate beside the real record. It uses `${bodyKey}-${date}` with an ordinal suffix instead, which relies on page order for same-day pairs — a known, documented weakness, not an oversight.

`bozemanmt.gov` is never fetched. Agenda packets (28 MB, 439 pages, 724 of them) are not fetched unless `includePackets` is set.

---

## Things that will bite you

Collected from both adapters, in rough order of how long each took to find.

1. **`describeSource()` must rebuild its arrays every call.** The contract asserts the second call's `bodies` is not the same object reference as the first's.
2. **`baseUrls` must include every origin reached *after redirects*.** Bozeman declares the S3 attachment origin because `AgendaViewer.php` 302s there. Both adapters enforce this themselves with an `OffSourceUrlError` guard.
3. **`FetchedArtifact.sourceUrl` is the final URL, not the requested one.** `artifacts.source_url` records where the bytes actually came from. This matters more than it looks: a backfill that joined `artifacts.source_url` to `meeting_documents.url` covered Gallatin completely and **missed Bozeman entirely**.
4. **Copy bytes out of your cache before hashing** (`Uint8Array.from`), so a mutating caller cannot corrupt the content address.
5. **Skip an unknown body loudly; never guess.** Both adapters warn and drop the rows. Bozeman refuses similarity matching outright and uses an explicit one-entry alias table plus a matching-only normaliser (`bozemanBodyMatchKey`) — which must **not** be folded into `slugifyBodyName`, because that function's output is a stored key and changing it renames every body.
6. **Never invent a fact the source does not state.** Gallatin publishes no start time and no location; the adapter emits neither. A null is a real answer and the site renders it as one.
7. **Registration is create-only.** Changing politeness or bodies in `describeSource()` does not update an existing `ingestion_sources` row. That needs a migration or manual SQL.
8. **New sources are created disabled**, with `disabled_reason` set from `descriptor.notes`. Those notes are operator-facing text that will be rendered on `/admin/sources` and summarised on the public `/status` page. Write them for that reader.
9. **The backend `tsconfig` carries no `DOM` lib**, deliberately. Hence the hand-written `FetchLike` and `RedirectMode` types. Do not reach for DOM types.
10. **`MIN_POLITENESS_DELAY_MS` is 500 ms.** That is the contract's floor, not the project's norm.

---

## The first live sweep

```bash
cd backend
npm run sweep -- --list                                        # what exists
npm run sweep -- --adapter yourcity-vendor --enable             # enable, sweep once, now
npm run sweep -- --adapter yourcity-vendor --lookback-days 14   # a short first look
```

`--enable` flips `ingestion_sources.enabled` before sweeping; `--source <uuid>` selects by row id instead of key. Exit codes: `0` success, `1` the sweep ran and failed, `2` no matching source, `3` the sweep did not run (lock not acquired, or still disabled).

**Use a short lookback the first time.** At Bozeman's 10 seconds per document, a 365-day sweep runs for hours and will blow the scheduler's 15-minute timeout, leaving the run `failed` and its jobs queued for the next tick until it catches up.

After it runs, look at `/admin/sources` and `/status`. Every failure is in a row with its error text, which is the point.

---

## Checklist

- [ ] Probed the source with `curl` before writing anything; read its `robots.txt`.
- [ ] Captured fixtures verbatim, at the rate you will actually crawl at, with the project user agent.
- [ ] Wrote `PROVENANCE.md`, including what the capture disproved.
- [ ] Adapter module with a factory, injectable transport and clock, and exported constants.
- [ ] Registered in `createDefaultRegistry()` in `backend/src/services/ingestion/index.ts`.
- [ ] Test file calling `runAdapterContract`, importing from `./contract` — not `./contract.test`.
- [ ] **Test file added to the `test` script in `backend/package.json`.**
- [ ] Fixture transport throws on any URL it did not capture.
- [ ] Fixture digests asserted before parsing.
- [ ] `descriptor.notes` written for the operator who will read it on the status page.
- [ ] Full gate green: `npm run typecheck && npm run lint && npm test` in both packages.
