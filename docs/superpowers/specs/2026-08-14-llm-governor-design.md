# The LLM governor, and the claims review screen

> Design of record for roadmap §4. Written 2026-08-14. Companion to
> `2026-08-14-published-claim-design.md`, which owns what a reader sees; this spec owns what stands
> between a model's output and an operator's eyes.

## What already exists, and what it cannot do

`backend/src/services/extraction/` is pass 1, and it is stronger than most descriptions of it
suggest. `verify.ts` is 495 lines of **mechanical** checking with nine rejection reasons:
`empty-subject`, `unknown-action`, `not-an-official`, `quote-too-short`, `quote-not-found`,
`subject-not-in-quote`, `wrong-role-in-quote`, `asserts-motive`, and the matter-window check. It
locates the quote in the artifact bytes; migration 072's `NOT NULL` on `quote_offset` means a claim
that was not located cannot be stored at all. A model that invents a sentence produces no row.

That is a real wall, and it is worth being precise about what it stops: **fabricated text**. It
proves the quote is in the document, that the named subject appears in it, and that the surface
form carries no motive language.

Here is what none of that can decide:

> The quote is real, the subject is in it, and the attributed action is still wrong.

*"Commissioner Sample moved to table the item; Commissioner Fixture seconded."* A claim of
`subject_name: "Fixture", action: "moved"` passes every mechanical check — the quote exists, Fixture
is in it, Fixture is an official, no motive language. `subjectPerformedAction` does what it can with
proximity and word order, but this is a semantic judgement about which of two names attaches to
which of two verbs, and the general case is not a regex.

**That gap is the governor's entire job.** It is not a second extractor and not a quality filter. It
is one question, asked of a different model with less information: *does this span of text support
this attribution?*

## The governor's constraints

**It is a judge, never an author.** It receives the ±2,000-character window (`MATTER_WINDOW` already
exists at exactly this value) and the claim triple. It emits a verdict. It cannot propose a claim,
cannot correct one, cannot rewrite a quote, and its output never reaches a reader — the published
claim spec's rule 1 makes the rendered sentence a template fill, so there is no channel through
which governor text could surface even by mistake.

**It never sees pass 1's reasoning.** No chain of thought, no confidence score, no "the extractor
thought". A judge shown the advocate's argument agrees with it. This is the single most important
property here and it must be enforced by the shape of the input type, not by a comment: the
governor's input struct contains the window, the triple, and the quote offsets, and there is no
field it could be smuggled in.

**It is a different model from pass 1.** Same model judging its own output is a rubber stamp.
Config carries two pins, `EXTRACTION_MODEL` and `GOVERNOR_MODEL`, and startup refuses to run the
governor if they are equal. Both go through `assertFreeModel` through the prototype — the operator's
decision was "prototype and dev with free only and eventually move to more in production", so the
allowlist stays and the model is a swappable pin, not a hardcode. `DEFAULT_MODEL` is already
`nvidia/nemotron-3-nano-30b-a3b:free`; the governor default must be a different free model, chosen
at implementation time by probing what OpenRouter actually serves — do not spec a model id that has
not been probed.

**It must point, not opine.** The verdict schema:

```ts
interface GovernorVerdict {
  supported: boolean;
  /** Spans of the claim the window does not support. Required when supported=false. */
  unsupported_fragments: string[];
  /** Which sentence(s) of the window the judge relied on, as offsets into it. */
  relied_on: Array<{ start: number; end: number }>;
  confidence: "low" | "medium" | "high";
}
```

A `supported: false` with an empty `unsupported_fragments` is a **parse failure**, not a rejection —
the response is discarded and the claim is treated as un-judged. A judge that cannot say *what* is
wrong has not judged. Same for `relied_on` spans that fall outside the window or do not resolve to
text: the verdict is void. Validate against the bytes, exactly as `locateQuote` already does for
pass 1. **We do not trust the extraction, we test it against the bytes** — that principle applies to
the judge too.

**Severity is a deterministic table, and a model-proposed severity is `alwaysHold: true`.** The
governor has no severity field at all, which is the cleanest way to enforce this. If a later change
adds one, `resolveReviewState({ severity, alwaysHold: true }, policy)` is mandatory, per the pattern
`routes/anomalies.ts` already uses for hand-entered findings.

**Hallucinated-name detection stays mechanical.** `namesAnOfficial` and `officialMentions` in
`verify.ts` do this against `RECORDED_OFFICES` and the roster. Do not ask a model whether a person
exists. This is also why corpus throughput (§4) must deliver a *sourced* roster: the mechanical
check is only as good as the list behind it.

## What the governor does not gate

**The governor cannot approve.** Nothing it emits sets `status = 'approved'`. Its verdict is
metadata that orders and annotates the operator's queue.

- `supported: true, confidence: high` — the claim sits at the top of the queue, marked as
  double-checked. An operator still presses the button.
- `supported: false` — the claim is marked `governor_rejected` and **drops to the bottom of the
  queue**, with the unsupported fragments highlighted. It is not deleted. A judge with a 5% error
  rate that auto-discards is a judge that silently loses one true claim in twenty, and a
  transparency project cannot have a mechanism that quietly drops records.
- **un-judged** (API down, rate-limited, void verdict) — the claim is queued normally and labelled
  *not checked by the governor*. `blocked` is not `pass`, and it is not `fail` either.

This is the shape of the whole feature: the governor changes the **order and the annotation** of
human review. It never changes what is publishable. Every path still terminates at a person.

## Storage

Migration `077_create_claim_verdicts.ts`:

```
id                    uuid pk
claim_id              uuid not null references minute_claims(id) on delete cascade
model                 text not null
prompt_version        text not null
supported             boolean not null
unsupported_fragments jsonb not null default '[]'
relied_on             jsonb not null default '[]'
confidence            text not null
window_sha256         char(64) not null   -- sha of the exact window judged
raw_response          text not null       -- what the model actually returned
created_at            timestamptz not null default now()

CHECK (confidence IN ('low','medium','high'))
CHECK (supported OR jsonb_array_length(unsupported_fragments) > 0)
CHECK (window_sha256 ~ '^[0-9a-f]{64}$')
CREATE UNIQUE INDEX claim_verdicts_current ON claim_verdicts (claim_id, model, prompt_version, window_sha256);
```

A separate table, not columns on `minute_claims`, for three reasons: a claim may be re-judged when
the governor model changes and the history matters; `raw_response` is bulky and belongs nowhere near
a hot read path; and the unique index makes re-running the governor over unchanged bytes with an
unchanged model a no-op, the same idempotence `artifacts.sha256` gives the fetcher.

`window_sha256` pins *what was judged*. If the artifact is reissued the window changes and the old
verdict is visibly stale rather than quietly reused.

`raw_response` is stored because the first time this project disagrees with a model's judgement, the
question will be "what did it actually say", and a parsed struct cannot answer it.

Governor runs record into the existing `extraction_runs` ledger (migration 073) with a
`stage`/`kind` discriminator, rather than a parallel table. One ledger, one status page.

## The claims review screen

**Nothing writes `minute_claims.status` today, so no operator can approve a claim at all.** This
screen is the missing half of migration 072, and shipping the governor without it produces verdicts
nobody can act on.

Per the published-claim spec §5, this is the review queue with a second target kind — B-a's
`approval_requests` and `services/review/queue.ts`, not a second approval concept.

What the screen shows, per claim:

1. **The quote in situ** — ±500 characters of artifact text with the quote span marked, plus a link
   to the full artifact viewer at `/source/{artifact_sha256}#offset-{quote_offset}`. An operator who
   cannot see the sentence in context is rubber-stamping, and this is the single most important
   element on the page.
2. **The exact sentence that would publish** — rendered by the same code the public page uses. Not a
   paraphrase of it, not the triple. This is what approval pins, per published-claim §4.
3. **The governor's verdict**, with unsupported fragments highlighted inside the quote, or the words
   *not checked by the governor* when there is none.
4. **Provenance**: extraction model, prompt version, served model, run id, artifact sha.
5. **Three actions**: approve, reject with a reason, or edit-with-reason. Edit is the queue's
   existing third action and it re-renders and re-pins.

Approval writes `status`, `approved_by`, `approved_at`, `rendered_text`, `render_sha256`,
`render_version`, appends to `record_corrections`, and emits `claim.approved` — all in one
transaction, because the event-spine spec requires the event to share the publishing transaction.

**No bulk approve.** Stated in published-claim §9 and restated here because this is the screen where
someone would build it.

## Prompt versioning

`prompt_version` is already NOT NULL on `minute_claims` and nullable on `extraction_runs`. The
governor adds its own. Both are string constants in source, bumped by commit, and a claim carries
the pair. When a prompt changes, existing claims are not re-judged automatically — re-judging is an
operator action with a recorded reason, for the same reason replay is in the event spine.

## Cost and rate limits

Free-tier models are rate-limited per minute and `openrouter.ts` already backs off 2s/4s/8s and
treats 429 as retryable. The governor roughly doubles model calls per document. Two consequences the
plan must handle rather than discover:

- The governor runs as its own queue stage, after extraction, at its own rate — not inline in the
  extraction loop. This is the same "batch extraction as a queue stage, not a loop in a route"
  requirement corpus throughput (§4) makes, and both should land on the same mechanism.
- A governor backlog is visible on the status page as a count, because a silently growing backlog of
  unjudged claims looks identical to a system with nothing to judge.

## Tests the plan must require

- The governor's input type has no field that can carry pass 1's reasoning — asserted structurally
  (a test that constructs the input and enumerates its keys).
- Startup throws when `EXTRACTION_MODEL === GOVERNOR_MODEL`.
- `assertFreeModel` is enforced on the governor pin.
- `supported: false` with empty `unsupported_fragments` is treated as void, not as a rejection.
- `relied_on` spans outside the window void the verdict.
- A `governor_rejected` claim is still present in the queue, ordered last.
- An un-judged claim is queued and labelled, never dropped and never auto-approved.
- Re-running the governor over the same claim, model, prompt version and window inserts no second
  row.
- The screen's rendered sentence is byte-identical to what the public renderer produces for the same
  claim — one test, and it is the one that keeps published-claim §4's pin honest.
- Approval writes all six columns, one correction row, and one event, and rolls all of them back
  together on failure.

## Open questions

**Should a `governor_rejected` claim be visible to the operator by default, or behind a filter?**
Specified as visible-but-last. A filter that hides them by default would, in practice, make the
governor an auto-discarder with extra steps.

**Two judges instead of one?** Cheap on free tiers, and disagreement between two judges is a far
better signal than one judge's confidence field. Not specified now because it doubles the rate-limit
pressure before there is any evidence about the single-judge error rate. Revisit once there is a
measured rejection rate to look at — and *measure it*, rather than assuming the governor is right.
