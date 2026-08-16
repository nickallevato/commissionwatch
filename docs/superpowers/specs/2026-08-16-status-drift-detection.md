# Making status-document drift self-detecting

**2026-08-16.** Written after correcting three stale figures found by the second maturity review in
one pass: `docs/STATUS.md`'s header test counts (2038/491, 737/64 — actually 2217/534, 869/70 at
`0cb66ac`), and `docs/incidents/README.md`'s cancelled-run claim (said the push-batching fix worked;
measured, it did not — 30.0% before the decision, 36.4% after, on the runs available). Those are the
fourth and fifth instances of the same failure mode today: a number written into a status document
stops matching the system it describes, and nothing notices until a reviewer or an accident finds it.
This document asks where a check could catch that class of drift automatically, and is honest about
the answer being smaller than "add a CI job that checks all the numbers."

## The pattern, named once

Every instance today had the same shape: an agent (or the loop coordinator) measured something once,
wrote the number into prose, and then the system kept moving while the sentence didn't. The number
was true when written and false by the time someone read it. This is not a carelessness problem —
every agent involved was working in good faith and most of the drift was caught by the project's own
discipline (a reviewer re-measuring, a coordinator re-reading its own log) — it is a structural
problem: **a hand-written number in a markdown file has no relationship to the thing it describes
after the moment it is typed.** The project already has one working example of turning that
relationship into code: `test/event-log-hygiene.test.ts` reads `package.json`'s test list and fails
if a file is missing from it, and `vocabulary.test.tsx` / `sitemap.test.ts` / `coverage-drift.test.ts`
each assert a *relationship* between two artifacts rather than a static count. The question below is
which of today's stale numbers are that same shape, and which aren't.

## Sorting today's numbers: checkable vs. not

### Checkable — a test or CI step could assert these today

| Number | What it drifted from | How a check would work |
|---|---|---|
| **Backend/frontend test & suite counts** in `STATUS.md`'s header | The actual `npm test` output at the cited sha | A `posttest` (or a separate `npm run status:check`) step parses the last test run's summary line and greps `docs/STATUS.md`'s header for the two `N tests / M suites` pairs. Mismatch fails with both numbers printed. This is the cheapest item on this list — the ground truth already exists in the test runner's own stdout every single run. |
| **DORA change-failure-rate / cancelled-run rate** in `docs/incidents/README.md` | The Gitea Actions API, `deploy.yml` runs | A script (not a unit test — it needs network and a token) that re-queries the API and diffs against the numbers in the file, e.g. `npm run docs:verify-dora`, run as a scheduled Gitea Action (not per-PR, since the number legitimately changes every deploy) that opens an issue or fails a nightly job when the file's numbers are more than N points stale. |
| **Coverage baseline's file list vs. the test list** (H5 in the maturity review — `test:coverage` already drifted from `test`) | `package.json`'s two script bodies | Trivial: extend `event-log-hygiene.test.ts`'s existing pattern to a second assertion — the `test:coverage` file set must equal the `test` file set (or a stated, named subtraction). This is the same shape as the guard that already exists for `test`, just not extended to its sibling. |
| **Roadmap row status** (Planned/Partial/Done) against whether the code exists | `git log`, file existence, a passing test for the feature | Partially checkable: "does a test exist and pass for the thing this row claims" is checkable; "is the *product* actually done" is a judgement call no test can make. A weak but real check: a script that greps roadmap rows marked `Done` and confirms each cites a commit sha that exists on `main`. Would have caught 6.7/6.8 reading Planned after landing, not 7.3 (H2's session-sweep claim), because that failure was directional prose ("nothing calls it"), not a status word. |
| **Production sha cited in `STATUS.md`'s "Live state" table** (currently `9d2825c`, weeks stale) | `curl https://commissionwatch.bmux.sh/api/version` | Checkable, cheaply — but see below on whether it's worth guarding rather than deleting. |

### Not checkable — no test can verify these, and the document should say so instead of a number

| Number / claim | Why it resists a check |
|---|---|
| **"339 meetings discovered" / "215 meetings / 1 published"** kind of production content figures scattered through `STATUS.md`'s narrative | These describe a point-in-time count of a live, growing corpus. A check could assert "this number was true at the time it was measured" (impossible — no record of when) or "this number matches production *right now*" (true only until the next sweep, so the check would need to run continuously and the document would need to be regenerated, not hand-edited, to stay green) |
| **MTTR** | Explicitly and correctly still "not yet measured" — no check needed, the document already says so and that is the honest state, not a gap |
| **Judgement calls dressed as numbers** — "Level 3" maturity scores, "the loop should stop after five more items" | These are the reviewer's synthesis, not a fact about the tree. No amount of tooling makes a maturity level machine-checkable without flattening exactly the judgement the review exists to apply |
| **Historical dated log entries** ("Counts after B-a: backend 827/214...") | These are correct by construction — they describe the state *at the time the entry was written*, not the state now, and the file's own structure (append-only, dated sections) already makes that legible. They do not need a check; they need a reader to notice the difference between a dated entry and the header, which today's drift shows is not obvious even to the agents writing the file |

## The honest recommendation

Two of the five checkable items are worth building; the rest are not, and the reasoning for each is
different enough that "add more guards" is the wrong single takeaway.

1. **Guard the test-count header, and guard `test:coverage` against `test`.** Both are near-zero
   cost (the ground truth is produced by a command the project already runs on every commit) and both
   would have caught today's actual drift. Build these.
2. **Do not try to keep `STATUS.md`'s production-content figures (meeting counts, published counts,
   discovered totals) live-checked in the document itself.** The correct fix for "339 meetings" going
   stale is not a test that fails when it does — it's removing the number from hand-written prose and
   replacing it with a link to `/api/metrics` or `/status`, which is *already* the source of truth and
   *already* live. A document that says "see the live count at `/status`" cannot drift, because it
   stopped claiming to be the count. This is the same move 0.5.0 already made for the extraction
   reading share (`PublicExtractionReading`'s discriminated union) — the fix there wasn't a check, it
   was making the flattering value structurally unreachable. The same move applies to prose.
3. **A periodic (not per-PR) DORA re-check is worth it, but only as a freshness alarm, not a
   correctness gate.** The number legitimately changes with every deploy, so failing a PR on a stale
   DORA figure would be noise; a nightly job that flags "this file's numbers are >48h old, re-run
   `npm run docs:verify-dora`" is proportionate. This is squarely inside the project's own precedent —
   the monitor's `blocked` state exists because a check that cannot determine an answer must say so
   rather than default to green, and a DORA number more than a day old is exactly that shape of
   uncertainty.
4. **Roadmap status-vs-commit checking is worth a light version, not a strict one.** A script that
   flags a `Done` row with no commit sha, or a `Planned` row whose named file already exists and is
   imported, catches the two directional failures found today (6.7/6.8 marked Planned after
   shipping) cheaply. It should warn, not fail a build — the false-positive rate on "does this file
   exist" as a proxy for "is this feature done" is high enough that a hard gate would train people to
   route around it, which is the exact failure the project already named for the `npm audit` gate
   (H3 in the maturity review: a threshold nobody can pass gets an allow-list bolted on and becomes
   decoration).
5. **Everything in the "not checkable" table should stay prose, but the fix for prose numbers is
   usually deletion or delegation, not acceptance.** Where a number can be replaced by a link to a
   live endpoint, replace it — that closes the gap "detecting drift" was trying to solve by removing
   the surface it could occur on. Where it genuinely can't (a judgement call, a synthesis), it isn't a
   drift risk in the same sense — nobody expects "Level 3" to be machine-verified, and pretending
   otherwise would be a worse failure than the ones being fixed today, which is a document trying to
   sound more rigorous than the check backing it.

**The line to hold:** a guard is worth writing when the ground truth already exists as a byproduct of
something the project does anyway (a test run, an API the monitor already polls) and the check is
cheap enough not to become a second thing to maintain. A guard is the wrong answer when the "ground
truth" would have to be invented for the guard's sake (nobody logs when "339 meetings" was true), or
when the number is actually a judgement rather than a fact. Four stale figures and four wrong roadmap
statuses in one day is a real pattern, but the fix for most of them is fewer hand-written numbers in
documents that already have a live source of truth to point at instead — not a larger test suite
whose own job is to keep another set of numbers from drifting.
