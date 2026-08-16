# API stability and project continuity — 2026-08-16

**What this is.** The two cheapest sustainability lifts identified by the 2026-08-16 maturity
review (`docs/superpowers/specs/2026-08-16-maturity-review.md` §7c, §7e) and named as roadmap
items 7.2 and 7.4. Sustainability scored level 1 — the worst category in that review — and both
of these are policy decisions with no engineering dependency: they cost writing the truth down,
not building anything. Both are published on `frontend/src/pages/DataLicensePage.tsx` (`/data`),
under the "API stability" and "Who runs this, and what happens if it stops" sections, and
enforced by `frontend/src/pages/DataLicensePage.test.tsx`.

**Why now, rather than at the moment of withdrawal.** The parity matrix
(`docs/superpowers/specs/2026-08-16-civic-platform-parity-matrix.md`) researched two cautionary
precedents while looking for prior art: the ProPublica Congress API issues no new keys, and Open
States has been absorbed into commercial Plural and is deprecating its public tooling. A
well-resourced newsroom and a flagship civic-data project both failed to keep a public API alive.
This project publishes `/api/data`, `/api/data/ocd.json`, `/feed.xml`, `/feed.rss` and an MCP
endpoint and invites people to build on them, with — until this spec — no stated stability tier.
Deciding the policy now costs nothing; deciding it under pressure, after someone has already built
on a surface that turns out to be unstable, costs their trust as well as ours.

---

## 7.2 — API stability and deprecation policy

### The tiers

| Tier | Surfaces | Promise |
|---|---|---|
| **Stable** | `/api/data` (manifest and bulk export), `/api/data/ocd.json`, `/feed.xml`, `/feed.rss`, the per-record read API (`/api/meetings`, `/api/officials`, `/api/votes`, `/api/matters`, `/api/search`, `/api/places`, `/api/source`, `/api/transcripts`, `/api/calendar`, `/api/corrections`, `/api/data`, `/api/metrics`, and the rest listed under "Getting the data" on `/data`) | Breaking changes get 90 days' notice. |
| **Experimental** | The MCP endpoint (`POST /mcp`, `/.well-known/mcp.json` — shipped dark, `MCP_ENABLED` unset per `CHANGELOG.md`), and anything else `CHANGELOG.md` records as shipped dark | May change shape or disappear without notice. |

The stable/experimental line is drawn at *shipped dark* exactly because a feature behind a flag
that has never been switched on for a reader carries no reader expectation to protect yet — the
project's own completeness-factor convention (`CHANGELOG.md`, "Shipped dark: built, tested,
deployed, off behind a flag") already marks this distinction, so the stability policy inherits it
rather than inventing a second taxonomy.

### The five rules, as published

1. **Two tiers, stated per endpoint** — the table above, published verbatim on `/data`.
2. **A withdrawal is announced, never 404'd.** A retired stable endpoint is announced on
   `/corrections` — the same surface used when a published claim changes — because withdrawing
   data people depend on is the same category of act as changing a claim. This is a policy
   commitment as of this spec; nothing in `backend/` currently automates posting to that log on a
   route removal, and that gap is not closed here — it is a future implementation task, not a
   documentation one, and it stays out of scope because this pass touches docs and the frontend
   only.
3. **90 days' notice** for retiring or breaking a stable endpoint. The notice states what
   replaces it or that nothing does — silence about the replacement is not permitted.
4. **Additive changes are not breaking.** A new field or a new dataset may appear on a stable
   surface at any time without notice. Consumers must tolerate unknown fields. This is stated
   explicitly so additive work is never blocked waiting on the notice period above.
5. **If the project ends, the final export is published and left reachable** for as long as the
   domain is held. This rule is shared with 7.4 below — an ended project and a withdrawn endpoint
   are the same event from a reader's chair, so the same promise covers both.

### Why `/data` rather than `/bot`

Both pages were read for voice and both were live candidates. `/bot` (`BotPage.tsx`) addresses
machine consumers directly and already lists the machine-readable surfaces — the audience match is
real. But `/data` (`DataLicensePage.tsx`) is where the project's actual promises about the API
already live: the three-layer licensing table, the endpoint list under "Getting the data," and the
attribution and reuse terms. `BotPage.test.tsx`'s own pattern is to link out to `/data` for "full
terms" rather than duplicate them ("Full terms on the open data page" — `BotPage.tsx:192-198`),
and `DataLicensePage.test.tsx` already has a guard (`the API surface the page advertises is the
one that is mounted`) that keeps its endpoint list from drifting off `backend/src/app.ts`. Adding
a second, separately-maintained copy of "here is our API surface and its terms" on `/bot` would be
exactly the hand-kept-list-that-drifts failure this codebase has already paid for once
(`DataLicensePage.tsx`'s own doc comment: "It listed six of these when the backend mounted
twenty-seven"). One canonical location, cross-linked, was chosen over two.

---

## 7.4 — Funding and continuity statement

Published in the new "Who runs this, and what happens if it stops" section on `/data`, directly
below the API stability section (a retired endpoint and an ended project are close enough in kind
that they read naturally in sequence).

### What is stated, plainly

- **Who runs it, on what basis.** A volunteer project — not a newsroom, not a nonprofit, no staff,
  no board, no funding beyond what the publisher pays out of pocket for the host, the domain and
  the model tokens. No money from any government, candidate, committee or party, matching
  `SECURITY.md`'s existing "volunteer watchdog project with no bounty programme."
- **Bus factor is one, stated as a fact rather than implied away.** `git shortlog -sne --all`
  returns two identities: `CommissionWatch <noreply@…>` at 440 commits (the agent) and Nick
  Allevato at 43 (one human, verified today). The page names the command and the number rather
  than writing "we" in a way that implies a team that does not exist — the maturity review's exact
  finding (§7a): "The roadmap's *Gaps* §1 correctly identifies review throughput as the binding
  constraint and correctly says the answer is to make a reviewer faster. **It does not say that
  the reviewer is singular.**" This page now says it.
- **What survives if it stops.** The three-layer licensing table already on `/data` is the
  mechanism, not new prose: the compiled dataset is CC BY 4.0, the code is MIT, both survive the
  project by design and require nobody's permission to keep using. The government documents
  underneath were never this project's to relicense — they are public records and stay obtainable
  from the jurisdictions whether or not this site is running. If the project ends, the final
  export is published as of that date and left reachable for as long as the domain is held.
- **What a reader should do if the site goes quiet.** The same records are obtainable from the
  custodians directly, and `/public-records` — the records-request generator — works identically
  whether or not this project is the one reading the answer. The page links to it.

### What this does not do

This is a statement, not a mitigation. It does not raise funding, does not create a second
reviewer (that is 7.1, filed separately and still **Planned**), and does not change bus factor
from one to more than one. The maturity review's finding that "cost is already blocking a
resilience control" (backups never leaving the instance, §1a) is unchanged by this spec — writing
down that funding is thin is not the same as fixing that it is thin. The value of this page is
narrower and real: a reader who has built something on this project's data now knows, in advance,
what happens if the one person behind it stops, instead of finding out the day it happens.

---

## Verification

`DataLicensePage.test.tsx` carries two new `describe` blocks — `"API stability"` and `"funding and
continuity"` — asserting: both tier names appear with their surfaces named; the 90-day notice and
"announced on the corrections log, never 404'd" language is present; additive changes are stated
as non-breaking; the bus-factor sentence and the `git shortlog` command are present; the volunteer/
no-staff/no-board language is present; the "record does not stop existing" and licensing-survival
language is present; and the page links to `/public-records`. Mutation-verified: removing the
"Bus factor is one." sentence made `it("states plainly that bus factor is one")` fail on exactly
that assertion; restoring it returned the suite to 25/25 passing.
