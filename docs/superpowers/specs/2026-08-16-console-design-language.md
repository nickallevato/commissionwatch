# The console's design language

**Written 2026-08-16**, after the operator rejected a dense console mockup as "messy and confusing",
chose a simpler shape, and approved its implementation on `/admin/sources`. This is that shape stated
as rules, so the other eleven console pages can be brought to it without re-deriving the reasoning
each time.

Every rule below came out of a specific thing that went wrong. The reason is kept with the rule,
because a rule without its reason gets applied as a style and dropped when it becomes inconvenient.

---

## The nine rules

### 1. Answer first

A page opens with the thing the operator came to learn, not with chrome or summary tiles. `/sources`
opens with the sweep that is running; if none is, it opens with the sentence "Nothing is sweeping."

**Why:** the rejected mockup opened with a four-tile summary row that restated numbers appearing
again twenty pixels below. The operator has a question; the top of the page should answer it.

### 2. Quiet the idle

Anything not needing attention collapses to one line. On `/sources`, an idle source is a single row;
the running one gets the whole block.

**Why:** giving equal visual weight to the four things that are fine and the one thing that is not is
how a console trains its reader to skim past the alert.

### 3. Spend the accent once

There is one red, and it marks the thing that is wrong or the place the pipeline stops. Nothing
else. On `/sources` the only accent elements are `0 collected, ever` and the three-day-old head of
the queue.

**Why:** the rejected mockup had accent pills, accent kickers, accent chips and accent rules, so the
accent meant "this is a heading" as often as "this is wrong", which is to say it meant nothing.

### 4. No ornament that carries no information

Removed from `/sources`: a four-tile summary row that restated the table below it, a fourteen-bar
sparkline whose own docblock conceded thirteen bars were always grey because the API returns one run
and no history, and a verdict pill that duplicated adjacent text.

**Why:** a sparkline of thirteen empty slots is not a chart, it is a decoration shaped like one. If a
component cannot be fed real data, it should not be on the page.

### 5. History beats a gauge

`/sources` replaced the sparkline with five real sweeps and, crucially, a column splitting each
sweep's **own** work from work it did for other sources.

**Why:** that column is what revealed the starvation bug. Five consecutive rows reading *own 0,
others 90* is a diagnosis; no per-source gauge could have shown it, because the fault was a property
of the queue and every screen showed sources. **When a fault is structural, the view has to be
structural.**

### 6. Every number says what it counts, and against what

`193 of 341`. `0 of 64`. `1 of 212`. Never a bare number where a denominator exists.

**Why:** `/data` reporting `records: 0` for a sweep that processed 90 documents, and the console
reporting `91 records` for the same sweep, were both true statements of different quantities with the
same label. The label is the bug.

### 7. Never show a figure the system does not have

`/sources` omits "next sweep 07:17" because the API exposes a cron expression and no computed next
fire. It omits `jobs/min` because nothing samples it, and shows `drained last hour` instead.

**Why:** this is a project about unsourced claims. A console that invents a plausible number is the
same failure in a back office.

### 8. Failure and emptiness are different states, and must look different

A failed fetch never renders as a zero. If `/queue` cannot be read, the page says so and still
renders the sources it did get — it does not print "0 jobs queued".

**Why:** an error rendered as a zero is a lie with a number on it, and it is the most dangerous
single defect class this console can have.

### 9. Plain English, and one date formatter

No raw enum reaches an operator's eye — `partial` is "Partly succeeded", never rounded up to
"Succeeded". Every timestamp goes through `@/lib/dates` and carries its timezone.

**Why:** an operator reading `8/15/2026, 1:32:01 AM` cannot tell whether that is their clock or the
server's, and they are using that screen to decide whether ingestion is stalled.

---

## Applying it to the remaining pages

Eleven pages remain. The rules land differently on each, and the point is not uniformity of layout —
it is that each page answers its own question first.

| Page | The question it should answer first |
|---|---|
| `AdminHomePage` | What needs a person, biggest blocker first |
| `AdminReviewPage` | Which findings are held, and for how long against the window |
| `AdminClaimsPage` | Which claims are waiting, grouped so 64 is workable rather than a wall |
| `AdminPlaceLinksPage` | Which place links are held, and what they would put on a public map |
| `AdminRunDetailPage` | Did this run do its own work, and what failed |
| `AdminSourceMeetingsPage` | What came out of this source, and what is publishable |
| `AdminMeetingDetailPage` | Is this meeting ready to publish, and what is missing |
| `AdminRecordsPage` | Which requests are outstanding, and how long they have been |
| `AdminRosterPage` | Which seats are sourced, which are implied, which are unknown |
| `AdminChannelsPage` | Which channels would actually deliver, and which are dark |
| `AdminFeaturesPage` | Which switches are on, and what each one currently controls |

### Two that need care beyond layout

**`AdminClaimsPage` is the bottleneck**, and layout is the least of it. There are 64 held claims
across one meeting and five subjects, all past the 72-hour window. A flat list of 64 rows is a wall.
Grouping by subject turns it into five decisions with nineteen, nineteen, ten, eight and eight items —
the same work, in a shape a person can finish. **This is the page most likely to actually move the
site.**

**`AdminFeaturesPage` must not lose its four empty-case distinctions.** The snapshot ledger there
already separates *field absent* from *request failed* from *never enabled* from *nothing recorded*,
and that precision was hard-won. Rule 2 says quiet the idle; it does not say collapse four different
answers into one.

## What must survive the re-layout, everywhere

Learned on `/sources`, where three documented decisions nearly went out with the ornament:

- **A zero that has been true for the product's life renders as wrong**, not as a tidy empty cell.
- **A watched expectation keeps both figures** — "31 h ago" against "expected every 12 h". One
  without the other is not checkable.
- **A disabled thing stays listed with its reason**, not hidden.
- **Every existing action keeps working.** These are re-layouts, not feature removals, and the action
  tests are the evidence: on `/sources` they passed untouched.
- **No test is deleted.** A test whose markup moved gets rewritten against the new DOM. The behaviour
  it protects is exactly what must not change.
