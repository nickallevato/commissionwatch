# The Pressroom console — presentation layer

**Date:** 2026-08-10
**Branch:** `worktree-agent-ad3bf23e9bd028093`
**Spec:** the approved mockup, artifact `89b93541-3fa8-42d7-968b-91a771ab7291`
("CommissionWatch — The Pressroom"), screens 01–06.

## The problem

The console's logic is correct and tested; its presentation layer was never
built. Across all seven admin pages there is not one sparkline, stripe, tile,
pill, meter or badge, and there is no `<nav>` anywhere in the admin at all.
`AdminHomePage` exists only because navigation does not — it is a link list
standing in for a rail.

The earlier briefs described behaviour ("zero renders as a failure state") and
never form. This plan describes form, and treats the mockup as the
specification rather than as a reference.

## What this is not

A re-skin plus a shell. **No behaviour and no API contract changes.** In
particular the publication wall (`services/publication.ts`), the review
threshold, the append-only `record_corrections` trigger and credential masking
are untouched. Where an existing test's DOM query stops matching, the query is
updated to the new markup; no assertion is deleted or loosened.

## Token mapping

The mockup declares its own custom properties. Every one maps onto a token that
already exists in `frontend/tailwind.config.ts`. **No new palette entry, no new
custom property, no new dependency.**

| Mockup | Token | Notes |
|---|---|---|
| `--paper` | `paper` | |
| `--sunk` | `paper-sunk` | the console ground |
| `--ink` / `--ink-soft` | `ink` / `ink-soft` | |
| `--muted` | `muted` | |
| `--rule` | `rule` | |
| `--accent` / `--fail` | `accent` | identical hex |
| `--accent-50` / `--fail-wash` | `accent-50` | identical hex |
| `--ok` | `pass` | identical hex |
| `--warn` | `sev3` | identical hex |
| `--rule-firm` (`#CFC7B6`) | — | **not in the palette.** Firm borders draw with `rule`; the double rules draw `border-double` in `rule`. |
| `--idle` (`#8A857C`) | `muted` | `sev2` carries the exact hex but is outside the sanctioned list |
| `--ok-wash` / `--warn-wash` | `paper-sunk` | no green/amber wash exists; the tinted rows take the sunk ground and keep their stripe and pill for meaning |

Faces: `font-display` for headings, `figure` / `tabular` for numerals,
`label-sm` + `tracking-label` for uppercase micro-labels. All already defined.

## Deliverables

### 1. `components/PressroomLayout.tsx` — the shell (new)

A route element, so every admin page inherits it and none has to remember to.

- Sunk ground; the work area is `paper`, so figure/ground still says which side
  of the publication wall you are on.
- A brand block — `CommissionWatch` in the display serif over `Pressroom` in
  accent micro-caps — that is a `Link` to `/admin`.
- A persistent left rail, a real `<nav aria-label="Pressroom">`, grouped
  **Operate** (Dashboard, Sources with a failure pip, Runs, Queue) /
  **Record** (Meetings, Officials, Requests) / **Deliver** (Channels,
  Subscribers) / **Later** (greyed). Group headings are `<h2>`s inside the nav,
  lists are `<ul>`.
- Active state carries **three** signals — a 2px accent left border, semibold
  ink on paper, and `aria-current="page"`. Never colour alone.
- Destinations that do not exist as routes render as greyed `<span>`s carrying
  the reason they are not links, exactly as `AdminHomePage` did for its
  record-scoped surfaces. A dead link would be worse than saying plainly where
  a surface is reached from.
- A signed-in-as footer with the operator's email in mono and a sign-out
  control.
- On narrow viewports the rail stacks above the work area rather than
  disappearing; it is the only navigation the console has.
- The failure pip counts sources whose verdict is `never_run`, `failing` or
  `suspect`, from `/api/admin/pressroom/sources`. The query fails silently: a
  console whose nav explodes because a count could not be fetched is worse than
  a console with no count.

### 2. `components/PressroomUI.tsx` — the primitives (new)

One module, components and constants only, so `react-refresh/only-export-components`
stays quiet. Everything is divs, spans and inline styles — no charting library.

- `PressroomCard` — moved here unchanged.
- `WorkTitle` — the `h1` + stamp row over a double rule.
- `Tiles` / `Tile` — the four-up stat grid. `tone` of `bad` / `warn` / `good` /
  `plain`; figures in `figure` at 25px.
- `Sparkline` — `<i>` elements with inline heights, 5px wide, 2px gap, 22px
  tall. Bars are `ok` / `warn` / `bad` / `none`; `none` is `rule`. Carries a
  `<span class="sr-only">` sentence, because a strip of coloured bars is not
  information to a screen reader.
- `SeverityStripe` — the 3px full-height stripe in a table cell.
- `StatusPill` — bordered `currentColor` span, uppercase, **always carrying its
  text**. `ok` / `warn` / `bad` / `idle` / `plain`.
- `SegmentedControl` — a real `role="radiogroup"` of `<button role="radio">`,
  arrow-key navigable, visible focus ring. Used for min severity and cadence.
- `SpendMeter` — label, 6px track, inline-width fill, `role="meter"` with
  `aria-valuenow/min/max`.
- `FlagBar` — the bordered strip with a micro-label and a sentence.
- `KeyValues` — the `dl` grid used by the provenance and artifact panels.
- `LogTail` — monospace `<pre>`, pre-wrap, own horizontal scroll.
- `Dropzone` — dashed bordered label wrapping a real `<input type="file">`.
- `ACTION` / `ACTION_QUIET` / `ACTION_PRIMARY` / `ACTION_SMALL` / `FOCUS_RING` —
  the button class constants, so seven pages stop each inventing their own.

### 3. Routing

Admin routes move out of the public `Layout` and into `PressroomLayout`. An
operator currently sees the newspaper masthead and the reader nav — Findings,
Meetings, Officials, Votes, Search, Methodology, Alerts — none of which is any
use backstage. `/admin/login` goes to its own bare centred shell, matching
screen 01: it has a masthead of its own and must not carry a rail an
unauthenticated visitor cannot use.

### 4. Screens

**01 Sign in** — verify against the mockup: centred card, masthead with
`Operator access` kicker, double rule, mono-faced fields, full-width primary
button, `or` divider with hairlines, dashed greyed Google/GitHub buttons with
their brand glyphs and a `Soon` tag, fineprint about the edge allowlist and
rate limiting. Add the brand glyphs and the double rule; the rest is close.

**02 Sources** — four tiles (sources configured / swept in 24h / records
ingested / longest silence). Records ingested renders in the failure colour at
zero, which is `data-zero="true"` today and stays that way. A fourteen-bar
sparkline per source, a severity stripe per row, status pills (Healthy /
Suspect / Never run / No adapter / Disabled), per-row actions, and the
silence-watch bar naming the expected cadence.

**03 Run detail** — an action row (sweep now, retry failed, backfill range,
re-parse without re-fetching), a job-stage table with state pills and counts, a
provenance panel, a monospace log tail. A partial run keeps `pass` and a red
row; it never collapses to "failed".

**04 Record inspector** — agenda items with per-field marks rendered
OK / Check / Fix, a source-artifact panel with sha256, an extracted-text view,
the append-only correction control, and a publish gate that says plainly when
publishing is over a known defect.

**05 Channels** — the channel table with type and masked config; an edit-route
panel with segmented severity and segmented cadence, posting to the existing
`POST /api/admin/channels/:id/routes`; the masked field with its `Stored` tag;
the SMS spend meter; the SSRF note.

**06 Records requests** — status tiles, a documents table with sha256 and the
duplicate row, an upload dropzone, and the extraction panel with held-entity
handling.

**Dashboard** (`/admin`) — `AdminHomePage` stops being a menu. It becomes what
the rail made redundant: the operator's session, the source tiles, the review
queue's pending count, and the one sentence that says whether the presses ran.

## Where the mockup cannot be honoured against real data

Recorded here rather than invented in the UI. Every one of these renders as an
explicit "not recorded" rather than a plausible number, because a transparency
project that fabricates its own operational figures has nothing left to stand
on.

1. **The fourteen-bar sparkline.** `GET /pressroom/sources` returns
   `latest_run`, not a run history, and adding a field would be an API change
   this brief forbids. The strip renders fourteen slots: the latest run in its
   real colour and thirteen `none` bars, with an `sr-only` sentence saying how
   many sweeps are actually on record.
2. **Provenance** — robots check, rate limit, user agent, artifact count,
   trigger and deploy sha are not in `RunDetail`. Adapter is. The rest render
   "Not recorded".
3. **The log tail** has no API. It renders the failed jobs' `last_error`
   verbatim, which is the only real log text the console holds.
4. **Retry failed / backfill range** have no endpoint. They render disabled
   with a stated reason, the same honesty the sign-in page's SSO buttons use.
5. **Artifact page count** is not stored. Byte size and content type are.
6. **SMS spend** has no counter. The meter renders against the route's
   `daily_send_cap` where one is set and says "no cap recorded" where none is.
7. **Channel "last delivery"** has no counter either. Every row reads
   "Not recorded", with a line under the table saying why.
8. **The mockup's `--rule-firm`, `--ok-wash` and `--warn-wash`** have no token.
   Firm borders draw in `rule`; a tinted row takes `paper-sunk` or `accent-50`
   and keeps its meaning from the stripe and the pill, both of which carry
   text. No palette entry was added.

## Verification

```
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baselines: backend 827, frontend 307 / 33 files, deploy 61 / 0, zero lint
problems in both. The frontend count rises as the new components get coverage.
</invoke>
