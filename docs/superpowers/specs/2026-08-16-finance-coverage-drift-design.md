# Finance coverage drift — when "we do not read CERS" stops being true

**Status: SPEC ONLY. The guard is built; the wording change is not.** Written 2026-08-16 during the
third autonomous loop. The loop stopped here because the thing to change is **published text about
this project's own sourcing**, and getting it wrong misleads a reader about a named official's
donors in one direction or the other.

---

## What was found

`backend/src/services/finance/coverage.ts` publishes, on every finance surface:

> "Contribution records here come from the Federal Election Commission only. City and county
> officials generally do not file federally, so an empty result means no federal filing was found —
> it is not a statement that an official received nothing. **Montana state and local filings are held
> by CERS, which this site does not yet read.**"

That sentence, and the `state: "planned"` entry for `mt_cers`, are **hardcoded literals**. The
module's own docblock promised otherwise — it said that when the adapter landed, "its entry moves to
`active` … and every panel starts telling the truth about it without a single component changing."
Nothing moves it. Both strings must be edited by hand.

Two facts make this live rather than theoretical:

1. **The adapter landed on 2026-08-10** — `ingestion/adapters/mt-cers.ts`, registered *disabled*,
   with a real rate-limited sweep of 384 filers, 35 filed reports and 127 itemised transactions. The
   docblock claiming "no adapter in this codebase" was false for six days. It is corrected now.
2. **The only thing keeping the sentence true in production is that the source is disabled.** One
   operator action — enabling CERS — makes the site render CERS-derived contribution figures on the
   same page as a sentence saying it does not read CERS.

Nothing would have failed. Not a test, not a typecheck, not the monitor. The site would simply have
published a false statement about its own sourcing, on the surface built to keep its sourcing honest.

## What was built instead of a fix

`backend/test/coverage-drift.test.ts`. It fails when any `source_system` with rows in
`campaign_contributions` or `campaign_expenditures` is still listed as `planned`, and it fails when
`mt_cers` is marked `active` while the caveat still names CERS as unread.

Mutation-verified in both directions: marking CERS active while the caveat stands fails test 3;
inserting one CERS contribution row fails test 2, naming `mt_cers`.

**The guard converts a silent future lie into a loud test failure.** That was the part that could not
wait for a decision.

## Why the wording was not changed automatically

The obvious fix — derive `state` from whether rows exist — has a case it gets wrong, and the wrong
answer is published.

**A system that was swept and genuinely returned nothing is not a system that was never consulted.**

- If CERS is enabled, sweeps an official, and finds no contributions, a row-derived rule reports
  `planned`. The page then tells the reader that Montana filings are unread — so an empty donor panel
  reads as *our gap*. The reader concludes nothing about the official, when in fact the record
  genuinely showed nothing.
- The opposite error is worse. If the table claims `active` for a system never actually consulted, an
  empty donor panel reads as *the official received nothing*. That is a false impression about a
  named person, produced by our own disclosure, and it is the exact failure `coverage.ts` was written
  to prevent.

So the two directions are not symmetric, and no single boolean derived from row counts distinguishes
them. **Coverage is a statement about what was consulted, and row counts are evidence about what was
found.** Conflating the two is the root error.

## Options

### Option A — derive from the sweep, not from the rows *(recommended)*

`state` becomes `active` when the `ingestion_sources` row for that system is enabled **and has a
successful sweep**, regardless of how many records came back. That is exactly the claim the word
"consulted" makes.

- **Cost:** `financeCoverage()` becomes async and reads the database; four call sites change
  (`routes/officials.ts`, `services/officials.ts`, `services/finance/correlation.ts`,
  `scripts/finance-sync.ts`).
- **Benefit:** the sentence becomes true by construction, and the swept-but-empty case reports
  honestly — "we looked, and found nothing" — which is the case with the most potential to mislead.
- **Failure mode must be chosen deliberately:** if the database read fails, fall back to `planned`.
  Understating coverage makes a reader trust us less; overstating it makes them draw a false
  conclusion about a person. Fall back toward the harm we can afford.

### Option B — keep it hardcoded, and let the guard enforce the edit

Change nothing structural. The new test fails the moment CERS holds records, and whoever enables the
source edits both literals in the same change.

- **Cost:** the operator who enables CERS gets a red suite and must know why. Mitigated: the failure
  message says exactly which two things to edit.
- **Benefit:** zero new code paths, and the disclosure stays a deliberate sentence a human wrote
  rather than a string assembled at runtime — which has real value for text this consequential.
- **This is what exists today**, so choosing it means choosing to stop here.

### Option C — three states instead of two

`planned` / `consulted` / `active`, where `consulted` means swept with nothing found. Most truthful,
and it requires new caveat wording for the third state plus frontend rendering for it.

- **Cost:** the largest change, and it puts a new sentence in front of readers.
- **Benefit:** the only option that says the swept-but-empty thing out loud.

## What must be true whichever is chosen

- **`FEDERAL_ONLY_CAVEAT` is one string asserted on both the API and the page**, so it cannot be
  softened on one surface and not the other. Any revision keeps that property. Its final sentence
  names CERS explicitly, so it cannot survive CERS becoming active unchanged.
- **`correlation.ts` embeds the same caveat** in every vote-donor correlation payload. A revision
  that misses it publishes two different sourcing claims about the same data.
- **The direction of the fallback is a safety decision, not a default.** Understate, never overstate.
- **`federalOnly` is computed** from the active set and will flip on its own the moment `mt_cers`
  becomes active. Whatever renders off it must be checked at the same time.

## Recommended next step

**Option A**, with the fallback pinned to `planned`, taken as its own small change with the four call
sites migrated together — not folded into whatever change enables the CERS source, because that is
the moment the wording matters most and the worst moment to be editing it in a hurry.
