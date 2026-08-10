# Match quality in the review queue

**Date** 2026-08-10 · **Branch** `feat/archive-salvage` · **Base** `599f054`

## The inversion

A `vote_donor_conflict` finding rests on a fuzzy name match. `name-match.ts` models that
uncertainty honestly — a band (`weak` / `moderate` / `strong`, with nothing above `strong`),
a score, the terms that matched, the terms that did not, and the terms the matcher was blind
to — and `evidence.ts` stores all of it on the finding so an approved claim keeps meaning
what it meant when a human read it.

`DonorOverlay.tsx` renders every bit of that to the **public**: a chip carrying
"— not a verified identity" in the chip itself, and a disclosure listing matched, unmatched
and ignored terms.

`AdminReviewPage.tsx` renders **none** of it. So the reader is told how uncertain a claim is
and the operator being asked to approve it is not. The person making the decision has less
information than the person receiving it.

Everything below fixes that, and then goes one step further: an operator's judgement about
whether two names are the same entity is currently thrown away the moment they close the tab.

## Scope

1. Surface the match on the review card — band, score, matched / unmatched / blind terms.
2. Let the queue be worked by match quality — filter and sort by band.
3. State the weak-match policy instead of burying it in a `continue`.
4. Remember an operator's entity-resolution judgement, reuse it, and audit it.

## Decisions taken before any code

### D1 — The evidence is parsed server-side, exactly once

`evidence.ts` says every reader comes back through `parseVoteDonorEvidence`. The review queue
will not be the exception that parses `jsonb` in the browser. `QueueItem` grows an
`evidence: VoteDonorEvidence | null` field, filled by the same parser the officials API uses.
A finding whose metadata does not parse renders as a finding with no match panel, never as a
partial one.

### D2 — The band chip is one component, shared with the public page

`MatchConfidenceChip` already exists in `DonorOverlay.tsx` and already carries
"— not a verified identity" inside the chip. Moving it to
`frontend/src/components/officials/MatchQuality.tsx` and importing it from both surfaces is
the only way the two can never drift into saying different things about the same band. The
existing tests that assert no label reads as certainty then cover both surfaces at once.

### D3 — A weak match stays out of the queue, and the drop becomes a stated policy

`MINIMUM_MATCH_BAND` stays `moderate`. Raising weak matches would flood the queue with
coincidences — a single common term shared between a donor name and an agenda item is not
evidence of anything, and a queue full of them is a queue nobody reads.

But a threshold expressed only as `if (!bandAtLeast(...)) continue` is a policy nobody can
find. Three changes make it findable:

- `correlateVoteDonorsWithDiagnostics` returns `{ drafts, withheld }`, where `withheld`
  tallies what was considered and not raised, by band and by reason.
  `correlateVoteDonors` becomes a one-line wrapper, so every existing caller and test is
  untouched.
- The policy itself becomes an exported, described value — `MATCH_POLICY` — carrying the
  minimum band, the band labels, and the sentence explaining the drop. The API returns it on
  the queue listing.
- The review page renders that sentence in a `FlagBar` above the queue.

**Deliberately not done: persisting the withheld tally.** A row per considered-and-dropped
coincidence is a table that grows with the product of donors and agenda items and answers no
question anyone has. The diagnostics exist so the rule can be tested and so a future operator
report can be built from a pure function; nothing writes them to disk in this change. That is
a decision, stated here, not an omission.

### D4 — An entity-resolution decision keys on the pair, not the finding

The pair an operator actually judges is *"the donor filed as X"* against *"the thing named in
the agenda item"*. The only durable handle on the second is the set of distinctive terms the
matcher found — the agenda item id changes every meeting, the finding id changes every sweep,
and the raw item text is a sentence. So the key is:

```
(donor_terms, subject_terms)
```

both being sorted, space-joined lists of **distinctive** terms — the donor's through the same
`splitTerms` the matcher uses, the subject's being `donorMatch.matchedTerms`. That pair is
byte-stable across sweeps and across meetings, which is exactly the reuse being asked for:
an operator who has decided that the donor "Anderson Ridge LLC" is *not* the "Anderson" named
in agenda items has decided it once.

**Corrected during implementation.** The first draft keyed the donor half on
`normalizeName(donorName)`, and the tests caught it being wrong twice over. "Ridgeline
Aggregate LLC" and "RIDGELINE AGGREGATE, L.L.C." are one company filed by two clerks and
produced two keys, so a judgement had to be made twice. Worse, "Ridgeline Aggregate LLC" and
"Ridgeline Aggregate Union" also produced two keys — which would have made a stored judgement
depend on what class of organisation the donor is, on a code path whose governing invariant is
that detection applies identically to every entity class. Routing the donor half through
`splitTerms` discards the class word before the key is built, exactly as `name-match.ts` does,
so uniform treatment holds by construction rather than by anybody remembering it.

Two decisions, and they are not symmetric:

- **`different_entity` suppresses.** The finding is not raised on the next sweep. This is the
  operator saying the link is a coincidence, and re-raising it would be asking the same
  question again after they answered it.
- **`same_entity` does not publish.** It annotates. The finding is still raised, still
  `held`, still needs an explicit approval with a stated reason. Nothing in this change
  publishes a finding as a side effect.

Changing your mind updates the row and appends another `record_corrections` entry, so the log
holds the whole sequence. The decisions table is *not* append-only — it is current state — and
the audit trail beside it is. One log, not two.

### D5 — Nothing branches on entity type

The decision is stored against distinctive terms with every entity-class word already removed. There is no column for
what kind of thing the donor is, no branch on one, and no way to write one without adding a
column somebody would have to justify. Uniform treatment survives by construction, as it does
in `name-match.ts`.

### D6 — No PII

The new table stores a donor's filed **name** and the matched terms. No address, occupation,
employer, phone, email or residence city. `finance-pii-guard.test.ts` gets a case for the new
table so this is enforced rather than asserted.

## Tasks

### T1 · Migration `070_create_entity_resolution_decisions.ts`

- `id` uuid pk, `gen_random_uuid()`
- `donor_terms` text not null — the donor's distinctive terms, sorted, space-joined
- `subject_terms` text not null — matched distinctive terms, sorted, space-joined
- `donor_name_filed` text not null — as filed, so the console can show what a human would recognise
- `decision` text not null, CHECK in (`same_entity`, `different_entity`)
- `reason` text not null, CHECK non-empty
- `operator_id` uuid null, `operator_email` text null — snapshotted, no FK, migration 031's reasoning
- `created_at`, `updated_at` timestamptz not null
- unique (`donor_terms`, `subject_terms`)
- widen `record_corrections_target_table_check` to add `entity_resolution_decisions`
- `down` narrows the CHECK back and drops the table

No import from `../src/` — the band and decision literals are written out, as migration 031
writes out `CORRECTABLE_TABLES`.

### T2 · `backend/src/services/finance/entity-resolution.ts`

- `pairForEvidence(evidence)` / `pairFor(name, terms)` → `{ donorTerms, subjectTerms, donorNameFiled }`, pure
- `pairKey(pair)` → `donorTerms + ":" + subjectTerms`; the separator is a colon because both
  halves are space-joined term lists and a space would let two different pairs collide
- `loadEntityDecisions(db)` → `Map<string, StoredEntityDecision>` keyed on `pairKey`
- `recordEntityDecision(db, input)` — upsert plus `appendCorrectionRow`, in one transaction
- `listEntityDecisions(db)`

### T3 · `correlation.ts`

- `MATCH_POLICY` exported: `{ minimumBand, bands, statement }`
- `correlateVoteDonorsWithDiagnostics(input)` → `{ drafts, withheld }`
- `correlateVoteDonors` becomes `(input) => correlateVoteDonorsWithDiagnostics(input).drafts`
- `CorrelationInput.entityDecisions?: ReadonlyMap<string, EntityDecisionState>`
- a `different_entity` decision suppresses the draft and is counted in `withheld`
- a `same_entity` decision is carried into the evidence as `operatorEntityDecision`
- `checkVoteDonorConflict` loads the decisions and passes them in

### T4 · `evidence.ts`

- `VoteDonorEvidence.operatorEntityDecision: StoredEntityDecision | null`
- parsed and serialised like everything else; absent parses to `null`

### T5 · `review/queue.ts` and the route

- `QueueItem.evidence: VoteDonorEvidence | null`
- `QueueItem.entity_decision: StoredEntityDecision | null`
- `QueueFilters.band?: MatchBand` — SQL on `metadata->'donorMatch'->>'band'`
- `QueueFilters.sort?: "default" | "weakest_first"` — findings with no band sort last, and the
  default ordering (overdue first, then oldest) is unchanged
- `QueueListing.match_policy`
- `POST /api/admin/review/queue/:id/entity-resolution` — `{ decision, reason }`

### T6 · Frontend

- `MatchQuality.tsx`: `MatchConfidenceChip` (moved), `MatchQualityPanel` (new)
- `DonorOverlay.tsx` imports the chip rather than defining it
- `types/index.ts`: `evidence`, `entity_decision`, `match_policy`, filter params
- `AdminReviewPage.tsx`: the panel above the buttons, a `SegmentedControl` for the band filter,
  a `SegmentedControl` for the sort, the policy `FlagBar`, and the two entity-resolution buttons

### T7 · Tests

- `backend/test/entity-resolution.test.ts` — new, registered in `package.json`
- extend `vote-donor-correlation.test.ts`, `review-queue.test.ts`, `finance-pii-guard.test.ts`
- `frontend/src/pages/AdminReviewPage.test.tsx`, `MatchQuality.test.tsx`

## Gate

```
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baselines: backend 1108, frontend 430 / 42, deploy 61 / 0, zero lint errors.

## Result

- backend **1141 / 1141** (+33, all in `test/entity-resolution.test.ts`)
- frontend **443 / 443** across 42 files (+13)
- deploy **61 / 0**
- backend lint: 0 errors, the 2 standing warnings; frontend lint: **0 problems**
- migration 070 verified from an empty database (45 migrations, batch 1)

### One exemption added to the PII guard, narrowly

`entity_resolution_decisions.operator_email` — the audit actor's own address, snapshotted the
same way `record_corrections.operator_email` and `approval_requests.reviewer_email` are
everywhere else. The exemption is a set of full `table.column` strings rather than a pattern,
so it cannot widen: a `donor_email` anywhere, or an `operator_email` added to
`campaign_contributions`, still fails the scan.
