# Vocabulary and the design system

> Design of record for roadmap §3 and §10. Written 2026-08-14.
>
> **Do this before the surfaces in the other specs are built.** Feeds, Discord embeds, the calendar,
> the MCP adapter, the claims screen and the server-rendered pages each name these things again. The
> rename cost is roughly linear in surfaces, and the count is about to go from four to twelve.

## The problem, measured

One object is currently called four different things on a single page, and one of the four denies
being it:

| Where | What it says |
|---|---|
| `Layout.tsx:24` nav label | **Findings** |
| the URL | **/anomalies** |
| `AnomaliesPage.tsx:51` `<h1>` | **Flagged for review** |
| `AnomaliesPage.tsx:56` body copy | "…nothing here is **a finding**." |
| the database | `anomaly_flags` |

The nav promises findings; the page says these are not findings. A reader who notices has learned
something true and unfortunate: nobody decided.

The same split runs through officials. `Layout.tsx:26` labels it **Officials** and points at
`/members`. There is a `/officials/:id` route and a `MembersPage`. The database table is `members`,
and migration 072's comment already had to explain that "the officials *page* is a view over the
`members` table, and there is no table by that name."

This is not a polish issue. In a project whose product is precision about a public record,
inconsistent naming is a credibility defect. It is also the thing that makes the published-claim
spec's careful distinctions — a claim is not a finding, a document is not an artifact — impossible
for a reader to hold.

## The vocabulary

Six nouns. These are the words, everywhere, at every tier.

**Meeting** — a sitting of a body, on a date, with an agenda. Table `meetings`. Public at
`/meetings/{id}`. Unchanged; it is already consistent.

**Official** — a person who holds or held a seat. Table `members` (the table is not renamed; see
below). Public at `/officials` and `/officials/{id}`. **`/members` redirects permanently to
`/officials`.**

**Vote** — one recorded position by one official on one motion. Unchanged.

**Claim** — *what the record says a named person did*, with the line that says it. Table
`minute_claims`. Never a page of its own; rendered at `#claim-{id}` inside a meeting or an
official's page. This word is new to the reader and it is the most important one — the
published-claim spec is entirely about it.

**Finding** — *a pattern this project detected across records*, held for review, approved by a
person. Table `anomaly_flags`. Public at `/findings` and `/findings/{id}`.
**`/anomalies` redirects permanently to `/findings`.**

**Source** — the bytes a claim or finding rests on: a fetched file at a content address, with the
URL, fetch time and HTTP status. Public at `/source/{sha256}`.

Two words are retired from reader-facing text entirely:

- **Anomaly.** It asserts that something is abnormal, which is a conclusion, and it was never what
  the page meant. Replaced by *finding*. The database keeps `anomaly_flags`, the enum keeps its
  name, and `AnomalyBadge`/`AnomalyCard` get renamed as components.
- **Artifact** and **document** as interchangeable reader-facing words. A reader gets *source*. In
  code, `documents` and `artifacts` remain distinct tables and keep their names — they mean
  different things internally and collapsing them would be worse than the inconsistency.

**The tables are not renamed.** Renaming `anomaly_flags` and `members` would touch every migration
comment, every query, every seed and every test, to fix a problem readers have and code does not.
The rule is narrower and enforceable: **the database name and the reader-facing name are allowed to
differ, and the mapping lives in exactly one place.**

## Claim, finding, and the line between them

Worth stating plainly because the rest of the roadmap depends on it, and because the current copy is
confused precisely here.

- A **claim** is a quotation. "The minutes say Sample voted no." Its truth condition is *the document
  says this*, and `verify.ts` plus `quote_offset` check exactly that.
- A **finding** is an inference. "This item appeared on three agendas and was tabled each time." Its
  truth condition is *this pattern is present across these records*, and a detector produced it.

A claim can be verified mechanically against bytes. A finding cannot. That is why they have separate
tables, separate review paths, and — per the published-claim spec — different answers to "does it
get its own page". Using one word for both would erase the distinction that makes the claim pipeline
safe.

## Enforcement

Prose in a document does not hold a vocabulary. A test does.

`frontend/src/vocabulary.ts` — a frozen map, the single source for every reader-facing noun,
its plural, and its route:

```ts
export const VOCABULARY = {
  meeting:  { one: "meeting",  many: "meetings",  path: "/meetings" },
  official: { one: "official", many: "officials", path: "/officials" },
  vote:     { one: "vote",     many: "votes",     path: "/votes" },
  claim:    { one: "claim",    many: "claims",    path: null },   // never its own page
  finding:  { one: "finding",  many: "findings",  path: "/findings" },
  source:   { one: "source",   many: "sources",   path: "/source" },
} as const;
```

`frontend/src/vocabulary.test.ts`, in the existing idiom:

- Scan every `.tsx` under `src/` for the retired words in reader-facing string literals — `anomaly`,
  `anomalies`, `member`, `members` — and fail with the file and line. Allow-list the deliberate
  exceptions (the redirect definitions, the API client's paths) explicitly and by name, so an
  exception is a decision someone wrote down.
- Assert every nav `to` in `Layout.tsx` resolves to a route in `App.tsx` and that its label matches
  the vocabulary entry for that path. This is the test that would have caught "Findings" →
  `/anomalies` on the day it was written.
- Assert the retired routes redirect rather than 404.

The backend gets the same treatment for anything it renders into a feed, an embed or an email — one
shared renderer module, per the delivery spec, so there is one place where a noun is chosen.

**Redirects, not renames-in-place.** `/anomalies` and `/members` are in the sitemap, and the sitemap
is in production and being crawled. A 301 preserves whatever has accrued and tells a crawler the
canonical address; a 404 discards it. `STATIC_PATHS` in `backend/src/routes/sitemap.ts` lists the
old paths today and must list only the new ones after this change — the redirect targets, not the
redirects.

## The design system

Two things are true at once: the operator console is better built than the reader's site, and
`components/ui/` contains exactly one file (`CellLabel.tsx`). The good patterns exist; they are
inlined in admin pages where no reader-facing page can reach them.

### a. One provenance component set, used by both tiers

Every surface that shows a claim, a finding or a vote must show where it came from, and each
currently does it its own way. Extract to `components/ui/`:

- **`<Citation>`** — quote, source label, link to `/source/{sha}#offset-{n}`. The one place a
  citation is rendered. The published-claim spec pins the *sentence*; this pins the *citation
  furniture*.
- **`<Provenance>`** — fetched-from, fetched-at, sha256 (abbreviated, copyable in full), HTTP status.
- **`<ReviewStamp>`** — "approved for publication by an operator on {date}", or the withheld/
  retracted equivalent.
- **`<SeverityBadge>`** — replaces `AnomalyBadge`, reading `severity.ts`, which already exists.

The rule that gives these teeth: **a component that displays a claim or finding cannot be rendered
without a `<Citation>` child.** Enforce with a required prop of a citation type, not with a
convention. "No unsourced claim reaches the public site" should be hard to violate at the component
level, not just at the query level.

### b. `<Absence>` — the empty-state grammar

This project's empty states are load-bearing statements, not placeholders. "Bozeman: last successful
sweep 6 days ago" is a *feature*; "no data" is a lie of omission. The failure-disclosure invariant
says as much.

`<Absence>` takes a reason and renders the sentence for it:

| reason | renders |
|---|---|
| `not-yet-ingested` | "No sweep has run for this source yet." |
| `sweep-failed` | "The last sweep failed on {date}. {error}" + link to `/status` |
| `withheld` | "Records exist for this meeting and have not been published yet." |
| `none-exist` | "The record shows none." |
| `not-reviewed` | "No claims from this meeting have been reviewed." |
| `absent-upstream` | "The source published nothing here." |

The last two matter for the transcripts spec, which needs `transcript_absent` to be
reader-visible: *published nothing* and *published an empty file* are different statements and the
site must be able to say which. `<Absence>` is where that distinction surfaces.

There is no `reason` value meaning "we don't know". If the system does not know why something is
empty, that is a defect in the ingestion ledger, not a copy problem, and it must show as
`sweep-failed` or as an explicit unknown that links to the status page — never as blankness.

### c. The extraction, and its budget

Move to `components/ui/`: `Table`, `Card`, `Badge`, `Button`, `Field`, `EmptyState`, `PageHeader`,
lifted from the admin pages that already do them well. Keep the established look — light editorial,
serif headlines, one red accent, tabular numerals, citation chips. This is an extraction, not a
redesign; a redesign concurrent with a vocabulary change makes both un-reviewable.

Accessibility carries forward from the pass already shipped: every page an `h1`, focus moves on
navigation, and the `axe-core` assertions stay. **`vitest-axe` is not an option** — its typings
augment a `Vi` namespace Vitest 2 removed, so `toHaveNoViolations()` does not typecheck and the only
fixes are a cast or `@ts-ignore`, both barred. Build on `axe-core`'s own typed API, as the existing
tests do.

## Sequence

1. `vocabulary.ts` + its test, failing.
2. Route renames + 301s + `STATIC_PATHS` update. Sitemap regenerates.
3. Copy sweep until the test passes. `AnomaliesPage`'s h1 becomes "Findings" and the body copy stops
   contradicting the nav.
4. Component renames (`AnomalyBadge` → `SeverityBadge`, `AnomalyCard` → `FindingCard`).
5. `components/ui/` extraction, `<Citation>`/`<Provenance>`/`<ReviewStamp>`/`<Absence>`.
6. Only then: the new surfaces from the other specs.

Steps 1–4 are a single commit. A half-renamed vocabulary is worse than the current state, because
the current state is at least consistently confusing.

## Open question

**What replaces "Flagged for review" as the page's promise?** The h1 becomes "Findings", but the
subhead has to say what a reader is looking at without either overclaiming ("problems we found") or
disclaiming into meaninglessness ("nothing here is a finding"). The honest version is close to:
*"Patterns in the public record that a person reviewed and published. Each one links to the
documents it rests on. A finding is not an allegation."* Worth the operator's eye — it is the
sentence that sets what this project is asserting, and it is the only place on the site that says it
in the reader's own terms.
