# Design review — 2026-08-16

**Written during the third autonomous loop**, at the operator's instruction to "do a design review
and do mockups that would fix any UI issues or otherwise improve UI/UX." Rung 4 of four, reached
after rungs 1–3 were closed.

**The headline is a compliment with one exception.** This frontend is unusually disciplined about
absence: most empty states carry a comment explaining *why* they are worded the way they are, and the
`Absence` component exists specifically so "could not load" never looks like "nothing here." The
findings below are gaps against that high bar, not a catalogue of neglect. Where a page was already
right, it is recorded as right, because the next reviewer should not re-litigate it.

Verified by static read of `frontend/src`, plus live probes of production. **No page was rendered in
a browser and nothing was screenshotted**, so every responsive finding is inferred from CSS classes
rather than observed — stated here because it bounds the whole section.

---

## The most serious finding, and it was not on the UX list

**The front page could not report a published finding.**

`HomePage.tsx` imports `useAnomalies` and calls it — for the flags rail. The **lead column**, the
largest element on the page a first-time visitor sees, rendered a hardcoded `NO_FINDING_YET` constant
**unconditionally**.

Its own docblock described the fix as future work: findings "do not exist in the data model — there is
no `findings` table, no `/findings` endpoint and no hook … when they land, this constant is deleted
and the lead column reads the latest *published* finding from the hook."

They landed. `anomaly_flags` is the table, `GET /api/anomalies` is the endpoint, `useAnomalies` is the
hook, `/findings` is a live page reading it, and `/api/metrics` reports `findings_total`. The hook was
already imported **in that same file**. Only the lead was never wired.

**Why this outranks every accessibility finding below.** Today the text is accurate — zero findings
are published — so nothing looks wrong. It becomes false the moment the first finding publishes, which
is a single operator action away. At that point a site whose purpose is to surface findings would be
telling every visitor it had found none, while `/findings` and the RSS feed carried the finding. The
defect was invisible precisely because it is latent, and no test caught it because **the test asserted
the defect**: `HomePage.test.tsx` pinned the h1 to "No finding has been published yet" while its own
mock returned four flags.

Fixed. The lead now reads the hook and falls back to the constant only when there is genuinely nothing
— so rendering is unchanged today and stops being a lie later. It **composes no prose**: the headline
is `flagTypeLabels[flag_type]` and the dek is the detector's own `description`, the same two fields
`/findings` renders, because a finding here is the detector's sentence rather than written copy. It can
only ever show a published flag, since `/api/anomalies` applies the wall server-side.

Ordering is by `created_at`, deliberately **not** by severity, and that is pinned by a test: a front
page ranked by severity would keep the worst thing ever found at the masthead indefinitely and would
be editorialising by ordering. The severity-ranked view is the rail beside it.

This is the third stale comment this loop has found describing a future that had already arrived — the
others were `finance/coverage.ts` and `skipReasonFor`. **The pattern is the finding**: this codebase's
comments are unusually good, which makes them unusually trusted, which makes a stale one unusually
expensive.

---

## Fixed in this review

1. **`MeetingDetailPage` agenda section: failure and absence were indistinguishable.** Both rendered
   as `<p className="mt-4 text-sm text-muted">`, and the error had no `role="alert"` — while the Flags
   and Transcript sections on the *same page* use `Absence` precisely to keep them apart. A reader had
   to parse the sentence to learn whether the agenda failed to load or genuinely had no items.
2. **Four pages announced nothing while loading** — `MattersPage`, `MatterDetailPage`, `MetricsPage`,
   `SourcePage` used inert plain text where the rest of the site uses `role="status" aria-live="polite"`.
   A screen-reader user got silence, then a sudden content swap.
3. **`StatusPage` showed a raw database enum on a public page**: `running` / `succeeded` / `partial` /
   `failed`, verbatim, three rows below a cell that maps a verdict to "Healthy" / "Suspect" /
   "Failing". Now labelled — with `partial` handled carefully, because it means some work succeeded and
   some did not, and labelling it as success would overstate.
4. **`CalendarPage` formatted dates as `en-GB`** — "Fri, 14 Aug 2026", day before month, the only page
   on a US local-government site doing so.
5. **`NotFoundPage`** used Title Case and a straight apostrophe against the site's sentence case and
   typographic entities.

## Found and recorded as sound

So the next reviewer spends their time elsewhere. All verified by reading the code.

- **No `<img>` without `alt`** anywhere — the site has essentially no raster images.
- **No icon-only button without an accessible name.**
- **No `onClick` on a `div` or `span`.** Clickable rows are real `Link`/`button` elements.
- **Severity is never carried by colour alone.** `SeverityMark` encodes it as a numeral, a `title`,
  and an `sr-only` span, with colour only reinforcing — and a comment states that intent.
- **Every data table uses `<th scope>`**, including the responsive stacked variants, which restate
  `role="table"/"row"/"cell"` because `display:block` strips native table semantics.
- **No fixed pixel widths.** Wide tables use a stacked-card-below-`sm` pattern with the reasoning
  commented each time.
- **No raw enum leaks on public pages** other than the `StatusPage` case above; everything else goes
  through a `_LABEL` map.
- **Every one of the 43 page components has a co-located `.test.tsx`.** No exceptions.
- **Heading hierarchy is sound.** Apparent multiple-`h1` files are conditional loading/error/loaded
  branches that never render together.

---

## Not fixed, and why — for the operator

### Date formatting has five implementations *(recommend consolidating)*

Four hand-rolled formatters solve the same UTC-date-shift problem four ways — and each carries a
comment explaining that problem, which shows the *hazard* was understood every time and the
*duplication* was not noticed. Worse, three pages (`StatusPage`, `CorrectionsPage`,
`DataLicensePage`) call bare `toLocaleString()` with **no locale and no timezone label**.

That last part is the substantive bit rather than a tidiness complaint. A correction's timestamp
renders in whatever timezone the reader's browser happens to be set to, unlabelled — on the page whose
entire purpose is to record precisely when a published claim changed. Elsewhere the codebase is
careful about exactly this (`SourcePage` appends "UTC" explicitly; `CalendarPage` names each
jurisdiction's timezone), which makes these three an inconsistency rather than an oversight in
judgement.

**Not fixed here** because consolidating five formatters into one utility touches a dozen call sites
across pages another agent was editing concurrently, and a display-format change wants to land as its
own reviewable commit. **Recommendation:** one `formatDay`/`formatTimestamp` pair, timezone always
labelled where a time-of-day is shown, and a test asserting no page calls `toLocaleString()` directly
— the same shape of guard as `feature-registry-audit`.

### Two data-fetching patterns

Most pages use `react-query` hooks; `CalendarPage`, `StatusPage`, `CorrectionsPage`,
`DataLicensePage` and `PublicRecordsPage` hand-roll `fetch` + `useEffect` + local state. Not
user-visible, but it doubles the places a fetch bug can hide, and it is why those pages' loading and
error handling drifted from the majority pattern in the first place.

### `MethodologyPage` uses formula notation

`present < ⌊seats ÷ 2⌋ + 1` and `status = emergency or special`. This is a genuine tension rather than
a defect: the page's purpose is to let a reader *check* the detectors, and a checkable threshold has
to be precise. Plain prose explains each one immediately below. **Left alone deliberately** — flagged
so nobody "simplifies" it into vagueness, which would cost more than it gained.

---

## The structural observation no polish addresses

Measured from `/api/metrics` on 2026-08-16:

| | |
|---|---:|
| Meetings ingested | 212 |
| Meetings published | **1** |
| Agenda items ingested | 3,160 |
| Agenda items public | **36** |
| Findings published | **0** |
| Votes | 0 |
| Claims approved | 0 of 64 |
| Places public | 0 of 0 |

**The public site is a well-built scaffold around one meeting.** A visitor who walks the navigation
hits `/findings` (empty), `/votes` (empty), `/matters` (empty), `/officials` (a seed roster),
`/elections` (deliberately empty), `/map` (empty) — six empty pages in a row.

Each one explains itself well. That is genuinely rare and it is worth keeping. But **individually
honest empty states do not add up to a cumulatively honest experience**: the reader is told six times
that this particular thing is absent, and never once that *almost everything* is, or why — that the
review gate is deliberate and an operator has published one meeting of 212.

This is a design question rather than a bug, and it belongs to the operator because the honest answer
shapes what the site claims to be:

- **Option A — say it on the front page.** One line above the fold: what has been collected, what has
  been published, and that the gap is review rather than failure. `/status` and `/metrics` already
  hold every number; nothing new would be computed or claimed.
- **Option B — say it in the navigation.** Counts beside each nav item, so an empty section is visible
  as empty before it is clicked. Honest, and it makes the site look emptier than a visitor might
  otherwise notice — which is the point, and also the cost.
- **Option C — leave it.** Defensible while the corpus is small and the per-page states are this good.
  The risk is a reader concluding the *project* is broken rather than that the *record* is
  under-published, and that misreading falls on the project's credibility.

**Recommendation: A.** It costs one line, invents no data, and answers the question a confused visitor
is actually asking. B is a bigger change than it looks — counts in navigation need a source of truth,
a loading state of their own, and a decision about what a count means when the section is
operator-gated rather than empty.
