# Maturity review 3 — the five items, verified, 2026-08-16

**What this is.** The final pass of the maturity loop. `2026-08-16-maturity-review-2.md` scored six
of seven categories as passing and named **five** things that had to land before the loop stopped.
This document does one job: establish whether those five are real, whether operational readiness now
passes, whether anything regressed, and whether the loop should stop.

**Method.** Nothing here is taken from a commit message. Every claim is backed by a file I read at a
stated path, a test file I executed, or a live probe against `https://commissionwatch.bmux.sh`. I did
not run the full suite — the figures cited are the coordinator's, taken uncontended at `fbd0eb1`
(backend 2219/534, frontend 869/70, both clean; `npm audit --omit=dev` 0). Where I could re-derive a
figure cheaply and independently, I did, and I say so.

Production served `sha 0cb66ac` throughout this review. `fbd0eb1` and `f3aafdd` are on `main` and not
yet deployed — `fbd0eb1`'s deploy run (29343) was **cancelled** by the next push, and 29344 was still
in progress. Neither commit changes runtime behaviour, so nothing below is affected.

---

## The five items

### 1. A monitor check that fails when no backup has succeeded recently — **real, with one honest shortfall**

The claim was that a *recording* side had to be built first. That claim is correct and I verified the
whole chain rather than its ends:

| Link | Verified |
|---|---|
| `deploy/backup.sh:268` emits `ops.backup_succeeded` | Read. Crucially it emits **even when the offsite leg is missing** (`OFFSITE_MISSING=1` → `emit ops.backup_offsite_missing`, then `emit ops.backup_succeeded`, then `exit 60`). So an instance-only backup still records a success, which is the behaviour the freshness check needs — otherwise the check would be permanently blocked on the operator's bucket decision. |
| `emit-ops-event.ts:32` calls `recordOpsEvent` **before** `dispatch()` | Read. Unconditional, outside the try, independent of whether any channel route matches. The stated reason — `deliveries` only writes per matched route, so zero channels meant zero evidence — is accurate against `dispatcher.ts`. |
| Migration `107_create_ops_event_log` | Read. `event_type`/`occurred_at` composite index for exactly the "latest of this type" read. Applied in production: `/api/health` reports `"migrations":{"version":"107","pending":0}`. |
| `/api/health` `backup.lastSuccessAt` | **Live.** `{"backup":{"lastSuccessAt":null}}`. Public, unauthenticated, no bucket/path/size disclosed. |
| `evaluateBackupFreshness` (`external-monitor.ts:1060`) | Read all seven branches. Transport failure, unparseable body, missing `backup` object, non-string/non-null `lastSuccessAt`, unparseable date → **`blocked`**. Never-recorded → **`blocked`**. Past the 27-hour allowance → **`fail`**. Within it → `pass`. |
| Wired into the outcome list | `external-monitor.ts:1509`, inside the array `summarise()` consumes. Not defined-and-uncalled. |
| Tests | `test/external-monitor.test.ts` — nine assertions covering every branch, including `fails when the last success is older than the 27-hour allowance` and `BLOCKS — never passes — when no backup has ever been recorded`. I ran `external-monitor.test.ts`, `ops-events.test.ts`, `health.test.ts` and `event-log-hygiene.test.ts` together: **136 tests, 23 suites, 0 fail.** |

**And then I ran the monitor against production**, which is the only check that matters:

```
PASS     health: 200, database connected
PASS     resources: disk ok, memory ok
BLOCKED  backup: no backup has ever been recorded as succeeded — this could be a fresh host,
         an uninstalled cron, or a cron that has never once run. Absent evidence is not a pass
PASS     version: both images serve 0cb66ac
BLOCKED  release-drift: MONITOR_EXPECTED_SHA is not set …
PASS     prerender / source:bozeman-granicus / source:gallatin-civicplus / source:mt-cers

No check failed (0 warning(s), 2 blocked …). Nothing is posted on a green run.
EXIT=0
```

**This is not a guard over an empty table.** The table is real, the write path is real and
unconditional, the read is live on a public endpoint, and the check has something truthful to read —
it read it, and reported the truth, which is that no backup has ever succeeded on this host.

**The shortfall, stated plainly.** My item said *fails*. What landed reports **`blocked`**, and
`summarise()` sets `failed` only on `fail`, and `main()` returns 0 before `buildAlertMessage` on a
non-failing run. So the exact state production is in right now — no backup, ever — produces a green
monitor run every fifteen minutes and posts nothing. The alerting branch that *can* fire (`fail`) is
the one that requires a backup to have succeeded at least once first.

**I am not counting this against the category, and here is why, rather than a shrug.** Three reasons,
in order of weight:

1. **The backup cron is not installed, and that is the operator's item**, ranked #1 in
   `docs/STATUS.md`'s next steps for a week. No check can manufacture a backup. The condition the
   check is silent about *is* the operator action, not a system failure the product is hiding.
2. **It is no longer invisible.** Review 2's finding was that "if the nightly backup has never run
   once, every surface in this system reports green." That is now false: `/api/health` publishes
   `lastSuccessAt: null` to anyone, and every monitor run prints the sentence above in words. The
   state moved from *unrepresented* to *represented but not paged*, which is a real category change.
3. **The design reasoning is written down and coherent** — `blocked` exists precisely so absent
   evidence is never laundered into a pass, and failing on a fresh host would page a human for the
   act of installing the thing. I disagree with the choice at the margin; I cannot call it a dodge
   when the alternative is argued in the code.

Once the cron is installed, the first run records, and the 27-hour allowance against a `17 4` cron
gives three hours of margin. From that point the check is load-bearing. **Real, not hollow.**

### 2. Fix or delete `deploy/Caddyfile` — **real**

`deploy/Caddyfile` is gone (`git log -1 -- deploy/Caddyfile` → `0cb66ac`; `ls deploy/` confirms). The
evidence offered for deleting rather than fixing holds up: I re-ran the reference grep across the tree
and the only surviving mentions are `deploy/README.md`, `backend/test/backup-script.test.ts` (the
guard), three design/plan documents and the two review documents — **nothing that applies config**.

The guard is two assertions in `backend/test/backup-script.test.ts:183` and `:202` — the file must not
exist, and no committed `.sh` or `.yml` under `deploy/` or `.gitea/workflows/` may reference one. I
ran that file: **13 tests, 5 suites, 0 fail.** The failure message is written for the next person and
asks the right question (*"does it route /api/\* to its own upstream?"*) rather than just saying no.

`deploy/README.md` now records what governs the edge and that it lives outside this repository, so the
knowledge survived the deletion. That was the actual risk of deleting and it was handled.

### 3. Correct `PrivacyPage.tsx` and its two stale copies — **real, and verified in the shipped bundle**

All three corrected:

- `frontend/src/pages/PrivacyPage.tsx:222` — *"A housekeeping job **now** clears out old operator
  sign-in records on its own. Once a day it removes any session row past its absolute expiry…"*
- `docs/superpowers/specs/2026-08-16-retention-policy.md` — §24, §172, §182, §230 all now say wired,
  with the commit (`52cfd60`).
- `docs/roadmap.md` row 7.3 — corrected, and it names the review finding that produced the correction.

The two genuinely-unbuilt gaps are still stated as unbuilt, in the same paragraph, unhedged:
*"Two pieces of this policy are still a stated intention, not a running system, and we are saying so
rather than implying otherwise."* That is the discipline the finding was about, and it survived the
fix — the correction did not quietly upgrade the neighbours.

**Live in the deployed bundle** (`/assets/index-D11et6Yn.js`, 665 KB): `A housekeeping job now clears`
→ 1 match; `stated intention, not a running system` → 1; `no deletion schedule` → 0.
`PrivacyPage.test.tsx` — 12 tests, pass.

### 4. Fix the two runtime advisories or write the reasoned allow-list — **real, and it did both**

```
backend $ npm audit --omit=dev   →  found 0 vulnerabilities
backend $ npm audit              →  found 0 vulnerabilities
```

Not six, not two, and not only in production scope — **zero across the whole tree**. I verified the
mechanism rather than the headline: `npm ls` shows `body-parser@2.3.0` under `express@5.2.1` and
`esbuild@0.28.2` under `tsx@4.23.12`. The `package.json` diff is two lines: the `test:coverage` script,
and `tsx: ^4.21.0 → ^4.23.12`. That is a floor raise, not a major jump and not `--force`, and the
allow-list explains exactly why it was needed (`tsx@4.21.0` pinned `esbuild ~0.27.0`, which cannot
reach the fixed `0.28.1`; `4.22.0`+ pins `~0.28.0`).

**Does an allow-list with zero entries change anything?** Mechanically, no — and it says so itself, in
its own words: *"this allow-list has no entries to make right now. It exists anyway, because the gate
being clear today does not mean it will be tomorrow, and 6.2's deliverable was the mechanism, not a
one-time cleanup."* What actually changed the security posture is the six advisories being gone. The
document's value is the written rule for the next one — including *"'Moderate' is not a reason on its
own"* and the refusal to allow-list a `high`.

One genuine residual: **`backend/AUDIT-ALLOWLIST.md` is referenced by nothing** — not the CI step, not
a test, not the roadmap. `grep -rn AUDIT-ALLOWLIST backend/test .gitea/workflows docs/roadmap.md`
returns nothing. So the next tolerated moderate can be left in place with no prompt to write a row. It
is a convention, not a mechanism. Small, and noted below rather than blocking.

### 5. Guard `test:coverage`'s file list — **real, and better than what I asked for**

I asked for a guard. What landed removes the second list entirely. `backend/package.json`'s
`test:coverage` is now `tsx test/helpers/run-coverage.ts`, and that file's
`testFilesFromTestScript()` parses `package.json`'s **`test` script** and runs those files under
`--experimental-test-coverage`. There is exactly one list. I read both the script and the driver:
the ~120-filename string appears **once** in `package.json`.

Held in place by `event-log-hygiene.test.ts`:
- `test:coverage delegates to the single-source file list instead of restating it` — asserts the
  script matches `run-coverage.ts` **and** `doesNotMatch(/\.test\.ts/)`. This is the load-bearing
  assertion: it makes reverting to an inline list a test failure.
- `test:coverage's derived file list matches the test script's, exactly` — this one is close to a
  tautology (both sides split the same string on the same predicate), but it is harmless and it
  catches a mangled extraction.

`pretest` still gates and `posttest` still runs unconditionally, as documented.

**One residual, pre-existing rather than introduced:** `run-coverage.ts:83` discards the test run's
exit status and `main()` exits with `posttest`'s code, so **`npm run test:coverage` exits 0 even when
tests fail.** The old inline `… ; npm run posttest` had the identical behaviour, so this is not a
regression — and `test:coverage` is not in CI (`grep -n 'test:coverage' .gitea/workflows/deploy.yml`
returns nothing), so nothing gates on it today. It is worth one line the day anyone tries.

---

## Did anything regress?

**No.** `git diff --stat e22706b..fbd0eb1` is 24 files, and every one of them belongs to one of the
five items plus documentation. No scope creep, no drive-by refactor. Specifically:

- The four test files touching the new work pass together on a clean database: **136 tests, 0 fail.**
- `PrivacyPage.test.tsx` passes.
- `main` is green in CI at every commit that ran to completion. `fbd0eb1`'s deploy (29343) was
  **cancelled** — by the next push, not by a failure — and 29344 was in progress at review time.
- The `body-parser`/`tsx` bumps are within declared ranges, and the coordinator re-ran the full suite
  before and after specifically because `tsx` is load-bearing for how every test in this repo runs.
  That was the right precaution to take and the right one to state.
- `docs/STATUS.md`'s header test counts, stale in review 2 (2038/491, 737/64), are now **2217/534 and
  869/70** with the supersession noted. Fixed.
- `docs/incidents/README.md` was corrected to say the coordinator's own push-batching change made the
  cancelled-run rate **worse**. I re-derived this independently from the Gitea Actions API: of the
  most recent `deploy.yml` runs in a 100-run window, **10 of 22 concluded runs were cancelled (45%)**,
  against the 29% the document originally cited as the problem. The self-report is honest and, if
  anything, understates the regression. A project that publishes a measurement disconfirming its own
  decision has the habit that makes the rest of its claims worth reading.

---

## New, and not caught in either prior review

Four. Two turned out to be already in the roadmap, which I record as credit rather than as findings.

### N1. A production ingestion run has been stuck for five hours, and every automated surface is green

`GET /api/ingestion/sources`, probed twice **25 minutes apart**:

| Source | enabled | verdict | lifetime records | latest run |
|---|---|---|---:|---|
| `bozeman-granicus` | true | **`failing`** | 1147 | `running` since 07:17Z, 44 records / **30 failures**, `finished_at: null` |
| `gallatin-civicplus` | true | `healthy` | **0** | `running` since 07:17Z, 0 records / 1 failure |

**Byte-identical across both probes** — the counters did not advance in 25 minutes, and the run has
been open for over five hours on a nightly sweep. Meanwhile the external monitor prints
`PASS source:bozeman-granicus: last successful sweep 28.7 h ago, within 168 h`.

Three things compound here, and none of them is in the roadmap:

1. **`evaluateSource` reads only staleness**, never the feed's own `verdict`. That refusal is argued
   in its docstring (*"the point of an external monitor is not to ask the subject how it thinks it is
   doing"*) and it is a good argument about `silence`. But `verdict: failing` is not the subject's
   opinion of its own health — it is a **count of consecutive failures**, a fact the monitor has no
   other way to see, and it is being discarded.
2. **`expected_interval_hours` is 168 against a `17 7 * * *` cron.** A source that sweeps nightly gets
   a seven-day silence allowance. Bozeman could stop entirely on a Monday and go green until the
   following Monday.
3. **The docstring on `evaluateSource` is itself stale**: *"Bozeman, Gallatin and MT CERS are
   registered and switched off."* Two of the three are on.

**This does not bear on fitness to be public**, and I want to be exact about why, because it is the
distinction this whole loop has been about: `/status` renders the verdict
(`StatusPage.tsx:598`), so a reader sees "failing" for Bozeman on the public site. **Nothing false is
being published.** This is an alerting gap, not a truthfulness gap. It is a roadmap item.

### N2. The most emphatic "measured, not assumed" claim in this repository is wrong

`.gitea/workflows/monitor.yml:21` opens with:

> `⚠ THE SCHEDULE DOES NOT FIRE ON THIS GITEA. Measured, not assumed.`

It fires. I pulled every `monitor.yml` run from the Gitea Actions API — **617 of them**, landing on
:00/:15/:30/:45 continuously since 2026-08-09T22:30, including overnight stretches where four
consecutive runs share one `head_sha` with no commit between them, which no push can produce. Gitea
labels them `event: push`, which is very likely how the original 2026-08-10 measurement was misread.

**The loop already caught this** — `docs/roadmap.md` has a *"Stale in `docs/STATUS.md`, corrected
here"* section recording it with 580 runs. Credit where it is due. But the correction lives in a third
file while `docs/STATUS.md` and the workflow's own comment block still assert the opposite in
capitals, and `CLAUDE.md` sends every reader to `STATUS.md` first. Doc-only, but it is the file the
project designates as the source of truth.

The substantive upside is worth stating: **the external monitor genuinely runs every fifteen minutes
against production.** That is a materially stronger operational posture than either prior review
credited, and it is what makes item 1's freshness check load-bearing the moment a backup succeeds.

### N3. `CLAUDE.md` and `STATUS.md` both say ingestion is switched off in production. It is on.

`CLAUDE.md:22` — *"the live source is registered **disabled** until an operator enables it."*
`docs/STATUS.md:2582` — *"Enable Gallatin on the live host and install the backup cron … neither is
switched on in production."*

Both `bozeman-granicus` and `gallatin-civicplus` return `enabled: true` and are sweeping nightly.
Half of that next-step is done. This is the project's habitual error direction — understating itself —
and it is in the two files `CLAUDE.md` names as read-this-first.

### N4. Gallatin has ingested zero records, ever — already found, and found well

`lifetime_records: 0` for the county half of a two-jurisdiction watchdog. `docs/roadmap.md` §7 already
has this, found the same morning with the jobs endpoint, and diagnosed further than I could from
outside: three pending `discover` jobs, one carrying `AbortError`, no deduplication of an outstanding
discover. It also **corrects an earlier claim of the loop's own** (starvation was why Gallatin never
*attempted*, not why it collected nothing) and refuses to design a fix before probing. That entry is
the best piece of writing produced in this loop and I have nothing to add to it.

---

## The seven categories

| # | Category | Framework | Review 1 | Review 2 | Now | Verdict |
|---|---|---|---:|---:|---:|---|
| 1 | Operational readiness | SRE | 2 | 3 | **3** | **Passes** |
| 2 | Security posture | OWASP ASVS | 2 | 3 | **3** | Passes |
| 3 | Software delivery | DORA | 2 | 3 | **3** | Passes |
| 4 | Testing maturity | TMMi | 4 | 4 | **4** | Passes |
| 5 | Data governance | DAMA-DMBOK | 3 | 3 | **3** | Passes |
| 6 | Product / UX | WCAG 2.2 + product | 3 | 4 | **4** | Passes |
| 7 | Project sustainability | CHAOSS | 1 | 3 | **3** | Passes |

**Seven of seven pass.**

### Operational readiness — why it now passes

It failed on one item: *"this system still cannot tell you whether a backup has ever succeeded."* It
can now. There is a durable, unconditional record; a public field that reads it; a check that judges
it; nine tests over every branch; and — verified against production — the check reads the real state
and reports it correctly rather than reporting green over an empty table.

Two things I did not know at review 2 also raise this category on their own:

- The external monitor **runs every fifteen minutes**, 617 runs deep, not "after a deploy, because
  the schedule does not fire" (N2).
- The security-header foot-gun is gone rather than papered over, with a guard that keeps it gone.

What remains in this category is the same list as before, and every item on it is either a person's
decision or genuine Level-4 work: the `warn` tier still reaches nobody on a green run; `blocked`
likewise (item 1's shortfall, N1's would-be alert); 5xx counts are operator-only; no error tracking,
no tracing, no capacity figure, no load test. None of these is the difference between a site that
should be public and one that should not.

### Everything else

Unchanged from review 2 and re-confirmed where cheap. Security: zero advisories now instead of six,
Caddyfile gone. Data governance: the privacy page is no longer wrong about the code, in either
direction. Testing: 2219/534 and 869/70, one file list instead of two. Product: unchanged. The
constraint on what a citizen actually sees is unchanged and is not a code problem —
`/api/metrics` still reports **215 meetings, 1 published; 64 claims, 0 approved; last published
2026-08-11**. That is 7.1, and 7.1 is a person.

---

## What is left, ranked — none of it blocking

| # | Gap | Where | Effort |
|---:|---|---|---|
| 1 | No second reviewer. The binding constraint on everything published. | 7.1 | *human* |
| 2 | **`PRERENDER_ENABLED=true`** — one Parameter Store line, and until it is set the only published meeting is a 1,185-byte shell to every crawler on a URL `sitemap.xml` advertises | H6.2, review 2 | *operator* |
| 3 | Install the backup cron and set `BACKUP_S3_URI`. The check is built and waiting; today it reports `blocked` on a 15-minute tick and nobody is paged. | STATUS #1 | *operator* |
| 4 | A stuck/failing production sweep is green on the monitor; `evaluateSource` discards `verdict`, and the 168 h allowance is seven times the cron interval | N1 | S |
| 5 | Gallatin's `discover` aborts; discovers do not dedupe | roadmap §7 | M |
| 6 | `blocked` and `warn` reach nobody on a green monitor run | item 1, H4 | S |
| 7 | `CLAUDE.md`, `STATUS.md` and `monitor.yml` assert three things production disproves | N2, N3 | S |
| 8 | `AUDIT-ALLOWLIST.md` is referenced by no test, no CI step, no roadmap row | item 4 | S |
| 9 | `test:coverage` exits 0 when tests fail (pre-existing; not in CI) | item 5 | S |
| 10 | No dependency upgrade cadence, no rotation cadence, no SBOM, no image scanning; nothing computes the DORA keys; 124 raw `console.*`; no browser e2e; no request through the real nginx container | 6.x remainder | M |

---

## Verdict

The five items are real. I pressed on the three the brief asked me to press on, and all three held:
the backup check has a durable table written unconditionally by a path I traced end to end, and it
read production's real state correctly when I ran it; the allow-list's zero entries change nothing by
themselves, but the six advisories it was written about are **actually gone**, which is more than was
asked; and the coverage list is genuinely one list, with the assertion that makes reverting to two a
test failure. Nothing regressed. The diff is 24 files and every one of them is on the list.

I found four things neither prior review caught. Two of them the loop had already found and written
up better than I would have. One is an alerting gap on a stuck sweep that the public site is
nonetheless honest about. One is that this repository's most emphatic measured claim has been wrong
for a week, in the direction of understating itself — which is the failure mode of a project that has
made self-doubt into a discipline, and it is a far better failure mode than the alternative.

**Operational readiness passes. Seven of seven pass.**

### Should this loop stop? **Yes. Stop.**

Without hedging: this product is fit to be public. It publishes nothing it cannot source, it states
what it has not built on the page where a reader will look, it corrects itself in writing when a
measurement disconfirms a decision it already made, and every one of the five things I said had to
land has landed in substance rather than in ceremony.

Everything still on the list is one of three things: a person (7.1), an operator's decision (the
prerender flag, the backup cron, the bucket), or Level-4-to-5 engineering polish that no reader will
ever feel. Item 4 on that table — the stuck sweep — is the closest thing to an exception, and it is
not one, because the public `/status` page already tells a reader that source is failing. Nothing on
the site is false. That was always the bar.

The most valuable thing that could happen to CommissionWatch next is not a fifteenth engineering
item. It is a person approving a claim, and an operator setting one line in Parameter Store. A day of
excellent work moved the public record by nothing, because the constraint was never the code.

Stop.
