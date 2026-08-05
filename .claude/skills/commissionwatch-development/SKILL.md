---
name: commissionwatch-development
description: Use when planning, designing, or implementing any substantial CommissionWatch feature - establishes the brainstorm to spec to plan to fan-out pipeline, the grounding discipline, and the invariants that make this project publishable
---

# CommissionWatch Development Process

The process that produced the production design. Follow it for any substantial feature.

## The pipeline

```
brainstorm  →  spec  →  plan  →  workflow fan-out  →  verify + audit  →  commit
```

| Stage | Output | Location |
|---|---|---|
| Brainstorm | Decisions, with the user, one question at a time | conversation |
| Spec | What we are building and why | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| Plan | Bite-sized tasks with exact files and commands | `docs/superpowers/plans/YYYY-MM-DD-<name>.md` |
| Execute | Parallel agents over disjoint file sets | `Workflow` tool |
| Verify | Real command output, never an agent's claim | verification agent |
| Audit | Adversarial review from multiple lenses | audit agents |

Do not skip to implementation. Each stage catches errors the next one cannot.

## Ground every design in reality first

**The single highest-value habit in this project.** Before designing anything that touches an
external system, probe it. Every significant plan change so far came from a probe, not from
reasoning:

- Bozeman moved to `bozemanmt.gov` and is Akamai-blocked (403 on `/robots.txt`) — the hardcoded
  scraper URL was stale and its selectors were never validated. Found by `curl`, not by reading code.
- Gallatin is CivicPlus AgendaCenter with a permissive `robots.txt` — so Gallatin ships first.
- Montana campaign finance is CERS, a structured system, not PDF scraping.
- IRS 990 e-file XML comes only as yearly zip bundles at
  `apps.irs.gov/pub/epostcard/990/xml/{year}/{year}_TEOS_XML_{NN}{A|B}.zip`. The old
  `s3.amazonaws.com/irs-form-990` bucket is retired and empty. Per-object-ID fetches return 302/404.

Probe with `curl -sS -w "http=%{http_code} size=%{size_download} final=%{url_effective}"`, follow
redirects, and try a browser user agent before concluding a site is unreachable.

Never write a spec that assumes an endpoint exists. Check.

## Fan-out rules

Learned the hard way — `main` was broken by parallel branches merging without a gate.

**Disjoint file ownership.** Assign every agent an explicit, non-overlapping file list. State in
the prompt which files belong to other agents and are off limits.

**No concurrent git writes.** Agents must not run `git add`, `commit`, `checkout`, `stash`, or
`reset`. Concurrent agents in one working tree will corrupt each other through the index lock.
Read-only git (`diff`, `status`, `log`) is fine. The orchestrator commits.

**Verification is a separate agent that runs commands.** Never accept "it passes" from the agent
that wrote the code. The verify agent runs the real commands and returns their real output.

**`blocked` is not `pass`.** A check that could not run (no database, no network) must report as
blocked, never as passing. Make the schema enforce it with an enum.

**Audit adversarially, from several lenses.** For this project the productive lenses are:
error-silencing, divergence from the database schema, and plan completeness.

## Invariants

These are not style preferences. Breaking one is a defect.

**Never silence an error.** No `any`, no `@ts-ignore`, no `@ts-expect-error`, no cast to quiet the
compiler, no deleted or skipped test. A test referencing an undefined constant means the constant
is missing, not that the test is wrong.

**The database is the source of truth for types.** Frontend types must match what migrations permit
and what routes actually return. A frontend type that compiles but misnames a column is a runtime
bug typechecking cannot catch — and it is exactly how `main` broke.

**No unsourced claim reaches the public site.** Every published assertion traces to a stored
artifact with a locator. A claim without a source cannot be persisted; a finding containing one
cannot be published. This has legal consequences, so it gets an explicit test.

**Nothing naming a person auto-publishes.** Generated narrative goes to the operator review queue
as a draft. The operator approves before it is public.

**Describe the record, never the motive.** Generated text says what happened, when, and in what
order. It does not assert intent, corruption, or illegality.

**Failures are disclosed, not swallowed.** Every failure path lands in an `ingestion_jobs` or
`ingestion_runs` row with its error text, and the public status page reads from those rows. A
transparency project that silently stops ingesting is worse than one that says
"Bozeman: last successful sweep 6 days ago."

**CI gates merges.** Typecheck, test, and build must pass for both packages, with no
`continue-on-error` and no `|| true`.

## Scraping conduct

All targeted material is public record. Fetch politely: a real browser at low rate, an honest user
agent naming the project, aggressive caching, and no re-fetching of unchanged documents. Respect
`robots.txt`.

If a source requires fingerprint spoofing or proxy rotation to access, **stop and ask the
operator.** Do not build it. The fallback is a public-records request for the same documents.

## Architecture facts

Correct as of 2026-08-04. The older `docs/spec/architecture.md` was wrong about the stack for
months — verify against `package.json` before trusting any document.

- Backend: Express 5 + TypeScript on Node 22, Knex migrations, PostgreSQL 16 + pgvector, MinIO
- Frontend: React + Vite + Tailwind (**not** Next.js)
- Queue: Postgres `SKIP LOCKED`. No Redis
- Domain: `commissionwatch.bmux.sh`. `legacy-platform` is removed from this repo — do not reintroduce it
- Design: light editorial — serif headlines, one red accent, tabular numerals, citation chips
- Ingestion stages after `fetch` read stored artifacts, never the network, so `parse` and `analyze`
  develop at full speed even when a source is blocked

## Non-partisanship

Detection logic applies identically to every entity class — nonprofits, business PACs, unions,
trade associations, developers. Never build a detector that targets one category. Beyond being the
project's stated principle, uniform treatment is what makes a finding defensible when someone
alleges bias.
