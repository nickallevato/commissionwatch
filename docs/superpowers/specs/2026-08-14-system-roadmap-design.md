# CommissionWatch — System Roadmap

> **Status:** design of record for the next phase, 2026-08-14.
> Supersedes nothing; sits alongside `2026-08-04-commissionwatch-production-design.md`.
> Read `docs/STATUS.md` first for what is true right now.

**Operator mandate, in their words: "follow the law, push the tech."** Technical capability is the
bar — if we can build it, we build it. Where the law constrains us, the constraint becomes *data*
that a human verifies and the code reads, rather than a paragraph in a document nobody enforces.
That principle is what the regions module (§2) exists to implement, and it is why this roadmap
puts it before almost everything else.

The other governing sentence is the operator's framing of the product: it should **feel like a
system, not a web app**. Most of what follows is chosen because it makes the parts share one spine
rather than because each is individually attractive.

---

## 0. What landed on 2026-08-14, before this roadmap starts

Three commits on `fix/operator-guard-public-writes`. Recorded here because the rest of the plan
assumes them.

1. **Ten public writes closed.** `POST /api/anomalies` was unauthenticated and passed
   `alwaysHold: false` unconditionally, so a stranger could publish a finding naming a living
   official at the default threshold. Also `DELETE /api/anomalies/:id`, both detection routes,
   `/meetings/:id/detect-anomalies`, and all six writes on `members` and `votes`. A hand-entered
   finding is now held at every severity. **The Caddy IP allowlist must not come down until this
   deploys** — `STATUS.md`'s "B3 no longer blocks going public" was written without knowing this.
2. **`agents/meeting-monitor` deleted** after a module-by-module salvage check. Nothing survived.
   Three latent bugs recorded in the commit message, one of which — a `failed` motion rendered as
   `deferred` — was a "describe the record" violation.
3. **The crawler door opened.** `robots.txt`, a publication-walled sitemap generated from the
   database, and an nginx fix so a missing file 404s instead of returning the SPA shell with a 200.

---

## 1. The three findings that reorder everything

**a. The site was invisible, and the corpus is empty.** Fixed the first half above. The second
half stands: `/api/data` publishes **1 meeting, 0 votes, 0 findings**. Every distribution idea in
this document is blocked on there being a record to distribute. Extraction throughput (§5) is
therefore ranked above every delivery channel.

**b. We already have an LLM and a governor.** `services/extraction/` runs OpenRouter free-only with
`assertFreeModel` enforced in code; `verify.ts` rejects any claim whose quote is not byte-locatable
in the stored artifact, across seven adversarial checks. On the one real document it rejected
roughly half of what the model proposed. The work is to *harden and extend*, not to introduce.

**c. The meeting bot is unnecessary.** Bozeman's own Granicus server publishes timestamped WebVTT
transcripts at `bozeman.granicus.com/videos/{clip_id}/captions.vtt` — probed live, 9 of 14 sampled
clips returned real transcripts, one of them 5,480 lines. This is a published government file
fetched under the same posture as an agenda. **A bot joining a meeting is cancelled** (§6).

---

## 2. The regions module — "if we need paperwork, build it into the regions module"

**The idea.** Everything that varies by jurisdiction and carries a legal or reputational
consequence becomes one verified, dated, per-region record. Today those facts are scattered across
a database table, three code constants, a code comment, a Methodology paragraph and an operator's
memory. Scattered facts drift, and the ones here are the ones that get us sued or blocked.

**What it absorbs**, all of which exist today in the wrong place:

| Fact | Where it lives now |
|---|---|
| Records-law citation, response deadlines, custodian | `jurisdiction_records_law` (right idea, too narrow) |
| robots.txt posture and the disclosed exception | a code comment, a Methodology paragraph, `respectRobotsTxt` |
| Crawl delay, user agent, concurrency | constants in `ingestion/adapters/http.ts` |
| Which bodies exist | `GALLATIN_BODIES` / Bozeman's list, hardcoded, known stale |
| Why a source is disabled | `ingestion_sources.disabled_reason` |
| Vendor platform | nowhere — inferred by whoever is reading |
| ToS / clickwrap posture | nowhere |

**Design.** A `regions` record (extending `jurisdictions` rather than replacing it) carrying:
statutory citation + URL + `acknowledge_days` / `respond_days` **nullable**, custodian contact,
vendor platform enum, crawl policy (delay, UA, concurrency, robots posture + disclosure
requirement), body list, and `verified_on` / `verified_by`.

Four rules that make it worth building rather than being a bigger table:

1. **Nullable means "no such obligation", and the letter then states no period.** P7 already
   refuses rather than guessing; that refusal generalises.
2. **A region with a stale `verified_on` degrades loudly** — the console warns, and `/status`
   publishes the verification date. A legal posture nobody has re-read in a year is a claim we are
   still making.
3. **The disclosure is enforced by the code that relies on it.** If a region asserts a robots
   exception, the Methodology page must render it; a test fails if it does not. The exception is
   valid only while disclosed — that is already this project's stated position, and this makes it
   structural instead of remembered.
4. **Adapters read policy at sweep time, not construction time.** This is what unblocks the
   long-declined "move the body lists into config" item, whose real obstacle was that
   `createDefaultRegistry()` is synchronous and database-free.

**Known correction to fold in.** MCA 2-6-1006 was rewritten effective **2026-07-01**; the
(Temporary) version `STATUS.md` cites terminated 2026-06-30. The replacement reportedly splits on
"local government" and leaves cities and counties with **no numeric deadline at all**, and
§2-6-1006(1)(d) reportedly means **no right to a machine-readable format**. *Reported by research,
not verified by a human.* Filling `jurisdiction_records_law` was always specified as a task a
person does and signs; that stands, and now they must also confirm which edition they are reading.

**Effort: L.** Highest-leverage structural change in this roadmap.

---

## 3. Cohesion — the event spine

**Diagnosis: there is no spine.** One in-process `EventEmitter` with a single emitter and a single
subscriber; every surface queries Postgres independently. Adding Discord today means writing
another database consumer, and the publication wall is re-enforced in eleven places.

**The parts already exist and point the wrong way.** `deliveries` + `channel_routes` +
`resolveRoutes` + real retry/backoff is an event bus. What is missing: (a) `DeliveryDispatcher` is
never constructed by the server — its only live caller is a CLI script; (b) events are not
persisted, so they cannot survive a restart or be replayed; (c) not every surface consumes it.

**The rule that makes it safe** is already true in code: *an event is emitted only for a
`published` object*. Then no consumer needs its own publication check, and "the wall is enforced in
eleven places" becomes "enforced once." Everything in §7 attaches here.

**Vocabulary, chosen now because rename cost is linear in surfaces.** `finding` (not anomaly, not
flag), `official` (not member), `meeting`, `document`/`artifact`, `source`. Today the list is at
`/members` while the page says "Officials" and the detail page is `/officials/:id`; the nav says
"Findings", the URL says `/anomalies`, the headline says "Flagged for review", and the body copy
says "nothing here is a finding." Enforced by a test in the existing idiom — `chrome-links.test.tsx`
already walks the nav, and `MethodologyPage.test.tsx` already asserts forbidden wording is absent.

**Provenance components, one implementation each**: `<Citation>`, `<Digest>`, `<SourceLink>`,
`<ConfidenceChip>`, used by both the public site and the console. Precedent and reasoning already
set by `MatchQuality.tsx`, extracted precisely so the public and the operator can never be told
different things about the same stored band.

---

## 4. The LLM governor

**Free-only through prototype and development, per operator decision; production moves to a paid
model later.** The design must therefore make the model a swappable pin, not an assumption —
`complete()` already records which model actually answered, which is what keeps that honest.

```
artifact (bytes, sha256)
   │   SPAN CONTRACT: every downstream object is (sha256, offset, length) or it cannot exist
   ▼
PASS 1 extractor  →  MECHANICAL GATE  →  PASS 2 governor  →  OPERATOR REVIEW
(cheap, free)        (verify.ts,          (adversarial,      (approve/reject
 proposes claims      deterministic,       different model,   + reason)
                      no model)            spans only)
```

- **The mechanical gate stays deterministic forever.** `quote-not-found` is *decidable*; no model
  may soften it. This is what makes a weak, free extractor acceptable — its failure mode is low
  yield, not a wrong record.
- **The governor is a judge, never an author.** It sees the ±2,000-character window and the claim
  triple, never pass 1's reasoning and never the whole document. Output is a constrained verdict
  with an `unsupported_fragments` array that forces it to *point*, which makes the verdict itself
  auditable. It never rewrites a claim: rewriting is generation, generation is unverifiable, and
  the architecture rests on the model never authoring a published sentence.
- **Hallucinated-name detection is mechanical, not LLM.** Resolve to a `members` row or to an
  office the minutes print. Never ask a model whether a name is real.
- **Severity is a deterministic table.** A model may propose; a proposal is `alwaysHold: true`. A
  model may never lower a hold.
- **The governor's own output is scanned** with the same `motiveTerms` lexicon its input was. A
  judge that editorialises has stopped judging.

**Open defects this must clear:** ~20% of every document is unread (`OpenRouter returned no
message content` on two of nine chunks — start by widening the error to report `finish_reason`);
there is no claims review screen at all, though `minute_claims.status`, `reviewed_by`,
`review_reason` and `reviewed_at` all exist; and **what a published claim about a named person
looks like is genuinely undecided** and deserves its own spec rather than an `if (approved)` in a
template.

**Do not build generated narrative prose.** Prose smooths — it turns three cited facts and one
unsupported inference into four sentences that read identically. If a paragraph is wanted, assemble
it from verified claims with deterministic code. This is also the honest disposition of the now-
orphaned `rundown_sheets`: the narrative returns on the reviewed-claims path, or the table is
retired. It does not come back as string concatenation.

---

## 5. Corpus — the actual bottleneck

1. Fix the empty-content chunks (above). Until then every run is honestly but permanently `partial`.
2. **Batch extraction as a queue stage, not a loop in a route.** Each run costs minutes against a
   rate-limited free model; `isExtracting` guards only per-meeting concurrency.
3. **A sourced roster.** `members` holds "Avery Sample" and "Riley Fixture", and those have reached
   a page before. This is the linchpin for `member_id`, claim↔vote linkage, and the shared entity
   model — "person" is currently four disconnected mentions, not an entity. **Probe for a source
   before designing**; no roster could be found on 2026-08-11.
4. **A `VoteEvent` wrapper.** `votes` is per-member rows with no motion text, result or counts —
   so **"the motion failed 2–3" is not currently a first-class fact in the database.** Worth fixing
   on its own merits, and it happens to be what an OCD-shaped export needs.

---

## 6. Transcripts — the capability that replaces the meeting bot

**Option A, and only A: fetch the custodian's published captions.** `classifyGranicusDocument`
returns `null` for `MediaPlayer.php` today, correctly, because a player is not a file. The fix is
to emit the `captions.vtt` URL as a new `transcript` document kind. Everything downstream already
works: content-addressed storage, `document_versions`, `artifact_texts`, full-text search, and
`verify.ts`'s byte-offset citation.

- **Handle the empty stub honestly.** 5 of 14 sampled clips returned 8 bytes. "They published
  nothing here" and "they published an empty transcript" are different statements — record
  `transcript_absent`, exactly as the MT CERS `cf_empty_body` distinction taught.
- **Immediate reader win:** `/search` currently tells readers only agendas are body-searchable.
- **Speaker attribution anchors on the minutes, never on audio.** The `>>` marker is a CEA-608
  *change* marker, not an identity. `verify.ts`'s office-gating and direction-carrying action cues
  already solve the hard half of this.

**Rejected, with reasons recorded so nobody rebuilds them:** capturing the HLS stream (CloudFront
403 to a plain client — working out what the player supplies lands on the SKILL.md hard line); a
bot joining the call (Granicus is not a joinable platform, it manufactures a consent question that
Option A does not have, and it produces a *worse* transcript than the custodian's); ASR (only for
a body that publishes video without captions — and an ASR transcript is *our* artifact, so a claim
cited to it is cited to us, which the citation must then say).

**Gallatin's broadcast route is unknown.** Probe before designing.

---

## 7. Delivery — ascending order of risk

Operator picked all four, RSS first, and asked for two more.

1. **RSS/Atom** — zero consent law, zero bounces, zero suppression list, zero deliverability fight,
   zero PII. Proves the spine at the lowest possible stakes. Also the free route into Slack
   (`/feed subscribe`, first-party) and Discord (MonitoRSS).
2. **Discord** — webhook, **not a gateway bot**. A webhook posts; it holds no message-read scope
   and cannot be prompt-injected by anything a user types. Mostly built already.
3. **Outbound email digests** — requires, in order: the `email_status = 'sent'` lie fixed (the
   scheduler runs daily in production against a dry-run sender), a suppression table *before* first
   send, `List-Unsubscribe` headers, and the one-commit cutover `STATUS.md` specifies — moving
   email onto the dispatcher and dropping `alert_subscriptions` together, because splitting it
   double-sends.
4. **Inbound email** — mirror `routes/sms.ts` exactly, signature verification included. A
   `subscribe@` mailbox makes double opt-in *structural*: sending from an address is better proof
   of mailbox control than any confirmation link. Also: `POST /api/alerts` currently returns the
   `verify_token` in its 201 body, so anyone can subscribe *and* verify an address they don't read.

**Surprise channel 1 — the query is the subscription.** A saved search gets a permanent feed URL:
`/feed?q=short-term+rental`. No account, no email, no PII, no consent regime, no suppression list —
the subscription *is* the URL, and losing it costs the reader nothing but a re-search. It also
gives every advocacy group, reporter and neighbourhood association their own private wire without
us holding a list of who cares about what. This is the cheapest possible answer to "how does a
resident follow the one thing they care about", and it fits the project's collect-nothing posture
better than any subscriber table.

**Surprise channel 2 — the weekly record receipt.** A dated snapshot of the published record, with
a manifest of sha256s, published to a public git repository. It answers "what did this site say in
March", which `/data` currently states outright is unanswerable. For a watchdog, being auditable
*about itself* is not a nice-to-have — it is what survives the first hostile question, and a
tamper-evident external copy is worth more than any assurance we could write. It doubles as an
offsite backup of the derived record and as a distribution surface other developers can diff.

---

## 8. Standards, distribution and the outside world

- **Adopt the Open Civic Data `Event` / `EventAgendaItem` / `VoteEvent` model as an export profile
  and naming discipline** — not a runtime dependency. Its `sources` array is `minItems: 1` on every
  object, which is *our* "no unsourced claim" invariant encoded as a validator constraint. Our
  schema has independently converged on it already. Vendor the JSON Schema and validate in CI, as
  OpenStates itself did. Caveat: OCD-the-organisation is dead; OCD-the-schema shipped a release
  two days ago inside `openstates-core`.
- **Do not adopt schema.org internally.** `Legislation` and `Claim` are pending, not core. Emit
  `Dataset` and `Event` JSON-LD **server-rendered** for Dataset Search and rich results — and not
  as an AI-citation play, which the evidence says is folklore.
- **Server-render the public pages.** One URL per meeting, agenda item and finding, real per-page
  title and description, absolute self-referencing canonical. Simultaneously the SEO play, the
  paste-worthiness play and the AI-citation play. Nothing substitutes for it.
- **The one peer-reviewed lever** (GEO, KDD 2024): cite sources, add quotations, add statistics —
  22–41% relative improvement each. *The discipline that makes our output defensible is the same
  discipline that makes it citable.* We are already built for this.
- **Firecrawl: skip.** Its differentiator is the managed anti-bot/proxy layer, which SKILL.md's
  hard line forbids; it returns markdown derivatives, breaking the sha256 provenance chain that is
  the product; it fetches as `FirecrawlAgent`, which would make our disclosed robots exception
  false; and it bills per fetch, discarding the ETag/sha256 dedup our pipeline is built on.
  **Spend the $20 on `BACKUP_S3_URI` instead** — there is currently no backup, only a copy.
- **Three adapters cover urban Montana**, not fifty: CivicPlus AgendaCenter, CivicClerk OData
  (Missoula, open, no auth), Granicus RSS. Two are built. Neither Bozeman nor Gallatin is a
  Legistar tenant (verified 500s). **Flathead County overwrites a single `agenda.pdf` with no
  history** — miss the week, lose the record. That is the argument for the artifact store being
  the actual product.
- **Shrink the robots exception.** Bozeman's RSS endpoint returns the same discovery data in 79 KB
  versus the 5.9 MB page we fetch today. If we set a robots file aside, do it for the smallest
  possible footprint on a machine-readable endpoint the vendor built to be consumed.
- **Ship 429 / `Retry-After` handling in `services/ingestion/`.** It exists in `delivery/sms.ts`
  and `extraction/openrouter.ts` but not in the crawl layer. Retain request logs: under
  *Intel v. Hamidi*, demonstrable non-impairment is a complete defence to trespass to chattels, and
  the logs are the evidence.
- **A `/bot` page** naming the user agent, a human contact, a copy-pasteable block snippet, and a
  standing offer to switch to any feed the agency prefers. This is the page you point a clerk at
  when they call. `bozeman.granicus.com/robots.txt` already allowlists a named non-Google crawler,
  `search-one-scgov` — so Granicus demonstrably adds per-tenant exceptions, and the ask is
  "you already publish this, your vendor blocks us, can we have a feed?"

**Positioning, and it is sharp.** Every Bozeman minutes PDF from ~clip 2775 onward now opens:
*"These meeting minutes were generated with the assistance of artificial intelligence and have not
been reviewed, approved, or adopted by the City Commission."* The city ships unreviewed AI
summaries as its official record; ours pass an operator review queue. **Lead with the review gate,
never with the AI** — a sceptic's first move is to lump us in with them.

---

## 9. Analysis quality

Current detectors are absolute-threshold keyword rules over columns. `checkLastMinuteAgendaChange`
is the strongest because it jumped from strings to the extracted record with cited hashes;
`checkUnanimousControversial` is the weakest and will bury the review queue with false positives —
a unanimous vote on a zoning item is the *normal* case.

Three structural moves, then the new signals:

- **Detect on the extracted record, not on strings.** The `minute_claims` path is the vehicle.
- **Add a baseline.** 339 Bozeman meetings across 2013–2026 is enough for a per-body base rate. A
  rule that fires on departure from a body's *own* pattern is more useful and more defensible.
- **Report the denominator.** "3 items added within 48 hours" without "out of 27, on a body that
  averages 1.2" is a number without a scale. That is the difference between a watchdog and an alarm.

New signals, cheapest first: consent-agenda volume and consent-to-discussion ratio (no new data —
and the single most-reported local-government story archetype); packet-to-decision gap (reuses the
`document_versions` evidence discipline); attendance and abstention patterns; public-comment volume
vs outcome (needs §6); repeat-deferral and item threading; cross-body contradiction across
Bozeman's 16 bodies.

**And measure the queue.** Median time-to-decision, approval rate by rule, findings per sweep.
Without it we cannot tell whether a detector is producing signal or burying the operator.

---

## 10. Tests, look and feel

**Tests, by risk:** `errorHandler.ts` has *zero* test references and decides what an unhandled
exception leaks to an HTTP client. `storage.integration.test.ts` runs in no CI job — that is the
MinIO path behind every citation. There is no pure-unit tier, because `pretest` runs migrations
unconditionally, so 17 database-free files cannot run without Postgres. `rate-limit.ts` is the
abuse control on the only unauthenticated write and is tested only transitively.
`export/manifest.ts` has no direct test and is what makes the bulk download verifiable. No
accessibility assertion exists anywhere. Frontend hooks are untested, including `formatSweepAge`,
whose entire design purpose is not to assert an invented age.

**Look and feel.** The token layer is genuinely good and should not be touched — editorial palette,
tabular numerals, hairline rules, and a `.cite` chip used 41 times across 15 files, which is the
most consistent thing in the frontend and the right thing to have made consistent. The defects:
six public pages open with `<h2>` and have no `<h1>` at all; no focus management on route change;
tables never reflow (one responsive-hiding rule in the whole codebase, so vote records are
horizontal-scroll-only on a phone — exactly what someone checks during a meeting); and
`tailwind.config.ts` declares `darkMode: "class"` while nothing ever adds the class.

**Delete the dead dark-mode config and keep the light editorial identity.** A committed look is
more credible than a half-built theme, and the `--cw-*` custom properties mean a later dark mode is
a token swap, not a rewrite.

**The deepest issue: the operator console is better-built than the reader's site.** `PressroomUI`
is a real component library; public pages re-declare class strings inline, and `Layout.tsx` defines
its own local `focusRing` rather than importing the shared one. For a public-transparency project
that is backwards. Extract the primitives to `components/ui/` and have both tiers import them.

**One empty-state grammar.** Absence is this project's most-rendered state and its most dangerous
to render wrongly — `NO_FINDING_YET`, "0 agenda items" split into five distinct sentences, "Not
recorded" deleted when it described our schema gap rather than the custodian's record. Codify it:
`<Absence kind="not_run" | "empty" | "withheld" | "no_source" />`.

---

## 11. Order of work

**Tier 0 — operator actions nobody can delegate.** Deploy the security fix before the allowlist
comes down. Install the external-monitor cron (nothing periodically checks the site today). Set
`BACKUP_S3_URI`. Rotate the superseded OpenRouter key. Read the statute and fill the region record.

**Tier 1 — foundation.** Regions module (§2). Event spine (§3). Vocabulary pass + enforcement test.
Test tier and the `<h1>`/axe fixes. Shared provenance components.

**Tier 2 — corpus.** Empty-chunk fix, batch extraction as a queue stage, roster probe, `VoteEvent`.

**Tier 3 — transcripts.** Gallatin probe, `transcript` document kind, VTT into search, then a
second extraction target citing `(transcript_sha256, offset)`.

**Tier 4 — the governor**, then the claims review screen, then the published-claim spec.

**Tier 5 — delivery**, in the order given in §7. RSS and the query-feed first; email last.

**Tier 6 — reach.** Server rendering, OCD export, `/bot` page, the record receipt, the three
outreach emails (Montana Free Press has city newsletters for four Montana cities and none for
Bozeman; Agenda Watch does this product and has never covered Montana; the Chronicle has four
general-assignment reporters and no city-hall beat).

---

## 12. Decisions still open

1. **What a published claim about a named person looks like.** Highest-stakes thing this project
   would publish. Needs its own spec.
2. **Whether email happens at all**, given RSS + the query feed + Discord cover delivery with no
   consent regime, no PII and no deliverability fight. Operator has said yes; worth re-asking after
   the query feed ships, because it may turn out to be unnecessary rather than merely last.
3. **`rundown_sheets`: revive on the claims path, or retire the table.**
4. **Who the product is for.** No one has demonstrated *residents* paying for local meeting alerts
   — every civic nonprofit that built keyword alerts killed the feature, while two funded companies
   sell it profitably to realtors, homebuilders, law firms and GR teams. Worth deciding
   deliberately rather than discovering in year two.
