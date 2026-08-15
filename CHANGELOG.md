# Changelog

All notable changes to CommissionWatch are recorded here.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The project is pre-1.0, so a minor bump
may carry a breaking change to a public surface — each one is called out.

**Every feature below carries a completeness factor.** That is deliberate, and it is the same
discipline the product applies to the record: a feature listed without saying how finished it is
reads as finished. The scale:

| | |
|---|---|
| **Shipped** | Built, tested, deployed, and verified against production. |
| **Shipped dark** | Built, tested, deployed. Off behind a flag. Turning it on is a separate, deliberate act. |
| **Operator-gated** | Built and live, but nothing happens until a person works the queue. |
| **Blocked** | Built as far as it can go. Something outside this codebase is in the way, named below. |
| **Refused** | Deliberately not built, with the reason. |

---

## [0.3.0] — 2026-08-15

The release in which the pipeline joined up end to end, and in which most of what was found was
found by **building the consumer of something that already existed**. Six real defects surfaced that
way and none by reading the code.

### Breaking

- **`GET /api/votes` now returns only votes on published meetings.** It previously returned every
  row in the table. A client depending on the old behaviour was depending on a leak. See *The
  publication wall* below.

---

### The publication wall

**Completeness: Shipped.**

`GET /api/votes` was public, took no id, and served every vote in the table. Two failures in one
query: it disclosed the `meeting_id` of every meeting an operator had ingested and withheld — the
enumeration `findPublishedMeeting` answers 404 rather than 403 to prevent — and it published how a
named official voted at a meeting nobody had approved. The `POST` handler on the next line of the
same file says a vote row is "this project's core published claim about how a named official acted.
Writing one is an operator act." Reading one was not.

It had never leaked in production only because no vote row had been ingested yet. That is a
deadline, not a mitigation.

- Found by auditing every module that names a walled table for whether it reaches `publication.ts`.
  Of the routes a stranger can reach, this was **the only one** — the clean part of that result is
  worth as much as the finding.
- `publication-wall-audit.test.ts` now measures the property rather than describing it: a router
  naming a walled table must import `publication.ts`, apply `requireOperator` to the whole router, or
  appear in an allow-list with a written reason. Verified by mutation, including against a
  behaviourally identical hand-rolled `whereNotNull`, because a second copy of the rule is how
  `emitEvent`'s claim wall went a clause stale.
- The guard's own blind spot was found and closed within the hour: `db("meetings as m")` reads the
  same rows as `db("meetings")`, and the first extractor could not see an alias.

### Claims — review, publication, and the render pin

**Completeness: Operator-gated.** Built and live; nothing is public until an operator approves it,
and none has been approved yet.

- An operator can approve a claim, and approval pins the **exact bytes** — `rendered_text`,
  `render_sha256`, `render_version`, `approved_by` — so a later template edit cannot republish words
  nobody read.
- A reader sees an approved claim at `#claim-{id}` inside the meeting it came from. A claim never
  gets its own page: a page whose entire content is one sentence about one named person is an
  accusation; the same sentence inside the record is a record.
- Corrections to claims now appear in the public corrections log, gated on the full three-predicate
  claim wall.
- Claims are in the bulk export, with the pinned bytes and the model that drafted them, and without
  the approver's identity.

### The event spine and delivery

**Completeness: Shipped dark.** `EVENT_DRAIN_ENABLED` is unset in production.

- `events` table, `emitEvent` (re-checking publication inside the caller's transaction), `EventDrain`
  with `FOR UPDATE SKIP LOCKED`, and `retractSubject` — a withdrawal revokes what announced it.
- RSS/Atom feeds, including the query feed: **the subscription is the URL.** No account, nothing to
  leak, nothing to unsubscribe from.
- Discord routing with audience separation, enforced by a database trigger rather than by a caller.
- Email: `dry_run` is now its own status. `sendEmail` previously returned `void` whether it reached a
  provider or wrote to stdout, and both callers then recorded `sent` with a timestamp — the email log
  had been lying daily in production.
- `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058). `GET` renders a form and does not act,
  because a GET that acts is unsubscribed by the next link prefetcher.

**Security fix, in this release:** `POST /api/alerts` returned the `verify_token`, so anyone could
subscribe an address they did not own and verify it in the next call. Worse: for an address that was
already subscribed it returned **that subscriber's** `unsubscribe_token`, which reads, edits and
cancels their alerts. Submitting a stranger's email handed you control of their subscription.

### The MCP server

**Completeness: Shipped dark.** `MCP_ENABLED` unset; `POST /mcp` and `/.well-known/mcp.json` both
404, indistinguishable from not existing.

Six read-only tools over JSON-RPC, hand-rolled rather than adding a dependency. Every tool delegates
to the walled service that already exists; the file contains no query builder at all, deliberately.
nginx proxies both paths, with `/.well-known/mcp.json` on an **exact-match** location because the
static-extension regex would otherwise answer it from the SPA's disk.

### Server-side rendering for clients that do not run JavaScript

**Completeness: Shipped dark.** `PRERENDER_ENABLED` unset.

- One self-contained document per public record, with JSON-LD, driven off the `events` table.
- Two corrections to its own spec, both from reading code: the cursor is `(updated_at, id)`, because
  revoking a publication bumps a row written days ago and never touches `occurred_at`; and an event
  is a **trigger, never an instruction** — the consumer ignores `event_type` and re-asks
  `publication.ts` what the subject is now. That is what makes an unpublish reach the disk while the
  drain is off, which it is.
- nginx serves the prerendered copy to **crawlers only**. The documents load no script by design, so
  serving them to a browser would replace the application with a bare document on exactly the pages
  that matter. Same records, same URL, same database — not cloaking.
- Verified by curling a real container, not by `nginx -t`, which has been happy with three separate
  broken configs in this repository.

**Enabling it is two steps and the second is not optional:** the consumer walks the event log, so a
meeting published weeks ago has no event to replay. `prerender-rebuild` is a required seed, not a
repair tool.

### Geography — decisions on a map

**Completeness: Operator-gated.** The extractor and geocoder run; nothing is approved, so
`/api/places/near` correctly answers 200 with nothing in it.

- Points, radius, and a near-me feed, without PostGIS — `earth_box` and a GiST index, because the
  deployed image has no PostGIS and a migration assuming otherwise would not apply.
- **There is no slippy map, and that is a decision.** The CSP allows no host beyond the origin, so
  every commercial map SDK is blocked by the browser. A transparency site that tells a mapping
  company which parcels each reader looked at has built the surveillance layer it was designed to
  avoid. The page shows distance, direction, precision and a citation instead.
- Every position carries a precision grade, and **nothing is drawn or printed more precisely than
  its grade supports**. `block` is a TIGER address-range interpolation, not a surveyed point.
- The review path and console screen: approve and reject each demand a reason and each write an
  audit row in the same transaction.
- The reader map distinguishes **four** kinds of empty, including "we could not check" — the previous
  copy asserted nothing was found whether or not it had looked.

### Extraction — measured for the first time

**Completeness: Operator-gated.** Not scheduled; a fifth of chunks still truncate.

`extraction_runs` was **empty**. The distribution this project had called unmeasured for weeks was
not unread — there was nothing to read. It was produced by running the real extractor over the real
stored corpus: 10 documents, twice, 24 chunks, 20 runs.

**5 of 24 chunks unread (20.8%), and every one of them `truncated-reply`. 100%, n=5.** Zero refusals,
zero upstream errors, zero reasoning-only. The spec's §1 targets a branch that fired zero times.

- **Chunk splitting is not justified and was not built.** Size does not predict truncation, and the
  truncating documents emitted 86–127 "claims" from records containing a handful of votes. That is a
  repetition loop; splitting a chunk that loops gives two chunks that loop.
- The defect the numbers exposed: a one-chunk document — most of the archive — that truncated was
  classified `failed` while holding verified, stored claims, and `stage.ts` throws on `failed`, so
  the queue retried a **deterministic** outcome five times against a rate-limited free tier.

### Recordings — and the audio that will not be transcribed

**Completeness: Refused (transcription) / Shipped (coverage).**

Bozeman's player page publishes the media URL. `archive-video.granicus.com` answers **403 from
CloudFront to an honest, contactable user agent and 200 from AmazonS3 to a browser string**. The
custodian's own download link 302s onto that CDN and inherits the 403. `podcast.php` returns a valid
RSS channel with zero items.

The only route to the audio is presenting a user agent we are not. That is fingerprint spoofing.
**Stopped**, and a test asserts those hosts never enter `allowedOrigins`. Gallatin is unchanged: a
Blazor shell answering 200 for every path behind an AWS WAF challenge. For both, the answer is a
public-records request.

So the audio spec's headline claim — that this "unlocks the 2013–2020 Bozeman archive" — is false.
No transcription pipeline was built; it would have had zero input.

What the probe *did* justify: `meeting_recordings` records **which recording a meeting has and how
long it is**. Clip 1301 — 2013, an empty caption stub — reports a **2h 56m recording that exists and
cannot be searched**. That is the sentence that makes a records request worth making, and it is now
a row rather than an anecdote. The duration is corroborated, not merely parsed: the page says 1678s
and the caption file, fetched separately in a different format, ends its last cue at 1676.633s.

### Transcripts

**Completeness: Shipped** (Bozeman) / **Blocked** (Gallatin).

Bozeman captions across 1,135 archived meetings, parsed into cues and searchable. Gallatin is behind
the same WAF as its audio; the answer is a records request.

**Disclosure was a live breach, now fixed.** The Methodology page said "agendas and minutes" while
captions for 1,135 meetings were already stored. The vendor-robots exception is valid *only while
disclosed*, so the exception had been running undisclosed for a class of material already fetched. It
now names four classes and states that the recordings themselves are refused, why, and what the route
is instead.

### The roster

**Completeness: Blocked.** Migration 103 landed the columns; `traceable` is still 0 and the probe
says why.

- `source_url`, `fetched_at`, `artifact_sha256` on `members` — nullable, **nothing backfilled**,
  because every existing row is genuinely unsourced. `members_provenance_check` makes provenance
  all-or-nothing: a row with a URL and no hash reads as sourced and proves nothing.
- `GET /api/admin/roster` and `/admin/roster` put the per-body roll where naming a body is the point.
- `npm run roster:load` is dry-run by default and refuses a name that does not appear in the fetched
  bytes — **no similarity scoring, no override flag**.
- **Why it is blocked:** `bozemanmt.gov` answers 403 from Akamai at the root, so Bozeman's roster is
  not accessible by acceptable means. `gallatinmt.gov/directory.aspx` returns 200 and names the
  commissioners, but carries **no term dates**, and `members.term_start` is NOT NULL — a load would
  have to invent one. Nothing was loaded.

`/api/metrics` publishes a **distribution** over bodies rather than a roll, and carries no body or
jurisdiction name: an aggregate names nobody, but a per-body list tells a stranger which counties
hold withheld records. A first version of that endpoint leaked the names and was caught by the test
that forbids identifiers there.

### Open data

**Completeness: Shipped.**

- Bulk export in JSON and CSV, streamed in keyset batches, with the publication wall on every
  dataset — plus **claims**, which were missing while `/api/data` described itself as the manifest of
  every bulk export.
- Open Civic Data event feed; meetings held with no source URL are **omitted and counted**, never
  emitted unsourced.
- `/api/source/{sha256}` — the other end of every citation, addressed by the hash of the bytes so it
  still resolves after the source site is reorganised.
- Three licences, deliberately not collapsed: CC BY 4.0 for the compiled dataset, MIT for the code,
  and **no licence asserted at all** over the government records underneath — they are not ours to
  license.

### Transparency about ourselves

**Completeness: Shipped.**

- `/metrics` — this project measured by its own standard, including `roster_sourced: false`.
- `/status` now states **how much of the record has actually been read**, and *unmeasured is not
  zero*: the type's unmeasured branch has **no `unread_fraction` field at all**, so no component can
  reach for the flattering zero by accident.
- The public corrections log, which had silently stopped covering three tables that became
  correctable after it was written. The guard now reads the live CHECK constraint.

---

### Fixed

- **A CHECK constraint that evaluates to NULL is satisfied.** Four shipped in one day —
  `vote_events.counts`, `place_links_citation_check`, `minute_claims_approved_pin_check`,
  `transcript_status_sha_check`. `A OR (B AND C)` with a nullable operand on the right enforces
  nothing, and the row it admits is the one that violates it hardest. Now guarded against the live
  schema.
- **A fragment never leaves the browser.** Three call sites built `/source/{sha}#offset-{n}`; the
  server picks the window, so every citation would have opened a three-hundred-page packet at
  character zero and nothing would have looked broken.
- **A flaky assertion that would also have passed over a real leak.** A test asserted that channel
  ciphertext contained no `"@"`. Ciphertext is random bytes and `0x40` is `"@"` — measured at
  **10.6% over 3,000 encryptions**, so it failed about one CI run in nine. Flakiness there is
  symmetric: it would have passed at random over a row that really held an address.
- **`percentile_cont` over an empty set returns NULL, `Number(null)` is 0, and `Number.isFinite(0)`
  is true** — so `/metrics` reported "published in 0 days" for a project that had never published.
- Two operator screens reported "the record shows none" when the request had failed — the strongest
  claim available on the weakest evidence available, on the screens whose purpose is that somebody
  looks.
- The findings page claimed a human review that does not happen, and the test asserted those exact
  words: page and test agreed while both disagreed with the code.
- The map wrote an **eleven-metre** fix of the reader into the address bar, and from there into
  history and any shared link. Now ~110 m; the smallest search offered is 250 m, so the answer does
  not change.
- `add_header` in an nginx location discards every inherited header, so declaring `Vary` would have
  silently stripped the CSP from every page of the site.

### Drift, guarded

Four surfaces claimed to mirror something and had quietly stopped. Each is now measured against the
thing it mirrors rather than described in prose:

- The **sitemap** was three pages behind the router — including `/corrections/dispute`, the route by
  which someone named in a record contests it.
- The **open-data page** advertised six endpoints of twenty-seven.
- The **corrections log** silently excluded three tables that had become correctable.
- The **vocabulary test** could not see six of the words it existed to forbid, including "One anomaly
  on this record" rendered as an `<h2>` on the busiest page.

---

## [0.2.0] — 2026-08-14 and earlier

Ingestion, the Pressroom console, the review queue, the corrections log and dispute route, the
agenda diff timeline, full-text search, the public-records request generator, the status page,
campaign-finance ingestion, the calendar and iCal feeds, the fork path, accessibility, and the
deployment over SSM. See `docs/STATUS.md` for the detail and for the defects worth remembering.
