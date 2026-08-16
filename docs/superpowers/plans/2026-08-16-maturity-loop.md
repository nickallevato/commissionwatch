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
