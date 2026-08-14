# The published claim

> Design of record for roadmap §4, and the answer to `docs/STATUS.md` next-step 1g, which records
> this as genuinely undecided. Written 2026-08-14.
>
> **This is the highest-stakes thing this project publishes: a sentence naming a living person.**
> The rest of the system is plumbing around this decision. Section 9 lists the two points where the
> operator, not this document, should decide.

## What is being decided

`minute_claims` (migration 072) holds what the minutes say a named person did, with the line that
says it. The table has `status`, `reviewed_by`, `review_reason`, `reviewed_at` — and **nothing in
the codebase writes any of them**. No operator can approve a claim today. Every row sits `held`
forever.

So the question is not "should we build an approval button". It is: *when the button is pressed,
what appears on the public internet, at what address, in whose words, and how is it undone.*

## The five rules

Everything below follows from these. If a later change contradicts one, the change is wrong.

1. **No generated prose reaches a reader.** Not summarised, not "cleaned up", not passed through a
   model for fluency. The published sentence is assembled by deterministic code from a fixed
   template and the verified quote. A language model's output is *input to a review*, never output
   to a reader.
2. **The quote is the claim.** Everything else on a claim card is scaffolding around a verbatim
   span of a stored artifact, located by offset, that a reader can check.
3. **The operator approves exact bytes, and the bytes are pinned.** If what would render today
   differs from what the operator read, nothing renders.
4. **A claim never appears alone.** It renders inside the meeting record it came from, never as a
   standalone page.
5. **Retraction is an append, and it leaves a mark.** `record_corrections` is append-only and so is
   the public history. Nothing this project published ever silently ceases to have existed.

---

## 1. What the reader sees

The unit is a **claim card**. It has exactly six parts and no seventh:

```
┌─────────────────────────────────────────────────────────────┐
│ Avery Sample — voted no                                     │  subject + action
│ on Ordinance 2145, second reading                           │  matter
│                                                             │
│ “Commissioner Sample voted no on the motion to adopt        │  the quote, verbatim
│  Ordinance 2145.”                                           │
│                                                             │
│ Minutes, Bozeman City Commission, 12 March 2026 — page 4    │  source, addressable
│ [ read the source ]  [ this is wrong ]                      │
│                                                             │
│ Approved for publication by an operator on 14 Aug 2026.     │  provenance of the decision
│ Extracted by <model> (prompt v3), checked against the       │
│ stored document.                                            │
└─────────────────────────────────────────────────────────────┘
```

The sentence at the top is a **template fill**, not a generation:

```
{subject_name} — {ACTION_LABEL[action]}
{matter ? "on " + matter : ""}
```

`ACTION_LABEL` is a frozen map over the eight values migration 072 already constrains `action` to:
`voted_yes` → "voted yes", `moved` → "moved", `recused` → "recused themselves", and so on. Eight
strings, in a source file, changed only by a commit. There is no path by which a model's words
become the headline.

**What the card must never contain**: why. No `because`, no `after`, no `despite`, no adjective on
the action. The corrections log's existing `motiveTerms` list in `services/review/language.ts` is
already the project's definition of that line, and the claim renderer runs the assembled string
through it before it can be approved. Describe the record, never the motive.

**Absence is stated, not hidden.** A meeting with no approved claims says "No claims from this
meeting have been reviewed" — not nothing. The `<Absence>` grammar from the vocabulary spec (§8)
owns the wording.

## 2. The citation, and how it is addressed

`minute_claims` already stores `artifact_sha256` and `quote_offset`. Those are the citation. What is
missing is a public address for the thing they point at.

**Every claim card links to a stored-artifact viewer at a content address**, not to the county's
website:

```
/source/{artifact_sha256}#offset-{quote_offset}
```

Three reasons for the content address rather than a document id or an upstream URL:

- The upstream URL rots, and a citation that 404s is not a citation. This project's own history
  contains a scraper pointed at a hostname that had moved.
- The county can reissue minutes. A different set of bytes is a different artifact, and the old
  claim must keep pointing at what it was actually read from — which is precisely why 072 stores a
  sha and not an FK.
- A reader who wants to verify independently can hash the file they downloaded and compare.

The viewer renders the artifact text with the quote span highlighted, and states its own provenance:
the fetch URL, the fetch time, the sha256, and the HTTP status. The upstream link is shown *as well*,
labelled as "where we got it", so a reader can go check the source of the source.

The artifact viewer is public **only** for artifacts whose meeting is published — the same wall,
reached through the same helpers. An artifact with no meeting follows the records path.

## 3. Whether a claim is its own page

**It is not.** This is the one place where reach and safety pull in opposite directions, and safety
wins.

Roadmap §8 wants one URL per meeting, per agenda item, and per finding, because ~69% of AI crawlers
execute no JavaScript and a per-claim URL would be a clean citable atom. That argument is real. It
loses anyway, for two reasons:

- **A page whose entire content is one sentence about one named person is an accusation.** Strip a
  procedural vote of the meeting it happened in and what remains reads as a dossier entry. The
  context is not decoration; it is the difference between a record and a charge.
- Thin, near-duplicate, person-named pages generated in bulk are exactly the shape a search engine
  demotes and a defamation claim likes.

So: **a claim is addressable but not a page.** It renders in two places, both of which carry
context:

- the meeting page, in agenda order, at `#claim-{id}`
- the official's page, grouped by meeting, at the same anchor, each row linking back to the meeting

Both are server-rendered per §7, both carry the claim in the HTML rather than behind a fetch, and
both get `Event`/`Person` JSON-LD naming the source document. That gets the reach without the
standalone-dossier page.

**Findings keep their own pages.** A finding (`anomaly_flags`) is an assertion about a pattern, it
already has a public route, and it is not a single sentence about a single person. Different object,
different rule.

## 4. What the operator approves, exactly

**The rendered sentence, byte for byte, plus the quote.** Not the triple, not "the claim".

The reason is concrete. `subject_name`, `action`, and `matter` are three fields, and the rendered
sentence is a function of those *and* of `ACTION_LABEL` *and* of the template. Approving the triple
means approving a function of code that can change after the approval. An operator who approved
"Avery Sample — abstained" would, after a well-meaning label edit, be publishing "Avery Sample —
declined to vote" over their name and timestamp, having never read it.

Migration `076_add_claim_publication.ts` adds to `minute_claims`:

```
rendered_text          text        null   -- the exact string approved
render_sha256          char(64)    null   -- sha256 of rendered_text
render_version         text        null   -- template + label-map version, e.g. 'claim-render@1'
approved_by            uuid        null
approved_at            timestamptz null
retracted_at           timestamptz null
retracted_reason       text        null

CHECK (status <> 'approved' OR (rendered_text IS NOT NULL
       AND render_sha256 ~ '^[0-9a-f]{64}$' AND approved_by IS NOT NULL))
CHECK (retracted_reason IS NULL OR retracted_at IS NOT NULL)
```

(`reviewed_by`/`reviewed_at` already exist and record *that a decision was made*; `approved_by`/
`approved_at` record *an approval to publish*. Keeping them separate means a rejection and an
approval are not the same shape of row. If the plan finds that distinction is not carrying weight,
collapsing them is acceptable — but it is a decision to make deliberately, not by accident.)

**The pin, and what it does when it breaks.** At render time the public path recomputes the string
from current code and compares its sha to `render_sha256`. On mismatch: **the claim does not
render**, the meeting page shows "One claim from this meeting is awaiting re-review", and an ops
event fires. It does not fall back to the stored `rendered_text` — that would publish a sentence
whose meaning the current code no longer agrees with — and it does not silently re-approve.

`render_version` exists so that a deliberate template change can be handled as a batch: bump the
version, and every claim pinned to the old one goes back to the queue with a reason that says why.
That is a visible, auditable, operator-facing event, and it is *supposed* to be inconvenient. The
inconvenience is the mechanism.

## 5. Approval is the review queue, not a second thing

The brief is explicit and it is right: follow B-a rather than inventing a second approval concept.

`approval_requests` (migration 038) already generalises over a target; `services/review/queue.ts`
already enforces "a finding with no citation cannot be approved" (409), already appends every
decision to `record_corrections`, and already derives overdue rather than writing it. Claims join
that queue as a second target kind.

Three things carry over unchanged and one is new:

- **No citation, no approval.** For a claim this is automatic — 072's NOT NULL on `quote_offset`
  means an uncited claim cannot exist — but the queue's check stays, because the queue must not
  depend on another table's constraint to be safe.
- **Rejection leaves the claim un-publishable** by the same rule that keeps an unreviewed one
  un-publishable. `minute_claims.status` has a `rejected` value; the wall keys on `approved`.
- **Every decision appends to `record_corrections`.** `minute_claims` must be added to
  `CORRECTABLE_TABLES` in migration 031's constraint, by a new migration.
- **New: the queue shows the quote in its artifact context**, ±500 characters, with the quote span
  marked. An operator approving a sentence they cannot see in situ is rubber-stamping. This is the
  claims review screen, specified in the LLM governor spec (§3), and it is the same screen.

## 6. Publication wall, and a live trap

The wall for claims:

```ts
export function whereClaimPublic<T extends Knex.QueryBuilder>(db, query, table = "minute_claims"): T
```

in `services/publication.ts`, alongside its two siblings, with the same shape: `status = 'approved'`
**and** `retracted_at IS NULL` **and** its meeting is published. Public read paths use it; the
operator console does not, for the reason `publication.ts`'s header already gives — a mechanism that
hid unpublished rows from every reader would hide them from the person whose job is to decide.

**The trap, recorded here because it is live in the schema today:** migration 027 gave
`anomaly_flags.review_state` a default of `'published'`. A bare insert into that table is public.
The detectors set it deliberately and the routes are guarded, so nothing leaks now — but the default
is the wrong way round, and it is why `POST /api/anomalies` needed `alwaysHold: true` hardcoded.
`minute_claims.status` correctly defaults to `'held'`. Do not copy `anomaly_flags`' default into any
new table, and the plan should carry flipping it to `'held'` as a follow-up with the audit of every
insert site that would need to change.

## 7. Retraction

`record_corrections` is append-only. Public history should be too.

A retraction sets `retracted_at` and `retracted_reason`, appends a `record_corrections` row, and
emits `claim.retracted` per the event-spine spec. It **never** deletes the row and never blanks
`rendered_text`.

What the reader sees afterwards, at the same anchor:

```
This claim was withdrawn on 20 August 2026.
It previously read: “Avery Sample — voted no on Ordinance 2145, second reading.”
Reason: the minutes were reissued and the vote is recorded differently.
[ read the current minutes ]
```

Showing the withdrawn text is not obviously right and deserves its defence: a person named in a
retracted claim generally wants it *gone*, not quoted. But the claim was published; it is in caches,
feeds, and possibly a Discord channel. A reader who arrives from one of those needs to land on a
page that says *that specific sentence was wrong*, not on a page that shows nothing and leaves the
cached version as the only version they ever see. Silence is not a correction, and a transparency
project that quietly unpublishes is doing the thing it exists to detect.

The tombstone is `noindex` and excluded from the sitemap and every feed except the retraction item
itself. It does not need to be found again; it needs to be there when someone arrives.

**Every published claim carries "this is wrong"** — the existing `record_disputes` path (migration
039). A subject who wants to contest is not required to find a contact page.

## 8. Tests the plan must require

- An `approved` claim on an unpublished meeting is invisible on every public path (mirror
  `meeting-publication.test.ts`).
- A `held` claim, a `rejected` claim, and a retracted claim are each invisible; each is a separate
  test because each is a different predicate.
- A claim whose `render_sha256` does not match a re-render does not render, and the page says so.
- The rendered string fails approval if it contains a `motiveTerms` match.
- `ACTION_LABEL` covers exactly `CLAIM_ACTIONS` — a test that iterates the constant, so adding a
  ninth action to the migration fails the suite until it has a label.
- Approving a claim appends exactly one `record_corrections` row and emits exactly one event.
- Retraction preserves `rendered_text` and the public page shows the tombstone.
- Two claims for the same meeting render in agenda order, and their anchors are stable across
  re-render.

## 9. What the operator should decide, not this spec

**a. Does the subject get notice before publication, or only a dispute route after?**

> **Settled 2026-08-14** by `2026-08-14-notification-and-dispute-loop-design.md` §b: **notice at
> publication, not before**, carrying the dispute link, sent to the seat's published contact address
> of record. Pre-publication notice would hand a subject a window to object to an accurate record
> and turn publication into a negotiation. Notice at publication with a working reply loop gives the
> subject the thing that matters — prompt, answered contest — without giving anyone a veto.

The original framing, kept because it is the trade-off: every claim names a living person, the
officials are a known finite set with public email addresses, and a 48-hour "we are about to publish
this, here is the quote" notice is both ordinary journalistic practice and a strong defence. It also
slows the pipeline and hands a subject a window to object to accurate records.

**b. Does a claim about a person who is no longer in office publish the same way?**

Specified above as yes — the record is the record. Worth a deliberate answer rather than a default,
because the public-interest justification for naming someone is strongest while they hold the
office.

Two further open items, lower stakes:

- **`rundown_sheets`** has had no writer since the `agents/` deletion. The claim card is what that
  table was reaching for. Recommendation: retire it in the migration that adds §4's columns rather
  than leave a dead table that a future reader mistakes for a plan.
- **Bulk approval.** Not specified, deliberately. A screen that approves forty claims in one click
  is a screen that publishes forty unread sentences about named people. If throughput becomes the
  binding constraint, the answer is a better single-claim screen, not a checkbox column.
