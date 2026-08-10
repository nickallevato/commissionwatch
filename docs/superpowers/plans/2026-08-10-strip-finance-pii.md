# Strip donor PII from the campaign-finance ingest

**Date:** 2026-08-10
**Directive:** operator — *"we must not ingest PII."* Not a refactor; a data-handling decision.
**Branch:** `worktree-agent-a7a5f77a472f1b966`, from `origin/main` (`f63b534`).

## What is being removed, and what is emphatically not

The MT CERS adapter landed hours ago and swept for real. It stored four fields that describe a
private person rather than a public transaction:

| Column | Table | Migration |
|---|---|---|
| `entity_address` | `cf_transactions` | 041 |
| `occupation` | `cf_transactions` | 041 |
| `employer` | `cf_transactions` | 041 |
| `residence_city` | `cf_filers` | 041 |

**Donor name, amount and date stay.** They are the civic core of the disclosure — a contribution
without them is not a contribution, and `vote_donor_conflict` exists precisely to link a named
donor to a vote. Removing the four above costs nothing that any detector, view or export consumes;
removing the three below would gut the feature. The CERS adapter keeps its ability to sweep.

## Containment, already established — not to be redone

No PII reached production: all three sources are `enabled=false`, production holds zero rows, the
public bulk export contains no `cf_` dataset, and the `artifacts` export carries only `sha256`,
`source_url` and `byte_size` — never bytes. Both local scratch databases holding the swept rows
have been dropped. This plan is the **forward fix** only.

## Steps

### 1 · Drop the columns (migration `043`)

A new migration in the 041–049 block, which is CERS's. `dropColumn` on all four — not "stop writing
them". A nullable column is an invitation to a future writer, and the whole point is that there is
no longer anywhere to put the value. `down()` re-adds them nullable so the migration is reversible
in shape, which is the honest inverse: the *data* is gone either way.

No import from `../src/` — `test/migrations-selfcontained.test.ts` enforces it.

### 2 · Stop the adapter and the writer extracting them

- `src/services/ingestion/adapters/mt-cers.ts` — drop `entityAddress`, `occupationDescr` and
  `employerDescr` from the `CersLineItem` interface and from `toLineItem`. Transaction parsing
  only; `toCandidate` and everything else in `adapters/` is out of scope by directive.
- `src/services/ingestion/campaign-finance.ts` — drop the three fields from the
  `replaceTransactions` insert, and drop `residence_city` from `upsertCandidateFiler`.
- `cityFromAddress` existed solely to derive `residence_city` from the candidate's filed home
  address. With that column gone it has no caller, so it and its unit test go with it. This is the
  one place the backend test count legitimately drops.
- `src/services/finance/ingest.ts` — `ContributionRow.donor_employer` / `donor_occupation` are
  already hard-coded `null` on the OpenFEC path. Remove the fields so nothing can start populating
  them. Behaviour-preserving.

### 3 · Scrub the fixtures

`test/fixtures/mt-cers/post-financeRepDetailList-*.json` carry real donors' street addresses,
occupations and employers. Replace every populated value with a clearly synthetic one, keeping
**exact structure, field names, key order and types** so the parser tests stay meaningful — a
fixture that no longer looks like a CERS response tests nothing. Donor names, amounts and dates are
left as filed; they are public record and the tests assert on them.

Record the scrub in `PROVENANCE.md`: what, when, why, and — critically — that re-recording from the
live host will reintroduce PII, so nobody "restores" the fixture thinking it is corrupt.
`record.ts` must scrub on the way in for the same reason.

*Seed data never names a real person* is an existing project invariant. This is that rule applied
to fixtures.

### 4 · Guard it (`test/finance-pii-guard.test.ts`)

Two assertions, both of which must fail if the work is undone:

1. **Schema.** After `migrate:latest`, query `information_schema.columns` and assert none of the
   four exist on their tables. Catches a future migration re-adding one, which a source scan of
   041 alone would not.
2. **Fixtures.** Scan every `post-financeRepDetailList-*.json` and fail on any populated
   `entityAddress`, `occupationDescr` or `employerDescr` that is not from the synthetic set.

Both verified **negatively** — reintroduce a violation, watch each fail, restore.

Register the file in `package.json`'s `test` script. That script enumerates every path; three
suites were silently dropped from it in a merge last night and 159 tests stopped running while the
suite stayed green. Verify every file on disk is registered except `test/storage.integration.test.ts`.

### 5 · `docs/STATUS.md`

What was removed and why, and that **whether to rewrite git history is the operator's decision, not
this branch's**. The fixtures are already on `origin/main`; no history is rewritten here, nothing is
force-pushed, nothing is rebased.

## Gate

Isolated database `cw_test_pii_strip` on the existing `commissionwatch-db-1` container — port 5432
is held by the main checkout, so a second container is not started; a second *database* is the
isolation.

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cw_test_pii_strip
```

Baselines: backend 1086, frontend 425/42, deploy 61/0, zero lint errors (backend keeps 2 deliberate
warnings). Backend should drop only by the `cityFromAddress` test, and only because the field it
served no longer exists.

## Out of scope, to be reported

`migration 050` (`campaign_contributions`) carries `donor_employer`, `donor_occupation` and
`donor_city` — the same shape of PII on the OpenFEC path. 050 is outside the 041–049 block this
directive assigns, and the columns are written `null` today. Flagged for the operator rather than
dropped unilaterally.
