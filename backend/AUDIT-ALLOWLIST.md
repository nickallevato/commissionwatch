# Backend dependency-audit allow-list

This is the deliverable roadmap item 6.2 named and did not yet have: a written,
reasoned record of every advisory this project tolerates in a production
dependency, to sit alongside the `npm audit` gate in
`.gitea/workflows/deploy.yml` (`ci-backend`, the "Audit production
dependencies" step).

## What the gate does

`npm audit --audit-level=high --omit=dev`, run in CI before typecheck.
`--omit=dev` scopes the check to what actually ships and runs in the API
served at `commissionwatch.bmux.sh` — a vulnerable linter or test runner never
reaches a reader. `--audit-level=high` fails the build on `high` or
`critical`; `low` and `moderate` do not block.

## Current state (2026-08-16)

**Zero vulnerabilities**, `npm audit --omit=dev` in `backend/`, both before and
after this file was written — so this allow-list has **no entries** to make
right now. It exists anyway, because the gate being clear today does not mean
it will be tomorrow, and 6.2's deliverable was the mechanism, not a one-time
cleanup.

Two things landed the same day this file did, non-force, verified against the
full backend test suite (2217 tests / 534 suites, 0 failures) before and
after:

- `npm audit fix` (no `--force`) took `body-parser` 2.2.2 → 2.3.0 and, via
  Express's own dependency tree, `qs`, `uuid`, `svix` and `resend` to versions
  already satisfying `backend/package.json`'s existing `^` ranges. This closed
  the `qs` DoS (GHSA-q8mj-m7cp-5q26) and the `body-parser` silent-limit DoS
  (GHSA-v422-hmwv-36x6) that the first maturity review named as runtime risks,
  plus the `uuid`-via-`svix`-via-`resend` chain (GHSA-w5hq-g745-h8pq). No
  `package.json` dependency range changed — only `package-lock.json` moved
  within ranges already declared.
- `esbuild` (GHSA-g7r4-m6w7-qqqr, low, arbitrary file read from its dev
  server) could not be reached by `npm audit fix` alone: it is pinned by
  `tsx`, and the installed `tsx@4.21.0` pinned `esbuild` to `~0.27.0`, a range
  that does not include the fixed `0.28.1`. `tsx@4.22.0`+ pins `~0.28.0`
  instead — a **minor** bump, inside the `^4.21.0` range `package.json`
  already declared, not a major-version jump and not `--force`. Installing
  `tsx@4.23.12` (latest at the time) picked up the fixed `esbuild` and brought
  the count to zero. Typecheck, lint, build and the full suite were re-run
  clean after this change specifically, since `tsx` is load-bearing for how
  every test and script in this repo runs.

## How to add an entry

When `npm audit --omit=dev` next reports something `npm audit fix` (no
`--force`) cannot clear, and it is a `low` or `moderate` (a `high` or
`critical` fails the CI gate and must be fixed or the gate reasoned down, not
allow-listed), add a row here before merging anything that leaves it in place:

| GHSA id | Package | Why tolerated | What would change that |
|---|---|---|---|
| _(none currently)_ | | | |

"Moderate" is not a reason on its own. A real reason names either why the
vulnerable code path is unreachable from what this service actually does
(e.g. the advisory is in a request-signing helper this API never calls), or
why the vulnerable path is dormant in production specifically — the pattern
already established for the `resend`/`svix`/`uuid` email chain before it was
fixed: that chain is the notification-delivery path, and delivery is
DNS-blocked and sends nothing per `CLAUDE.md`'s "Deliberately dormant"
section, so a DoS or buffer-bounds bug reachable only through an SDK call this
process never makes was a real, checkable argument, not a shrug.

## Decision: the gate stays at `--audit-level=high`

Keeping the CI gate at `high` (not tightening to `moderate`) is the right call
**as long as this file exists and is kept current**, for the reason the
maturity review raised first: a `moderate` advisory in a dependency this
service doesn't reach the vulnerable path of should not block every deploy —
a gate that blocks on cannot-be-triaged noise trains people to route around
it, which is worse than a gate that lets a reasoned exception through. The
condition that makes that safe is exactly this document: every non-`high`
advisory this project actually chooses to ship with is written down, named,
and dated, so "the gate is set not to see it" (the maturity review's phrase)
stops being true — the gate still doesn't see it, but a human reading this
file does, and can see when a "moderate, tolerated" entry has sat here longer
than its stated condition should allow.

If this file is ever empty of entries **and** stale (nobody has touched it in
months while advisories accumulated below the gate), that is the signal to
revisit the threshold, not evidence the threshold is fine.
