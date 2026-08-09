# Phase 2 — Making the site real

> Date: 2026-08-09
> Status: drafted for operator review; not yet committed
> Target branch: `main` (deployed lineage), after the archive-salvage batch lands
> Companion: `docs/superpowers/specs/2026-08-09-archive-salvage-design.md`

## Why this document exists

The salvage batch now building delivers operator authentication, multi-channel subscriptions and
a records-request pipeline. When it finishes the site will still contain **zero rows**, and the
admin panel the operator named as their primary gap will still not exist. Four of the eight
approved mockup screens have no spec behind them.

That is not a defect in the salvage spec — its job was deciding what crosses over from the
abandoned lineage, and the console is a new build rather than a port. This document covers the
remainder.

Six items. P1 and P3 are coupled and must ship together. P2 depends on A1. P5 and P6 are new
capability rather than gap-closing, and are specified last deliberately.

| | Item | Depends on | Closes |
|---|---|---|---|
| P1 | Ingestion scheduling | — | `STATUS.md` next-step #1 |
| P2 | The Pressroom console | A1 (operator auth) | Mockup screens 02–04 |
| P3 | Backups with a tested restore | P1 | Backlog B4 |
| P4 | Bozeman Granicus adapter | P1 | Backlog B6 |
| P5 | Agenda diff timeline | P1 | New — activates a dormant enum value |
| P6 | Full-text search | P1 | New — replaces the withdrawn embeddings work |
| P7 | Public-records request generator | B-d | New — makes the statutory route a button |

---

## P1 · Ingestion scheduling

**The gap.** `agents/meeting-monitor/src/adapters/gallatin-civicplus.ts` works and passes against
recorded fixtures. `backend/src/services/ingestion/queue.ts` and `worker.ts` exist. `ingestion_sources`,
`ingestion_runs`, `ingestion_jobs` and `artifacts` all exist. **Nothing calls any of it.**
`backend/src/index.ts` starts the digest scheduler and nothing else. Not one public record has been
fetched in the product's lifetime.

This is the highest-value change in the entire backlog. Everything else in this document is
improved by it, and several items are meaningless without it.

**Design.**

- A `SourceScheduler` alongside the existing `DigestScheduler`, started from `index.ts`, using
  `node-cron` — already a dependency, no new package.
- Cadence is **per source, stored in the database**, not in code: add `cron_expression` and
  `enabled` to `ingestion_sources`. An operator changing a schedule must not require a deploy.
- Add `expected_interval_hours` to `ingestion_sources`. This is what makes the silence watch on
  screen 02 possible: a source that has not succeeded within its expected interval is
  **Suspect**, and silence is treated as failure until proven otherwise.
- **One sweep per source at a time.** Take a Postgres advisory lock keyed on the source id; a
  scheduled tick that cannot acquire it logs and returns rather than queueing a second sweep.
  This is what stops a slow source from stacking up sweeps forever.
- Every tick writes an `ingestion_runs` row before doing any work, and closes it with
  `succeeded`, `partial` or `failed`. A run that produced work *and* errors is `partial` — the
  existing enum already models this correctly and must not be collapsed to a boolean.
- Failures land in the row with their error text. Nothing is swallowed.

**Boot safety.** The scheduler must not sweep on process start — a crash-loop would hammer a
county web server. First execution is on the first cron tick. A `SCHEDULER_ENABLED` env flag
defaults to off in `NODE_ENV=test` so the suite never schedules anything.

**Acceptance.**
- With the scheduler enabled and a 1-minute test cron, a sweep runs, `ingestion_runs` gains a row
  that reaches a terminal status, and `meetings` gains rows.
- A second tick while the first sweep holds the advisory lock does not start a second run.
- A sweep whose adapter throws produces a `failed` run carrying the error text, and the process
  stays up.
- The test suite schedules nothing.

**Operational note.** The moment this works, the site has data worth losing. P3 ships with it.

---

## P2 · The Pressroom console

**Scope.** Mockup screens 02, 03 and 04. Screen 01 is delivered by A1; screens 05–08 by B-e, B-d
and P-later work.

**Route surface.** All under `/admin`, all behind `requireOperator` from A1.

| Route | Screen | Reads |
|---|---|---|
| `/admin/sources` | 02 | `ingestion_sources`, latest `ingestion_runs` per source |
| `/admin/runs/:id` | 03 | one `ingestion_runs` row plus its `ingestion_jobs` |
| `/admin/meetings/:id` | 04 | `meetings`, `agenda_items`, `meeting_documents`, `artifacts` |

**Design decisions carried from the approved mockups** — each is a requirement, not decoration:

1. **Zero is rendered as a failure state, not an empty table.** Lifetime ingested records at 0
   displays in the failure colour. The number that has been true for the product's whole life
   should look wrong, because it is.
2. **Silence watch.** A source past `expected_interval_hours` since its last success renders as
   Suspect. Without this a dead scraper and a quiet month at City Hall produce identical screens.
3. **Disabled sources stay listed** with a reason. `bozemanmt.gov` remains visible with "Why
   disabled" explaining the Akamai block, so that knowledge lives in the console rather than in
   somebody's memory.
4. **Partial failure stays green-with-a-red-row.** A run that parsed 34 of 37 is a success with a
   footnote. Collapsing it to "failed" trains the operator to ignore the status.
5. **Re-parse without re-fetching.** Artifacts are stored and hashed, so a parser fix replays
   against bytes already held — no second request to a county server, and a reproducible result.
   This is a distinct action from "sweep now" and must be separately available.
6. **Confidence is per field, not per record.** Seven good agenda items and one mangled one is
   not a low-confidence meeting. Mark the item.
7. **Corrections are append-only.** A new `record_corrections` table: who, when, field, old value,
   new value, reason. **The artifact is never mutated.** A transparency project that edits its own
   evidence has nothing left to stand on.
8. **`ingested` and `published` are different states.** Add `published_at timestamptz null` to
   `meetings`. Publishing is a decision with an audit trail, not a side effect of ingestion.
   Publishing over a known defect is permitted and recorded as such.

**Frontend.** Reuse the deployed design system — `tailwind.config.ts` tokens, no new palette. The
admin ground is `paper-sunk` with `paper` cards, inverting the public site's figure/ground so the
operator always knows which side of the wall they are on. No new dependencies.

**Acceptance.**
- Every `/admin` route returns 401 without a session and renders without a database error with
  zero rows present.
- A correction inserts a `record_corrections` row and leaves the referenced artifact byte-identical.
- A meeting with `published_at IS NULL` does not appear in any public API response.

---

## P3 · Backups with a tested restore

**Ships with P1, not after it.** Today nothing is backed up, which is harmless at zero rows and
unacceptable the moment P1 succeeds. P1 creates the emergency this closes.

**Design.**

- Nightly `pg_dump` of the application database, and a mirror of the MinIO bucket, both to a
  location off the instance. Retention: 7 daily, 4 weekly.
- **A restore that has actually been executed.** A documented, run-at-least-once procedure that
  brings a dump up in a scratch database and asserts row counts against the source. A backup
  nobody has restored is a hypothesis.
- The restore drill is a script in `deploy/`, not prose in a document, so it can be re-run.
- Backup success or failure emits `ops.backup_succeeded` / `ops.backup_failed` through the
  existing delivery dispatcher, so a silent backup failure is not possible once B-e lands.

**Acceptance.**
- A dump exists off-instance, and its restore has been performed with row counts compared.
- A deliberately failed backup produces a delivered notification.
- The runbook names the exact commands, verified by running them.

**Note on secrets.** `POSTGRES_PASSWORD` is fixed at volume initialisation; a restore into a fresh
volume must account for that. Recorded because it has already cost this project a deploy.

---

## P4 · Bozeman Granicus adapter

**Grounding, already done** (`docs/exploration/bozeman-access-spike.md`):
`bozeman.granicus.com/ViewPublisher.php?view_id=1` carries **520 City Commission meetings spanning
2013–2026**, 507 with agendas, 434 with minutes. `bozemanmt.gov` is a blanket Akamai deny and must
not be retried — that door stays closed, and the records were found by following a DNS CNAME chain
rather than attacking the HTTP endpoint.

**Design.** A second adapter implementing the existing `adapters/types.ts` contract and registered
in `adapters/registry.ts`, so it inherits the queue, artifacts, runs and console with no new
plumbing. Fixtures recorded under `agents/meeting-monitor/tests/fixtures/bozeman-granicus/` with a
`PROVENANCE.md` naming the fetch date and URL, matching the Gallatin precedent.

**Conduct.** One request every few seconds, never concurrent. Honest user agent naming the project —
never a spoofed browser identity. Unchanged documents never re-fetched. The vendor-robots exception
applies and **must remain disclosed on the Methodology page**; if that disclosure ever comes down,
the exception ends with it.

**Backfill.** 520 meetings at one request per two seconds is roughly 17 minutes of fetching for the
index alone, and considerably more with documents. Backfill is an explicit operator action from
screen 03 with a date range, not something a first cron tick attempts.

**Acceptance.**
- The adapter satisfies `contract.test.ts` exactly as Gallatin does.
- A fixture-driven parse produces meetings, agenda items and document references with no network.
- A live sweep limited to one page produces real rows and respects the interval.

---

## P5 · Agenda diff timeline — *what changed, and how close to the vote*

**Why this one.** `anomaly_flag_type` already carries `last_minute_agenda_change`, and **nothing
can currently substantiate it**, because no version history is kept. Meanwhile `artifacts` is
content-addressed with `sha256 UNIQUE` — meaning every distinct version of a republished agenda is
*already* preserved the moment it is fetched twice. The data model has been quietly ready for this
since migration 019. Almost all the cost is already paid.

This is the most journalistically valuable thing a commission watchdog can show: not that a
document exists, but that item 6 appeared nineteen hours before the vote and was not in the version
published the week before.

**The missing link.** On this lineage `meeting_documents` has no `artifact_id` and no version
concept — its columns are `meeting_id`, `title`, `document_type`, `url`. Artifacts and documents
have never been joined. That join is the whole feature.

```
document_versions (
  id uuid pk,
  meeting_document_id uuid not null references meeting_documents on delete cascade,
  artifact_id         uuid not null references artifacts,
  version_no          int  not null,
  first_seen_at       timestamptz not null default now(),
  unique (meeting_document_id, artifact_id),
  unique (meeting_document_id, version_no)
)
```

Because `artifacts.sha256` is unique, **a re-fetch of unchanged bytes collides and creates no new
version**. A changed document creates exactly one. Version history is therefore a consequence of
the existing fetch path rather than new bookkeeping — the fetcher writes a `document_versions` row
on every successful fetch and lets the constraints decide whether it is new.

**Diffing.** Compare extracted agenda-item text between consecutive versions, not raw PDF bytes.
Report items added, removed and retitled. Render as a two-column diff on the public meeting page
and in the console, with each side labelled by its version's `first_seen_at`.

**The finding it produces.** When a version lands within N hours of `meetings.scheduled_at`, raise
`last_minute_agenda_change` with the item list and both artifact hashes as evidence. N is
configurable per jurisdiction, defaulting to 48.

**Invariant.** The diff describes the record and nothing else. "Item 6 was added 19 hours before
the meeting" is a fact about documents. Why it was added is not ours to assert, and the generated
text must not imply it.

**Acceptance.**
- Fetching the same bytes twice creates one artifact and one version.
- Fetching changed bytes creates a second version and a computed diff.
- A version arriving inside the window raises the flag with both hashes recorded.
- The diff renders correctly when a document has exactly one version — the common case — without
  an empty or broken comparison.

---

## P6 · Full-text search over the record

**Why this one, and why now.** A6 (embeddings) was withdrawn: the operator has no OpenAI account,
OpenRouter does not serve embeddings, and nothing consumed vectors anyway. But the underlying want
— *find me everything about this* — is real and is most of what makes an archive useful rather than
merely present.

**PostgreSQL full-text search answers it with no vendor, no API key, no per-call cost and no
dimension decision.** It is the honest replacement for the withdrawn work, and it removes the
temptation to reach for an embeddings provider to solve a problem `tsvector` already solves.

There is currently no FTS anywhere in the codebase — no `tsvector`, no `to_tsquery`. Greenfield.

**Design.**

- A generated `search_vector tsvector` column with a GIN index on `agenda_items` (title,
  description), `meetings` (title), `members` (name, title) and the extracted text of artifacts.
- Weighting: title `A`, description `B`, body `C`, so a title match outranks a passing mention.
- Query with `websearch_to_tsquery`, which accepts quoted phrases and `-exclusion` the way a person
  expects, rather than making users learn `&` and `|`.
- `ts_headline` for result snippets, so a result shows the matching sentence rather than a title
  alone.
- One public endpoint `GET /api/search?q=`, paginated, returning typed results discriminated by
  kind. Public and unauthenticated — this is open data.
- **Only published records are searchable.** The `published_at` gate from P2 applies here, or
  search becomes a hole straight through the review process.

**Deliberately not built:** fuzzy matching, synonyms, and semantic similarity. If exact-and-stemmed
search proves insufficient in practice, that is the evidence that would justify revisiting
embeddings — with a real requirement attached, rather than because the table was there.

**Acceptance.**
- A meeting whose agenda mentions a term is returned; one that does not is not.
- Results are ranked with title matches above body matches.
- An unpublished record never appears, asserted by a test.
- Search of an empty database returns an empty result set rather than an error.

---

## P7 · Public-records request generator

**Approved by the operator 2026-08-09.** Depends on B-d, which introduces `records_requests`.

**The idea.** Every gap the system already knows about is an opportunity: a meeting with no
minutes, a document behind the Akamai wall, a source marked disabled, an agenda referencing an
exhibit that was never published. Each of those can offer a **pre-filled Montana public-records
request** naming the custodian, the record and the statute — tracked through the same
`records_requests` table, so a gap becomes a request becomes an artifact becomes a published
record, in one loop.

This closes the circle the project's own scraping policy already commits to: the public-records
route must be offered alongside the vendor-robots exception. Right now that offer is a sentence on
a page. This makes it a button.

### Legal grounding — probed 2026-08-09, and it changed the design

Verified against **Montana Code Annotated 2025** at `mca.legmt.gov`, Title 2, Chapter 6, Part 10:

| Cite | Title |
|---|---|
| §2-6-1003 | Access to public information — safety and security exceptions — additional exceptions |
| §2-6-1006 | Public information requests — fees |
| §2-6-1009 | Written notice of denial — failure to meet response deadline — civil action — costs to prevailing party |

From §2-6-1006, verbatim findings:

- acknowledge receipt **within 5 business days** of the designated contact receiving the request;
- respond **within 90 days**, unless the agency gives written notice explaining why that is not
  feasible;
- if the *requester* does not answer an agency's clarification request **within 30 days**, the
  agency may close the request after notifying them.

**The trap, and the reason this section is written this way.** Those deadlines are stated for
*"an executive branch agency"* and *"a public agency that is not a local government."* Gallatin
County and the City of Bozeman **are local governments** and fall under a different subsection of
the same statute. A generated letter that cites "5 business days" to a county would be wrong.

Both sections are additionally marked **(Temporary)** in the 2025 edition, meaning these versions
carry effective and termination dates and will be superseded.

**Therefore: no statutory text, citation or deadline is hardcoded.** They are per-jurisdiction
configuration carrying their own provenance:

```
jurisdiction_records_law (
  jurisdiction_id   uuid pk references jurisdictions on delete cascade,
  statute_citation  text        not null,   -- e.g. 'Mont. Code Ann. § 2-6-1006'
  statute_url       text        not null,   -- the exact page the text was read from
  acknowledge_days  int         null,       -- null means "not established for this class"
  respond_days      int         null,
  custodian_name    text        null,
  custodian_email   text        null,
  custodian_address text        null,
  verified_on       date        not null,   -- when a human last checked this against the source
  verified_by       uuid        null references operators,
  notes             text        null
)
```

`verified_on` is the load-bearing column. The console surfaces a warning when it is older than a
year, because a statute that moved under us is exactly the failure this table exists to prevent.

### Design

- **Trigger points.** A "Request this record" action appears wherever the system knows something
  is missing: a meeting with no minutes document, a source in the disabled state, a failed fetch
  job, an agenda item referencing an unpublished exhibit.
- **The letter is a draft, never a send.** The generator produces text and a `records_requests`
  row in `draft`. The operator reads it, edits it, and sends it through their own email. **The
  application does not transmit legal correspondence on anyone's behalf.**
- **Template.** Requester details, the specific record with the meeting date and document title,
  the citation and deadline drawn from `jurisdiction_records_law`, a fee-waiver request where
  applicable under §2-6-1006, and a delivery preference for electronic copies.
- **Public version.** The same generator, unauthenticated, on the public site. A reader can
  produce the identical letter for the same gap and send it themselves. This is the statutory
  route the methodology page promises, made real. The public version creates no database row.
- **Closing the loop.** When documents arrive they attach to the request through B-d's upload
  path, become `artifacts`, and flow through the identical pipeline as a scraped document.

### Invariants

- The letter states what record is sought and cites the statute. **It does not allege
  wrongdoing, delay, or bad faith** — a request is not an accusation, and this project's rule
  against asserting motive applies to correspondence as much as to findings.
- Generated text is reviewed by the operator before it leaves the building. Nothing auto-sends.
- If `jurisdiction_records_law` has no row for a jurisdiction, the generator **refuses** rather
  than falling back to a generic citation. A confidently wrong statute is worse than no letter.

### Acceptance

- A meeting missing minutes offers the action; one with minutes does not.
- Generating creates a `records_requests` row in `draft` and sends nothing.
- A jurisdiction with no `jurisdiction_records_law` row produces a clear refusal naming what is
  missing, not a letter with a placeholder citation.
- A `verified_on` older than one year renders a warning in the console.
- The public generator produces identical text and writes no row.

### Correction to a mockup

Screen 06 of the approved mockups displays "Days open 16 · statutory guide: 10". **That figure was
invented and is wrong.** It must be replaced by the per-jurisdiction value from
`jurisdiction_records_law`, or omitted entirely where none is established. Recorded here so the
error is corrected rather than implemented.

## Sequencing

```
P1 ─┬─▶ P3  (ships together; P1 creates the risk P3 covers)
    ├─▶ P4  (second source, once one source is proven)
    ├─▶ P5  (needs fetches to produce versions)
    └─▶ P6  (needs records to index)

A1 ─▶ P2   (console is behind operator auth)
B-d ─▶ P7  (extends records_requests)
```

P1 and P3 first, together. Then P2, which makes everything after it observable. Then P4, P5, P6 and
P7 in whatever order suits — they are independent of each other.

**One task belongs to nobody yet and should be done first, because it is cheap and blocks P7:**
populate `jurisdiction_records_law` for Bozeman and Gallatin County. That means a human reading the
correct subsection of §2-6-1006 for local governments — the one this document could not extract —
and recording the deadlines with a `verified_on` date. It is twenty minutes of reading and it is
the difference between a letter that is right and a letter that is confidently wrong.

## Invariants

Unchanged from `CLAUDE.md` and the development skill. Restated because P5 and P6 are the two items
most able to breach them:

- No unsourced claim reaches the public site. The diff cites both artifact hashes.
- Nothing naming a person auto-publishes.
- Describe the record, never the motive.
- Detection logic applies identically to every entity class.
- Failures are disclosed, not swallowed.
- Never silence a type error; never delete a test to go green.
