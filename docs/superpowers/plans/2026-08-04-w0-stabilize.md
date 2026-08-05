# W0 — Stabilize `main` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get `main` to a state where typecheck, tests, and build all pass on both frontend and backend, and CI blocks any future merge that breaks them.

**Architecture:** Every error on `main` is a merge artifact — duplicate declarations and references to symbols that exist on one branch but not another. Fixes are removals and reconciliations, not new features. The one design decision is which of the two rival anomaly-detection services survives.

**Tech Stack:** TypeScript 5.5, React 18 + Vite 5, Vitest 2, Express 5, Node 22, Gitea Actions.

## Global Constraints

- Node 22 (`.github/workflows/ci.yml` was upgraded to 22; `frontend/package.json` still declares `"node": ">=20"` — leave the floor at 20 unless a dependency demands otherwise).
- Do not add dependencies. Every error here is fixable by deleting or reconciling existing code.
- Do not delete tests to make the build pass. A test referencing an undefined constant means the constant is missing, not that the test is wrong.
- Do not change public API shapes (route paths, response bodies) — later workstreams depend on them.
- No `any` to silence a type error. If a type is genuinely wrong, fix the type.
- Verification commands are run from the package directory: `frontend/` or `backend/`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/types/index.ts` | Canonical domain types for the frontend | Reconcile `Vote`, `Member`, `AnomalyFlag` with real usage |
| `frontend/src/mocks/data.ts` | MSW fixture data | Remove duplicated declaration blocks; conform literals to types |
| `frontend/src/pages/VotesPage.tsx` | Votes list page | Align with the reconciled `Vote` type |
| `frontend/src/components/Layout.tsx` | App shell and nav | Remove duplicate icon components |
| `backend/src/routes/anomalies.ts` | Anomaly HTTP routes | Fix undefined `created` and `detectAnomalies` references |
| `backend/src/services/anomaly-detection.ts` | Anomaly detection (survivor) | Becomes the single implementation |
| `backend/src/services/anomalyDetection.ts` | Anomaly detection (duplicate) | Deleted after callers are migrated |
| `backend/test/votes.test.ts` | Votes route tests | Define the missing fixture constants |
| `.github/workflows/ci.yml` | CI | Ensure typecheck + build gate merges |

---

### Task 1: Reconcile frontend domain types and fixtures

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/mocks/data.ts`
- Modify: `frontend/src/pages/VotesPage.tsx`
- Test: `frontend/src/lib/api.test.ts`, `frontend/src/pages/VotesPage.test.tsx` (existing, must keep passing)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the canonical `Vote`, `Member`, and `AnomalyFlag` types that every other frontend task and all later workstreams use. Specifically it fixes the field name for a member's cast vote and the allowed values of `VoteValue`, and the `AnomalyFlagType` union.

- [ ] **Step 1: Reproduce the failures**

Run from `frontend/`:

```bash
npx tsc --noEmit
```

Expected: 30 errors, including `TS2451: Cannot redeclare block-scoped variable 'members'` at `src/mocks/data.ts:238` and `TS2339: Property 'vote' does not exist on type 'Vote'` at `src/pages/VotesPage.tsx:28`.

- [ ] **Step 2: Determine the true shape from the backend**

Read `backend/src/routes/votes.ts` and the migration `backend/migrations/010_create_votes.ts`. The database column names are the source of truth — the frontend type must match what the API actually returns, not the other way round. Record the real column name for the cast vote and its permitted values.

- [ ] **Step 3: Make `types/index.ts` match the backend**

Update `VoteValue` to exactly the values the database permits, and `Vote` to carry the field name the API actually returns. Update `AnomalyFlagType` to the full union the backend emits — `backend/src/services/anomaly-detection.ts` and `agents/meeting-monitor/src/anomaly/detectors.ts` list the detector types. Add `email` to `Member` only if the API returns it; if it does not, remove it from the type rather than adding it to every fixture.

- [ ] **Step 4: Remove the duplicated blocks in `mocks/data.ts`**

`members`, `votes`, and `anomalyFlags` are each declared twice (around lines 238, 291, 348 and again at 437, 500, 511). Keep exactly one declaration of each. Keep whichever block is richer and conforms to the reconciled types; delete the other outright. Do not rename one to `members2`.

- [ ] **Step 5: Align `VotesPage.tsx`**

Update the field access and the `Record<VoteValue, string>` label map to use the reconciled names and values from Step 3.

- [ ] **Step 6: Verify types and tests**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: zero errors from `types/index.ts`, `mocks/data.ts`, and `VotesPage.tsx`. `Layout.tsx` errors may remain — Task 2 owns those. All tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/mocks/data.ts frontend/src/pages/VotesPage.tsx
git commit -m "fix(frontend): reconcile Vote/Member/AnomalyFlag types with backend and de-duplicate fixtures"
```

---

### Task 2: Remove duplicate icon components in `Layout.tsx`

**Files:**
- Modify: `frontend/src/components/Layout.tsx`
- Test: `frontend/src/components/Layout.test.tsx` (existing, must keep passing)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new — `Layout` keeps its current export.

- [ ] **Step 1: Reproduce**

```bash
npx tsc --noEmit src/components/Layout.tsx
```

Expected: `TS2393: Duplicate function implementation` at lines 91, 99, 115 and 131, plus `TS6133: 'CheckCircleIcon' is declared but its value is never read`.

- [ ] **Step 2: Delete the second definitions**

`UsersIcon` and `AlertIcon` are each defined twice. The pairs differ only in SVG path casing (`0Zm` versus `0zm`). Keep the first of each, delete the second. Delete `CheckCircleIcon` entirely — nothing references it.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx vitest run src/components/Layout.test.tsx
```

Expected: no errors from `Layout.tsx`; the layout test passes.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Layout.tsx
git commit -m "fix(frontend): remove duplicate icon components from Layout"
```

---

### Task 3: Consolidate the two anomaly-detection services

**Files:**
- Modify: `backend/src/routes/anomalies.ts:115`, `backend/src/routes/anomalies.ts:170`
- Modify: `backend/src/services/anomaly-detection.ts`
- Delete: `backend/src/services/anomalyDetection.ts`
- Test: `backend/test/` (existing anomaly tests must keep passing)

**Interfaces:**
- Consumes: nothing.
- Produces: a single exported detection service. Later workstreams import anomaly detection from `backend/src/services/anomaly-detection.ts` only.

- [ ] **Step 1: Reproduce**

```bash
npx tsc --noEmit
```

Expected: `TS2304: Cannot find name 'created'` at `src/routes/anomalies.ts:115` and `TS2552: Cannot find name 'detectAnomalies'. Did you mean 'detectAnomaliesBatch'?` at line 170.

- [ ] **Step 2: Compare the two services**

Read both `backend/src/services/anomaly-detection.ts` (290 lines) and `backend/src/services/anomalyDetection.ts` (149 lines). Identify which exports each provides, which one the tests exercise, and whether the smaller file has any capability the larger lacks. Write down the answer before editing.

- [ ] **Step 3: Migrate any unique capability into the survivor**

`anomaly-detection.ts` is the survivor — it is larger, batch-capable, and hardened (per commit `9b4d190`). If `anomalyDetection.ts` holds behaviour the survivor lacks, port it across first.

- [ ] **Step 4: Fix the route's two broken references**

At line 170, call the real exported function. At line 115, `created` is undefined — determine from surrounding code what value the response is meant to carry (most likely the result of the insert immediately above) and bind it properly. Do not paper over it by returning a literal.

- [ ] **Step 5: Delete the duplicate and update every importer**

```bash
grep -rn "anomalyDetection" backend/src backend/test
```

Update each hit to import from `anomaly-detection.ts`, then delete `backend/src/services/anomalyDetection.ts`.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
npm test
```

Expected: no errors from `routes/anomalies.ts`; `grep -rn "services/anomalyDetection" backend/` returns nothing; tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src backend/test
git commit -m "fix(backend): consolidate duplicate anomaly detection services and repair anomalies route"
```

---

### Task 4: Restore the missing test fixture constants

**Files:**
- Modify: `backend/test/votes.test.ts:105`, `:123`
- Test: `backend/test/votes.test.ts`

**Interfaces:**
- Consumes: the seed data in `backend/seeds/001_pilot_data.ts`.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Reproduce**

```bash
npx tsc --noEmit
```

Expected: `TS2304: Cannot find name 'BOZEMAN_MEETING_ID'` and `TS2304: Cannot find name 'MEMBER_CUNNINGHAM_ID'`.

- [ ] **Step 2: Find the real IDs**

Read `backend/seeds/001_pilot_data.ts` and any sibling test that already defines these constants — a neighbouring test file very likely declares them, since this file was split off in a merge. Reuse the existing values so the fixtures stay consistent; do not invent new UUIDs that no seed row matches.

- [ ] **Step 3: Declare the constants**

If a sibling test already exports them, import them. If not, declare them in `votes.test.ts` with the values from the seed file.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm test
```

Expected: no `TS2304` errors; the votes tests pass against the seeded database rather than erroring on a missing row.

- [ ] **Step 5: Commit**

```bash
git add backend/test/votes.test.ts
git commit -m "test(backend): restore missing fixture constants in votes tests"
```

---

### Task 5: Make CI actually block a broken merge

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitea/workflows/deploy.yml`

**Interfaces:**
- Consumes: the now-green build from Tasks 1–4.
- Produces: a CI configuration that fails on a type error.

- [ ] **Step 1: Establish what CI runs today**

Read `.github/workflows/ci.yml`. Determine whether it runs `tsc --noEmit` and `npm run build` for both packages, or only `npm test`. The errors on `main` reached it, so at least one gate is missing or non-blocking.

- [ ] **Step 2: Add the missing gates**

Ensure both packages run, in this order and each failing the job on non-zero exit: install, `npm run typecheck`, `npm test`, `npm run build`. `frontend/package.json` already defines `typecheck` and a `build` that runs `tsc --noEmit` first; `backend/package.json` must be checked for the same and given a `typecheck` script if absent.

- [ ] **Step 3: Remove every `legacy-platform` reference**

Per the spec, `legacy-platform` is stripped entirely. All five occurrences:

```bash
grep -rn "legacy-platform" . --exclude-dir=node_modules --exclude-dir=.git
```

- `.gitea/workflows/deploy.yml:1` — workflow name
- `.gitea/workflows/deploy.yml:228,267` — tunnel socket paths
- `deploy/Caddyfile:1` — site block hostname, becomes `commissionwatch.bmux.sh`
- `deploy/README.md:7` — prose
- `deploy/docker-compose.ai2.yml:4` — comment

Rename the host to `commissionwatch.bmux.sh` throughout. Leave the `import allowlist` line in the Caddyfile alone and do not touch credentials or the ECR registry — W4 owns going public and the deployment retarget.

- [ ] **Step 4: Verify locally**

```bash
cd frontend && npm run typecheck && npm test && npm run build
cd ../backend && npm run typecheck && npm test && npm run build
```

Expected: all six commands exit 0.

- [ ] **Step 5: Prove the gate works**

Introduce a deliberate type error in a scratch file, confirm `npm run typecheck` fails, then remove it. This verifies the gate rather than assuming it.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .gitea/workflows/deploy.yml
git commit -m "ci: gate merges on typecheck and build for both packages"
```

---

### Task 6: Correct the stale architecture docs

**Files:**
- Modify: `docs/spec/architecture.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Fix the tech stack table**

`docs/spec/architecture.md` claims "Backend API: Python / FastAPI" and "Frontend: Next.js". The code is Express 5 / TypeScript and React 18 / Vite. Correct both, in the table and in the prose under "Output Layer" and "Deployment".

- [ ] **Step 2: Correct the roadmap's dashboard description**

`docs/roadmap.md` item 1.2 describes a Next.js app with "dark mode default, amber/gold accent". The approved design is light editorial with a red accent. Replace that description and point at the new spec.

- [ ] **Step 3: Verify no other stale claims**

```bash
grep -rn "FastAPI\|Next.js\|amber/gold" docs/ README.md
```

Expected: no hits outside the historical spec's decision log.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: correct stale stack and design claims"
```

---

## Definition of done

```bash
cd frontend && npm run typecheck && npm test && npm run build
cd ../backend && npm run typecheck && npm test && npm run build
grep -rn "legacy-platform" . --exclude-dir=node_modules --exclude-dir=.git
```

All six commands exit 0, and the grep returns nothing.
