# The office gate — what 283 rejections are actually telling us

**Status: SPEC ONLY. Do not implement without the operator.** Written 2026-08-16 during the second
autonomous loop. The loop deliberately stopped here: every option below changes what can be
published about a named person.

---

## The measurement

After extraction de-duplication cut rejections from 1,007 to 336, **283 of the 336 survivors are
`not-an-official`** — 84% of everything still being rejected, and the largest single category by a
wide margin.

The gate is three lines:

```ts
export const RECORDED_OFFICES = ["mayor", "deputy mayor", "commissioner"] as const;
// requires the office to LEAD the name: "Commissioner Bode" qualifies,
// "a resident who used to be a commissioner" does not.
```

The 283 are not near-misses. They are a **Weed District board printing bare first names with no
office at all** — minutes whose house style never states a title, against a gate that requires one to
lead the subject.

## What the gate is for, and why it is not a bug

The gate is what lets extraction run **before a sourced roster exists**. `roster-coverage.ts` states
the position plainly: no sourced roster could be found on 2026-08-11, seeds name no real person and
never run in production, and a roster assembled from the model's own output would let a hallucinated
name validate itself.

So the office prefix is standing in for identity verification. **Loosening it to accept a bare first
name is the change that puts an unverifiable person's name on a public page.** That is not a
refactor; it is a change to who this project can be wrong about.

The 283 rejections are therefore the gate **working**. The defect is not that they are rejected — it
is that the system currently presents them as a mysterious pile, and that we are spending model
budget extracting from a body whose minutes the gate can never accept.

## The actual question

**Should a body whose minutes never print offices be extracted at all?**

Three answers.

### Option A — exclude such bodies from extraction, at the source

Mark the body in `ingestion_sources.config` as one whose minutes carry no offices, and skip the
extraction stage for it. Fetch, store and index continue; only claim extraction stops.

- **Cost:** the record is still captured and searchable, but no claims are ever extracted from it,
  including ones a future sourced roster could have validated.
- **Benefit:** stops burning model budget on documents that cannot pass, and — more importantly —
  removes 84% of the rejection noise, which is what makes the *remaining* rejections readable.
- **Reversible.** Flipping it back re-enables extraction for future documents.
- **This is the option the loop would take**, because it changes what we *spend*, not what we
  *publish*, and it is the only one of the three with that property.

### Option B — source the roster for that body, then let the gate check names against it

The real fix, and the one `roster-coverage.ts` already lays out in order: provenance columns on
`members` (**done**, migration 103, with an all-or-nothing CHECK and a loader that refuses a roster
without them), then a jurisdiction-scoped term-dated import from a published roster page, then
attendance rolls as *corroboration only*, parsed deterministically rather than by the model.

- **Cost:** steps 2 and 3 are unbuilt, and step 2 requires probing real roster pages — Bozeman via
  `bozeman.granicus.com`, Gallatin via CivicPlus, or CERS, which is structured and already an adapter
  target. Nothing in the codebase fetches a roster today.
- **Benefit:** the only option that increases what can be truthfully published.
- **Precondition:** a bare first name still cannot be matched to a roster entry with confidence. A
  sourced roster makes "Commissioner Bode" checkable; it does not make "Dave" checkable. **So Option
  B does not, by itself, unlock the 283.**

That last point is the one most likely to be missed by a future reader in a hurry, and it is why
Option B is not simply "the right answer, later".

### Option C — leave it, and make the rejections legible

Change nothing about the gate; surface the breakdown by body so an operator reading the status page
sees "Weed District: 283 rejected, this body's minutes print no offices" instead of an unexplained
count.

- **Cost:** continues spending model budget on documents that cannot pass.
- **Benefit:** cheapest, and it makes the situation self-explaining rather than mysterious — which
  is the failure `roster-coverage.ts` says kept this invisible in the first place.

## What must be true whichever is chosen

- **`RECORDED_OFFICES` does not grow to accommodate a body whose minutes print no offices.** Adding
  entries is legitimate when a real office exists and is printed — a chair, a trustee. It is not
  legitimate as a way to admit bare names.
- **No option accepts a subject without a verifiable identity.** The three offices are a proxy for
  identity, and any replacement must be a *better* proxy, not a weaker one.
- **The F2d loss measurement must be re-run after any change here.** It concluded that 0 of 6
  truncated chunks lost a verified claim, on a corpus that verifies ~1 claim per chunk with two of
  five chunks verifying zero. Changing what passes the gate changes that denominator, and the old
  result would silently become a statement about a different corpus.

## Recommended next step

Take Option A **and** Option C together — they are complementary and neither touches what is
published — and treat Option B as its own project, beginning with a probe of the real roster pages
rather than a design. Do not implement any of it from a loop.
