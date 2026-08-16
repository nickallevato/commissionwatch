# The maturity loop

**Started 2026-08-16.** Runs every 15 minutes until the product is mature and the critical reviewer
is satisfied. Run `date -u` to check the clock; **do not infer the time from git history.**

## The operator's instruction

> a /loop firing every 15 minutes, ensuring at most 2 subagents are working (if appropriate for two
> concurrency things to be built) and that they are working on the roadmap, with you understanding
> the roadmap and delegating work (and not writing code yourself), and if you find gaps or issues you
> answer your own questions, and you own the product and the decisions for the loop. loop until the
> product is truly mature and the subagent is satisfied.

## What changed about how I work

Two standing rules from the earlier loops are **superseded**:

| Was | Now |
|---|---|
| One subagent at a time | **Up to two**, and only when the two pieces of work are genuinely independent — different files, no shared migration, no shared test fixture |
| The main loop writes code when the judgement is subtle | **The main loop writes no code.** It reads, plans, delegates, verifies, decides and commits |

Unchanged, because these are what kept the previous loops honest:

- **Subagents never run git write commands.** The main loop commits.
- **Verification is never delegated.** An agent reporting its own pass is the claim this project does
  not accept. The main loop runs typecheck, test, lint and build itself.
- **`git add -A` is banned while an agent is running** — it sweeps half-finished work into a commit
  claiming to be something else. Add explicit paths.
- **Commit messages go in a file, passed with `-F`.** Backticks and quotes in `-m` are shell
  substitution and have silently eaten text before.
- **Mutation-verify every guard.** A guard not seen to fail is not a guard.
- **Cheap disproof before dispatch.** Thirty seconds proving a task is really undone — grep the
  symbol, `ls` the file, `git log` the commit. Four tasks in the 0.6.0 loop were already built.
- **Anything that changes what is published about a named person stops and goes to the operator.**
  It gets a spec, not an implementation.

## Where the state lives

- **`docs/roadmap.md` is the work queue.** The loop takes its next task from there.
- **`docs/superpowers/specs/2026-08-16-maturity-review.md`** is the acceptance criterion: the
  category-by-category assessment. The loop ends when its categories pass.
- This file holds loop health and the decisions I make on the operator's behalf.

## Two concurrent agents — when it is appropriate

Two only when the work is genuinely disjoint. The pairs that are safe:

- backend service + frontend page
- docs/spec + code
- two different frontend pages with no shared component

The pairs that are **not**, learned today: two agents in `frontend/src/pages` at once (the date
consolidation and the record-count fix collided in `AdminSourcesPage`), and anything touching
`backend/package.json`'s explicit test list concurrently — two agents editing that file
read-modify-write will clobber one another's registration and the lost test simply never runs.

## Decisions I own

Recorded as I make them, so the operator can overrule with the reasoning visible.

- **Console design language** applies to every admin page — approved by the operator for `/sources`
  and extended by instruction. Spec: `2026-08-16-console-design-language.md`.
- **Dark theme follows `prefers-color-scheme`**, no toggle, nothing stored.
- **Reviewer throughput outranks new capability.** The pipeline already ingests faster than anyone
  can review — 212 meetings in, 1 published — so building more ingestion widens the gap. This
  reorders the roadmap's own phases and is the loop's default priority.

## Tick log

- **Loop armed.** Critical maturity review dispatched (opus, read-only on code, may write the spec
  and roadmap entries). The loop's first job on its return is to turn its gaps into scheduled work.
- **08:13Z** — Maturity review returned and is committed. **PASS**: testing (L4), data governance (L3),
  product/UX (L3). **FAIL**: operational readiness (L2), security (L2), delivery (L2),
  sustainability (L1). Phases 6 and 7 added to hold operations, security, retention and
  stewardship — the structural finding being that all five existing phases were feature phases, so
  this work had nowhere to live and was untracked rather than undone.

  Verified the top finding myself rather than taking it: `npm audit --omit=dev` confirms 3 moderate
  in the frontend (`react-router`, exercised on every public page) and 6 in the backend (`resend` →
  `svix` → `uuid`, shipped but dormant). The production-only lens matters — a build-time advisory
  does not reach a reader.

  **Two agents dispatched, disjoint by package:** frontend takes the shipping router advisory plus a
  Gitea audit step; backend/deploy takes the off-instance backup leg. No shared file, no shared test
  list.

  **Decision made and recorded:** the CI audit gate runs `--omit=dev --audit-level=high`. Failing on
  build-time moderates would train everyone to ignore the check, and a gate people route around is
  worse than no gate. The current moderates are being fixed rather than tolerated.
- **08:20Z** — Tick one minute after dispatch; both agent slots full, nothing to verify. Did **not**
  run the frontend suite: `package.json` and the lock were mid-upgrade, and a suite run against a
  half-installed tree measures nothing.

  **Found a problem of my own making.** Production is on `f50d65e` while head is `944e8d1`, so the
  dark theme and the review-queue rebuild are committed, verified and **not live**. Four of the last
  eight CI runs are `cancelled`: pushing after every commit means each push kills the previous
  deploy. A verified commit that never reaches production is worth nothing, and I had been treating
  the push as the finish line.

  **Decision: batch pushes.** Hold until the in-flight run for `af09468` lands, then push the
  accumulated commits as one. Push at verified milestones, not per commit.

  Also noted for later: a remote branch `fix/operator-guard-public-writes` exists at `7373488` that
  this loop did not create. Not touched; recorded so it is not mistaken for mine.
- **08:28Z** — Frontend advisory work verified myself: **829 tests / 69 files**, typecheck lint build
  clean. Committed `0b4f0ed`.

  **The agent found a ceiling and stopped, correctly.** `react-router-dom@6.30.4` is the *last* v6
  release, and all three advisories against it are fixed only in 7.13.0+. Verified independently:
  `npm view react-router-dom@6 version` → 6.30.4, latest → 7.18.2. So the v6 line can never clear
  this, and the agent was right to refuse a framework migration on its own initiative.

  **Decision, mine: migrate to v7.** An open redirect on a site whose value is being trustworthy
  about the public record is worse than its moderate CVSS — a link that looks like our domain and
  lands on a phishing page damages precisely what this project sells. And the migration is
  incremental: the suite already emits `v7_startTransition` and `v7_relativeSplatPath` warnings, so
  the codebase is already being told the deltas. Dispatched in **two verifiable steps** — future
  flags on v6 first, then the version bump — so a behaviour change is never confounded with a
  version change.

  Instructed it to mutation-verify a broken `Navigate` redirect specifically. `/anomalies` →
  `/findings` and `/members` → `/officials` exist because public URLs were renamed; a silently
  broken redirect there is a broken published URL, and if no test catches it that missing guard
  matters more than the migration.
- **08:38Z** — Two Phase 6 items verified and committed. Held push released once CI caught up:
  `af09468` went green and live, which confirmed the batching decision was right.

  **6.1 backup** (`2f41349`): verified backend **2134 / 516**, `bash -n` clean. The agent chose both
  a critical ops event *and* a non-zero exit rather than one, with the right reasoning — a bare log
  line was the original design and is exactly what let this sit unnoticed, so a warning alone is a
  disproven hypothesis here, not an untested one. Spot-checked myself that no credential is echoed
  and that the upload verifies with an independent `aws s3 ls` read-back rather than trusting `cp`.

  **6.2 → v7 migration** (`ff528f9`): verified frontend **829 / 69** and, independently,
  `npm audit --omit=dev` → **0 vulnerabilities**, tree resolving to a single `react-router@7.18.2`.
  Sixty-seven files moved their import. Step one, the future flags on v6, broke **nothing** — which
  is the useful result, because it means the two flags were the entire behavioural delta and the
  version bump carried no hidden one.

  The mutation that mattered was the redirect, not the upgrade: `/anomalies` → `/findings` and
  `/members` → `/officials` exist because public URLs were renamed, so a broken one is a broken
  *published* URL. Pointing it wrong fails exactly one named test, so that guard is real.

  Dispatched **6.10** (rate limit + cache on `/api/search`) to the free backend slot. **I set the
  numbers rather than asking**: 60/min per client and `max-age=60`. A reader searching hard does ~10
  a minute, and the limit sits deliberately above what a scripted client needs so it nudges bulk
  users toward `/api/data/*.csv` instead of punishing them. On a transparency site a limit set too
  low is its own failure.
- **08:39Z** — Tree clean of my own work; head `b8a9015` matches `origin/main`, deploy in flight for
  the v7 and backup commits. Backend agent is mid-6.10 (three files touched) so I ran **no** backend
  suite this tick — measuring a tree someone is editing produces a number that means nothing either
  way.

  Filled the free frontend slot with **7.2 + 7.4** rather than the higher-risk 6.9. Reasoning, since
  it departs from strict risk-ranking: 6.9 is an end-to-end browser test of the review→publish path
  and would need the test database, which the backend agent is currently using — two agents
  contending for one Postgres is how a suite starts failing for reasons that have nothing to do with
  the code. 6.9 goes to the backend slot when it frees.

  **Policy decisions made, not delegated.** The agent is writing up decisions I made: two stability
  tiers with experimental surfaces obliged to say so; a withdrawal announced on the corrections log
  rather than 404'd, because withdrawing data people depend on is the same category of act as
  changing a published claim; 90 days' notice; additive changes explicitly not breaking so the
  policy cannot be used to block ordinary work; and bus factor stated as **one** rather than implied
  away by writing "we". The parity matrix supplies the reason this is urgent — ProPublica's Congress
  API is dead and Open States has been absorbed into commercial Plural. A newsroom and a flagship
  civic-data project both failed to keep a public API alive, and this project invites people to
  build on four.
