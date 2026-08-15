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

## [0.4.0] — 2026-08-15

The release in which the things shipped dark in 0.3.0 got a switch an operator can actually reach —
and in which building that switch found it did not reach two of the six features it claimed to
control.

**Deployment status: partial, and that is not a formality.** `72c10b0` is live, so the registry, the
console and the live toggle are in production. Everything after it — the extraction de-duplication,
the taxonomy mirror guard, the From-address fix, the dated archive — is committed, pushed, and **not
running**, because the deploy host filled its disk. See *The deploy that did not happen* below.

### Breaking

None. With no row in the `features` table every flag resolves byte-identically to 0.3.0. That is the
property the compatibility layer exists to hold, and it is why the drain, prerender and MCP suites
pass **unmodified** rather than rewritten.

---

### The feature registry

**Completeness: Shipped.** Live in production, verified from outside the host.

Three features shipped dark in 0.3.0 behind `process.env` reads. Right for shipping them, wrong for
operating them: turning one on meant editing a SecureString and re-running the SSM deploy, nothing
recorded who did it, and the console did not say which features were live — the answer was spread
across a compose file, a Parameter Store value and three source comments.

**What it deliberately cannot do is the load-bearing part.** The publication wall, the review gate
and the claim wall get no key. A registry able to disable a wall converts an invariant into a
setting, and a setting is something somebody eventually changes at 11pm for a reason that made sense
at the time. The manifest is an allow-list, and `feature-registry-audit.test.ts` asserts six wall
modules contain no import of and no call into the registry — **verified by mutation**: a `review_gate`
key fails it by name, and a registry call inside `whereMeetingPublished` fails it twice with the
offending line quoted. A guard never seen to fail is not known to work.

Resolution falls off to **off** in every failure mode: kill switch → registry row → legacy env →
default. A process that cannot reach the database enables nothing and never blocks startup finding
out.

**The env kill switch outranks the database, on purpose.** The case that most demands turning a
feature off is the one where the feature is hammering Postgres, and a switch needing a healthy
Postgres to say "stop" does not work when it matters. It is **one-directional**: `FEATURE_MCP_SERVER=true`
enables nothing and logs that the variable has no on position, because forcing a feature on from the
environment is the untraceable enable this replaces.

Every write records the operator, the timestamp and a **required reason**, in one transaction across
both tables. A no-op write is refused rather than recorded, so the log reads as a list of changes
and not a list of clicks.

### The console — `/admin/features`

**Completeness: Shipped.**

Grouped by risk, `sends` first and alone. Every row **names the source that decided it**, because the
failure this screen prevents is an operator flipping a row, seeing nothing change, and concluding the
console is broken rather than that `FEATURE_EVENT_DRAIN=false` sits in the deploy config.

- A kill-switched row's control renders **disabled**, with the variable printed beside it in place
  rather than in a tooltip. A control that accepts a click and changes nothing is worse than none.
- Turning on a `sends` feature requires **typing the key** as well as a reason — an input, not a
  checkbox, because a checkbox can be clicked without reading anything.
- The latency is printed as a **number** (~15s worst case), composed from server-supplied intervals.
  Not "instant", which invites a second click; not "takes effect on restart", false since the loops
  were fixed.
- `loadedAt` is shown, with the distinction spelled out: *the switch says on* and *this process has
  confirmed the switch says on* are different facts.
- A failed request renders an error and an explicit absence reason, **never an empty list**. Two
  operator screens in 0.3.0 claimed "the record shows none" when the request had failed; this is not
  a third.
- A risk grade this build does not recognise renders in an "unrecognised" group rather than falling
  through every branch — **a switch missing from the switch panel is a switch nobody knows exists.**

### The switch now reaches the loops

**Completeness: Shipped dark** (the features it gates remain off).

`EventDrain` and `PrerenderConsumer` latched their flag in the constructor, so a console toggle
reached only `mcp_server`. **Found by building the console, not by reading the code.** The early
return in `start()` was the actual bug: with no timer armed there was nothing left running to notice
a change.

**Where the gate sits matters as much as that it exists.** For the drain it is before the transaction
opens, so nothing is claimed and `dispatched_at` stays null. For the consumer it is after the cursor
read and before the event query, so the cursor does not advance while off. **Off is a pause, not a
loss** — and for the dispute mailer that is a person owed a reply still getting one when the flag
comes back on.

The test asserts on the **ledgers**, never a return value, because `sendEmail` returning void whether
or not it reached a provider is how the email log lied daily in production. It settles to `dry_run`,
asserted explicitly not to be `sent`.

### Extraction — the repetition loop

**Completeness: Operator-gated.** Extraction is still not scheduled.

0.3.0 measured a fifth of chunks unread and 100% `truncated-reply`. 0.4.0 read the raw replies. **The
model restates claims verbatim**: one reply emitted a single object 92 times and was cut mid-string;
another cycled four claims 33/32/33 times. In both, the genuine claims come first and the loop starts
at index 4.

- **De-duplicating by claim signature took rejections from 1,007 to 336** across 30 captured replies.
  **671 of them — 67% — were the model repeating itself**, not problems with the record. `proposed`
  is now counted after de-duplication, because 95 on the operator console said the model found 95
  facts in a passage containing four.
- **`repetition-truncated`** splits off from `truncated-reply`, earned only when the trailing run
  introducing nothing new is ≥5. Observed tails were 90–144; an honest cut has a tail of 0.
- **The chunk still counts as unread.** The label says what was observed and deliberately not what
  was lost, because one reply cannot establish that.
- Token ceiling untouched, chunks not split — both refused with reasons in 0.3.0 and unchanged.

**What the measurement says, and its limit.** At n=30, **0 of 6 truncated chunks lost a verified
claim**. The first analysis compared raw claim signatures and was **thrown out as worthless**: the
model is wildly nondeterministic at temperature 0 — five *complete* replies to one chunk produced
20/21/27/31/38 distinct claims against a union of 104 — so that measure charges truncation for the
model's variance.

And the result is published with its own bound rather than as a headline: **this corpus verifies
about one claim per chunk, and two of five chunks verify zero across all six runs.** A chunk with
nothing to lose cannot demonstrate that nothing is lost. Sound for this corpus, weak as a general
claim, and it must be re-run once the office gate is addressed — 283 of the 336 surviving rejections
are `not-an-official`, because these are a Weed District board's minutes printing bare first names.

**No early abort.** The client is a single non-streaming POST, so there is no stream to stop. The
cost is filed rather than hidden: a looping reply burns ~31k characters and ~65s against ~5k and ~15s.

### The dated export archive

**Completeness: Shipped dark.** `dated_export_archive` unset; every archive path 404s.

"What did this site say in March" was unanswerable, and `/data` said so rather than implying
otherwise. Two decisions, both settled by reading the schema:

- **A point in time means a snapshot somebody took — forward-only.** Publication state is
  `meetings.published_at`, one mutable timestamp, and unpublishing sets it to **NULL**. A meeting
  published in March and withdrawn in April leaves no trace of ever having been public, so filtering
  on `published_at <= date` returns today's survivors wearing March's date — and is most wrong
  exactly about the records later taken down, which are the ones the question is usually about. The
  archive answers from the first snapshot onward and 404s before it, saying no snapshot was taken.
  **That is a different statement from "the site published nothing."**
- **An archived export is walled at read time, so retraction reaches it.** A snapshot stores row ids
  and a sha256, **never the bytes**. Serving one calls the same builder `/api/data` calls and
  intersects with the recorded ids, so the intersection can only *remove* rows. `archive.ts` does not
  know what a retraction is and does not need to. A second copy of a wall rule is how `emitEvent`'s
  claim wall went a clause stale; there is no second copy here.

The cost is printed, not buried: an archived export is *the rows published then that are still
published now*, not the bytes served that day. Every response carries `rows_recorded`, `rows_served`,
`withheld_since`, `sha256_then`, `sha256_now` and `unchanged`, because a quietly shorter file is
indistinguishable from a smaller record.

---

### The deploy that did not happen

**Completeness: Blocked — operator action required.**

`deploy.yml` run 29009 failed. Every check job is green on the same sha; only `deploy-aws` failed,
**on the instance**, extracting a Docker layer: `no space left on device`.

The site was never at risk — the pull failed before anything replaced the running containers, so
production kept serving the previous good sha and answering health 200. A failed deploy that leaves
the previous version running is the pipeline behaving correctly.

**Nothing alerted, and that is the finding.** The external monitor watches whether the site is up,
and the site is up. A deploy failing while the previous version keeps serving is invisible to it. The
disk filled silently and the first symptom was a failed release. **A green check suite plus a healthy
site does not mean the release deployed** — probe `/api/version` for the sha.

Not remediated automatically: freeing space means deleting from a full production disk while unable
to see it, and `docker image prune -af` would remove the images a rollback needs.

---

### Fixed

- **`ALERT_FROM_EMAIL` defaulted to a domain this project does not deploy**, so it could never have
  aligned with any SPF/DKIM/DMARC record that might one day exist. Now derived from
  `PUBLIC_BASE_URL`'s host, making alignment a property of the code rather than of two literals in
  different files agreeing. That variable already decides every canonical URL, citation and
  unsubscribe link, so a deployment that gets it wrong is already visibly wrong in ways somebody
  notices — which is exactly what the From address was not. **This does not make mail deliverable**;
  the DNS records are an operator task and nothing in the codebase creates or checks one.
- **`MCP_ENABLED` was an exact `=== "true"` compare** and the generic legacy reader accepts
  `1|yes|on`. Routing MCP through the registry verbatim would have turned `MCP_ENABLED=1` into a live
  public endpoint. The test pinning the exact string was right.
- **The console's latency came from a constant copied frontend-side.** Now served from the loops' own
  constants, with a mutation test comparing against what a real consumer instance runs on rather than
  against the constant the route imported — the latter would pass just as happily against a hardcode.
- **`docs/STATUS.md`'s top extraction task pointed at a branch measured to fire zero times.**
  Retracted in place rather than deleted; silently absent text reads as never having been there.

### Drift, guarded

- **The frontend hand-mirrored the extraction failure taxonomy.** Adding a reason meant editing the
  backend list and two frontend copies, and missing either would have printed `undefined` to a reader
  on the public status page rather than failing a build. Now asserted in both directions, with the
  `unclassified` allowance derived from the backend's own declaration so the exemption cannot itself
  go stale.

  The lesson outlives the test: **a set-comparison guard needs a guard of its own.** Two empty sets
  are equal, so a regex that stopped matching turns the file green and blind in the same moment. A
  non-empty assertion on each scan caught a real fault on its first run.

### Operational traps, stated rather than implied

- **A kill-switched key can still be written.** The row can read `true` while the feature is off, so
  dropping `FEATURE_EVENT_DRAIN=false` from the deploy config later starts the drain with **no fresh
  decision**. Refusing the write would leave the console unable to record a decision at all.
- **A push that succeeds is not a push that ships.** `origin` is Gitea and drives the deploy;
  `github` is the public mirror CI does not use. A push to the mirror returns exit 0 and looks
  identical to a deploy trigger — check the printed sha range, not the exit code.
- **A validation that cannot distinguish "absent" from "the tool errored" measures nothing.**
  `docker compose config` appeared to drop all seven `FEATURE_*` keys; it was failing outright
  because `IMAGE_FRONTEND` is unset outside CI. The same shape as `nginx -t` being happy with three
  broken configs in this repository.

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
