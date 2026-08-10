# CommissionWatch — Status, Gaps and Next Steps

> Last updated: 2026-08-10, after landing **B3 — the public corrections log and the dispute
> route**, which was the last build gate on making this site publicly reachable. Earlier the same
> day: the **findings review queue** (B-a and B-b's
> replacement) — the change that made publishing a finding possible at all. Earlier still:
> the **public status page** and a sweep of the known defects; and before those: P7 (the public-records request generator), P5 (the agenda diff
> timeline) and P6 (full-text search).
> Previously the same day after P2 (the Pressroom console) and the deploy healthcheck fix, and
> 2026-08-09 after P1 (ingestion scheduling), P3 (backups) and P4 (the Bozeman Granicus adapter).
> Read this before starting work. It records what is true, not what was planned.

## Archive salvage — what has landed

Working from `docs/superpowers/specs/2026-08-09-archive-salvage-design.md`.

| Item | State |
|---|---|
| A4 · `vote_donor_conflict` anomaly type | **Landed.** Migration 020. The enum carries seven values. |
| A2 · OpenFEC client | **Landed.** Migrations 021, plus `HttpCache` and `OpenFecClient`. No orchestration framework came with it. Needs `OPENFEC_API_KEY` to make a live call; every test is fixture-based. |
| A1 · Operator authentication | **Landed.** Migrations 022–023, scrypt passwords, server-side sessions in an httpOnly cookie, `/api/admin/*` closed by default, CORS split. |
| A3 · Embedding client | **Withdrawn.** Nothing consumes embeddings; see the spec. The want underneath it — *find me everything about this* — is answered by P6's Postgres full-text search instead. |
| B-e · Subscriptions and delivery | **Landed.** Migrations 024–025. A subscription is a destination, a filter and a cadence. SMS added with consent and a per-day cap. |
| B-a · Review queue | **Landed 2026-08-10.** Migration 038. `approval_requests`, a single severity threshold in place of `execution_policies`, claim-to-citation binding, and operator approval as the only thing that makes a finding public. See below. |
| B-b · Execution policies | **Collapsed, as specced.** Replaced by `review_policy` — one row, one threshold. Not ported. |
| B-d · Records requests | **Landed.** Migrations 026–027. A hand-obtained document takes the identical path as a scraped one, and records-derived flags are held, never published. |

**The dispatcher still sends no email.** That is deliberate and load-bearing.
`alert_subscriptions` is retained read-only for one release and the legacy
`EmailDeliveryService` remains email's only sender, which is what makes B-e's
back-fill of those rows onto `delivery_channels` incapable of double-sending.
`test/subscriptions-unified.test.ts` asserts it. Cutting email over to the
dispatcher and dropping `alert_subscriptions` is a separate change, and the two
must happen in the same commit.

Per `CLAUDE.md`, nothing in the delivery layer sends product events yet — including SMS. The
substrate exists. **The review queue landed 2026-08-10** (B-a, below), so the gate it was waiting
on is now built; cutting delivery over to published findings is a separate, deliberate change, and
the notification path is already filtered so a held finding can never be sent.

**There is no operator account until one is seeded.** The backend creates the first
operator at boot from `OPERATOR_SEED_EMAIL` / `OPERATOR_SEED_PASSWORD` /
`OPERATOR_SEED_NAME`, once, and only while `operators` is empty. Those reach the container
from `/commissionwatch/env` in Parameter Store like every other secret. Clear them after the
first boot: leaving them set does nothing except keep a password in the environment. Without
them the admin console exists and cannot be entered, which is the correct default.

`ADMIN_ORIGINS` gates credentialed requests to `/api/admin`. The public read-only API stays
open to any origin — that is deliberate, and open data is the point.

## P2 — the Pressroom console has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P2 and
`docs/superpowers/plans/2026-08-10-pressroom-console.md`. Migrations 030–033.

Three operator screens behind `requireOperator`: `/admin/sources`, `/admin/runs/:id`,
`/admin/meetings/:id`, served by `/api/admin/pressroom/*`.

**`ingested` and `published` are now different states.** `meetings.published_at` exists, and a
meeting with `published_at IS NULL` **does not appear in any public API response** — ten public
paths take a meeting id and a test walks all ten. Existing rows were backfilled to `created_at`,
so nothing that was public stopped being public. **Rows ingested from here on default to NULL**:
a sweep produces a candidate, an operator produces a publication, and the seed sets the column
explicitly because seed data demonstrates the public record. An unpublished meeting 404s rather
than 403s, so nobody can enumerate what has been ingested and withheld.

**Corrections are append-only, in the database.** `record_corrections` records who, when, field,
old, new and why, and a trigger raises on `UPDATE` and on `DELETE`. **The artifact is never
mutated** — a test hashes the `artifacts` row either side of a correction. The table has no
foreign key to its target and none to `operators`: a cascade from `meetings` would collide with
the trigger on every `pretest` seed, and `ON DELETE SET NULL` is itself an `UPDATE` the trigger
forbids, so the actor is snapshotted as `operator_email`. **A consequence: tests cannot clean up
`record_corrections`.** Rows accumulate in the test database, keyed on ids each run generates.
That is intended, not a leak.

**Confidence is per field.** `agenda_items.field_confidence` is a jsonb map of
`{ level, reason }` per column, written by the extractor: a title truncated by the
255-character column, an item with no section heading above it, a description cut at its limit.
Seven good items and one mangled one is not a low-confidence meeting.

**Silence is watched, and zero is a failure state.** A source past its own
`expected_interval_hours` since its last success reads *Suspect*. Lifetime ingested records is
computed from every run's `counts` and renders in the failure colour at 0. Disabled sources stay
listed with `disabled_reason`, seeded from the adapter's own notes — the Akamai block on
`bozemanmt.gov` is now in the console rather than in a code comment.

**Re-parse without re-fetching** opens a *new* `ingestion_runs` row and queues one `parse` job
per stored artifact. It cannot reach the network: parse targets carry a `sha256`, the queue
rejects a post-fetch target carrying a `url`, and the parse stage has no path back to a URL. It
is a separate action from "sweep now".

The two action routes need the live queue and scheduler, handed over by
`registerPressroomStack` from `index.ts`. **In a process where ingestion is not running they
answer 503**, which is why the test suite sees 503 rather than a constructed MinIO client.

Counts after P2: backend **660 tests / 168 suites**, frontend **180 / 25**, both green, zero
lint errors.

## P5 — the agenda diff timeline has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P5 and
`docs/superpowers/plans/2026-08-10-agenda-diff-timeline.md`. Migration 034.

**`meeting_documents` and `artifacts` are joined at last.** `document_versions` carries
`(meeting_document_id, artifact_id, version_no, first_seen_at, item_snapshot)` with a unique
constraint on each of the first two pairings. The fetch stage writes a row on **every** successful
fetch and lets the constraints decide: unchanged bytes resolve to the same artifact and collide,
changed bytes create exactly one version. There is deliberately no "have I seen this before?"
branch anywhere — that question and the content address can disagree, and then only one of them is
the record.

**The backfill produced 19 version rows for the 19 existing artifacts** — 11 Gallatin, 8 Bozeman —
all version 1, no artifact left unattached. It takes two passes, and the second one is the point:
matching `artifacts.source_url` to `meeting_documents.url` covers Gallatin and **misses Bozeman
entirely**, because Granicus redirects `AgendaViewer.php` to an S3 attachment and `source_url`
records where the bytes actually came from. The second pass goes through the `parse` job the fetch
stage enqueued, whose target carries the sha256, the meeting and the document type. A URL join
alone would have backfilled two thirds of the record and reported success.

**The diff is over extracted agenda items, never bytes.** Two renderings of an identical agenda
differ in their creation timestamp and generator string. `document_versions.item_snapshot` holds
what was extracted from *that* artifact, because `agenda_items` cannot answer for a superseded
version — it is merged on `(meeting_id, item_number)`, so parsing version 2 overwrites version 1.
A NULL snapshot means "not extracted" and renders as that, never as an empty agenda.

**`last_minute_agenda_change` can finally be substantiated, and the heuristic that faked it is
gone.** The old `checkLastMinuteAgendaChange` compared `agenda_items.created_at` — the moment *we*
ingested a row — against the meeting date, so any meeting swept the day before it convened flagged
every item on its agenda as added within 24 hours. That was a statement about our own database
published as a statement about the public record. It now compares two published documents, and the
evidence carries **both artifact hashes** and the changed item list. `RULES_VERSION` is `3.0.0`.

**Two schema facts the spec did not have.** `meetings` has no `scheduled_at`: it has a `DATE` and a
nullable `TIME`, and a meeting with no published time raises nothing rather than being assumed to
convene at midnight. And the wall time needs a zone — `jurisdictions.timezone` (default
`America/Denver`) was added with `agenda_change_window_hours` (default 48), because composing the
instant in the server's zone would make a published "19 hours before" quietly wrong by six or seven.
`MeetingRef.timezone` has been in the adapter contract since P1 and was discarded on the way to the
database.

**A flag whose changed items name someone on the roster is written `held`.** The public API already
filters `review_state`.

`GET /api/meetings/:id/agenda-diff` is behind `findPublishedMeeting` and is now the eighth public
meeting path `meeting-publication.test.ts` walks. On the meeting page,
`AgendaDiffTimeline.tsx` renders a two-column diff, each side labelled with its version's
`first_seen_at` and short hash. **The one-version case — the common one — renders as a single calm
sentence**, not an empty comparison and not a "no changes" badge, which would assert the result of
a comparison that never happened.

Counts after P5: backend **703 tests / 176 suites**, frontend **196 / 26**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

**One trap this introduced.** `document_versions.artifact_id` has no `ON DELETE CASCADE`, on
purpose — a version row losing its evidence silently would leave a citation pointing at nothing.
So a fixture teardown must drop meetings *before* artifacts, since the meeting cascade is what
releases them. `ingestion-handlers.test.ts` had the opposite order and failed loudly, which is the
constraint working.

## P6 — full-text search has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P6 and
`docs/superpowers/plans/2026-08-10-full-text-search.md`. Migration 035.

**This is the honest replacement for the withdrawn embedding work**, not a step towards it.
PostgreSQL answers *find me everything about this* with no vendor, no API key, no per-call cost and
no dimension decision. `document_embeddings` and `vector(1536)` are untouched, and if
exact-and-stemmed search proves insufficient in practice, *that* is the evidence that would justify
revisiting embeddings — with a requirement attached.

`GET /api/search?q=` is public and unauthenticated, paginated, and returns results discriminated by
`kind`: `agenda_item`, `meeting`, `member`, `document`. `websearch_to_tsquery` takes quoted phrases
and `-exclusions`; `ts_headline` returns the matching sentence.

**Search is the only public surface that could walk straight through the publication wall.** Every
other path takes a meeting id, so a reader who cannot guess one cannot reach a withheld record.
Search takes a *word*. Every meeting-derived query goes through `whereMeetingPublished` — which
gained an optional column argument so a joined query can name `m.published_at` rather than leave
`published_at` to become ambiguous — and `search.test.ts` asserts the wall **in both directions**:
an unpublished meeting, its agenda items and its document text are absent, and publishing the
meeting makes all three appear. Absence alone also holds for a search that returns nothing at all.

**Two schema facts the spec did not have.** `meetings` has no `title` — its only free text is
`location`, which is a venue and not a title, so it takes weight `B` and nothing in that table earns
`A`. The name a reader calls the sitting is `commissions.name`, and a `GENERATED ALWAYS` column may
not reference another table; the commission name heads the *result* instead, which is display and
not the index. And **nothing held the extracted text of an artifact**: the parse stage discarded it
once agenda items had been read out, so the body of every document — where most terms appear — had
no column to index. `artifact_texts` holds the text and its vector in the same row, which is what
makes the generated column legal at all.

**Only agendas are searchable by body.** `parse` returns early for minutes and packets, so their
contents are stored and citable but not extracted. The search page says so rather than letting a
reader who finds nothing wonder whether that is the record or the pipeline.

`ts_headline` marks matches with **control characters, never `<b>`**. The text being highlighted came
out of third-party PDFs and HTML; returning markup for the page to inject would be an XSS hole
opened for a typographic effect. `SearchPage` splits on the delimiters and builds `<mark>` elements.

**Deliberately not built**, and named in the plan rather than silently omitted: fuzzy matching,
synonym expansion, semantic similarity, and per-user search history. One known limitation is
recorded too — concatenating weighted vectors with `||` shifts positions, so a phrase query can
match across a title/description boundary. It is an occasional over-broad hit, never a leak.

An empty or stopword-only query answers **200 with an empty list**, as does an empty database. With
production holding zero rows, that is the ordinary case here rather than the edge one.

Counts after P6: backend **721 tests / 177 suites**, frontend **211 / 27**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## P7 — the public-records request generator has landed, and it refuses

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P7 and
`docs/superpowers/plans/2026-08-10-records-request-generator.md`. Migration 036.

### ⛔ BLOCKING OPERATOR TASK — `jurisdiction_records_law` is empty, deliberately

**Nobody can draft a records request for Bozeman or Gallatin County until a person reads a
statute.** The table ships with no rows and the generator refuses rather than guessing, so the
feature is complete and inert. This is the intended state, not a defect.

What has to happen, once, by a human:

1. Read **Mont. Code Ann. § 2-6-1006** at `mca.legmt.gov` — Title 2, Ch. 6, Part 10. Section URLs
   map the last digit ×10, so §2-6-1006 is `section_0060/0020-0060-0100-0060.html`.
2. Find the subsection that governs **local governments**. The figures everyone quotes —
   acknowledge within 5 business days, respond within 90 days, requester has 30 days to answer a
   clarification — are stated for *"an executive branch agency"* and *"a public agency that is not
   a local government."* **A city and a county are neither.** A letter citing "5 business days" to
   Gallatin County would assert an obligation that does not apply to it.
3. Note that §2-6-1006 and §2-6-1009 are both marked **(Temporary)** in the 2025 edition: they
   carry effective and termination dates and will be superseded.
4. `INSERT` one row per jurisdiction with `statute_citation`, `statute_url`, whichever of
   `acknowledge_days` / `respond_days` the subsection actually establishes (leave them NULL if it
   does not — the letter then states no period, which is the honest output), the custodian if
   known, `verified_on` = the date you read it, and `verified_by` = your operator id.

**Do not seed this table from the figures above.** They are in migration 036's comment as the
example of the failure, right next to a paragraph asking you not to. Seeding them would make the
feature appear to work while producing letters that are confidently wrong, which is worse than the
feature not working at all.

`/admin/records` shows the state of every jurisdiction, and warns when a `verified_on` is more than
a year old.

### What was built

**The generator drafts; it never sends.** It produces letter text and, on the operator surface
only, a `records_requests` row in `draft`. There is no email path, no dispatcher call and no queue
write anywhere on the P7 path. Two tests hold that: one reads every file on the path and fails on
an import from `services/delivery`, `email-delivery`, `services/notification` or `resend`; the
other counts `deliveries` and `notifications` either side of a generation on both surfaces. The
application must not transmit legal correspondence on anyone's behalf, and the operator sending it
themselves is also the only arrangement under which the letter is honestly theirs.

**Gaps are derived, never listed.** Four queries: a `completed` meeting with a past date, no
`minutes_url` and no `minutes` document; an agenda item whose text names an exhibit, attachment,
appendix or enclosure where the meeting holds no `attachment`/`packet`/`resolution`/`ordinance`
document; a source with `enabled = false`; a `fetch` job in `failed` or `blocked` whose target
carries a URL. Nothing enumerates a jurisdiction, a meeting or a source, so a new commission
appears without a deploy and a filled gap disappears without anyone pruning a list — the test
checks the same meeting before and after its minutes arrive.

**Two of the four kinds are operator-only.** A disabled source and an incomplete fetch describe
*our ingestion*, not the public record; publishing them would present our operational state as
though it were the county's. The other two pass through `whereMeetingPublished` in public scope,
and the gap id a caller hands back is re-resolved in the same scope — so an operator-scope id is
not a way through the wall. Asserted in both directions, withheld then published.

**`letter.ts` is a pure function**: no database handle, no clock, no I/O. That is what lets the
public and operator surfaces be proved identical by **string equality** rather than by inspection.

**The letter alleges nothing.** Every gap kind is rendered and scanned against a list of
accusatory terms — failure, delay, refusal, withheld, wrongdoing, and twenty more. A request is
not an accusation. (The scan is word-bounded: "late" must not match "related", or the test would
be forbidding English rather than accusation.)

`GET /api/public-records/gaps` and `POST /api/public-records/letter` are public and write nothing.
`GET /api/admin/records/gaps`, `/law` and `POST /draft-request` are behind `requireOperator`;
`draft-request` writes the row. Both refuse with **409** — the caller's request is well formed, our
record is incomplete, and saying so is the point.

### Three corrections to the spec

- **The fee paragraph carries no citation.** The spec asked for "a fee-waiver request where
  applicable under § 2-6-1006". That section is the fee section, and its fee provisions carry the
  same local-government split as its deadlines. So the letter *asks* for a waiver — a request needs
  no legal authority — and asserts no entitlement to one. When a jurisdiction's fee provision is
  verified it belongs in `jurisdiction_records_law`, not in a string literal.
- **Mockup screen 06's "statutory guide" figure was invented**, as the spec already recorded.
  `response_due_at` is now set only when the jurisdiction records a response period; an unknown
  deadline renders as no deadline, never as a plausible number.
- **`jurisdiction_id` is the primary key** of `jurisdiction_records_law`, not a plain foreign key.
  The absence of a row is the refusal condition, so making it the identity means "is there a law
  row?" cannot find two disagreeing answers.

### One trap this introduced

`listJurisdictionLaw` left-joins the law columns onto `jurisdictions`. Selecting
`law.jurisdiction_id` alongside `j.id as jurisdiction_id` makes the **second** column win in the
row object, so every jurisdiction *without* a law row came back with a null id and vanished from
the console — the exact rows the console exists to show. The law select deliberately omits
`jurisdiction_id` and the caller supplies it.

Counts after P7: backend **782 tests / 202 suites**, frontend **222 / 28**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## The public status page has landed

Working from `docs/superpowers/plans/2026-08-10-public-status-page.md`. Migration 037.

`/status` is a read-only public projection of `/admin/sources`, reading `ingestion_sources` and
`ingestion_runs` through `GET /api/ingestion/sources`. It is unauthenticated: it describes *our*
ingestion, not anybody's record, and the people this project reports for are the people entitled to
know whether it is working.

**Every figure is a query.** There is no maintained list on the page. A status page kept by hand is
a status page that lies eventually, which is precisely the failure this project exists to find in
other people's publications.

**The judgements are reused, not reimplemented.** `assessSilence` and `assessVerdict` come from
`services/pressroom/sources.ts` unchanged; `services/ingestion-status.ts` is a pure narrowing over
`listSources`. A judgement written twice is a judgement that will disagree with itself, and the
console and the public page must never render different verdicts for the same source.

**The projection publishes figures and never text.** `ingestion_runs.error` and every run id stop
at the console. That error string is written by whatever threw and routinely carries a document URL
— and a Granicus URL carries a meeting title in its query string. So the public row says a run
recorded three failures; it does not say what they said. `test/public-status.test.ts` builds the
worst case deliberately — an unpublished meeting, an agenda item under it, and a run whose error
quotes both — and asserts none of it survives, then hits `toPublicSource()` directly with a hostile
row so the narrowing is proved by construction rather than by the fixture happening to be innocuous.

**Nothing is filtered.** A never-run source says Never run. A disabled source is listed with its
`disabled_reason` in the open rather than behind a disclosure, because this is the page where "why
is Bozeman missing?" gets answered. An absence you can see is a commitment; an absence you cannot is
a quiet failure.

**Migration 037 registers MT CERS** so the page can show it. The page may only show what the table
holds, and a source we committed to and never built is exactly the absence requirement two is about.
`jurisdiction_type` gains `'state'` — a statewide filing system is neither a city nor a county, and
typing it as one to dodge an enum change would put a false claim in the column the whole page
derives from. PostgreSQL will not *use* an enum value added in the same transaction, so 037 runs
with `config = { transaction: false }` and every statement in it is safe to re-run.

**One trap.** `seeds/001_pilot_data.ts` deletes every `jurisdictions` row and `ingestion_sources`
cascades from it, so 037's rows are absent on a seeded development or test database. That is
pre-existing seed behaviour, not something this change introduced, and it is why the status-page
tests build their own fixtures. Production is never seeded, so the row survives where it matters.

The Methodology page's promise of a per-source table "when the ingestion registry ships" is now a
link to `/status` rather than a paragraph explaining its own absence. The robots.txt disclosure
itself is untouched — it is summarised on `/status` with the sentence that **the exception is valid
only while it is disclosed**, and tests on both pages fail if either wording is removed.

Counts after the status page and the defect sweep: backend **795 tests / 203 suites**, frontend
**297 / 32**, both green. Backend lint: **2 warnings, 0 errors** — both deliberate, see Known
defects. Frontend lint: **0 problems**, down from 10 warnings.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## B-a — the review queue has landed, and a finding can be published

Working from `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` §§ B-a and B-b, and
`docs/superpowers/plans/2026-08-10-review-queue.md`. Migration 038.

**Until this landed the product could not publish a finding at all.** No code path anywhere set
`anomaly_flags.review_state` to `published`, so records-derived and person-naming flags were
written `held` and stayed held forever. The invariant "nothing naming a person auto-publishes"
was enforced by there being no publish path. Safe, and useless.

`approval_requests` is the archive's table with four changes. The reviewer is an `operators` row,
not a generic `users` one — there is no `users` table here. `requested_by_agent_id` is **dropped**:
it referenced `agent_registry`, part of the orchestration framework that was never adopted.
`meeting_id` is **nullable**, because migration 027 made a flag's meeting nullable and added
`artifact_id`, and those records-derived flags are precisely the ones that are always held —
`NOT NULL` would have made them unqueueable. The unique constraint on `anomaly_flag_id` is kept.

**What an expiry means here, and it is not what the archive meant.** A request past `expires_at`
and still pending is *overdue*, and that is all: the queue badges it, sorts it first, the count
shows on the console, and the flag stays `held`. There is no `expired` status, no sweeper, and no
path from elapsed time to `published`. The archive had `expireStaleApprovals()` writing a terminal
status from a timer, and two objections killed it — a status set by a clock reads in the log
exactly like a decision a person made, and a status only a background job writes silently means
"the job ran" rather than "the window passed". Overdue is derived at read time and cannot drift.

**`review_policy` is B-b's replacement: one row, one severity threshold, default `high`.** Not
`execution_policies` — with one operator every manual stage resolves to the same person. The
threshold can only *add* holds: a rule that held a finding because it names someone on the roster
wins at any threshold, which is what keeps the person-naming invariant true regardless of
configuration. This is a behaviour change and is meant to be: `emergency_session`,
`closed_door_vote`, `quorum_issue` and an over-30-day `missing_minutes` no longer auto-publish.
Production holds zero flags, so nothing that was public stopped being public.

**Approval refuses a finding that cites no stored artifact**, with a 409. Citations resolve from
the flag's own `artifact_id`, from any 64-hex value under a metadata key ending in `sha256` — how
P5's `last_minute_agenda_change` carries `from_sha256`/`to_sha256` — and from the meeting's stored
documents through `document_versions`. The third route is what makes a meeting-derived finding
approvable at all, and it is honest: the meeting record the claim describes was extracted from
those bytes. A meeting with no stored artifact has nothing behind its findings and they cannot be
approved. That is the correct refusal, not a gap.

**Rejection leaves the finding `held`.** There is deliberately no `rejected` review state: the
wall keys on `published`, so one rule covers both the undecided and the refused, and there is no
second failure mode to keep in step.

**Edit-with-reason is scanned for motive.** It is the one place a human types free text that will
be published, and the lexicon is deliberately *narrower* than P7's letter scan — a finding may say
minutes were published ninety days later, because that is the record stated as arithmetic. What is
forbidden is the assertion that someone meant it, profited by it, or broke a law doing it.

**Every decision appends to `record_corrections`** through the same writer publication and
correction already use. Migration 038 widens that table's `target_table` CHECK to admit
`anomaly_flags` and `review_policy`. One log, not two. Its rollback narrows the CHECK again and
will fail loudly once a decision is logged, because the table forbids DELETE — that is the
append-only guarantee working.

**Two holes closed on the way.** `GET /api/anomalies` filtered on `review_state` alone, so an
auto-published flag on a meeting an operator had not published leaked the meeting's existence and
a sentence of its content — through the one public route that does not take a meeting id and
therefore cannot be reached only by guessing one. `whereFindingPublic` in `publication.ts` is now
the single rule and adds the meeting condition. And `IMMEDIATE_SEVERITIES` in the notification
service is exactly `critical` and `high` — the severities the default threshold holds — so
without filtering the `anomaly.detected` emit *and* the service's own re-query, the pipeline
would have withheld a generated claim from the site and emailed it in the same breath.

`/admin/review` puts the evidence above the buttons rather than behind a disclosure, disables
approval on an unsourced finding and says why, reproduces the API's refusals verbatim, and offers
no bulk action — approving in a batch is approving without reading, on the one screen whose whole
purpose is that somebody read it.

Counts after B-a: backend **827 tests / 214 suites**, frontend **307 / 33**, both green. Backend
lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## B3 — the corrections log and the dispute route have landed

Working from `docs/superpowers/plans/2026-08-10-corrections-and-disputes.md`. Migration 039.

**B3 is satisfied.** Backlog item 7 required a published correction log and a route for a named
person to contest a record *before* the Caddy IP allowlist comes down. Both exist, both are
unauthenticated, both are tested. The remaining launch-readiness items — public data export and
licensing, backups with a tested restore, accessibility — are **not** what B3 gated on, and are
listed separately below.

**`/corrections` publishes only corrections to records that are public now.** A correction row
quotes a fact about its target in `old_value`, so publishing one for a withheld record would
disclose the withheld record — through a page that takes no id and therefore, like P6's search,
cannot be reached only by guessing one. The publicity test is **per target table** and routes
through `services/publication.ts` rather than retyping the rule: `meetings` through
`whereMeetingPublished`, `agenda_items` and `meeting_documents` through their meeting,
`anomaly_flags` through `whereFindingPublic`. `review_policy` and `record_disputes` never appear —
neither is a correction to a published record. Built from `EXISTS` rather than joins on purpose:
**an `EXISTS` that is wrong returns nothing; a join that is wrong returns everything.**
`public-corrections.test.ts` walks all four tables **in both directions**, withheld then published,
because absence alone would also hold for a query that is simply broken.

Two consequences that are intended: **unpublishing hides the correction that unpublished it**, and
a *rejected* finding never surfaces because it stays `held`. The page states the first in plain
words rather than implying the log is a complete history of every edit ever made.

**The operator's address is not published.** `operator_id` and `operator_email` stop at the
console; the accountable editor is named on the Methodology page.

**A dispute is not a finding, and migration 039 keeps it that way.** Writing a stranger's assertion
into `anomaly_flags` would make it the same object the detectors produce, on the same publish path,
one operator misclick from being published under this project's name. `record_disputes` is its own
table with its own two decisions — uphold and decline — sharing the operator's screen and the audit
log but not the type. `/admin/review` gained a **Disputes** tab; the tab strip is the whole of the
shared chrome and there is deliberately no approve button on the dispute side.

**A dispute is never published.** `review_state` is `NOT NULL DEFAULT 'held'` with
`CHECK (review_state = 'held')` — one legal value — and there is no public read route for the
table. The CHECK is the second lock, not the first, and a test proves the database refuses the
update.

**Upholding a dispute changes no record.** The correction that follows is a separate operator act
through the corrections path carrying `record_corrections.dispute_id`, which is what makes
dispute → review → correction followable end to end in one table and what keeps an unauthenticated
stranger's text from being one route away from the published record. A test asserts the `meetings`
row is byte-identical either side of an uphold.

**Abuse resistance, since it is the only unauthenticated write in the product.** Three bounds, and
one alone would be theatre: an in-memory per-client fixed window (3/hour, 10/day) that **stores
nothing about anybody**; a site-wide cap (30/hour) and a per-target cap (5 undecided) that are
queries **inside the insert's transaction** — a limit checked in middleware and a limit checked in
the transaction are two different limits, and only the second holds under concurrency. The target
must resolve through the publication wall, and **an unpublished record and a non-existent one
answer identically**, so the route is not an oracle for what has been ingested and withheld. The
per-target refusal message deliberately says nothing about *that record* having disputes. Field
lengths are capped in the database as well as at the route. **Nothing is emailed and nothing is
published**, which is the strongest property here and is structural: the form has no output an
attacker can aim at a third party.

Three things collected: what is contested, the contester's account, a contact. No identity
document, no IP, no user agent — a test asserts `record_disputes` has no such column.

**`app.set("trust proxy", 1)`** — one hop, Caddy. `true` would trust the whole chain including
anything a client wrote, which would let a caller displace their own address and walk past the
per-client window.

**Motive scanning moved to `appendCorrectionRow`**, the single writer every path already uses.
Every stated reason in `record_corrections` is a publishable sentence now, including the ones B-a's
approve and reject write, so *describe the record, never the motive* has to hold for all of them —
and a guard the next writer has to remember is not a guarantee. `routes/admin/review.ts` learned to
map `CorrectionError`, which it never needed to before; without that the 400 would have surfaced
as a 500.

**Four unenforced clocks came off the Methodology page.** It promised "2 business days", "10
business days", "24 hours" and "3 business days" for handling a dispute. **Nothing in this codebase
measured, tracked or alerted on any of them** — four unenforced claims on the page belonging to the
project whose subject is unenforced claims. They are replaced by a table of what is actually
guaranteed and *by what* (a database trigger, a database constraint, the response body).
`MethodologyPage.test.tsx`'s assertion on `"10 business days"` is now the inverse: it fails if any
`business days` promise comes back.

Counts after B3: backend **867 tests / 221 suites**, frontend **330 / 36**, both green. Backend
lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## MT CERS — Montana campaign finance has landed, and it has swept

Working from `docs/exploration/mt-cers-spike.md` and
`docs/superpowers/plans/2026-08-10-mt-cers.md`. Migrations 041–042.

**This is the money source for local office.** OpenFEC covers *federal* candidates; a Gallatin
County Commissioner and a Bozeman City Commissioner have no federal filings at all, so until now
"follow the money" could say nothing about the officials this project exists to watch.

**Nobody had ever looked at CERS, and the one data point we had was misleading.** A guessed path
returned 404 with a 26 KB body, which reads like a wall. It is not one: the search forms POST to a
*relative* action resolved against `/CampaignTracker/public/search`, so `searchResults/…` lands one
level **up**, and the guess put it one level down. The host publishes **no `robots.txt` at all**
(`/robots.txt` is a Tomcat 404, not a `Disallow`), there is no login, no CAPTCHA and no user-agent
discrimination. **No access exception is claimed for this source and none is needed** — this is the
cleanest posture of any source in the project, cleaner than Gallatin and far cleaner than Granicus.

**"A structured system, not PDF scraping" is confirmed as to structure and refuted as to bulk.**
CERS is a server-side DataTables JSON API. There is **no CSV, no export, no bulk file and no
documented API** — the only export affordance in the whole application is a `window.print()` button.
Records are walked entity by entity at one request every two seconds.

**A real sweep ran on 2026-08-10 and reported `succeeded`.** What landed locally:

| | |
|---|---|
| `cf_filers` | **384** — 42 Gallatin County Commissioner candidacies, 342 city candidacies resident in Gallatin |
| `cf_reports` | **35** filed reports (C-5, C-7, amendments) |
| `cf_transactions` | **127** — 70 contributions totalling **$18,910.00**, 57 expenditures |
| `artifacts` | **45**, content-addressed, 2.16 MB, bytes in MinIO |
| `meetings` / `commissions` under *State of Montana* | **0 and 0** |

**A CERS record has no URL, and that shaped the design.** Its criteria live in an HTTP session, so
obtaining one contribution schedule means replaying four requests in order. `DocumentRef.metadata`
carries that chain and `fetchDocument` replays it; `ref.url` is the endpoint plus those parameters —
a stable, unique, readable identity that is deliberately **not** dereferenceable. `advanceSession`
writes the protocol down once and both the adapter and the fixture harness use it, because a fixture
keyed on the request alone would serve one candidate's contributions for every candidate and every
test would pass.

**CERS publishes no meetings, so the adapter invents none.** The `discover` handler is entirely
meeting-shaped, and the alternative to changing it was to manufacture a meeting per filing period —
a fabricated public record in `meetings`, written to reuse a function. `SourceAdapter` gained an
optional `discoverDocuments`, whose refs are enqueued for `fetch` with no meeting id and routed in
`parse` on the record kind their own adapter stamped. **Nothing sniffs bytes**: a stored artifact's
meaning comes from the ref that asked for it. The contract suite now asserts the invariant in both
directions — an adapter declares bodies **exactly when** it discovers meetings.

**Every transaction cites a stored artifact**, in a `NOT NULL` column with no `ON DELETE CASCADE`.
An unsourced contribution cannot be inserted and deleting the evidence under a stored one fails
loudly; both are tested. Idempotency is `(artifact_id, row_index)` — an amendment is different
bytes, therefore its own artifact and its own rows, which is right, because an amendment is a second
thing the filer said rather than a correction to the first.

**Two shared-transport bugs surfaced while recording fixtures**, and both produced *silent wrong
answers* rather than errors. `fetch` exposes only the final response's headers and CERS mints
`JSESSIONID` on a **302**, so following redirects in the transport made every search run in a fresh
session and return `iTotalRecords: 0` **under HTTP 200**. And `HttpResponse.headers` is a flat map
while CERS sets three cookies at once, so exactly one survived and it was not the session.
`HttpRequest.redirect` and `HttpResponse.setCookies` exist because of those; `setCookies` is
optional so every existing fixture double stays valid.

**Two things the first live sweep taught, both now covered by tests.** CERS answers 200 with a
**zero-byte** body — not `[]` — for a schedule that does not apply, which is counted as
`cf_empty_body` rather than folded into "0 rows", because "they published nothing here" and "they
published an empty list" are different statements. And the roster **pages**: the first sweep wrote
142 filers where 384 exist, with `iTotalRecords` saying so in the same response. Each page is now
its own record, with the offset in its identity.

**Known limitation, recorded rather than hidden.** The per-target candidate cap slices the roster in
CERS's own alphabetical order, so a target with more candidates than the cap always sweeps the same
ones. Closing it needs a cursor in `ingestion_sources.config`. The caps themselves are small on
purpose: at 2 s per request the first draft's 25×12 would have been over 3,000 requests and nearly
two hours, timing out every night and looking like a broken scraper.

**Deliberately not built:** no public route, no frontend, no donor-to-vote join, no committee sweep.
Candidates' home addresses, personal emails and telephone numbers are in these filings; they are
**stored and never surfaced**, and publishing them is an operator decision, not a default.

The source stays **disabled**. Migration 042 rewrites 037's `disabled_reason`, which said "No
adapter has been written for this source yet" and is published verbatim on the **public** status
page — leaving it would put a false statement about our own ingestion on the page whose purpose is
that absences are honest.

Counts after MT CERS: backend **989 tests / 247 suites**, green. Backend lint: 2 warnings, 0
errors — the same two deliberate ones.

## Live state

**https://commissionwatch.bmux.sh returns 200.** Verified from outside the host, with a valid Let's Encrypt certificate.

| | |
|---|---|
| Host | `i-0123456789abcdef0`, shared `*.bmux.sh` platform, t4g.medium (arm64), 4 GB |
| Containers | `commissionwatch-web`, `-backend`, `-db` (pgvector pg16), `-minio` — all healthy |
| Footprint | ~144 MB actual against 1408 MB of declared limits |
| Deploy dir | `/home/ec2-user/commissionwatch` on the host |
| Access | Gated at the Caddy layer to `184.166.213.70`. Everyone else gets 403 |
| Data | Live host not yet swept. Locally, the first real sweep landed 7 meetings, 40 agenda items, 11 artifacts (2026-08-09) |

### Ingestion runs — the first public records have been fetched

**"Nothing ingests" stopped being true on 2026-08-09.** It was the single most important sentence
in this file for the product's whole life, and it is now wrong, so it is gone rather than softened.

`SourceScheduler` (`backend/src/services/ingestion/scheduler.ts`) is started from `index.ts`. It
reads `ingestion_sources.cron_expression` and `.enabled`, arms one `node-cron` job per enabled
source, takes a Postgres advisory lock keyed on the source id so one sweep runs at a time, writes
an `ingestion_runs` row **before** any work, and closes it `succeeded`, `partial` or `failed` with
every error text in the row. It **does not sweep on process start** — the first execution of any
source is its first cron tick, because a crash-looping container must never become a crawl of a
county web server. `SCHEDULER_ENABLED` defaults off under `NODE_ENV=test`.

**A real sweep ran against Gallatin County on 2026-08-09**, rate-limited to one request every two
seconds with the project's honest user agent. What landed locally:

| | |
|---|---|
| `meetings` | **7** (Weed Board ×4, Study Commission ×2, plus one more) |
| `agenda_items` | **40**, extracted from real agenda PDFs |
| `meeting_documents` | 11 |
| `artifacts` | 11, content-addressed, bytes in MinIO |
| `ingestion_runs` | 1, status `succeeded` |
| `ingestion_jobs` | 23, all terminal |

Two things the sweep taught us, both now in the spec:

- **AgendaCenter has been reorganised.** It rendered **three** categories on 2026-08-09
  (`cat3`, `cat2`, `cat4`) where the adapter's `GALLATIN_BODIES` constant names twelve. (An earlier
  version of this line said the *fixture* captured twelve. It does not — it holds those same three,
  and `gallatin-civicplus.test.ts` asserts it. Corrected 2026-08-10.) The constant is mostly wrong
  about what the site serves; it skips an unknown category loudly, so the failure mode is safe, but
  the list belongs in `ingestion_sources.config`.
- **Not every document is a PDF.** `/AgendaCenter/ViewFile/Agenda/_08062026-108` is a Word
  document. Parse records that as `parse_unsupported` and completes — the bytes are still stored
  and still citable. That meeting has 0 agenda items and the reason is recorded.

### Bozeman is the second source, and it has swept too

**A real sweep ran against `bozeman.granicus.com` on 2026-08-09**, 14-day lookback, one request
every **ten seconds**. What landed locally:

| | |
|---|---|
| `jurisdictions` | 1 — City of Bozeman |
| `commissions` | **16** |
| `meetings` | **18** (6 completed, 12 scheduled) |
| `agenda_items` | **88**, extracted from real agenda **HTML** |
| `meeting_documents` / `artifacts` | 8 |
| `ingestion_runs` | 2, both `succeeded` |

The second sweep re-fetched nothing — `artifacts_unchanged: 8` — which is the content address
doing its job.

Four things this source taught us:

- **The whole archive is one request.** `ViewPublisher.php?view_id=1` is 5.9 MB holding 1,135
  meetings across 16 bodies, 2013→2026, plus 17 upcoming. The year tabs are client-side. There is
  no per-year endpoint, which is the opposite of Gallatin.
- **`bozeman-access-spike.md` was wrong about several counts.** 519 City Commission meetings, not
  520; **16 bodies in total**, not "20+ others"; and 507/434 were City-Commission-only figures
  against 1,102/956 across all bodies. Corrections are inline in that document and in
  `backend/test/fixtures/bozeman-granicus/PROVENANCE.md`. Its **access** analysis held up exactly.
- **The archive's time column is the video clip's start, not the meeting's.** The 2026-08-04 City
  Commission row says 1:17 PM; that meeting's own agenda states an early start of 2:00 PM. Only
  upcoming meetings carry a time.
- **Agendas are HTML.** The parse stage only read PDFs, so every Bozeman agenda would have landed
  `parse_unsupported` with zero items. `services/ingestion/document-text.ts` now dispatches on the
  bytes, and `agenda-items.ts` learned dotted `G.1` markers and rejoins a marker the source put in
  its own element. The 2026-08-04 agenda yields 30 items.

**The robots.txt exception is now in force and is disclosed.** `bozeman.granicus.com/robots.txt`
is `Disallow: /` for this agent. We fetch anyway under the operator decision of 2026-08-04, at the
10-second `Crawl-delay` the file itself publishes, with the project's honest user agent. The
Methodology page carries the disclosure as of the same release, and three tests assert it is there.
**If that disclosure comes down, the adapter must be disabled with it** —
`respectRobotsTxt: true` makes it obey the file and discover nothing, which is the switch.

Enabling Bozeman is the same deliberate act as Gallatin, with one caveat:

```bash
npm run sweep -- --adapter bozeman-granicus --enable --lookback-days 14
```

**Use a short lookback the first time.** At 10 s per document a 365-day sweep runs for hours and
will blow the scheduler's 15-minute `sweepTimeoutMs`, leaving the run `failed` and its jobs queued
for the next tick until it catches up. Agenda packets (28 MB, 439 pages, 724 of them) are **not**
fetched unless `includePackets` is set.

The live host has **not** been swept: `ingestion_sources` rows are created **disabled**, so nothing
sweeps because a container started. Enabling Gallatin in production is a deliberate act:

```bash
npm run sweep -- --list                                    # what exists
npm run sweep -- --adapter gallatin-civicplus --enable     # enable and sweep once, now
```

**The adapter moved.** `agents/meeting-monitor/src/adapters/` is now
`backend/src/services/ingestion/adapters/`, with its contract suite in `backend/test/adapters/` and
its fixtures in `backend/test/fixtures/gallatin/`. `backend/Dockerfile`'s build context is
`./backend`, so a production image cannot contain a file from `agents/` — and the scheduler runs in
the backend. Those 68 contract tests had **never run in CI**; they do now.

### The running deployment now comes from CI

As of 2026-08-06 the live containers are the ones `deploy-aws` shipped over SSM, serving `71217e2`. Before that they had been started by hand over SSH on 2026-08-05, and the SSH version of the job could never have replaced them: the shared host's SSH private key is not retrievable from AWS by anyone, so it was blocked on a secret that does not exist to be supplied.

**Rewritten on 2026-08-06 to deploy over SSM Run Command** (`deploy/deploy-aws-ssm.sh`), which needs no key and no host address. Everything testable without AWS credentials is tested and green — payload construction, secret resolution, shared-host safety flags. Design: `docs/superpowers/specs/2026-08-06-ssm-deploy-design.md`.

**First real run, 2026-08-06.** `SHARED_STACK_LIVE` was set and `deploy-aws` executed. It authenticated as `commissionwatch-ci`, resolved both image pins to `25ba8b9`, and failed at `ssm:PutParameter` — the optional secret refresh. Diagnosis from the account: the CI user held exactly one inline policy, `commissionwatch-ecr-push-pull`, so `ssm:SendCommand` was missing as well; `/commissionwatch/env` had never been created; and `platform-aws-host` had no Parameter Store grant. **None of these are code defects** — the script did what it was told with the permissions it had.

**Second run, 2026-08-06 (`af7097f`, v0.2.0).** Failed at the same line, and that was informative: it proved `DEPLOY_ENV_FILE_AWS` was still set even though the IAM grants had landed. The Gitea *Variables* tab had been cleared, but the value is a **secret**, and secrets are a separate tab. The diagnostic block printed as designed and the job died before touching the host, so nothing on the box changed.

**Third run, 2026-08-06 (`71217e2`). The SSM round trip works end to end.** The host pulled both images, recreated `backend` and `web`, waited on `db` and `minio` health, and reported both containers serving `71217e2`. Secrets came from `/commissionwatch/env` — no DEGRADED fallback. Verified independently: `https://commissionwatch.bmux.sh/api/health`, `/api/version` and `/version.json` all return 200, and `/api/version` reports sha `71217e2`, built `2026-08-06T22:40:39Z`.

**The job still reported failure**, after the deploy had fully succeeded. Cause was in the workflow, not the deploy script: `cleanup() { [ -n "$TMPENV" ] && rm -f "$TMPENV"; }` as an `EXIT` trap. When a `&&` chain is the *last command of an EXIT trap* and its test fails, bash makes that the script's exit status — so a completely successful deploy exited 1 whenever `TMPENV` was empty. That is precisely the path taken when `DEPLOY_ENV_FILE_AWS` is unset, i.e. the normal one, which is why deleting the secret is what exposed a latent bug rather than causing a new one. Fixed with an `if`, which returns 0 with no else branch.

## Operational facts

Learned the hard way; each cost a failed deploy.

- **ECR repositories are `your-org/` prefixed** — `your-org/commissionwatch-backend`, `your-org/commissionwatch-frontend`. The CI user's IAM policy scopes to `repository/your-org/commissionwatch-*`, so an unprefixed path is denied. ECR reports both a wrong path and a missing repository as **403 on a blob HEAD**, never a 404, and never names the repository — so a 403 means check the path first, not the credentials.
- **Images must be `linux/arm64`.** The host is Graviton. An amd64 image builds cleanly and dies at startup with `exec format error`.
- **The host's instance role needed `ecr:BatchGetImage` on `your-org/*`.** The other products' repos are unprefixed, so `bmux-platform-host-ecr-pull` never covered ours. Fixed 2026-08-05 by adding that ARN pattern.
- **`ec2-user` cannot write to `/opt`.** `platform-aws` deploys to `/opt/platform-aws`, which must have been root-provisioned out of band. We deploy under `$HOME` instead, so no manual step is required per product.
- **Gitea `act_runner` runs jobs inside containers**, so a `services:` database answers to its service name (`postgres`), not `localhost`. The workflow probes both.
- **`actions/setup-node` had a corrupt runner cache**, failing with an `lstat` error naming a file from the action's own repo. Replaced with `container: node:22-bookworm`.
- **CI is Gitea Actions only.** Never add `.github/workflows/` — it does not run.
- **`POSTGRES_PASSWORD` is fixed at volume initialisation.** Changing the secret later will not change the database; rotation is an `ALTER ROLE` on the running instance.
- **SSM works on the host** (`AmazonSSMManagedInstanceCore` attached 2026-08-04). This is now the deploy path, not just a repair tool.
- **The shared host's SSH private key is unobtainable.** EC2 stores only the key pair's *name*; the private half belongs to whoever provisioned `platform-aws` and cannot be retrieved from AWS. Port 22 being open makes this look like a missing secret rather than a missing capability. Do not try to source it — that is a dead end, and it is why the old `deploy-aws` job could never go green.
- **`AWS_PROFILE` set but empty** makes every CLI call fail with *"The config profile () could not be found"*, which reads as missing credentials. Reproduced on the operator workstation 2026-08-06. `deploy-aws-ssm.sh` clears it when empty on both ends.
- **Secrets belong in SSM Parameter Store**, fetched by the host with its instance role. Never in the SSM command payload — `send-command` parameters sit in plaintext in command history for 30 days and in CloudTrail, readable by anyone in the account with `ssm:GetCommandInvocation`.
- **The instance role reads `/commissionwatch/*`, and only reads it.** The role is `platform-aws-host`, shared with the other products on the box, so the grant is an **inline** policy (`commissionwatch-param-read`) scoped to our path — it touches no managed policy and no other tenant. Applied and verified 2026-08-06. An earlier version of this file said the grant "is not ours to make"; **that was wrong** — the account holder has `AdministratorAccess`. See `deploy/README.md` §3. If the parameter is ever missing, deploys fall back to the `.env` on the host and run **DEGRADED**, loudly, rather than failing.
- **CI must not hold `ssm:PutParameter`.** The parameter is seeded once by hand and read by the host; the pipeline only sends commands. Setting `DEPLOY_ENV_FILE_AWS` reverses that — it makes every deploy push the secret through a runner and need a write grant. Verified 2026-08-06: with the secret set and no SSM policy on the CI user, the first failure is `PutParameter`, which reads as a broken deploy while concealing that `ssm:SendCommand` was also missing.
- **Nobody holds the plaintext of the env file, and nobody needs to.** It exists in `/home/ec2-user/commissionwatch/.env` on the host and, until 2026-08-06, in a Gitea Actions secret that is write-only. The host seeded Parameter Store from its own copy without anyone reading it — `deploy/README.md` §4. `/commissionwatch/env` is now a SecureString at version 1, 419 bytes, 8 keys, and the seed grant was revoked in the same session. Rotation means repeating that procedure, not recovering a copy from somewhere.
- **The `amazon/aws-cli` container fallback works** — verified 2026-08-06 with `aws` off `PATH`. The runners have docker but not the CLI.
- **`AWS_PAGER` must be set to `""`.** CLI v2 pages through `less(1)` and on a runner `TERM` is undriveable, so every `aws` call stalls on "Press RETURN" rather than failing. A deploy that looks slow rather than broken. Set on both ends and in the workflow job env.
- **Inside these containers, probe `127.0.0.1`, never `localhost`.** `/etc/hosts` maps `localhost` to `::1` too, busybox wget tries `::1` first, and nginx listens only on IPv4 — so `localhost` gives a flat `Connection refused`. **The `web` healthcheck used one**, so the container could never go healthy and `up -d --wait` would have blocked until timeout and failed the first automated deploy. Verified 2026-08-06 with the same image twice: `localhost` → unhealthy, `127.0.0.1` → healthy. Fixed.
- **Both images serve their build SHA** — `/version.json` from web, `/api/version` from the api, stamped from one `github.sha`. The deploy compares them through the web container and fails on skew (25), stale pull (26) or unreachable (24). The images roll independently, so a stack serving the old API behind the new UI is healthy by every other measure.

### Going public

**B3 no longer blocks this, as of 2026-08-10.** The published corrections log and the dispute route
exist and are tested; see the B3 section above. What remains before the gate comes down is an
operator decision, not a build.

Delete the two `@blocked` lines from the `commissionwatch.bmux.sh` block in `your-org/platform-aws`'s `caddy/Caddyfile`. **Do not** change the security group — its 443 allowlist is shared with seven other products, so opening it exposes all of them at once. Per-product exposure belongs in Caddy.

## Gaps — what is not built

Ordered by how much each blocks the product being real.

1. ~~**Nothing ingests.**~~ Closed 2026-08-09 by P1. The scheduler is wired, a real sweep has run, and the pipeline lands meetings, documents, artifacts and agenda items. Remaining: enable the source on the live host, and move the body list out of the adapter into `ingestion_sources.config`.
2. **W3 findings engine.** ~~and review queue~~ — the **review queue landed 2026-08-10** (B-a,
   above): `approval_requests`, a single severity threshold, claim-to-citation binding, and
   operator approval as the only thing that makes a finding public. What remains of this item is
   the *generated narrative* — a finding today is the detector's own sentence, not composed prose.
3. ~~**Bozeman adapter.**~~ Closed 2026-08-09 by P4. `backend/src/services/ingestion/adapters/bozeman-granicus.ts`, registered **disabled**, swept for real (below). `bozemanmt.gov` is still a blanket Akamai deny and is never fetched. ~~Outstanding from the same backlog item: the **public-records-request page**~~ — closed 2026-08-10 by P7, though it can draft nothing until `jurisdiction_records_law` is populated. See above.
4. ~~**MT CERS campaign finance**~~ (`cers-ext.mt.gov/CampaignTracker`). Closed 2026-08-10 — the
   adapter is written, registered **disabled**, and a real rate-limited sweep landed 384 filers,
   35 filed reports and 127 itemised transactions. See above. Outstanding from the same item: no
   public route and no frontend yet, no committee sweep, and the roster cursor named as a known
   limitation.
5. **W6 funding network layer.** Specced only — `docs/superpowers/specs/2026-08-04-funding-network-layer-design.md`.
6. ~~**W7 delivery channels.**~~ Built. Channels, routes, encryption, the Discord transport, and — as of B-e — cadence, SMS, and a self-serve subscriber surface on the same substrate. Nothing dispatches product events yet, because nothing ingests.
7. **Launch readiness**: ~~corrections and dispute policy~~ — **closed 2026-08-10 by B3**, see
   above. `/corrections` publishes the policy and the log, `/corrections/dispute` is the route, and
   disputes reach the operator queue. **This was the gate on making the site public**; the rest of
   this item is not. Still outstanding: public data export and licensing, backups with a tested
   restore (see item 8 — `BACKUP_S3_URI` and the cron), accessibility and shareability.
8. ~~**No database backups.**~~ Closed 2026-08-09 by P3. `deploy/backup.sh` takes a nightly
   `pg_dump -Fc` plus a MinIO mirror with 7 daily / 4 weekly retention and emits
   `ops.backup_succeeded` / `ops.backup_failed` through the delivery dispatcher.
   `deploy/restore-drill.sh` **has been executed**: 28 tables compared against the manifest,
   137 rows restored, no losses, 11 objects in the archive. Runbook: `deploy/README.md` §5.
   **Outstanding:** `BACKUP_S3_URI` is unset, so an archive currently never leaves the instance —
   that is a copy, not a backup. Setting it needs a bucket, which costs money and is the operator's
   call. The cron entry also still has to be installed on the host.
9. **No monitoring.** Nothing alerts if the site goes down or ingestion silently stops. P2's
   console makes a stalled scraper *visible to an operator who looks*; it does not page anyone.
10. ~~**No admin authentication.**~~ Closed 2026-08-09 by A1. One operator class, `scrypt` from
    `node:crypto`, revocable server-side sessions in an httpOnly cookie, no public registration.
    The review queue is no longer blocked on it.

## Known defects and debt

- **PRODUCTION IS DOWN as of 2026-08-09.** Deployed sha `1fb246f`. The frontend serves; the
  backend does not — `/api/health`, `/api/version` and `/api/meetings` all return 502. The host,
  the workflow log and ECR are not reachable from this repo, so the cause is not diagnosed here.
  Everything reproducible locally is green: migrations apply 1→33 on a fresh database, the image
  builds, the backend boots with only `DATABASE_URL`, and it uses 115 MB against a 512 MB limit.
  **Nothing has been pushed since**, deliberately — every push triggers a deploy onto the broken
  stack.
- ~~**A crash-looping backend deployed as a success.**~~ Fixed 2026-08-10, and it is why the
  incident above went out green. `docker compose up -d --wait` treats a service with **no
  healthcheck** as ready the instant its process starts; `backend` had none while `web`, `db` and
  `minio` all did, `web` depended on it with `condition: service_started`, and
  `restart: unless-stopped` restarted the dead container forever. The deploy script's
  version-skew check (24/25/26) never ran, because by then the deploy believed it had won.
  `backend` now has a healthcheck on its own `/api/health` — **127.0.0.1, never `localhost`** —
  `web` waits on `service_healthy`, the entrypoint names a migration failure instead of exiting
  silently, and `deploy/test-deploy-aws-ssm.sh` asserts every service in the deployed compose
  file declares a healthcheck. 53 assertions before, **61** now.
- **CI `deploy-aws` unverified.** The SSM round trip has not yet completed once from a runner. See above.
- ~~**Deploy pattern is push-based SSH**~~ — resolved 2026-08-06. No SSH key in CI, no rsync; secrets live in Parameter Store and are fetched by the host. Still push-based; a pull-based rollout watching ECR remains the better end state but is not blocking anything.
- **The instance-role grant for Parameter Store is outstanding**, so deploys run degraded. Not a defect in this repo — it needs whoever administers `your-org/platform-aws`. `deploy/README.md` §3 has the exact policy.
- **Images are tagged `:sha` and `:latest` only.** No `:version` tag: deriving one from `git describe` is unsafe on Gitea's shallow checkouts, where `--always` silently degrades to a bare SHA that looks like a valid answer. Rollback is by explicit pin instead, which works today.
- ~~**Homepage findings section is a placeholder constant.**~~ Resolved 2026-08-10, and the audit
  found a second defect underneath it. The constant is now `NO_FINDING_YET` and is **the honest
  empty state, meant to be rendered** — not a placeholder awaiting prose. There is nothing to fill
  in: no `findings` table, no endpoint, no hook, and the subject of a front-page claim on this site
  is a real, living, named official. The name `PLACEHOLDER_FINDING` was itself the hazard, because
  it invited the wrong repair.
  The second defect was the byline under it, which read *"Generated {today} · N meetings
  reviewed"*. **Both halves were false.** Nothing was generated — there is no finding above it —
  and `N` is what the meetings endpoint returned, a count of meetings in the record rather than a
  count of anything anybody reviewed. A site that exists to catch unsourced claims had two of them
  under its own masthead. It now reads *"N meetings in the published record"*, and the test that
  pinned the old wording now asserts `Generated` and `reviewed` are **absent**.
- ~~**`Layout.tsx` hardcodes "Last sweep 12 min ago."**~~ Fixed 2026-08-09. The masthead reads
  `GET /api/ingestion/status`, which reports the newest `finished_at` of a `succeeded` or
  `partial` run, and says **"No sweep yet"** whenever there is nothing to report — including
  while the request is in flight and when it fails. Seven tests, where there were none.
  Re-verified 2026-08-10: still true, no constant anywhere in `Layout.tsx`.
- ~~**`meetings` has no `adjourned_at` or `meeting_type`.**~~ Resolved 2026-08-10 by deleting the
  row. `meetings` has a `DATE`, a nullable `TIME`, a `location` and a `status`, and nothing else
  about the sitting — so `MeetingDetailPage`'s Adjourned row rendered the literal string
  "Not recorded" on every meeting that has ever existed and every meeting that ever will.
  "Not recorded" is a claim about the custodian's minutes; what it actually described was a column
  we never created. **A field that can only ever say one thing is not reporting**, and a field
  reporting our schema gap as the city's is worse than absent. Convened and Location stay: those
  columns are real, and their "Not recorded" is true of the source — Granicus publishes a time for
  upcoming meetings only. `meeting_type` was never referenced; the page derives a label from
  `status`, which is a real column. When an adjournment time is extracted from minutes it gets a
  column first, and a row second.
- ~~**No tests** for `MeetingDetailPage`, `StatusBadge`, `RundownViewer`.~~ Written 2026-08-10.
- ~~**`VoteBreakdown.tsx` may be unused.**~~ **Stale — it was never unused.** Verified 2026-08-10:
  `VotesPage.tsx` imports it and renders `<VoteBreakdown mode="roll-call" …>` in the expanded row,
  and `VotesPage.test.tsx` exercises it through the disclosure. Nothing was deleted. Its
  non-component exports (`VOTE_ORDER`, `VOTE_LABEL`, `tallyVotes`) moved to
  `components/vote-tally.ts` as part of the lint work below.
  **One real defect did turn up next to it**: `MeetingDetailPage` carries its own near-copy of
  `tallyVotes` and `outcomeOf`. Two implementations of vote arithmetic on a site whose whole
  product is vote arithmetic is a defect waiting for the two to disagree. Not merged in this pass —
  see the declined list.
- ~~**Ten frontend lint warnings.**~~ All ten cleared 2026-08-10, no rule disabled and
  `.eslintrc.json` untouched. Every one was `react-refresh/only-export-components`: a non-component
  export sharing a file with a component. Fixed by moving the exports to their own modules —
  `components/severity.ts`, `components/flag-labels.ts`, `components/vote-tally.ts`,
  `contexts/auth-context.ts` + `contexts/useAuth.ts`, `lib/AllProviders.tsx` — and repointing every
  importer. `meetingStatusLabel` in `MeetingsPage.tsx` had zero consumers repo-wide and was deleted.
- **The two backend lint warnings stay, and both are deliberate.** `errorHandler.ts`'s `_next` is
  **not removable**: Express identifies error middleware by `fn.length === 4`, so dropping the
  fourth parameter turns the error handler into ordinary middleware and errors stop being handled
  at all. `embeddings.ts`'s `_limit` is the `$2` of a documented Phase-3 contract in a function with
  no call sites; removing only the parameter would leave a signature reading "return everything",
  which is not what the module means. The honest fix for both is
  `argsIgnorePattern: "^_"` on `@typescript-eslint/no-unused-vars` — this codebase already uses a
  leading underscore to mean "intentionally unused" (`_index`, `_rowIndex`, `_req`,
  `_queryEmbedding`) and the config gives that convention no effect. That is a config change, so it
  is left for a decision rather than made unilaterally under a brief that forbids weakening config.
- **W1 critic findings were never fully cleared.** An orchestration bug capped repairs at 5 of 19. The remaining ones were partly fixed incidentally. Re-run the critics rather than trusting the old list.

### Declined in the 2026-08-10 defect sweep, with reasons

- **Moving the body lists into `ingestion_sources.config`.** This is a much larger change than the
  backlog entry implies, and doing it shallowly would be worse than not doing it. Three facts, all
  verified in the code rather than assumed:
  1. **Adapter construction is synchronous, boot-time and database-free.**
     `createDefaultRegistry()` builds both adapters with no arguments before `startIngestion` does
     any database work, and the module-level `gallatinCivicPlusAdapter` / `bozemanGranicusAdapter`
     singletons do the same at import. Reading config at construction means making the registry
     async or deferring adapter creation to sweep time. That is the actual work; the constant is
     not.
  2. **What `registration.ts` writes is unusable as a round trip.** `config.bodies` is
     `descriptor.bodies.map(b => b.key)` — slugs only. Gallatin's `catId` is dropped entirely, and
     `urban-parks-forestry-board` cannot regenerate `Urban Parks & Forestry Board`. The two adapters
     also take different shapes: Gallatin takes `{catId, name}[]`, Bozeman takes `string[]`.
  3. **The write is insert-only.** `registerSource` returns early when the row exists, so an
     existing deployment's `config` is frozen at first boot and no deploy would ever update it.
     `ensureCommissions` is likewise insert-only and never deletes, so shrinking a list orphans
     `commissions` rows.
  The five Bozeman meetings this was blocking are fixed directly instead (see the commit); the
  Gallatin list is stale but fails **safe** — an unknown category is skipped loudly, and the three
  categories the live site serves are all in the list with the right ids.
- **Correction to this file:** the line above said AgendaCenter "rendered three categories where the
  2026-08-04 fixture captured twelve." The **fixture holds three** (`cat2`, `cat3`, `cat4`) and
  `gallatin-civicplus.test.ts` asserts exactly that. Twelve exists only in the adapter's
  `GALLATIN_BODIES` constant. The discrepancy is constant-versus-reality, not fixture-versus-live.
- **Merging `MeetingDetailPage`'s private vote tally into `components/vote-tally.ts`.** Real debt,
  and it is a behaviour change rather than a move: the two implementations disagree on the
  zero-vote case (`unrecorded` versus `none`) and on labels, and `MeetingDetailPage` had no tests
  when the sweep started. It now does. Merging them belongs in a change that can be judged on its
  own, with the new tests as the safety net rather than written in the same breath.
- **`argsIgnorePattern` on the backend lint config**, and therefore the two remaining backend
  warnings. Reasons above.

## Invariants — do not break these

Full detail in `.claude/skills/commissionwatch-development/SKILL.md`.

- No unsourced claim reaches the public site. `funding_edges.source_artifact_id` is `NOT NULL` for this reason.
- Nothing naming a person auto-publishes. It goes to the operator review queue.
- Seed data never names a real person, and **seeds never run in production** — the seed deletes every row first, so an automatic seed would destroy ingested records. `docker-entrypoint.sh` refuses to seed when `NODE_ENV=production`.
- Describe the record, never the motive. No assertion of intent, corruption or illegality.
- Detection logic applies identically to every entity class. No detector may filter on entity type to select targets.
- Never silence a type error; never delete a test to go green.
- The database schema is the source of truth for types.

## Next steps, in order

0. **Populate `jurisdiction_records_law` for Bozeman and Gallatin County.** Twenty minutes of
   reading, and it is the difference between a letter that is right and a letter that is
   confidently wrong. It blocks P7 entirely and nothing else blocks it. Full instructions in the
   P7 section above. **This one cannot be delegated to an agent** — it is a person reading a
   statute and putting their name against the date.
1. **Enable Gallatin on the live host and install the backup cron.** The code for both landed
   2026-08-09; neither is switched on in production. `npm run sweep -- --adapter gallatin-civicplus
   --enable`, then the `17 4 * * *` entry from `deploy/README.md` §5. Set `BACKUP_S3_URI` at the
   same time, or accept that the backup has not left the instance.
2. **Prove CI deploy end to end.** Run `deploy-aws` and watch it succeed, so the manual deployment is no longer the only path that has ever worked.
3. **Move both body lists into `ingestion_sources.config`.** A city standing up a committee should
   not need a deploy. **The five skipped Bozeman meetings are no longer the reason to do it** —
   that was fixed directly on 2026-08-10 with a match-only `&`/`and` normalisation, an explicit
   alias for "Tax Increment Finance Advisory Board", and three upcoming-only bodies added to the
   list; all seventeen upcoming rows now resolve. What remains is the architecture: adapter
   construction is synchronous and database-free, `config.bodies` is written as slugs only and is
   lossy for both adapters, and `registerSource` never updates an existing row. See the declined
   list under Known defects for the detail before starting.
4. ~~**W3 review queue**~~ — landed 2026-08-10, see B-a above. What remains under W3 is the
   **generated narrative**: a finding is currently the detector's own sentence. The queue, the
   threshold, the citation binding and the audit trail are all in place to receive one.
5. ~~**Bozeman Granicus adapter**~~, landed 2026-08-09 and registered disabled. ~~The
   **public-records-request page** that goes with it is still outstanding~~ — landed 2026-08-10 as
   P7. The exception is now written on a promise that has a page behind it, and
   `MethodologyPage.test.tsx` asserts the link is there as part of the disclosure suite.
6. ~~**Status page** reading `ingestion_runs`~~ — fully closed 2026-08-10. P2 shipped it for the
   *operator* at `/admin/sources`; the **public** page is now at `/status`, reading the same tables
   through the same judgements and publishing figures rather than run text. See above.
7. Then W5 correlation, W6 funding network, W7 delivery channels, and the launch-readiness work.

## For future agents

- Read `.claude/skills/commissionwatch-development/SKILL.md` first. It holds the process and the invariants.
- **Probe external sources before designing against them.** Every significant plan change in this project came from a `curl`, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended.
- **Verify by running commands.** Do not report success from an agent's claim or a green pipeline. Both have lied in this project.
- When fanning out, give agents disjoint file ownership and forbid concurrent git writes — a shared index lock corrupts work.
- A check that could not run is `blocked`, never `pass`.
