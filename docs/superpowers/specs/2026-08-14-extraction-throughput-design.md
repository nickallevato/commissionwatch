# Corpus throughput

> Design of record for roadmap §5. Written 2026-08-14.
>
> **This is the binding constraint on everything else in the roadmap.** `/api/data` publishes
> **1 meeting, 0 votes, 0 findings**. Feeds, Discord, the receipt, SSR and the MCP endpoint are all
> distribution, and there is nothing to distribute. A perfect delivery system over one meeting is a
> demo.

The order below is the order to build in. Each step removes a specific reason the corpus is empty.

---

## 1. The silent 20%: `OpenRouter returned no message content`

`openrouter.ts:279` throws `new OpenRouterError("OpenRouter returned no message content", …)` when
`readMessageText` returns null. It is non-retryable, it carries no diagnosis, and it lands in
`extraction_runs.failed_chunks` as a string that says nothing. Roughly a fifth of every document
goes unread this way and nobody can say why.

**Start by widening the error, not by fixing it.** The cause is not known and guessing at it is how
this project's history records people wasting days. The completions payload carries the answer in
fields the current code discards:

- `choices[0].finish_reason` — `length` means the reply was truncated and `DEFAULT_MAX_TOKENS`
  is still too small for this document class. `content_filter` means the model refused, which for
  minutes naming people in a dispute is entirely plausible and is a *completely* different fix.
  `stop` with no content means the model emitted nothing.
- `choices[0].native_finish_reason` — provider-specific and often more precise.
- a top-level `error` object — OpenRouter returns HTTP 200 with an error body in some upstream
  failure modes, which is exactly the shape that reaches this branch.
- `choices` being empty or absent at all, which is a different fault from a choice with no content.

The error message must name which of these it saw, and `failed_chunks` must record it structurally
(`{ index, error, finish_reason, native_finish_reason }`) rather than as prose. Then run the
existing corpus and **read the distribution before changing anything else.** The fix follows the
data; the data does not exist yet.

Two things are already known and should not be re-derived: the reply ceiling has been raised twice
on evidence (2048 → 3000 → 8000, each time for a measured truncation), and reasoning models are
disqualified — `nemotron-3-super-120b` produced 27,000 characters of deliberation and zero JSON on
nine chunks of minutes that plainly record a 5-0 vote. Whatever the distribution shows, do not
reintroduce a reasoning model as the fix.

**Retryability.** A `length` finish is retryable with a smaller chunk. A `content_filter` finish is
not retryable at all and must surface as a distinct, visible outcome — "this document could not be
read by the model" is a fact the status page should state, not a chunk that silently reads as empty.
The current blanket `retryable: false` is wrong for at least one of these cases.

## 2. Extraction becomes a queue stage

`routes/admin/pressroom.ts:387` does this:

```ts
void runExtraction({ db, read: downloadDocument, client }, id).catch(…)
```

An unawaited promise in a request handler. `run.ts`'s own header defends being "a service called by
a route rather than a CLI script", and that part is right — but the route should *enqueue*, not
*execute*. As written:

- A deploy or a restart mid-run loses the work. `extraction_runs` is left `running` forever, and the
  `CHECK ((status = 'running') = (finished_at IS NULL))` constraint means it stays that way.
- There is no concurrency control. Two operators, or one impatient one, run overlapping extractions
  against a per-minute-rate-limited free tier and both degrade.
- There is no backpressure and no queue depth to look at. "How much of the corpus is unread" is
  currently unanswerable.
- It cannot be scheduled. A nightly sweep over unextracted meetings has nowhere to live.

The project already has the right mechanism and uses it for everything else: `services/ingestion/`'s
Postgres `SKIP LOCKED` queue, with stages `discover | fetch | parse | analyze`.

**Add `extract` to `IngestionStage`.** It sits after `parse`. Like every stage after `fetch`, it
reads stored artifacts and never touches the network for source data — the queue's own header states
that invariant, and extraction honours it: the only network call is to OpenRouter, which is not a
source.

Consequences that come free and are the point of doing it this way:

- Restart safety, retry with backoff, and a visible `blocked` state, all from the existing worker.
- `ingestion_jobs` rows carry the failure text, and the public status page already reads from them.
  "Failures are disclosed, not swallowed" starts applying to extraction.
- Concurrency is one knob, set low, because the free tier is per-minute rate-limited.
- The **governor** (spec §3) becomes a second stage — `judge` — on the same mechanism, rather than a
  second bespoke loop. Both specs should land on this.
- A scheduled backfill is a job enqueuer, nothing more.

The admin route keeps its shape: `POST` enqueues and returns the job id; `isExtracting`/`listRuns`
already exist to report on it.

**`extraction_runs` stays.** It is the model-facing ledger — chunks, proposed, verified, stored,
rejected, served models — and `ingestion_jobs` is the work ledger. Two ledgers, two questions. The
job row references the run.

## 3. The roster, and why it gates the corpus

`verify.ts` rejects `not-an-official` using `namesAnOfficial` against `RECORDED_OFFICES`
(`mayor`, `deputy mayor`, `commissioner`) plus the `members` table. That check is only as good as
the list behind it, and **no sourced roster could be found on 2026-08-11.** Seed data deliberately
names no real person, and seeds never run in production.

This is not a nice-to-have: it is a correctness gate on every claim. Too small a roster rejects true
claims about real officials; a roster assembled from the model's own output would let a hallucinated
name validate itself.

**Probe before designing.** The candidates, in order of preference:

1. The jurisdiction's own published roster page — Bozeman via `bozeman.granicus.com` (the
   `bozemanmt.gov` door is an Akamai wall and stays closed), Gallatin via CivicPlus.
2. The Montana Secretary of State / CERS, which is structured and already an adapter target for
   campaign finance. An elected official has filings.
3. The minutes themselves — attendance rolls name every member present, at every meeting, with their
   title.

Option 3 is tempting because the data is already in hand, and it is the one to be most careful with:
a roster derived from documents the extractor also reads is close to circular. It is acceptable only
as *corroboration* — a name that appears in an attendance roll of N meetings, extracted by
deterministic parsing rather than by the model, and reconciled against option 1 or 2.

Whatever the source, the roster is stored with provenance — where it came from, when, and the
artifact sha — and is jurisdiction-scoped and term-dated. An official is an official *for a period*,
and a claim about someone who had left office is a different error from a claim about someone who
never held it. `members` needs term columns if it lacks them; check the schema, which is the source
of truth.

**Report the roster's coverage on the status page.** "Bozeman: 5 of 5 seats sourced; Gallatin: 0 of
3" is the number that predicts the rejection rate, and it should be visible rather than inferred
from a mysterious pile of `not-an-official` rejections.

## 4. `VoteEvent` — making the tally a fact

*"The motion failed 2–3" is not currently a first-class fact in the database.*

`minute_claims` records what one named person did on one matter: eight actions, one subject, one
quote. Five claims of `voted_no`/`voted_yes` on the same matter *imply* a tally, but nothing holds
it, nothing checks it, and no page can state it. So the site can say "Sample voted no" and cannot
say "the motion failed 2–3" — which is the sentence a reader actually wants and the only one that
makes the individual votes mean anything.

The gap also loses an error check that comes almost free. Open Civic Data's `VoteEvent` is the
established shape here, and the project already targets an OCD-shaped export (spec §7), so follow it
rather than inventing a schema: a vote event has a motion, a result, counts per option, and the
individual votes that compose it.

Migration `078_create_vote_events.ts`, sketched:

```
id             uuid pk
meeting_id     uuid not null → meetings
agenda_item_id uuid null     → agenda_items
motion_text    text not null
result         text not null     -- 'pass' | 'fail' | 'tabled' | 'withdrawn' | 'unrecorded'
counts         jsonb not null    -- { yes: n, no: n, abstain: n, absent: n }
artifact_sha256 char(64) not null
quote          text not null
quote_offset   integer not null
status         text not null default 'held'
...same review/approval columns as minute_claims
```

Plus `minute_claims.vote_event_id`, nullable, linking a personal claim to the tally it belongs to.

**The check this buys:** the sum of linked claims per option must equal `counts`. A mismatch is not
silently reconciled — it means the extractor missed a member or invented one, and it should surface
as a distinct, visible discrepancy on the review screen. A tally that disagrees with its own votes is
the single loudest signal available that a document was read badly, and right now the system cannot
notice it.

**A vote event is held and approved exactly like a claim.** It names people by composition and it is
a stronger statement than any individual claim. Same wall, same queue, same rendering pin. It is not
a page of its own; it renders on the meeting page with its member votes nested under it — which is
also the layout that makes the individual claims read as record rather than as dossier.

## 5. What "enough corpus" means

A number, so this is falsifiable rather than a feeling. Before the delivery channels are worth
building:

- **Every published meeting has an extraction run that is not `failed`**, and the count of meetings
  is in the hundreds, not in the ones. The Granicus archive spans 2013–2026 and 520 meetings were
  found by following the DNS CNAME chain.
- **The unread fraction is measured and stated**, per §1 — a known 8% is fine, an unknown 20% is not.
- **`/api/data` reports non-zero votes and findings**, and the `/status` page states, per source, the
  last successful sweep and the extraction backlog depth.

## Tests the plan must require

- `readMessageText` returning null produces an error naming the finish reason it saw; one test per
  branch (`length`, `content_filter`, empty `choices`, top-level `error`).
- A `content_filter` outcome is non-retryable and lands as its own recorded state; a `length` outcome
  is retryable.
- An `extract` job survives a simulated worker restart and is re-claimed.
- Two workers do not claim the same extract job (the existing `SKIP LOCKED` test pattern).
- The roster loader refuses a roster with no provenance, and a claim about a name absent from the
  roster is still rejected `not-an-official`.
- A vote event whose linked claims do not sum to its counts is flagged and cannot be approved.
- A vote event is invisible publicly while `held`, and while its meeting is unpublished.

## Open questions

**Does extraction run automatically on newly ingested meetings, or only when an operator asks?**
Specified implicitly as automatic-via-scheduler once it is a queue stage, because a backlog nobody
triggers is a backlog. But automatic extraction over a free tier with an unmeasured failure rate
will produce a large pile of held claims and a large pile of failures at once. Recommendation: run
it automatically only after §1's distribution is known and the rate is acceptable, and until then
enqueue on operator action.

**Does a document that no model can read get a records request?** `run.ts` already says the right
thing for scanned PDFs — "it is likely a scan; the records-request route is the way to obtain a text
copy". If §1's distribution shows `content_filter` refusals on a whole document class, the same
answer applies and the records module should be able to open a request from a failed extraction run.
That is a small feature and a strong one: the system routes around its own limits through the
statutory channel rather than pretending the record does not exist.
