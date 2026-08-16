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
