# CommissionWatch — Status, Gaps and Next Steps

> Last updated: 2026-08-15, after a long parallel build that took the product from *a corpus with
> nowhere to go* to **a claim an operator can approve, a reader can see, and a citation that opens
> the document it cites** — see § 2026-08-15 immediately below. Backend **1600 tests / 375 suites**,
> frontend **572 / 54**, both packages typecheck- and lint-clean, deployed at `febae02`.
> Before that: 2026-08-14, **closing ten unauthenticated public writes, deleting the dead
> agent package, opening the crawler door, and landing the regions module** — see
> § 2026-08-14, and the design of record at
> `docs/superpowers/specs/2026-08-14-system-roadmap-design.md`. **Production is healthy and serving
> the fix**; the "PRODUCTION IS DOWN" entry under Known defects is from 2026-08-09 and is stale,
> annotated there rather than deleted. Before that: **minutes extraction landing and reading a real meeting** (below
> — 44 cited claims from the 2026-07-14 Bozeman minutes, every one held, and seven defects found by
> running it rather than reading it). Before that: **the first live Bozeman sweep and the four defects it exposed**
> (below — a sweep that worked perfectly was recorded `failed`, nothing drained the queue between
> sweeps, "Sweep now" reported a gateway timeout as a sweep failure, and "0 agenda items" meant two
> opposite things). Before that: **building the two console levers that stood between a healthy
> deployment and a live one** (below — production had every source registered and no way to enable
> one, because the only code that flipped the flag lives in a script the production image does not
> ship). Before that: **putting the name-match quality in front of the operator who
> approves it** (below — the public page showed the band and the review console showed nothing,
> so the person deciding knew less than the person reading) and **remembering an operator's
> entity-resolution judgement** so the same ambiguous pair is not re-asked every sweep. Before
> those: **joining a dispute to the correction it produced** (B3, below —
> `dispute_id` was a column nothing wrote) and giving the **external monitor a trigger that
> actually fires** (`deploy/monitor-trigger.sh`, below — one operator action remains, and the
> dead-man's-switch gap is named there rather than left implicit). Before those: the **bulk data
> export, the fork path and the public meeting calendar** (see below) — the launch-readiness item that was not B3. Before that: **B3 —
> the public corrections log and the dispute route**, which was the last build gate on making this site publicly reachable. Earlier the same
> day: the **findings review queue** (B-a and B-b's
> replacement) — the change that made publishing a finding possible at all. Earlier still:
> the **public status page** and a sweep of the known defects; and before those: P7 (the public-records request generator), P5 (the agenda diff
> timeline) and P6 (full-text search).
> Previously the same day after P2 (the Pressroom console) and the deploy healthcheck fix, and
> 2026-08-09 after P1 (ingestion scheduling), P3 (backups) and P4 (the Bozeman Granicus adapter).
> Read this before starting work. It records what is true, not what was planned.

## 2026-08-15 — the pipeline joined up, end to end

The through-line: **several pieces already existed and were simply unreachable**, and connecting
them is what found the bugs. `DeliveryDispatcher` — 643 lines of durable, batching, consent-gating
delivery — had never been constructed by a running server. `minute_claims` had review columns since
migration 072 and nothing wrote them. `rosterCoverage` had no caller. Every one of those is now
wired, and each wiring surfaced a defect that reading the code had not.

**Deployed and verified in production at `febae02`.**

### What is now true that was not

- **An operator can approve a claim.** Migration 087 adds the render pin, and a CHECK that an
  `approved` row carries the rendered sentence, the sha of *those exact bytes*, a version and an
  approver. Approving is no longer a status flip — the pin is what stops a later template edit
  republishing words nobody read.
- **A reader can see one.** `GET /api/meetings/:id/claims`, rendered at `#claim-{id}` on the meeting
  page. A claim is never its own page: a page whose entire content is one sentence about one named
  person is an accusation; the same sentence inside the record it came from is a record.
- **A citation opens the document it cites.** `/api/source/{sha256}` and the page over it.
- **The archive has a second corpus.** Bozeman captions across 1,135 archived meetings, parsed into
  cues and searchable. Minutes became searchable earlier the same day — they had been fetched,
  stored, content-addressed and never indexed.
- **A withdrawn record revokes what announced it**, in both directions: claim retraction and meeting
  unpublish.
- **Events exist, and the dispatcher is running dark.** `EVENT_DRAIN_ENABLED` is unset, so the loop
  runs in production over an empty `channel_routes` table. That is deliberate: it is the cheapest
  possible way to find out it works.

### Also landed

RSS/Atom and the query feed (the subscription is the URL — no account, nothing to leak, nothing to
unsubscribe from). `vote_events`, so *"the motion failed 2–3"* is a stored fact with a check that the
linked claims must sum to the counts. Extraction as a real queue stage. `/api/metrics` and `/metrics`,
this project measured by its own standard. `/api/data/ocd.json`. The record receipt. `/bot`. The
privacy page. Matters. Discord routing with audience separation. Email suppression.

### Prerendering is wired into deploy, and it is OFF until an operator turns it on

`backend/src/services/prerender/` writes one self-contained HTML document per public record. It is
now connected to something that serves it:

- **A named volume, `commissionwatch-prerender`** — `deploy/docker-compose.shared.yml`. Mounted
  **rw** in the backend at `/var/lib/commissionwatch/prerender`, **ro** in the web container at
  `/usr/share/nginx/html/_prerender`. Read-only there on purpose: `web` is the only container on the
  `edge` network, so it is the only one an internet request can reach.
- **`PRERENDER_OUTPUT_DIR`** is pinned to the mount point. Left at the code default it writes into
  the container's writable layer — correct pages, served to nobody, lost on the next deploy.
- **`PRERENDER_ENABLED` is passed through unset**, exactly like `EVENT_DRAIN_ENABLED`. Off, the
  consumer writes nothing, every nginx lookup misses, and the site is byte-for-byte what it was.
- **nginx serves the prerendered copy to crawlers only** — `frontend/nginx.conf`. The documents load
  no stylesheet and no script (`document.ts` explains why the SPA bundle's hashed filename is not
  knowable from the backend), so serving them to a browser would replace the React app with a bare
  document on exactly the pages that matter. A `map $http_user_agent $prerender_prefix` sends known
  crawlers and unfurlers to `/_prerender$uri/index.html` and everyone else to a prefix that cannot
  exist. Same records at the same URL either way, so this is server-side rendering for clients that
  do not run JavaScript, not cloaking.
- **The tree is not directly addressable.** `location ^~ /_prerender/ { internal; }` — `^~` because
  the static-extension regex runs before prefix locations and would otherwise serve
  `/_prerender/.prerender-cursor.json`, the consumer's replication cursor, to anyone who asked.
- **`Vary: User-Agent`** on `location /`, with the whole server-level security header set repeated
  there because nginx's `add_header` does not merge across levels. Without the `Vary`, any cache
  between here and a reader can hand a crawler's unstyled document to the next human.

#### ⛔ OPERATOR ACTION — two steps, in this order

1. Deploy. Nothing changes: the volume is empty, the flag is unset, every lookup falls through to
   the SPA. This is verifiable and is the point of shipping it dark.
2. Add `PRERENDER_ENABLED=true` to the SecureString at `/commissionwatch/env` (Parameter Store) and
   redeploy. Then seed the tree from the database rather than waiting for the next publish, because
   the consumer walks the **event log** and nothing replays a meeting published weeks ago:

   ```bash
   docker exec commissionwatch-backend node dist/src/scripts/prerender-rebuild.js
   ```

   Idempotent, safe at any time, and the tool to reach for whenever a page looks stale — it also
   deletes the page of anything no longer public, which is the half that matters. `PUBLIC_BASE_URL`
   must be set or it throws before writing anything; every page carries an absolute canonical.

Verified in a container on 2026-08-15, not by `nginx -t`: prerendered and non-prerendered record
paths under both a Googlebot and a Chrome UA, `/data`, `/api/data/meetings.csv`, `/sitemap.xml`,
`/feed.xml`, `/version.json`, `/robots.txt`, a hashed asset, the `/anomalies` redirect, and
`/_prerender/.prerender-cursor.json` (404, as required). Also verified: an empty volume serves the
SPA with no error, and files written by the backend's root process are readable by the nginx worker.

One trap found while doing it: **a volume cannot be mounted under a read-only bind mount**. Docker
cannot create the mountpoint and the container fails to start. Production is unaffected — the
document root there comes from the image layer — but a local test that bind-mounts `frontend/dist`
read-only at `/usr/share/nginx/html` will fail with `read-only file system` until it is made rw or
baked into a test image.

### The defects worth remembering

**A fragment never leaves the browser.** `sourceHref` and the claims service, in three places
total, built `/source/{sha}#offset-{n}`. The server picks the window, so every citation link would
have opened a three-hundred-page packet at character zero regardless of what it cited — and nothing
would have looked broken. Found by an agent building the page at the *other* end, not by reading the
code. All three now build `?offset=&len=`; `len` exists because the API returns no quote length, so
without it a viewer can find where a quote starts and not where it ends.

**Second copies fail the same way, whether of a rule or a constant.** `emitEvent` kept its own copy
of the claim wall and went one clause stale the moment migration 087 added `retracted_at` — so a
claim withdrawn *after* its event was written still read as public. Two agents found it from
opposite ends, the feed reading the wall and the retractor writing it, because the feed used
`whereClaimPublic` and the emitter did not. Separately, `test/adapters/contract.ts` held a
hand-copied duplicate of `DOCUMENT_KINDS`, so every well-formed transcript ref was called an unknown
kind.

**The email log was lying, daily, in production.** `sendEmail` returned `void` whether it reached a
provider or wrote a line to stdout, and both callers then wrote `email_status: 'sent'` with a
timestamp. `DigestScheduler` had been running that path against a service with no `RESEND_API_KEY`.
Underneath it, `initResend` was an `async` method called un-awaited from a synchronous constructor,
so `this.resend` was null for a window *even when a key was set*. `dry_run` is now its own status.

**A CHECK constraint that evaluates to NULL is satisfied — four of them shipped in one day.**
`jsonb_typeof(counts -> 'absent')` is NULL for a missing key, so the constraint on
`vote_events.counts` accepted exactly the malformed tally it existed to refuse. Then
`place_links_citation_check` let a `stated` link insert with **no citation at all**, and that one
had been wrong for hours while invisible, because nothing had ever written to the table — the first
writer found it on its first run. An audit for the shape then found two more:
`minute_claims_approved_pin_check` would have let an approved claim carry no render pin, and
`transcript_status_sha_check` would have let a published transcript carry no hash of the bytes it
claims to have read.

The rule is not about jsonb or about regex: **`A OR (B AND C)` with a nullable operand on the right
enforces nothing**, and the row it admits is the one that violates it hardest — the one with the
columns simply absent. Wrap the disjunct in `coalesce(..., false)`.

Neither of the last two had ever bitten, because their writers happen to set the columns. That is
why the response was a guard rather than four fixes: a constraint that is true only by the good
manners of its one caller fails the day a second caller appears, silently.
`test/migrations-selfcontained.test.ts` now audits the live schema, exempting by **name with a
stated reason** plus two provably-safe shapes — because any regex loose enough to cover the safe
ones covers the dangerous one too, which is exactly how this went unnoticed four times. Verified to
bite by injecting one.

**Restart safety was not free.** Nothing ever returned a claimed `ingestion_jobs` row to the queue,
so moving extraction onto the queue would have relocated the permanent-limbo bug rather than
removing it. `recoverStalled` had to be built.

**`return 301 /findings` emitted an absolute `Location`** built from the Host header and the
container's own listen port — `commissionwatch.bmux.sh:3000`, unreachable from the internet.
`nginx -t` was perfectly happy. Running the config in a container and reading the header is what
found it.

### Still not done, and known

- **The roster is unsourced.** `members` carries no `source_url`, `fetched_at` or `artifact_sha256`,
  so a row naming a real commissioner is indistinguishable from one somebody typed. `/metrics`
  publishes `roster_sourced: false` and the page says so in the reader's words. This gates the claim
  pipeline: every unmatched name is a true claim the verifier throws away.
- **Nothing has run the backfill.** `npm run backfill:artifact-text` exists; until an operator runs
  it on the host, minutes stay unindexed for the *existing* archive — the code fix only catches new
  fetches. Start with `-- --dry-run`.
- **The extraction failure distribution is unmeasured.** `failed_chunks` now carries a structured
  reason (`truncated` / `refused` / `upstream-error` / `reasoning-only` / …). One SQL query answers
  which dominates, and that answer decides whether the next work is chunk splitting, a prompt
  change, or abandoning the free tier. Guessing wrong there costs a day.
- **Email cannot ship.** SPF/DKIM/DMARC are unconfigured and `ALERT_FROM_EMAIL` still defaults to
  `alerts@commissionwatch.org`, which is not the deployed domain and will fail alignment.
- **The Methodology page must disclose transcripts before the first transcript sweep.** The vendor
  robots exception is valid *only while disclosed*, and the current disclosure names agendas and
  minutes.
- Gallatin transcripts are **not** buildable: AV Capture All behind an AWS WAF challenge. The answer
  is a records request, not a client.

## 2026-08-14 — the public writes were open, and the site was invisible

Nine commits. The first four are **deployed and verified in production** (sha `9d2825c`); the rest
are on `main` and ship on the next deploy. `SHARED_STACK_LIVE` is set, so **every push to `main`
now deploys.**

### ⛔ The defect that mattered — `POST /api/anomalies` was unauthenticated

`backend/src/routes/anomalies.ts` was mounted on the public `/api` surface with **no guard**, and
passed `alwaysHold: false` unconditionally. `alwaysHold` is what carries *nothing naming a person
auto-publishes* — the detectors derive it from what they matched. So an anonymous stranger could
`POST` a `medium`- or `low`-severity finding naming a living official and have it **published under
this project's byline** at the default `high` threshold, with no operator ever seeing it.
`DELETE /api/anomalies/:id` was open too, as were both detection routes,
`/meetings/:id/detect-anomalies`, and all six writes on `members` and `votes` — the two tables
`/officials/:id` computes its arithmetic from.

Only the Caddy IP allowlist stood in front of it. **This file said "B3 no longer blocks going
public"; that was written without knowing this.** It is now closed, and verified live:
`POST /api/anomalies` → 401, `POST /api/members` → 401, `GET /api/anomalies` → 200.

**A hand-entered finding is now held at every severity.** Deriving `alwaysHold` from a roster name
match was the obvious alternative and is weaker — `members` holds seed fixtures, so matching
against it is a guard that only looks like one. The honest reason is that a hand-entered finding
has no detector, no `RULES_VERSION` and no citation behind it, and approval already refuses a
finding citing no stored artifact.

### `agents/meeting-monitor` is deleted

A second analysis engine writing the same `anomaly_flags` table with none of the discipline: a bare
insert with no delete-then-insert, so every re-run duplicated every flag, and it never wrote
`review_state`. Its ~72 tests ran in no CI job. Its untracked `dist/` held three compiled modules
whose TypeScript source does not exist in this repo, and `npm start` ran them.

A module-by-module salvage check found nothing worth porting. Three latent bugs recorded on the way
out: `extractors.ts:207`'s `/^\s*[,;:to]+\s*/` is a character class, not the word "to", so "table
the ordinance" loses its `t`; `extractors.ts:236`'s unanimous-vote `if` has a comment for a body;
and `generator.ts:76` rendered a **`failed` motion as `deferred`**, publishing a motion the body
voted down as merely postponed — a "describe the record" violation, and the clearest argument
against porting any of it.

**One consequence, deliberately left standing:** `rundown_sheets` now has no writer.
`GET /meetings/:id/rundown` answers 404 with "Rundown not yet generated" and the page degrades
quietly, so nothing false reaches a reader — but the surface is dormant. Reviving it on the
reviewed-claims path or retiring the table is an open decision.

### The site was invisible to every crawler, and it was one line

`frontend/nginx.conf`'s `try_files $uri $uri/ /index.html` meant `/robots.txt`, `/sitemap.xml` and
`/llms.txt` all returned **HTTP 200 with the 525-byte application shell**. Verified against the
live site before the fix. A crawler asking for our policy was told, in HTML, that there wasn't one.

This matters more than it looks: measured across ~500M fetches, GPTBot fetches JS in 11.5% of
requests and ClaudeBot in 23.8%, and **neither executes it**. A shell is all they ever see.

- `frontend/public/robots.txt` names the **retrieval** crawlers separately from the training ones —
  they are different user-agents, and they are the ones that decide whether we appear in an answer.
  `/admin/` is disallowed for everyone.
- **`GET /sitemap.xml` goes through the publication wall.** It is the fourth public surface that
  takes no id, after `/api/anomalies`, `/search` and `/corrections`. Every other public path takes a
  meeting id, so a reader who cannot guess one cannot reach a withheld record — a document that
  *lists* URLs hands the ids out. `sitemap.test.ts` asserts it in both directions. An official is
  listed only with a vote on a published meeting, so the seed fixtures cannot reach it.
- `lastmod` is the row's `updated_at`, never build time. No `<changefreq>`/`<priority>` — Google
  ignores both.
- **The `/api/` nginx location is now `^~`.** nginx tries regex locations *before* plain prefix
  matches, so the new static-extension rule would otherwise have captured `/api/data/meetings.csv`
  and 404'd every bulk export off disk. Caught by running the config in a container and curling
  each path, not by reasoning about matching order.

### The regions module — migration 074

`jurisdiction_access_policy`, one verified dated record per jurisdiction: vendor platform, robots
posture, crawl delay, concurrency, user agent, ToS notes, `verified_on`/`verified_by`.

**The line it draws: our conduct is ours to state; their statute is theirs and must be read.** So
this table ships **seeded** and `jurisdiction_records_law` still ships **empty**. The rows here
record decisions this project made about its own behaviour; a statute is the opposite, and the
letter generator still refuses rather than inventing a deadline. **Do not blur that line later.**

- **The disclosure is a CHECK, not a habit.** A `vendor_exception` row is illegal unless
  `disclosure_required` is true. `assessPosture` refuses one a second time in code — the constraint
  protects the table, the service protects the sweep against a row from a restore or a hand-edited
  staging database.
- **No policy means `fetchable: false`.** The absence of a decision must not read as permission to
  crawl politely; that is how a jurisdiction added by a future migration starts being fetched under
  a policy no human agreed to.
- **Staleness never stops a sweep** — it is surfaced for a human. A status set by a clock later
  reads exactly like a decision somebody made (B-a's expiry reasoning, applied again).
- **The seed carries the same two rows.** `jurisdiction_access_policy` cascades from
  `jurisdictions`, which `seeds/001_pilot_data.ts` deletes wholesale — the same collision migration
  037 hit. Left alone, a seeded dev database refuses to fetch anything, correctly but confusingly.

### The error handler had no tests, and threw on an already-sent response

Zero test references, on the module that decides what an unhandled exception tells a stranger.
Writing them found two real defects. **It threw inside itself when headers were already sent** — a
route that had begun writing (a bulk export, the new sitemap) and then threw turned a handled error
into an unhandled one, and the caller got a truncated body with a 200 on it. It delegates now, as
Express's own final handler does. And **a `statusCode` outside HTTP's range** raised a RangeError
that reached the caller as a socket hang-up.

`_next` became `next` and is genuinely used, so **backend lint is 2 warnings → 1** by the parameter
doing work rather than by the config being weakened. Only `embeddings.ts`'s `_limit` remains.

One harness bug worth recording: a `quiet()` helper chained `.finally()` on supertest's `Test`,
which is a thenable rather than a real promise and never settles. Every 500 test hung and no other
did, which pointed at the middleware rather than the helper.

### Accessibility, and the frontend

Six public pages — Members, Meetings, Anomalies, Search, Votes, NotFound — opened with `<h2>` and
had **no `<h1>` at all**, while four others did it correctly. Fixed, with the level skip below them
corrected. Focus now moves to the page heading on navigation, chosen over a route announcer because
an announcer leaves a keyboard user's next Tab back in the nav they just left.

**Automated a11y assertions exist for the first time**, over 15 public routes through the full app.
`vitest-axe` was tried and dropped — its typings augment a `Vi` namespace Vitest 2 removed, so the
assertion does not typecheck and the only fixes are a cast or a suppression, both barred. Built on
`axe-core`'s own typed API instead. It immediately found a genuine violation: `HomePage`'s lead
column was a `<main>` nested inside `Layout`'s `<main>`. `color-contrast` is the single exclusion,
with the reason in the code — it needs a canvas jsdom does not have.

`darkMode: "class"` is deleted; nothing ever added the class. Public tables reflow to cards below
`sm`, carrying explicit ARIA roles because `display: block` strips a table's implicit semantics in
every browser.

### Counts after 2026-08-14

Backend **1308 tests / 308 suites**, from 1262/299. Frontend **485 / 45**, from 409/41. Both green,
typecheck clean, backend lint **1 warning / 0 errors**, frontend lint 0 problems.

### Research that did not become code, and should not be re-done

`docs/superpowers/specs/2026-08-14-system-roadmap-design.md` holds the reasoning. Headlines:

- **Firecrawl: skip.** Its differentiator over `fetch`+`cheerio` is the managed anti-bot/proxy
  layer, which SKILL.md's hard line forbids; it returns markdown derivatives that cannot back a
  sha256 citation; it fetches as `FirecrawlAgent`, which would make our disclosed robots exception
  false; and it bills per fetch, discarding the ETag/sha256 dedup this pipeline is built on.
- **No meeting bot.** `bozeman.granicus.com/videos/{clip_id}/captions.vtt` returns real timestamped
  WebVTT — 9 of 14 sampled clips, one of them 5,480 lines. The custodian publishes the transcript.
- **Three adapters cover urban Montana**, not fifty: CivicPlus AgendaCenter, CivicClerk OData
  (Missoula, open, no auth), Granicus RSS. Two are built. **Neither Bozeman nor Gallatin is a
  Legistar tenant** (verified 500s; `bozeman.legistar.com` returning 200 is a wildcard trap).
- **Bozeman's RSS endpoint returns the same discovery data in 79 KB versus the 5.9 MB page we fetch
  today** — worth shrinking the robots exception to.
- **MCA 2-6-1006 was rewritten effective 2026-07-01.** The (Temporary) version cited in the P7
  section below terminated 2026-06-30. Reportedly the replacement leaves local governments with
  **no numeric deadline at all**, and §2-6-1006(1)(d) means **no right to machine-readable format**.
  *Reported by research, not verified by a human* — the P7 operator task now also has to confirm
  which edition it is reading.
- **Every Bozeman minutes PDF from ~clip 2775 on** opens: *"These meeting minutes were generated
  with the assistance of artificial intelligence and have not been reviewed, approved, or adopted
  by the City Commission."* The city ships unreviewed AI summaries as its official record; ours
  pass a review queue. **Lead with the review gate, never with the AI.**

## Archive salvage — what has landed

Working from `docs/superpowers/specs/2026-08-09-archive-salvage-design.md`.

| Item | State |
|---|---|
| A4 · `vote_donor_conflict` anomaly type | **Landed.** Migration 020. The enum carries seven values. |
| A2 · OpenFEC client | **Landed.** Migrations 021, plus `HttpCache` and `OpenFecClient`. No orchestration framework came with it. Needs `OPENFEC_API_KEY` to make a live call; every test is fixture-based. |
| A1 · Operator authentication | **Landed.** Migrations 022–023, scrypt passwords, server-side sessions in an httpOnly cookie, `/api/admin/*` closed by default, CORS split. |
| A3 · Embedding client | **Withdrawn.** Nothing consumes embeddings; see the spec. The want underneath it — *find me everything about this* — is answered by P6's Postgres full-text search instead. |
| B-e · Subscriptions and delivery | **Landed.** Migrations 024–025. A subscription is a destination, a filter and a cadence. SMS added with consent and a per-day cap. |
| B-a · Review queue | **Landed 2026-08-10.** Migration 038. `approval_requests`, a single severity threshold in place of `execution_policies`, claim-to-citation binding, and operator approval as the only thing that makes a finding public. See below. |
| B-b · Execution policies | **Collapsed, as specced.** Replaced by `review_policy` — one row, one threshold. Not ported. |
| B-d · Records requests | **Landed.** Migrations 026–027. A hand-obtained document takes the identical path as a scraped one, and records-derived flags are held, never published. |

**The dispatcher still sends no email.** That is deliberate and load-bearing.
`alert_subscriptions` is retained read-only for one release and the legacy
`EmailDeliveryService` remains email's only sender, which is what makes B-e's
back-fill of those rows onto `delivery_channels` incapable of double-sending.
`test/subscriptions-unified.test.ts` asserts it. Cutting email over to the
dispatcher and dropping `alert_subscriptions` is a separate change, and the two
must happen in the same commit.

**The legacy routers over those rows are now operator-only** (2026-08-13). Every
route on `/api/subscriptions` and `/api/notifications` joins `alert_subscriptions`
and selects the subscriber's email, and all of them were unauthenticated:
`GET /api/subscriptions` with no query was a paginated dump of every subscriber's
address, `POST` returned the `verify_token` it had just minted — so an address
could be subscribed and verified by someone who does not read it — and `DELETE`
took an id the list had handed out. The two token-scoped links a subscriber
follows from their own mail, `/verify/:token` and `/unsubscribe/:token`, stay
open; an unsubscribe that demands a login is an unsubscribe that does not work.
Nothing in the frontend called any of the guarded routes. When
`alert_subscriptions` is dropped, both routers go with it.

Per `CLAUDE.md`, nothing in the delivery layer sends product events yet — including SMS. The
substrate exists. **The review queue landed 2026-08-10** (B-a, below), so the gate it was waiting
on is now built; cutting delivery over to published findings is a separate, deliberate change, and
the notification path is already filtered so a held finding can never be sent.

**There is no operator account until one is seeded.** The backend creates the first
operator at boot from `OPERATOR_SEED_EMAIL` / `OPERATOR_SEED_PASSWORD` /
`OPERATOR_SEED_NAME`, once, and only while `operators` is empty. Those reach the container
from `/commissionwatch/env` in Parameter Store like every other secret. Clear them after the
first boot: leaving them set does nothing except keep a password in the environment. Without
them the admin console exists and cannot be entered, which is the correct default.

`ADMIN_ORIGINS` gates credentialed requests to `/api/admin`. The public read-only API stays
open to any origin — that is deliberate, and open data is the point.

## P2 — the Pressroom console has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P2 and
`docs/superpowers/plans/2026-08-10-pressroom-console.md`. Migrations 030–033.

Three operator screens behind `requireOperator`: `/admin/sources`, `/admin/runs/:id`,
`/admin/meetings/:id`, served by `/api/admin/pressroom/*`.

**`ingested` and `published` are now different states.** `meetings.published_at` exists, and a
meeting with `published_at IS NULL` **does not appear in any public API response** — ten public
paths take a meeting id and a test walks all ten. Existing rows were backfilled to `created_at`,
so nothing that was public stopped being public. **Rows ingested from here on default to NULL**:
a sweep produces a candidate, an operator produces a publication, and the seed sets the column
explicitly because seed data demonstrates the public record. An unpublished meeting 404s rather
than 403s, so nobody can enumerate what has been ingested and withheld.

**Corrections are append-only, in the database.** `record_corrections` records who, when, field,
old, new and why, and a trigger raises on `UPDATE` and on `DELETE`. **The artifact is never
mutated** — a test hashes the `artifacts` row either side of a correction. The table has no
foreign key to its target and none to `operators`: a cascade from `meetings` would collide with
the trigger on every `pretest` seed, and `ON DELETE SET NULL` is itself an `UPDATE` the trigger
forbids, so the actor is snapshotted as `operator_email`. **A consequence: tests cannot clean up
`record_corrections`.** Rows accumulate in the test database, keyed on ids each run generates.
That is intended, not a leak.

**Confidence is per field.** `agenda_items.field_confidence` is a jsonb map of
`{ level, reason }` per column, written by the extractor: a title truncated by the
255-character column, an item with no section heading above it, a description cut at its limit.
Seven good items and one mangled one is not a low-confidence meeting.

**Silence is watched, and zero is a failure state.** A source past its own
`expected_interval_hours` since its last success reads *Suspect*. Lifetime ingested records is
computed from every run's `counts` and renders in the failure colour at 0. Disabled sources stay
listed with `disabled_reason`, seeded from the adapter's own notes — the Akamai block on
`bozemanmt.gov` is now in the console rather than in a code comment.

**Re-parse without re-fetching** opens a *new* `ingestion_runs` row and queues one `parse` job
per stored artifact. It cannot reach the network: parse targets carry a `sha256`, the queue
rejects a post-fetch target carrying a `url`, and the parse stage has no path back to a URL. It
is a separate action from "sweep now".

The two action routes need the live queue and scheduler, handed over by
`registerPressroomStack` from `index.ts`. **In a process where ingestion is not running they
answer 503**, which is why the test suite sees 503 rather than a constructed MinIO client.

Counts after P2: backend **660 tests / 168 suites**, frontend **180 / 25**, both green, zero
lint errors.

## P5 — the agenda diff timeline has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P5 and
`docs/superpowers/plans/2026-08-10-agenda-diff-timeline.md`. Migration 034.

**`meeting_documents` and `artifacts` are joined at last.** `document_versions` carries
`(meeting_document_id, artifact_id, version_no, first_seen_at, item_snapshot)` with a unique
constraint on each of the first two pairings. The fetch stage writes a row on **every** successful
fetch and lets the constraints decide: unchanged bytes resolve to the same artifact and collide,
changed bytes create exactly one version. There is deliberately no "have I seen this before?"
branch anywhere — that question and the content address can disagree, and then only one of them is
the record.

**The backfill produced 19 version rows for the 19 existing artifacts** — 11 Gallatin, 8 Bozeman —
all version 1, no artifact left unattached. It takes two passes, and the second one is the point:
matching `artifacts.source_url` to `meeting_documents.url` covers Gallatin and **misses Bozeman
entirely**, because Granicus redirects `AgendaViewer.php` to an S3 attachment and `source_url`
records where the bytes actually came from. The second pass goes through the `parse` job the fetch
stage enqueued, whose target carries the sha256, the meeting and the document type. A URL join
alone would have backfilled two thirds of the record and reported success.

**The diff is over extracted agenda items, never bytes.** Two renderings of an identical agenda
differ in their creation timestamp and generator string. `document_versions.item_snapshot` holds
what was extracted from *that* artifact, because `agenda_items` cannot answer for a superseded
version — it is merged on `(meeting_id, item_number)`, so parsing version 2 overwrites version 1.
A NULL snapshot means "not extracted" and renders as that, never as an empty agenda.

**`last_minute_agenda_change` can finally be substantiated, and the heuristic that faked it is
gone.** The old `checkLastMinuteAgendaChange` compared `agenda_items.created_at` — the moment *we*
ingested a row — against the meeting date, so any meeting swept the day before it convened flagged
every item on its agenda as added within 24 hours. That was a statement about our own database
published as a statement about the public record. It now compares two published documents, and the
evidence carries **both artifact hashes** and the changed item list. `RULES_VERSION` is `3.0.0`.

**Two schema facts the spec did not have.** `meetings` has no `scheduled_at`: it has a `DATE` and a
nullable `TIME`, and a meeting with no published time raises nothing rather than being assumed to
convene at midnight. And the wall time needs a zone — `jurisdictions.timezone` (default
`America/Denver`) was added with `agenda_change_window_hours` (default 48), because composing the
instant in the server's zone would make a published "19 hours before" quietly wrong by six or seven.
`MeetingRef.timezone` has been in the adapter contract since P1 and was discarded on the way to the
database.

**A flag whose changed items name someone on the roster is written `held`.** The public API already
filters `review_state`.

`GET /api/meetings/:id/agenda-diff` is behind `findPublishedMeeting` and is now the eighth public
meeting path `meeting-publication.test.ts` walks. On the meeting page,
`AgendaDiffTimeline.tsx` renders a two-column diff, each side labelled with its version's
`first_seen_at` and short hash. **The one-version case — the common one — renders as a single calm
sentence**, not an empty comparison and not a "no changes" badge, which would assert the result of
a comparison that never happened.

Counts after P5: backend **703 tests / 176 suites**, frontend **196 / 26**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

**One trap this introduced.** `document_versions.artifact_id` has no `ON DELETE CASCADE`, on
purpose — a version row losing its evidence silently would leave a citation pointing at nothing.
So a fixture teardown must drop meetings *before* artifacts, since the meeting cascade is what
releases them. `ingestion-handlers.test.ts` had the opposite order and failed loudly, which is the
constraint working.

## P6 — full-text search has landed

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P6 and
`docs/superpowers/plans/2026-08-10-full-text-search.md`. Migration 035.

**This is the honest replacement for the withdrawn embedding work**, not a step towards it.
PostgreSQL answers *find me everything about this* with no vendor, no API key, no per-call cost and
no dimension decision. `document_embeddings` and `vector(1536)` are untouched, and if
exact-and-stemmed search proves insufficient in practice, *that* is the evidence that would justify
revisiting embeddings — with a requirement attached.

`GET /api/search?q=` is public and unauthenticated, paginated, and returns results discriminated by
`kind`: `agenda_item`, `meeting`, `member`, `document`. `websearch_to_tsquery` takes quoted phrases
and `-exclusions`; `ts_headline` returns the matching sentence.

**Search is the only public surface that could walk straight through the publication wall.** Every
other path takes a meeting id, so a reader who cannot guess one cannot reach a withheld record.
Search takes a *word*. Every meeting-derived query goes through `whereMeetingPublished` — which
gained an optional column argument so a joined query can name `m.published_at` rather than leave
`published_at` to become ambiguous — and `search.test.ts` asserts the wall **in both directions**:
an unpublished meeting, its agenda items and its document text are absent, and publishing the
meeting makes all three appear. Absence alone also holds for a search that returns nothing at all.

**Two schema facts the spec did not have.** `meetings` has no `title` — its only free text is
`location`, which is a venue and not a title, so it takes weight `B` and nothing in that table earns
`A`. The name a reader calls the sitting is `commissions.name`, and a `GENERATED ALWAYS` column may
not reference another table; the commission name heads the *result* instead, which is display and
not the index. And **nothing held the extracted text of an artifact**: the parse stage discarded it
once agenda items had been read out, so the body of every document — where most terms appear — had
no column to index. `artifact_texts` holds the text and its vector in the same row, which is what
makes the generated column legal at all.

**Only agendas are searchable by body.** `parse` returns early for minutes and packets, so their
contents are stored and citable but not extracted. The search page says so rather than letting a
reader who finds nothing wonder whether that is the record or the pipeline.

`ts_headline` marks matches with **control characters, never `<b>`**. The text being highlighted came
out of third-party PDFs and HTML; returning markup for the page to inject would be an XSS hole
opened for a typographic effect. `SearchPage` splits on the delimiters and builds `<mark>` elements.

**Deliberately not built**, and named in the plan rather than silently omitted: fuzzy matching,
synonym expansion, semantic similarity, and per-user search history. One known limitation is
recorded too — concatenating weighted vectors with `||` shifts positions, so a phrase query can
match across a title/description boundary. It is an occasional over-broad hit, never a leak.

An empty or stopword-only query answers **200 with an empty list**, as does an empty database. With
production holding zero rows, that is the ordinary case here rather than the edge one.

Counts after P6: backend **721 tests / 177 suites**, frontend **211 / 27**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## P7 — the public-records request generator has landed, and it refuses

Working from `docs/superpowers/specs/2026-08-09-phase-2-design.md` § P7 and
`docs/superpowers/plans/2026-08-10-records-request-generator.md`. Migration 036.

### ⛔ BLOCKING OPERATOR TASK — `jurisdiction_records_law` is empty, deliberately

**Nobody can draft a records request for Bozeman or Gallatin County until a person reads a
statute.** The table ships with no rows and the generator refuses rather than guessing, so the
feature is complete and inert. This is the intended state, not a defect.

What has to happen, once, by a human:

1. Read **Mont. Code Ann. § 2-6-1006** at `mca.legmt.gov` — Title 2, Ch. 6, Part 10. Section URLs
   map the last digit ×10, so §2-6-1006 is `section_0060/0020-0060-0100-0060.html`.
2. Find the subsection that governs **local governments**. The figures everyone quotes —
   acknowledge within 5 business days, respond within 90 days, requester has 30 days to answer a
   clarification — are stated for *"an executive branch agency"* and *"a public agency that is not
   a local government."* **A city and a county are neither.** A letter citing "5 business days" to
   Gallatin County would assert an obligation that does not apply to it.
3. Note that §2-6-1006 and §2-6-1009 are both marked **(Temporary)** in the 2025 edition: they
   carry effective and termination dates and will be superseded.
4. `INSERT` one row per jurisdiction with `statute_citation`, `statute_url`, whichever of
   `acknowledge_days` / `respond_days` the subsection actually establishes (leave them NULL if it
   does not — the letter then states no period, which is the honest output), the custodian if
   known, `verified_on` = the date you read it, and `verified_by` = your operator id.

**Do not seed this table from the figures above.** They are in migration 036's comment as the
example of the failure, right next to a paragraph asking you not to. Seeding them would make the
feature appear to work while producing letters that are confidently wrong, which is worse than the
feature not working at all.

`/admin/records` shows the state of every jurisdiction, and warns when a `verified_on` is more than
a year old.

### What was built

**The generator drafts; it never sends.** It produces letter text and, on the operator surface
only, a `records_requests` row in `draft`. There is no email path, no dispatcher call and no queue
write anywhere on the P7 path. Two tests hold that: one reads every file on the path and fails on
an import from `services/delivery`, `email-delivery`, `services/notification` or `resend`; the
other counts `deliveries` and `notifications` either side of a generation on both surfaces. The
application must not transmit legal correspondence on anyone's behalf, and the operator sending it
themselves is also the only arrangement under which the letter is honestly theirs.

**Gaps are derived, never listed.** Four queries: a `completed` meeting with a past date, no
`minutes_url` and no `minutes` document; an agenda item whose text names an exhibit, attachment,
appendix or enclosure where the meeting holds no `attachment`/`packet`/`resolution`/`ordinance`
document; a source with `enabled = false`; a `fetch` job in `failed` or `blocked` whose target
carries a URL. Nothing enumerates a jurisdiction, a meeting or a source, so a new commission
appears without a deploy and a filled gap disappears without anyone pruning a list — the test
checks the same meeting before and after its minutes arrive.

**Two of the four kinds are operator-only.** A disabled source and an incomplete fetch describe
*our ingestion*, not the public record; publishing them would present our operational state as
though it were the county's. The other two pass through `whereMeetingPublished` in public scope,
and the gap id a caller hands back is re-resolved in the same scope — so an operator-scope id is
not a way through the wall. Asserted in both directions, withheld then published.

**`letter.ts` is a pure function**: no database handle, no clock, no I/O. That is what lets the
public and operator surfaces be proved identical by **string equality** rather than by inspection.

**The letter alleges nothing.** Every gap kind is rendered and scanned against a list of
accusatory terms — failure, delay, refusal, withheld, wrongdoing, and twenty more. A request is
not an accusation. (The scan is word-bounded: "late" must not match "related", or the test would
be forbidding English rather than accusation.)

`GET /api/public-records/gaps` and `POST /api/public-records/letter` are public and write nothing.
`GET /api/admin/records/gaps`, `/law` and `POST /draft-request` are behind `requireOperator`;
`draft-request` writes the row. Both refuse with **409** — the caller's request is well formed, our
record is incomplete, and saying so is the point.

### Three corrections to the spec

- **The fee paragraph carries no citation.** The spec asked for "a fee-waiver request where
  applicable under § 2-6-1006". That section is the fee section, and its fee provisions carry the
  same local-government split as its deadlines. So the letter *asks* for a waiver — a request needs
  no legal authority — and asserts no entitlement to one. When a jurisdiction's fee provision is
  verified it belongs in `jurisdiction_records_law`, not in a string literal.
- **Mockup screen 06's "statutory guide" figure was invented**, as the spec already recorded.
  `response_due_at` is now set only when the jurisdiction records a response period; an unknown
  deadline renders as no deadline, never as a plausible number.
- **`jurisdiction_id` is the primary key** of `jurisdiction_records_law`, not a plain foreign key.
  The absence of a row is the refusal condition, so making it the identity means "is there a law
  row?" cannot find two disagreeing answers.

### One trap this introduced

`listJurisdictionLaw` left-joins the law columns onto `jurisdictions`. Selecting
`law.jurisdiction_id` alongside `j.id as jurisdiction_id` makes the **second** column win in the
row object, so every jurisdiction *without* a law row came back with a null id and vanished from
the console — the exact rows the console exists to show. The law select deliberately omits
`jurisdiction_id` and the caller supplies it.

Counts after P7: backend **782 tests / 202 suites**, frontend **222 / 28**, both green, zero lint
errors. `deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## The public status page has landed

Working from `docs/superpowers/plans/2026-08-10-public-status-page.md`. Migration 037.

`/status` is a read-only public projection of `/admin/sources`, reading `ingestion_sources` and
`ingestion_runs` through `GET /api/ingestion/sources`. It is unauthenticated: it describes *our*
ingestion, not anybody's record, and the people this project reports for are the people entitled to
know whether it is working.

**Every figure is a query.** There is no maintained list on the page. A status page kept by hand is
a status page that lies eventually, which is precisely the failure this project exists to find in
other people's publications.

**The judgements are reused, not reimplemented.** `assessSilence` and `assessVerdict` come from
`services/pressroom/sources.ts` unchanged; `services/ingestion-status.ts` is a pure narrowing over
`listSources`. A judgement written twice is a judgement that will disagree with itself, and the
console and the public page must never render different verdicts for the same source.

**The projection publishes figures and never text.** `ingestion_runs.error` and every run id stop
at the console. That error string is written by whatever threw and routinely carries a document URL
— and a Granicus URL carries a meeting title in its query string. So the public row says a run
recorded three failures; it does not say what they said. `test/public-status.test.ts` builds the
worst case deliberately — an unpublished meeting, an agenda item under it, and a run whose error
quotes both — and asserts none of it survives, then hits `toPublicSource()` directly with a hostile
row so the narrowing is proved by construction rather than by the fixture happening to be innocuous.

**Nothing is filtered.** A never-run source says Never run. A disabled source is listed with its
`disabled_reason` in the open rather than behind a disclosure, because this is the page where "why
is Bozeman missing?" gets answered. An absence you can see is a commitment; an absence you cannot is
a quiet failure.

**Migration 037 registers MT CERS** so the page can show it. The page may only show what the table
holds, and a source we committed to and never built is exactly the absence requirement two is about.
`jurisdiction_type` gains `'state'` — a statewide filing system is neither a city nor a county, and
typing it as one to dodge an enum change would put a false claim in the column the whole page
derives from. PostgreSQL will not *use* an enum value added in the same transaction, so 037 runs
with `config = { transaction: false }` and every statement in it is safe to re-run.

**One trap.** `seeds/001_pilot_data.ts` deletes every `jurisdictions` row and `ingestion_sources`
cascades from it, so 037's rows are absent on a seeded development or test database. That is
pre-existing seed behaviour, not something this change introduced, and it is why the status-page
tests build their own fixtures. Production is never seeded, so the row survives where it matters.

The Methodology page's promise of a per-source table "when the ingestion registry ships" is now a
link to `/status` rather than a paragraph explaining its own absence. The robots.txt disclosure
itself is untouched — it is summarised on `/status` with the sentence that **the exception is valid
only while it is disclosed**, and tests on both pages fail if either wording is removed.

Counts after the status page and the defect sweep: backend **795 tests / 203 suites**, frontend
**297 / 32**, both green. Backend lint: **2 warnings, 0 errors** — both deliberate, see Known
defects. Frontend lint: **0 problems**, down from 10 warnings.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## B-a — the review queue has landed, and a finding can be published

Working from `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` §§ B-a and B-b, and
`docs/superpowers/plans/2026-08-10-review-queue.md`. Migration 038.

**Until this landed the product could not publish a finding at all.** No code path anywhere set
`anomaly_flags.review_state` to `published`, so records-derived and person-naming flags were
written `held` and stayed held forever. The invariant "nothing naming a person auto-publishes"
was enforced by there being no publish path. Safe, and useless.

`approval_requests` is the archive's table with four changes. The reviewer is an `operators` row,
not a generic `users` one — there is no `users` table here. `requested_by_agent_id` is **dropped**:
it referenced `agent_registry`, part of the orchestration framework that was never adopted.
`meeting_id` is **nullable**, because migration 027 made a flag's meeting nullable and added
`artifact_id`, and those records-derived flags are precisely the ones that are always held —
`NOT NULL` would have made them unqueueable. The unique constraint on `anomaly_flag_id` is kept.

**What an expiry means here, and it is not what the archive meant.** A request past `expires_at`
and still pending is *overdue*, and that is all: the queue badges it, sorts it first, the count
shows on the console, and the flag stays `held`. There is no `expired` status, no sweeper, and no
path from elapsed time to `published`. The archive had `expireStaleApprovals()` writing a terminal
status from a timer, and two objections killed it — a status set by a clock reads in the log
exactly like a decision a person made, and a status only a background job writes silently means
"the job ran" rather than "the window passed". Overdue is derived at read time and cannot drift.

**`review_policy` is B-b's replacement: one row, one severity threshold, default `high`.** Not
`execution_policies` — with one operator every manual stage resolves to the same person. The
threshold can only *add* holds: a rule that held a finding because it names someone on the roster
wins at any threshold, which is what keeps the person-naming invariant true regardless of
configuration. This is a behaviour change and is meant to be: `emergency_session`,
`closed_door_vote`, `quorum_issue` and an over-30-day `missing_minutes` no longer auto-publish.
Production holds zero flags, so nothing that was public stopped being public.

**Approval refuses a finding that cites no stored artifact**, with a 409. Citations resolve from
the flag's own `artifact_id`, from any 64-hex value under a metadata key ending in `sha256` — how
P5's `last_minute_agenda_change` carries `from_sha256`/`to_sha256` — and from the meeting's stored
documents through `document_versions`. The third route is what makes a meeting-derived finding
approvable at all, and it is honest: the meeting record the claim describes was extracted from
those bytes. A meeting with no stored artifact has nothing behind its findings and they cannot be
approved. That is the correct refusal, not a gap.

**Rejection leaves the finding `held`.** There is deliberately no `rejected` review state: the
wall keys on `published`, so one rule covers both the undecided and the refused, and there is no
second failure mode to keep in step.

**Edit-with-reason is scanned for motive.** It is the one place a human types free text that will
be published, and the lexicon is deliberately *narrower* than P7's letter scan — a finding may say
minutes were published ninety days later, because that is the record stated as arithmetic. What is
forbidden is the assertion that someone meant it, profited by it, or broke a law doing it.

**Every decision appends to `record_corrections`** through the same writer publication and
correction already use. Migration 038 widens that table's `target_table` CHECK to admit
`anomaly_flags` and `review_policy`. One log, not two. Its rollback narrows the CHECK again and
will fail loudly once a decision is logged, because the table forbids DELETE — that is the
append-only guarantee working.

**Two holes closed on the way.** `GET /api/anomalies` filtered on `review_state` alone, so an
auto-published flag on a meeting an operator had not published leaked the meeting's existence and
a sentence of its content — through the one public route that does not take a meeting id and
therefore cannot be reached only by guessing one. `whereFindingPublic` in `publication.ts` is now
the single rule and adds the meeting condition. And `IMMEDIATE_SEVERITIES` in the notification
service is exactly `critical` and `high` — the severities the default threshold holds — so
without filtering the `anomaly.detected` emit *and* the service's own re-query, the pipeline
would have withheld a generated claim from the site and emailed it in the same breath.

`/admin/review` puts the evidence above the buttons rather than behind a disclosure, disables
approval on an unsourced finding and says why, reproduces the API's refusals verbatim, and offers
no bulk action — approving in a batch is approving without reading, on the one screen whose whole
purpose is that somebody read it.

Counts after B-a: backend **827 tests / 214 suites**, frontend **307 / 33**, both green. Backend
lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## B3 — the corrections log and the dispute route have landed

Working from `docs/superpowers/plans/2026-08-10-corrections-and-disputes.md`. Migration 039.

**B3 is satisfied.** Backlog item 7 required a published correction log and a route for a named
person to contest a record *before* the Caddy IP allowlist comes down. Both exist, both are
unauthenticated, both are tested. The remaining launch-readiness items — public data export and
licensing, backups with a tested restore, accessibility — are **not** what B3 gated on, and are
listed separately below.

**`/corrections` publishes only corrections to records that are public now.** A correction row
quotes a fact about its target in `old_value`, so publishing one for a withheld record would
disclose the withheld record — through a page that takes no id and therefore, like P6's search,
cannot be reached only by guessing one. The publicity test is **per target table** and routes
through `services/publication.ts` rather than retyping the rule: `meetings` through
`whereMeetingPublished`, `agenda_items` and `meeting_documents` through their meeting,
`anomaly_flags` through `whereFindingPublic`. `review_policy` and `record_disputes` never appear —
neither is a correction to a published record. Built from `EXISTS` rather than joins on purpose:
**an `EXISTS` that is wrong returns nothing; a join that is wrong returns everything.**
`public-corrections.test.ts` walks all four tables **in both directions**, withheld then published,
because absence alone would also hold for a query that is simply broken.

Two consequences that are intended: **unpublishing hides the correction that unpublished it**, and
a *rejected* finding never surfaces because it stays `held`. The page states the first in plain
words rather than implying the log is a complete history of every edit ever made.

**The operator's address is not published.** `operator_id` and `operator_email` stop at the
console; the accountable editor is named on the Methodology page.

**A dispute is not a finding, and migration 039 keeps it that way.** Writing a stranger's assertion
into `anomaly_flags` would make it the same object the detectors produce, on the same publish path,
one operator misclick from being published under this project's name. `record_disputes` is its own
table with its own two decisions — uphold and decline — sharing the operator's screen and the audit
log but not the type. `/admin/review` gained a **Disputes** tab; the tab strip is the whole of the
shared chrome and there is deliberately no approve button on the dispute side.

**A dispute is never published.** `review_state` is `NOT NULL DEFAULT 'held'` with
`CHECK (review_state = 'held')` — one legal value — and there is no public read route for the
table. The CHECK is the second lock, not the first, and a test proves the database refuses the
update.

**Upholding a dispute changes no record.** The correction that follows is a separate operator act
through the corrections path carrying `record_corrections.dispute_id`, which is what makes
dispute → review → correction followable end to end in one table and what keeps an unauthenticated
stranger's text from being one route away from the published record. A test asserts the `meetings`
row is byte-identical either side of an uphold.

**That last sentence was aspirational until 2026-08-10, and is now true.** `dispute_id` existed and
the public log rendered *"Prompted by dispute CW-…"* off it, but **no operator screen ever set it**:
`POST /api/admin/pressroom/corrections` did not accept the field, so upholding a dispute and then
correcting the record produced two rows nothing joined — and the absence was silent. The route
accepts `dispute_id` now and **validates it rather than ignoring it**: `record_corrections` has no
foreign key to `record_disputes` (migration 031's append-only trigger is why that table has no
foreign keys at all), so a dispute that does not exist is a **404** and a **declined** one is a
**409** — declining says the record stands, and a correction citing it would put two contradicting
statements in one log. `received` and `upheld` are both accepted, deliberately: the ordinary flow is
uphold *then* correct, which is a resolved dispute, so refusing every decided dispute would refuse
the only sequence the feature was designed around. The check runs inside the transaction that writes
the row.

In the console the link travels rather than being retyped. The Disputes tab offers **"Correct the
record, quoting this dispute"**, which opens `/admin/meetings/:id?dispute=<id>`; that page resolves
the id, shows the reference and the contested sentence before anything is submitted, and opens the
correction form **on the contested row** rather than on the meeting — an operator who has to re-find
the agenda item a stranger quoted will eventually correct the wrong one. A dispute that cannot be
loaded is said out loud and the correction goes ahead unlinked, because refusing to correct a record
over a broken query string would be the worse failure.

**Abuse resistance, since it is the only unauthenticated write in the product.** Three bounds, and
one alone would be theatre: an in-memory per-client fixed window (3/hour, 10/day) that **stores
nothing about anybody**; a site-wide cap (30/hour) and a per-target cap (5 undecided) that are
queries **inside the insert's transaction** — a limit checked in middleware and a limit checked in
the transaction are two different limits, and only the second holds under concurrency. The target
must resolve through the publication wall, and **an unpublished record and a non-existent one
answer identically**, so the route is not an oracle for what has been ingested and withheld. The
per-target refusal message deliberately says nothing about *that record* having disputes. Field
lengths are capped in the database as well as at the route. **Nothing is emailed and nothing is
published**, which is the strongest property here and is structural: the form has no output an
attacker can aim at a third party.

Three things collected: what is contested, the contester's account, a contact. No identity
document, no IP, no user agent — a test asserts `record_disputes` has no such column.

**`app.set("trust proxy", 1)`** — one hop, Caddy. `true` would trust the whole chain including
anything a client wrote, which would let a caller displace their own address and walk past the
per-client window.

**Motive scanning moved to `appendCorrectionRow`**, the single writer every path already uses.
Every stated reason in `record_corrections` is a publishable sentence now, including the ones B-a's
approve and reject write, so *describe the record, never the motive* has to hold for all of them —
and a guard the next writer has to remember is not a guarantee. `routes/admin/review.ts` learned to
map `CorrectionError`, which it never needed to before; without that the 400 would have surfaced
as a 500.

**Four unenforced clocks came off the Methodology page.** It promised "2 business days", "10
business days", "24 hours" and "3 business days" for handling a dispute. **Nothing in this codebase
measured, tracked or alerted on any of them** — four unenforced claims on the page belonging to the
project whose subject is unenforced claims. They are replaced by a table of what is actually
guaranteed and *by what* (a database trigger, a database constraint, the response body).
`MethodologyPage.test.tsx`'s assertion on `"10 business days"` is now the inverse: it fails if any
`business days` promise comes back.

Counts after B3: backend **867 tests / 221 suites**, frontend **330 / 36**, both green. Backend
lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## The external monitor has landed, and the Gitea scheduler does not fire

Working from `docs/superpowers/plans/2026-08-10-external-monitoring.md`. No migration, no
dependency, no new runtime code in the application.

**Why it is outside the application.** On 2026-08-09 production returned 502 on every `/api/*`
route for about four hours and the only reason anyone found out was a person opening the site.
Every account this codebase gives of its own health — the masthead's sweep clock, `/admin/sources`,
`/status` — is served by the process that was down. A watch inside the process can only report
while the process is alive, which is exactly when it has nothing to report.

`backend/src/scripts/external-monitor.ts` probes the live site and exits non-zero on any failure:
`/api/health` must be 200 with `database: connected`; `/api/version` and `/version.json` must both
be 200 and **must serve the same sha**; and no *enabled* ingestion source may be past its
`expected_interval_hours`. It never POSTs to `/api/internal/events` — when `DISCORD_WEBHOOK_URL` is
configured it posts **straight to the webhook** and says in the message that it bypassed the
application's routing, which is the W7 fallback reasoning taken to its conclusion: a deploy that
broke the backend is exactly when the backend cannot be trusted to say so. With no webhook, the
failed run is the alert and nothing else is invented.

**⛔ SCHEDULED WORKFLOWS DO NOT RUN ON `gitea.example.invalid`.** Measured on 2026-08-10, not assumed.
The instance is 1.25.5 — five minor versions past the release that added the feature — and
`monitor.yml` registered `active` on the default branch and then sat through the 04:30 and 04:45
ticks without a run. So every repository on the instance was checked: **eight workflows across 82
repositories declare a cron schedule, and the number of `schedule`-triggered runs that have ever
existed is zero.** `na/minobi`'s `watchdog.yml` asks for `*/5 * * * *` and has 20,493 runs, every
one of them a push. Somebody already believes they have a watchdog and they do not.
`workflow_dispatch` and `workflow_run` both fire normally, so this is the scheduler specifically
and not Actions. The likely cause is the instance's cron being off in `app.ini`, which is an
operator change on the Gitea host — **and it would light up eight workflows at once.**

**What runs today, given that.** The `schedule:` block stays, because it is correct and starts
working the day the instance does. `workflow_dispatch` is proven: run 26478 probed production green
from a `POST …/actions/workflows/monitor.yml/dispatches` that answers 204, and the exact request is
in the workflow's header comment, so a hosted scheduled agent or anything else holding a token can drive
it. And `deploy.yml` now runs the identical probe as its last step — not a substitute for a
periodic check and not offered as one, but aimed at the failure that actually happened, because the
existing "Verify the site responds" step proves only that `/api/health` answers 200 while the images
roll independently.

**A disabled source is not a stale source, and a never-run one is not either.** All three
registered sources are disabled, so the monitor reports three skips and passes — correct rather
than lucky: its subject is whether what we turned on is running, and nothing is turned on. An
enabled source with a stated interval that has **never** swept is a *warning*, not a failure,
because the public feed does not record when a source was enabled and the first minute after an
operator enables Gallatin is exactly that state. Only an enabled source with an interval and a
successful sweep older than that interval fails the run. The arithmetic is recomputed from the raw
figures against the monitor's own clock rather than read from the feed's `silence.verdict`: an
external monitor does not ask its subject how it is doing.

**No `npm install` anywhere on the path.** Node 22 strips TypeScript types natively (v22.23.2 in
`node:22-bookworm`), so the workflow is one `docker run` of a stock image over a single
dependency-free file. A monitor whose green run depends on the npm registry goes red for reasons
that have nothing to do with the site. That is also why the file has no local imports — one
`import "./x"` would buy back the whole build step.

The judgement is a tested module and not shell `if` statements, which is the difference between a
monitor and a monitor-shaped thing: 27 tests over healthy, database disconnected, 502, 403 at the
Caddy allowlist, nothing answering at all, version skew, two `unknown` shas, stale, never-run,
disabled, an empty registry and three shapes of malformed response.

**The runner label is load-bearing.** `dh1` only. The live site is IP-gated at Caddy and `dh1` is
the only runner proven to get through it; `ubuntu-latest` has never made an outbound request to the
site, so its egress address is unproven and a monitor red because of its own network position is a
monitor people mute.

Counts after the external monitor: backend **894 tests / 226 suites**, frontend **383 / 39**, both
green. Backend lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.

### The trigger — `deploy/monitor-trigger.sh`, and the one operator action left

**`monitor.yml` is not changed. It is correct**, and its `schedule:` block stays so it starts
working the day the instance's cron is turned on. What was missing was a clock, and there is one now:
`deploy/monitor-trigger.sh` POSTs the `workflow_dispatch` that answers 204, and is meant to be run
from cron.

**Why this and not something cleverer.** It is the cheapest thing that genuinely fires.
`workflow_dispatch` is the *only* trigger measured to work on this instance — `schedule` has never
produced a single run in any of its 82 repositories. The trigger needs no access to the site at all:
the probe runs on `dh1`, the one runner proven through the Caddy IP gate, so the clock and the
prober fail independently. And it costs nothing and installs nothing — bash and curl, no account, no
vendor, no daemon, no new dependency, and **no token in the repository**. Turning the instance's
cron back on would be better and is not ours to make; a hosted scheduled agent, which the workflow header
names as this environment's pattern, would still need this same token and this same request, so the
script is that routine's body either way; and hanging the monitor off `push` fires here but would
mean committing on a timer.

Two behaviours worth knowing. **The token never reaches argv** — curl is driven entirely from stdin
through `--config -`, because `ps` and `/proc/<pid>/cmdline` are readable by every user on the
machine and one of the two candidate hosts is shared with seven other products. And **the script
reads back how long it has been since a monitor run** and exits 3 when that gap is past its
allowance, which turns "we quietly stopped watching in March" into "the clock says it missed eleven
hours" on the tick that restarts it. Two traps this Gitea sets are handled and tested: `started_at`
carries an **offset** rather than a `Z`, and a run that has been created but not started reports
**epoch zero**, not null — read blindly, the run the dispatch just created makes the clock look
fifty-six years behind, on every healthy tick.

`deploy/test-monitor-trigger.sh` drives all of it against a stub curl: **36 assertions**, no token,
no request. It runs in CI beside the deploy-script test.

#### ⛔ OPERATOR ACTION — the cron entry is not installed

Nothing periodic is running yet. On an always-on machine that can reach `gitea.example.invalid`, with
this repository checked out and `~/.config/commissionwatch/gitea.env` in place:

```bash
# Prove it before trusting it — sends nothing.
./deploy/monitor-trigger.sh --dry-run
./deploy/monitor-trigger.sh                    # expect: ok dispatched … (http=204)

# Then, every 15 minutes:
( crontab -l 2>/dev/null; \
  echo '*/15 * * * * cd /path/to/commissionwatch && ./deploy/monitor-trigger.sh >> /tmp/commissionwatch-monitor-trigger.log 2>&1' \
) | crontab -
```

**Where to put it is a real choice, not a detail.** The operator's own always-on machine is
preferred, because it fails independently of the subject. The deploy host
(`i-0123456789abcdef0`, reachable over SSM, already on) is the alternative and needs no new
hardware — but it shares a failure domain with the site it is watching, so a host-level outage
takes the clock down with the thing the clock exists to report.

#### The dead-man's-switch gap, stated rather than implied

**If the trigger itself stops, nothing notices.** A cron entry that was never installed, a machine
that rebooted and did not come back, an expired token — all of them look exactly like a site that
has been healthy for a week. Silence is the same shape as success. Closing that needs a third party
outside both this repository and Gitea, and every free one is an account and a vendor, so it is not
built. The staleness check above is a smaller claim and is not offered as a substitute: it reports a
gap *after* the clock restarts, and says nothing at all while the clock is stopped.

## Donor-to-vote correlation and the officials page have landed

Tier C of `docs/superpowers/specs/2026-08-09-archive-salvage-design.md`, rebuilt rather than
ported: `follow-the-money` and `vote-tracker`'s domain logic as plain services, with no
`agent_registry`, `createTask`, `acquireLock` or `HeartbeatExecutor`. Migration 050.

**`vote_donor_conflict` is raised at last.** It has been a legal `anomaly_flag_type` since
migration 020 and nothing has ever raised it, because there was nowhere to put a contribution.
`campaign_contributions` and `campaign_expenditures` are that place, and the OpenFEC client that
landed with A2 and had never been called is what fills them, through `http_cache`. The rule is
`services/finance/correlation.ts`, and it is the seventh check in `detectAnomalies`.
`RULES_VERSION` is `4.0.0`.

**Every finding is held, always.** Every one names a living person, so the draft sets
`review_state: 'held'` regardless of severity and the threshold in `review/policy.ts` can only add
holds. There is no configuration under which one of these publishes itself.

**Uncertainty is modelled, not glossed.** A donor-to-agenda link is a *name* match and there is no
identifier shared between the FEC's contributor field and a clerk's agenda text. So the matcher
returns a band — `weak`, `moderate`, `strong` — and **there is deliberately no band above
`strong`**; adding one would be a defect rather than an improvement. `moderate` is the floor to
raise anything. The band, the score, the terms that matched, the terms that did not and the terms
the matcher was blind to are all *stored on the finding* rather than recomputed, because the
generic-term list will grow and an approved claim must keep meaning what it meant when a human read
it.

**Non-partisanship is structural here, not careful.** Every entity-class word — `llc`, `union`,
`pac`, `foundation`, `association`, `developers`, `trade`, and the party words — is erased in
`name-match.ts` *before* any decision is taken, so a corporation, a union, a PAC, a nonprofit, a
developer and a trade association with the same distinctive name produce byte-identical output.
Two tests hold it: six filings differing only in class must yield the same count, severity, band,
score and (name aside) description; and the rule's own source is scanned for that vocabulary,
because a detector cannot branch on a category it never names.

**The archive's sentence is gone.** It wrote "voted yes on X **after receiving** a contribution
from Y" — a sequence offered for the reader to complete. `describeFinding` is a pure function so
the published sentence can be asserted character by character: the vote, the arithmetic, and in
plain words that the link is a name match and not a verified identity. It is scanned against the
review lexicon and against a second list of implied-causation phrases.

**A contribution carrying neither the filing system's identifier nor a document image number is
dropped before it can enter a claim**, and a finding built only from such records is not raised.
A dollar figure is not a source. `source_url` is the API request with the key stripped, because
that column is read by an unauthenticated API.

**Federal only, and it says so where it will be read.** OpenFEC holds federal filings; a city or
county commissioner ordinarily has none, so the ordinary result is *nothing found*, and the
distance between that and *received nothing* is the whole of the credibility here.
`services/finance/coverage.ts` is the single copy of the sentence. It is returned with every
finance figure, stored inside each finding, reachable without an official at
`GET /api/officials/finance-coverage`, and rendered on the page **outside every conditional** — the
`FlagBar` is there whether or not anything is under it. `mt_cers` is listed as `planned` and named
as not read. **No CERS adapter was built** — the `source_system` CHECK already admits it, so
landing it is an insert path rather than a rewrite.

**`/officials/:id` is the reader's view of one person**: voting record, attendance, majority
alignment, twelve months of activity, a timeline of sittings and the donor overlay. Everything goes
through `publication.ts` and is asserted in **both directions**, withheld then published — a
profile is arithmetic over meetings, and arithmetic over a withheld record still discloses it.
There is deliberately **no aggregate donor figure**: it would be a name match about a named person
that no operator approved. The overlay shows published findings only.

Two things the page refuses to say. A rate computed from nothing renders "Not measured", never
`0%`. A month with no votes is drawn as a tick on the baseline, never omitted — the empty months
are the information.

Ingestion is an operator command, `npm run finance-sync`, not a scheduler tick: FEC filing periods
are quarterly and a fifteen-minute sweep would spend a public API's rate limit re-reading the same
three months. `OPENFEC_API_KEY` is required; **`DEMO_KEY` is never used**, in code or in tests.

Counts: backend **959 tests / 241 suites**, frontend **409 / 41**, both green. Backend lint: 2
warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.

## Match quality reaches the operator, and an entity judgement is remembered

Working from `docs/superpowers/plans/2026-08-10-match-quality-in-review.md`. Migration 070.

**The inversion this fixed.** A `vote_donor_conflict` rests on a fuzzy name match, and that
uncertainty was modelled properly and stored on the finding — band, score, matched terms,
unmatched terms, blind terms. The **public** officials page rendered all of it, chip and
disclosure, with "not a verified identity" inside the chip. `AdminReviewPage.tsx` rendered
**none** of it. So the reader was told how uncertain a claim was and the operator being asked
to approve it was not: the person making the decision had less information than the person
receiving it.

**One component, two surfaces.** `MatchConfidenceChip` moved out of `DonorOverlay.tsx` into
`components/officials/MatchQuality.tsx`, and both the public page and the console import it.
Writing a second chip for the console would have fixed the symptom and kept the disease — two
components rendering the same stored band, free to drift. The band labels, short forms and
colours live in `matchBands.ts` so `MatchQuality.tsx` exports components and nothing else.

`MatchQualityPanel` is the operator's version and sits **above the buttons, not behind a
disclosure**. On the public page the terms are a `<details>`, which is right for a reader who
has already been given the caveat in the sentence they just read. It is wrong on the screen
where somebody decides whether the claim gets published: the single most useful fact about a
finding may be that it rests on one common word, and a test asserts the panel contains no
`<details>`.

**The queue can be worked by quality.** `?band=` filters on the stored band read straight out
of `metadata` in SQL — not recomputed, because the band on a finding is the band it was
raised under. `?sort=weakest_first` orders by `array_position` over the band list rather than
by the string; alphabetically "moderate" < "strong" < "weak", which is close to exactly wrong.
Findings with no band sort last. The default ordering — overdue first, then oldest — is
untouched, so nothing low-severity is quietly buried. `band_counts` says what is waiting.

**The weak-match policy is stated.** `MINIMUM_MATCH_BAND` is unchanged at `moderate` and weak
matches are still **not** raised: a weak match is one common term, across a full donor list
that is an enormous number of pairs, essentially all coincidences, and raising them would bury
the findings worth reading. What changed is that the decision is now findable. `MATCH_POLICY`
carries the minimum band, the labels and the sentence; the API serves it and the console
renders it **verbatim**, so screen and detector cannot drift.
`correlateVoteDonorsWithDiagnostics` returns the tally of what was considered and not raised.

**The tally is deliberately not persisted.** A row per considered-and-dropped coincidence is a
table growing with the product of donors and agenda items that answers no question anyone has.
The diagnostics exist so the rule is testable and so a future report can be built from a pure
function.

**An entity-resolution judgement is remembered.** `entity_resolution_decisions` (migration 070)
records whether an operator judged a donor and an agenda subject to be the same entity. The
pair is keyed on distinctive terms, not on the finding — a finding id changes every sweep and
an agenda item id changes every meeting, so keying on either would mean the judgement expired
exactly when it became useful.

**The donor half goes through `splitTerms`, and that is load-bearing.** Keyed on
`normalizeName`, "Ridgeline Aggregate LLC" and "RIDGELINE AGGREGATE, L.L.C." were two keys for
one company filed by two clerks — and "Ridgeline Aggregate LLC" and "Ridgeline Aggregate
Union" were two keys as well, which would have made a stored judgement depend on what class of
organisation the donor is, on a path whose governing invariant is that detection applies
identically to every entity class. Discarding the class word first makes uniform treatment hold
by construction, as it does in `name-match.ts`. The tests caught this; the first draft had it
wrong.

**The two answers are not symmetric.** `different_entity` suppresses the pair on later
sweeps — asking an operator the same question after they answered it is the defect this
exists to fix. `same_entity` **annotates**: the finding is still raised, still `held`, and
still needs an explicit approval with its own stated reason. Nothing here publishes anything
as a side effect, and the console says so on the screen.

**Changing your mind is expected.** The table is current state and updatable; every write —
first or fifth — appends to `record_corrections`, so the sequence is recoverable from the one
append-only log rather than from a second one that could disagree with it. `old_value` is
`null` on a first judgement and the previous answer on a revision, because "was never decided"
and "was decided the other way" are different facts. The row id is generated before the insert
so the first log entry for a pair names a target that exists.

**PII.** The table stores the donor's filed name and the matched terms — the disclosure — and
nothing else about a donor. `finance-pii-guard.test.ts` scans its column names. Its one
exemption is `entity_resolution_decisions.operator_email`, the audit actor snapshotted as
everywhere else, and the exemption is a set of full `table.column` strings rather than a
pattern, so it cannot widen to cover a `donor_email`.

Counts after this change: backend **1141 tests / 273 suites**, frontend **443 / 42**, deploy
**61 / 0**, all green. Backend lint: 2 warnings, 0 errors — the same two deliberate ones.
Frontend lint: **0 problems**. Migration 070 verified from an empty database.

## Open data, the fork path and the meeting calendar have landed

Working from `docs/superpowers/specs/2026-08-04-launch-readiness-design.md` § 2 for the export
and the licence. **No migration** — none of this needed a schema change, which is itself the
finding: the publication wall, the content addresses and `jurisdictions.timezone` were all
already there.

### The bulk export — `/api/data`

**Ten datasets, JSON and CSV, public and unauthenticated.** `jurisdictions`, `commissions`,
`meetings`, `agenda_items`, `meeting_documents`, `members`, `votes`, `findings`,
`artifact_references`, `artifacts`. `GET /api/data` is the manifest and computes its own row
counts, column lists and schema version — there is no maintained list anywhere.

**This is the largest public surface the product has, and it is a new shape of risk.** Every other
public path takes a meeting id, so a reader who cannot guess one cannot reach a withheld record;
P6's search takes a *word*, which is why it needed its own wall test. The export takes **nothing**.
It hands over whole tables, so one missed predicate empties the review queue into a file that looks
entirely correct. Every query routes through `services/publication.ts` —
`whereMeetingPublished` and `whereFindingPublic` — and `data-export.test.ts` walks all ten datasets
in **both formats and both directions**, withheld then published.

Three specific leaks were closed by construction rather than by care:

- **A published flag on an unpublished meeting.** The fixture sets `review_state = 'published'` on
  the withheld meeting's flag deliberately, because filtering on `review_state` alone would export
  it along with a sentence of the withheld meeting's content.
- **`artifacts` is not a table of harmless hashes.** `source_url` on a withheld meeting's document
  carries that meeting's URL, and a Granicus URL carries its title in the query string. The
  artifacts dataset is filtered through the publication wall for that reason, and the test asserts
  the withheld content address never appears.
- **`storage_key` is never exported.** It addresses bytes this project does not redistribute.

**Provenance travels with the row.** `meetings`, `agenda_items`, `meeting_documents` and `votes`
each carry `source_artifact_sha256`; `artifact_references` carries the full document-to-artifact
mapping with the post-redirect `source_url`. **Where the schema records no artifact — `members`,
`jurisdictions`, `commissions` — the column is absent rather than null**, and `/data` says so in
words: an empty provenance column reads as a lost source, and no column reads as "there never was
one", which is the true statement.

**Nothing is buffered.** Keyset batches of 500, written to the response as they are read. Knex's
`.stream()` needs `pg-query-stream`, which is not a dependency here. **One trap this introduced:**
`ORDER BY id` resolves against the select list and is fine, while `WHERE id > ?` resolves against
the tables and is ambiguous on a joined query — and the loop always asks one batch more than it
needs, so the failure appears only on the *second* batch. `artifact_references` hit it. Datasets
name their keyset column now.

### The licence, stated per layer

Unchanged from the spec and now stated in code as well as prose: the **compiled dataset is
CC BY 4.0**, the **code is MIT** per the repository `LICENSE`, and **no licence is asserted over
the government documents** — they are not ours, and their bytes are not redistributed. The manifest
carries all three, and an `X-License` / `X-Attribution` header travels with every file because a
`curl -O` of a CSV keeps no envelope.

### `/data`, and what it stops promising

The page at `/data-license` has been extended and now also answers at **`/data`**, which is the
address the spec names and the one the JSON-LD points at. `/data-license` still resolves; it has
been the published address of that page.

**The dataset table is a query**, read from the manifest, so columns and row counts cannot drift
from what the API serves. It carries `Dataset` JSON-LD whose `distribution` entries are generated
from that same manifest — a hand-written `contentUrl` is a 404 a search engine publishes on this
project's behalf.

Three paragraphs of promise came off. The page said the bulk export "is not published yet" while
describing nightly zips and dated snapshots. The export exists; **the dated archive does not**, and
the page now says plainly that there is no snapshot and no way to ask what this site said in March.
Three withheld entries were added because the export made them real: an unpublished meeting, the
storage key, and the text of an ingestion failure.

### The calendar and the iCal feeds

`/calendar` groups upcoming and recent published meetings by jurisdiction;
`GET /api/calendar/{jurisdiction_id}.ics` is a subscribable feed. Published meetings only — a
subscribed calendar keeps fetching long after anyone last looked at the site, so a leak here sits
in a stranger's phone until they unsubscribe.

**The timezone trap, handled explicitly, because both halves of it are live here.** `meetings` has
no `scheduled_at`: a `DATE` and a **nullable** `TIME`, naive, with the zone on
`jurisdictions.timezone`. Composing the instant in the server's zone publishes a 7pm Bozeman
meeting at one in the afternoon, so the wall time is converted through the jurisdiction's zone with
`Intl` and emitted as **UTC** — which also means no `VTIMEZONE` block to get wrong, and no `TZID`
referring to a definition the file does not contain. An unrecognised zone returns null and the
event is **omitted**, never silently placed in UTC.

**A meeting with no published time is an all-day event** — `DTSTART;VALUE=DATE` with an exclusive
`DTEND` on the following day — never midnight. Most rows have no time; `00:00` is what a naive cast
produces, not what the record says.

**A timed event carries no `DTEND` and no `DURATION`.** RFC 5545 §3.6.1 defines that as ending at
its start, and clients render it as a moment. The record does not state when a meeting adjourned,
and `DURATION:PT2H` would be the meeting page's deleted *"Adjourned: Not recorded"* row all over
again — in a file people subscribe to. This is a deliberate decision, not an omission.

UIDs are keyed on the meeting id alone, so a rescheduled meeting updates the subscriber's entry
rather than appearing twice. **No new runtime dependency:** an `.ics` file is text, folded at 75
*octets* (not characters — a multi-byte character must not be split across a fold) and escaped by
hand.

### The fork path

`README.md` was rewritten — it predated almost everything here — plus `CONTRIBUTING.md`,
`docs/ADAPTERS.md` and `scripts/dev-setup.sh`, **which was executed end to end twice** before any
of it was written, on Node v22.22.2 and Docker Compose v5.1.4.

`docs/ADAPTERS.md` leads with **what is not config**, because that is what the pitch misleads
about: hardcoded body lists, jurisdictions created by the registration path, an
`ingestion_sources.config` that is written once and is lossy for both adapters, and the
`adapterRegistry` export in `registry.ts` that is a decoy — permanently empty, referenced nowhere,
while the live list is `createDefaultRegistry()`. Then the contract, the suite's real assertions,
the fixture and `PROVENANCE.md` discipline, the conduct rules with the vendor-`robots.txt`
exception and its disclosure condition, the hard line on evasion, and the two worked examples with
what each live sweep *disproved*.

**Three defects found by actually running the thing**, each of which would have stopped a forker
in the first hour:

1. **`vite.config.ts` proxied `/api` to port 8000.** No part of this project has ever listened on
   8000. Every `/api` call from `npm run dev` was a proxy error, which surfaces as an empty
   response rather than a 404 — so it reads as a broken backend rather than a misdirected proxy.
   The README had been asserting `:3001` for months.
2. **`backend/.env.example` carried `commwatch:commwatch-secret` as `DATABASE_URL`.** Those are the
   MinIO credentials and have never been the Postgres ones, so anyone who exported that file got an
   authentication failure against a database that was running fine. The file now also opens by
   saying that **nothing in the Node process reads it** — there is no `dotenv` dependency and no
   `env_file` in compose — because the larger waste of time was believing it was load-bearing.
3. **`commissionwatch_test` only exists if the data volume was initialised after
   `scripts/init-databases.sql` landed.** A carried-over volume leaves `npm test` failing on a
   missing database while everything else works. `dev-setup.sh` creates it idempotently.

The caveats it cannot fix are written down rather than left to be discovered: the compose stack
binds fixed host ports with no variable, the `pgdata` volume survives a branch change and produces
the "migration directory is corrupt" failure, and **no ingestion source is enabled** — which is
correct, because enabling one means this machine starts fetching a real county's web server.

Counts after this work: backend **926 tests / 229 suites**, frontend **399 / 40**, both green.
Backend lint: 2 warnings, 0 errors — the same two deliberate ones. Frontend lint: 0 problems.
`deploy/test-deploy-aws-ssm.sh` still 61 passed / 0.

## MT CERS — Montana campaign finance has landed, and it has swept

Working from `docs/exploration/mt-cers-spike.md` and
`docs/superpowers/plans/2026-08-10-mt-cers.md`. Migrations 041–042.

**This is the money source for local office.** OpenFEC covers *federal* candidates; a Gallatin
County Commissioner and a Bozeman City Commissioner have no federal filings at all, so until now
"follow the money" could say nothing about the officials this project exists to watch.

**Nobody had ever looked at CERS, and the one data point we had was misleading.** A guessed path
returned 404 with a 26 KB body, which reads like a wall. It is not one: the search forms POST to a
*relative* action resolved against `/CampaignTracker/public/search`, so `searchResults/…` lands one
level **up**, and the guess put it one level down. The host publishes **no `robots.txt` at all**
(`/robots.txt` is a Tomcat 404, not a `Disallow`), there is no login, no CAPTCHA and no user-agent
discrimination. **No access exception is claimed for this source and none is needed** — this is the
cleanest posture of any source in the project, cleaner than Gallatin and far cleaner than Granicus.

**"A structured system, not PDF scraping" is confirmed as to structure and refuted as to bulk.**
CERS is a server-side DataTables JSON API. There is **no CSV, no export, no bulk file and no
documented API** — the only export affordance in the whole application is a `window.print()` button.
Records are walked entity by entity at one request every two seconds.

**A real sweep ran on 2026-08-10 and reported `succeeded`.** What landed locally:

| | |
|---|---|
| `cf_filers` | **384** — 42 Gallatin County Commissioner candidacies, 342 city candidacies resident in Gallatin |
| `cf_reports` | **35** filed reports (C-5, C-7, amendments) |
| `cf_transactions` | **127** — 70 contributions totalling **$18,910.00**, 57 expenditures |
| `artifacts` | **45**, content-addressed, 2.16 MB, bytes in MinIO |
| `meetings` / `commissions` under *State of Montana* | **0 and 0** |

**A CERS record has no URL, and that shaped the design.** Its criteria live in an HTTP session, so
obtaining one contribution schedule means replaying four requests in order. `DocumentRef.metadata`
carries that chain and `fetchDocument` replays it; `ref.url` is the endpoint plus those parameters —
a stable, unique, readable identity that is deliberately **not** dereferenceable. `advanceSession`
writes the protocol down once and both the adapter and the fixture harness use it, because a fixture
keyed on the request alone would serve one candidate's contributions for every candidate and every
test would pass.

**CERS publishes no meetings, so the adapter invents none.** The `discover` handler is entirely
meeting-shaped, and the alternative to changing it was to manufacture a meeting per filing period —
a fabricated public record in `meetings`, written to reuse a function. `SourceAdapter` gained an
optional `discoverDocuments`, whose refs are enqueued for `fetch` with no meeting id and routed in
`parse` on the record kind their own adapter stamped. **Nothing sniffs bytes**: a stored artifact's
meaning comes from the ref that asked for it. The contract suite now asserts the invariant in both
directions — an adapter declares bodies **exactly when** it discovers meetings.

**Every transaction cites a stored artifact**, in a `NOT NULL` column with no `ON DELETE CASCADE`.
An unsourced contribution cannot be inserted and deleting the evidence under a stored one fails
loudly; both are tested. Idempotency is `(artifact_id, row_index)` — an amendment is different
bytes, therefore its own artifact and its own rows, which is right, because an amendment is a second
thing the filer said rather than a correction to the first.

**Two shared-transport bugs surfaced while recording fixtures**, and both produced *silent wrong
answers* rather than errors. `fetch` exposes only the final response's headers and CERS mints
`JSESSIONID` on a **302**, so following redirects in the transport made every search run in a fresh
session and return `iTotalRecords: 0` **under HTTP 200**. And `HttpResponse.headers` is a flat map
while CERS sets three cookies at once, so exactly one survived and it was not the session.
`HttpRequest.redirect` and `HttpResponse.setCookies` exist because of those; `setCookies` is
optional so every existing fixture double stays valid.

**Two things the first live sweep taught, both now covered by tests.** CERS answers 200 with a
**zero-byte** body — not `[]` — for a schedule that does not apply, which is counted as
`cf_empty_body` rather than folded into "0 rows", because "they published nothing here" and "they
published an empty list" are different statements. And the roster **pages**: the first sweep wrote
142 filers where 384 exist, with `iTotalRecords` saying so in the same response. Each page is now
its own record, with the offset in its identity.

**Known limitation, recorded rather than hidden.** The per-target candidate cap slices the roster in
CERS's own alphabetical order, so a target with more candidates than the cap always sweeps the same
ones. Closing it needs a cursor in `ingestion_sources.config`. The caps themselves are small on
purpose: at 2 s per request the first draft's 25×12 would have been over 3,000 requests and nearly
two hours, timing out every night and looking like a broken scraper.

**Deliberately not built:** no public route, no frontend, no donor-to-vote join, no committee sweep.
Candidates' home addresses, personal emails and telephone numbers are in these filings; **they are
no longer stored at all** — see the two sections below, which supersede this paragraph entirely.

### The donor PII was removed on 2026-08-10, hours after it landed

**Superseding the paragraph immediately above, for donors.** That paragraph's reasoning — *stored
and never surfaced, publishing is a separate decision* — conflated **what we may publish** with
**what we may hold**, and only the first was ever in doubt. The operator's ruling is flat: *we must
not ingest PII.* Being entitled to read a donor's home address off a public filing is not the same
as being right to keep a copy of it in a database and a git repository this project operates.

**Migration 043 dropped four columns**, and dropped rather than merely stopped writing them,
because a nullable column left behind is an invitation the next writer will not think to refuse:

| Column | Table |
|---|---|
| `entity_address` | `cf_transactions` — a donor's street address |
| `occupation` | `cf_transactions` — a donor's occupation |
| `employer` | `cf_transactions` — a donor's employer |
| `residence_city` | `cf_filers` — a candidate's residence city, derived from their home address |

The adapter's `CersLineItem` no longer parses the three CERS fields at all, so the values do not
exist to be stored; `campaign-finance.ts` no longer maps them; and `cityFromAddress`, whose only
purpose was to split a candidate's home address into `residence_city`, is gone with it.

**Donor name, transaction date and amount stay, deliberately.** They are the disclosure.
`vote_donor_conflict` exists to say a named donor gave money before a named vote and can say
nothing without all three — removing them would not be a privacy measure, it would be the end of
the feature. **No detector, view or export read any of the four dropped fields**, which is what made
dropping them free: the bulk export has no `cf_` dataset at all, and `DonorOverlay` renders
`donorName` and never an address.

**The recorded fixtures were scrubbed.** 52 real values across four
`post-financeRepDetailList-*.json` files — 22 street addresses, 15 occupations, 15 employers —
replaced with clearly synthetic ones, preserving row counts, key order, field names, types and
populated-ness so the parser tests stay meaningful. `record.ts` now scrubs on the way to disk, so a
re-record cannot reintroduce them, and `PROVENANCE.md` carries a prominent notice so nobody
"restores" the fixture believing it corrupt. *Seed data never names a real person* is an existing
invariant; this is that rule applied to fixtures.

**`test/finance-pii-guard.test.ts` is the guard**, and it was verified negatively — each assertion
was made to fail by reintroducing a real violation, then restored. It checks the live schema after
`migrate:latest` (so a *later* migration re-adding a column is caught, not just this one), refuses
any column on the finance tables whose name suggests PII, scans the fixtures for unscrubbed values
and for address-shaped strings in *any* field, and asserts the donor name/date/amount are still
there so a future "scrub" cannot gut the disclosure instead.

**Nothing had reached production and this did not need containment.** All three sources are
`enabled=false`, production holds zero `cf_` rows, the public bulk export carries no `cf_` dataset,
and the `artifacts` export carries only `sha256`, `source_url` and `byte_size` — never bytes. The
two local scratch databases holding the swept rows were dropped.

**One thing this deliberately did not do, and it is still an operator decision:**

**Git history was not rewritten.** The unscrubbed fixtures are already on `origin/main`. Whether to
rewrite published history is the operator's call and is *pending*; this work is the forward fix
only. Nothing was force-pushed and no published commit was rebased. That remains true after the
second pass below.

### The second pass closed the rest of it, on 2026-08-10

The first pass named three exposures it had surfaced and left open. Closing them found three more.

**Migration 051 dropped `donor_employer`, `donor_occupation` and `donor_city`** from
`campaign_contributions` — migration 043 applied to the federal path, in the 050–059 block that
owns it. Verified first that nothing read them: `correlation.ts` is the only production SELECT and
names its columns, this project has no views, and no export, serializer, route, detector, seed or
frontend component mentions any of the three. **The claim that all three were written `NULL` was
true of two.** `normalizeContribution` was setting `donor_city` from `record.contributor_city` on
every ingested row; its writer went with the column.

**`campaign_contributions.raw` was putting them straight back.** It stores the OpenFEC record
verbatim, and OpenFEC sends contributor employer, occupation, city, street and ZIP whether or not
`OpenFecContributionRecord` declares them — an interface describes what we read, not what arrives.
Dropping three columns while serialising the same values into a jsonb blob one column over would
have been a schema change dressed as a privacy measure. `withoutContributorPii` now filters by key
shape rather than by a list of the fields we happen to know about.

**The CERS sweep was writing a candidate's address into the database, and it is not a dead path.**
`toCandidate` parsed `candidateAddress`, and `scheduleRef` put it into `DocumentRef.metadata`,
which `handlers.ts` round-trips through `ingestion_jobs.target.metadata`. Every sweep wrote it. The
parse is gone rather than the emission, because a populated field one autocomplete away from the
next metadata key is not a decision anybody has to argue with. `resCountyDescr` stays: a county is
the jurisdiction a candidacy is filed in, not a place a person lives.

**The fixture scrub went from four files to eleven.** 1,190 JSON values and 16 rendered HTML values,
covering candidates' mailing and home addresses, personal email addresses and home, work and mobile
telephone numbers. Three places the first pass had not looked: **both** `get-listFinanceReports-*.json`
embed the same `personDTO` inside `candidateDTO`; the rendered C-5 HTML prints the candidate's
contact details **and the campaign treasurer's home address**, and a treasurer is not a public figure
at all; and two email addresses were typed into free text, one in a candidacy's `comments` and one
in an expenditure's `purposeDescr`, where no field-name-driven scrub would ever have found them.
Nothing was dropped — every key, type and populated-ness is as recorded, so the parser's "not filed"
paths still run. `record.ts` now scrubs every response by shape rather than one endpoint by field
name. Full accounting in `backend/test/fixtures/mt-cers/PROVENANCE.md`.

**The guard was extended and watched failing, twelve violations one at a time.** It gained email and
telephone patterns — which it had never had, which is why 42 candidates' email addresses and 74 of
their telephone numbers sat in a scanned directory and the scan passed — an address predicate that
recognises all five renderings CERS ships rather than one literal, coverage of the whole tape rather
than six files out of twenty-one, and assertions on the two parsers where PII enters a column that
is allowed to exist. Doing it found two defects in the guard: the populated-ness check summed nulls
across the directory and asserted the total was non-zero, so filling in every optional field in the
roster still passed; and the table-existence check — the one that exists because a previous run was
silently pointed at the wrong database — failed without naming the missing table.

The source stays **disabled**. Migration 042 rewrites 037's `disabled_reason`, which said "No
adapter has been written for this source yet" and is published verbatim on the **public** status
page — leaving it would put a false statement about our own ingestion on the page whose purpose is
that absences are honest.

Counts after the second PII pass: backend **1108 tests / 269 suites**, frontend **430 tests / 42
files**, deploy **61 checks**, all green. Backend lint: 2 warnings, 0 errors — the same two
deliberate ones. Frontend lint: zero problems.

## Going live — the two levers that were missing

Found 2026-08-10 by tracing the path from "the container is healthy" to "a citizen sees a record."
Production was further along than it looked and blocked in an unexpected place.

**What was already true.** Registration had run. All three sources existed with their
jurisdictions, cadences and honest disabled-reasons; the scheduler was armed; MinIO had made its
bucket; `/api/admin/session` answered 401 on bad credentials, so an operator was seeded. And
`/api/meetings` returned `{"data":[],"total":0}`. Nothing was broken. One boolean was false three
times.

**Lever 1 — a source could not be enabled from anything that ships.** The only code in the repo
that writes `ingestion_sources.enabled` was `src/scripts/sweep.ts`, reached through
`npm run sweep -- --enable`. `backend/Dockerfile` copies `dist/` and `migrations/` and **never
`src/`**, so that script does not exist inside the container. No admin route wrote the column
either — the console listed three disabled sources and offered no way to turn one on. The **Sweep
now** button was live but a no-op, because `runSweep` returns `skipped: disabled` before doing
anything. Going live meant hand-written SQL over SSM, which is exactly what
`services/ingestion/registration.ts` says in its own doc-comment that it exists to avoid.

Now `PATCH /api/admin/pressroom/sources/:id` takes `{enabled, reason}`, with the toggle on the
sources screen. `enabled` must be a real boolean — accepting `"yes"` would let a typo read as the
decision that starts hitting a county's web server. The reason is mandatory and typed, never
defaulted.

**The scheduler had to learn to re-arm.** `start()` reads the enabled set exactly once, so a
source enabled at runtime had no cron task until the next deploy. `SourceScheduler.refresh()`
re-reads and re-arms, and the route calls it — otherwise the toggle would mean "sweeps nightly,
eventually", discovered by an operator wondering why nothing happened overnight. `refresh()`
sweeps nothing, exactly like `start()`: re-arming is not a reason to break the boot-safety rule.

**The database refused the first design, and was right.** The toggle was going to be logged as a
`record_corrections` row, next to publication. Migration 031 CHECKs `target_table` against
`meetings`, `agenda_items` and `meeting_documents`, and the insert failed. That constraint is
correct: `record_corrections` **is** the public corrections log, and widening it would put
configuration changes one allowlist edit away from a public page where they would read as
corrections to the record. Nobody's agenda was misstated because a source was off. So migration
071 adds `operator_actions` — same discipline, different subject: append-only by trigger, a CHECK
on `action`, no foreign key to `operators`, actor snapshotted. Not exposed publicly.

**Lever 2 — a swept meeting had no path to the public site.** Migration 030 made `ingested` and
`published` different states, which was right and left a hole: the console could open one meeting
by id and had nowhere to *find* an id. For Bozeman, whose Granicus page carries 2013–2026 in a
single 5.9 MB document, that is not a path at all.

`GET /api/admin/pressroom/sources/:id/meetings` lists what a source has ingested with its
publication state, and `POST /api/admin/pressroom/meetings/publish` publishes an explicit
selection. Scoped by **source, not by run**, because `meetings` has no `run_id` — identity is
`(commission_id, external_id)` and a re-sweep revises rather than inserts, so "what this run
produced" is not a question the schema can answer. "What from this source nobody has published"
is, and it is the question the operator actually has.

Four decisions in it worth keeping:

- **Explicit ids, never publish-by-filter.** A filter that drifted between the screen and the
  server would publish records nobody looked at.
- **One correction row per meeting, not one for the batch.** The log answers "why is *this* record
  public?", and a row saying "and 213 others" cannot.
- **Already-published records are skipped, not republished.** The single-meeting path deliberately
  permits republishing with a new reason — that is how publishing over a known defect is recorded —
  but in bulk it would write a row per meeting saying nothing changed, which is noise in the one
  place noise is most expensive.
- **A ceiling of 200 per action**, and the whole batch in one transaction. A partial publish that
  also partially logged would leave the site asserting things the log cannot explain.

`unpublished_total` is counted independently of the page limit, so the screen says "showing 100 of
512" rather than implying the backlog is what fitted on it. A failed load does not render as an
empty queue: "nothing is awaiting review" and "you cannot see the queue" are different sentences
and the first is the dangerous one to say wrongly.

**Verified:** backend 1168/1168 (was 1141), frontend 457/457 across 43 files (was 443/42), lint 0
errors both packages, `deploy/test-deploy-aws-ssm.sh` 61/0, both builds clean. Migration 071
applied locally.

**First light is now:** sign in → `/admin/sources` → **Enable** with a reason → **Sweep now** →
**Review** → select → publish with a reason. No SSH, no psql, no expired credential. Gallatin is
the honest first target: its `robots.txt` is permissive, where Bozeman fetches under the vendor
exception at the published 10-second crawl-delay and is correspondingly slow.

## The first live sweep, and what it taught us

**2026-08-10, 21:49 UTC. `bozeman-granicus` swept for real, against the live host.** It fetched 89
documents at 10.1 seconds each — exactly the crawl-delay disclosed on the Methodology page — hit
the 15-minute sweep deadline with 339 jobs queued, and was recorded **`failed`**.

Nothing had gone wrong. Bozeman's Granicus page yields **339 meetings** across 2013–2026; at a
polite rate that is ~57 minutes of fetching against a 15-minute box. **That source cannot finish in
one run, however healthy everything is.** Four defects fell out of the discovery.

**1 · A deadline is not a failure.** `drain()` threw a plain `Error`, so `classifyRun` returned
`failed` — on `/admin/sources` that is indistinguishable from a scraper that is dead, which is the
one confusion that screen exists to prevent. `SweepDeadlineReached` is now its own type, a run that
reaches its clock with progress and no errors classifies **`partial`**, and the outstanding count
is written into `counts` rather than left in an error string. A run that achieved nothing at all is
still `failed`.

**2 · Nothing drained the queue between sweeps.** `IngestionWorker` has carried a poll loop since
it was written and **nothing ever called it** — `index.ts` referenced `worker.stop()` on shutdown
and `worker.start()` nowhere. The only thing that ever turned the queue was `SourceScheduler.drain()`,
inside a sweep, until the sweep deadline. Two consequences, both seen live:

- **Re-parse did nothing observable.** It enqueues `parse` jobs and answers 202; with no worker
  running they sat `pending`. The button reported success and produced silence.
- **A timed-out sweep left its remainder frozen** — including 89 `parse` jobs over bytes already on
  disk, which need no network at all.

A standing worker now starts at boot claiming **`parse` and `analyze` only** (`STATIONARY_STAGES`).
That restriction is load-bearing: those two stages receive a content address and no URL, and a
context with no fetcher, so the loop **cannot** dereference anything. A standing worker that claimed
`fetch` would walk straight around the boot-safety rule that makes `SourceScheduler.start()` refuse
to sweep on start. Fetching stays sweep-driven, which is to say operator-driven.

**Proof it works:** the deploy carrying this fix brought Bozeman from **90 to 179 records within
seconds of the container starting** — exactly +89, the frozen parse jobs — then went idle, because
everything remaining was `fetch`.

**3 · "Sweep now" reported a failure for a sweep that was working.** The route awaited the entire
sweep; its own comment claimed *"the sweep has run by the time this returns"*, true for a small
source and impossible for a large one. `frontend/nginx.conf` sets no timeouts on `location /api/`,
so it inherits nginx's default **60-second `proxy_read_timeout`**. The operator got a gateway
timeout whose HTML body carried no `error` field, and the console said *"bozeman-granicus could not
be swept"* about a sweep that ran on for another fifteen minutes. It now returns a genuine 202 as
soon as the sweep is launched; the truth about how it went lives on the run row, where it belongs.

**4 · "0 agenda items" meant two opposite things.** A live meeting rendered *"Nothing was extracted
from this document"* about a document the parser had **never opened** — the sweep died with
`parse done 0` and every parse job queued. That is an absence dressed as a finding. `no_document`,
`not_run`, `running`, `done` and `failed` are now distinct states with distinct sentences, because
"parsed and genuinely empty" may be worth publishing with a note and "not parsed yet" is not a
record anyone should be deciding about.

### The sweep monitor

`/admin/runs/:id` polls every 5 seconds while a run is running and shows done-of-total, the queued
count, a progress bar, the **observed** per-job rate and an ETA. Observed, not configured: a
configured "10s per document" would keep asserting itself while a source throttled us to thirty,
growing more confident as it grew more wrong. Polling stops at a terminal status.

### 5 · A sweep that drains an older run's backlog now gets credit for it

Found by watching the **second** Bozeman sweep, 2026-08-11. It processed 250 queued jobs, took the
site from 179 records to 358 — and recorded `records: 0` against itself, then classified `failed`.

`ingestion_runs.counts` is written by handlers against the run that **enqueued** a job. `CLAIM_SQL`
carries no `run_id` filter and takes the oldest pending work **anywhere**. Both are correct, and the
global claim is exactly what lets a backlog finish across runs — but together they mean a sweep
that spends its life finishing an earlier run's queue ends with empty counts, and the new
`work === 0 → failed` branch then called it a failure for the second time in a day.

`drain()` now returns the number of jobs the sweep itself completed, `SweepDeadlineReached` carries
it, and it is recorded as `counts.processed` and weighed by `classifyRun`. The two numbers answer
different questions and are kept apart: `counts` is *what happened to this run's jobs*,
`processed` is *what this sweep did with its fifteen minutes*.

### What this means operationally

A large archive backfills **across several sweeps, by design**. `CLAIM_SQL` carries no `run_id`
filter and orders by `next_attempt_at`, so each sweep works the oldest outstanding jobs first and
nothing is lost when the clock runs out. Bozeman needs roughly four sweeps for its first full pass.
Records already ingested persist regardless — `runSweep` writes through `this.db`, not the
transaction, precisely so a sweep that dies leaves what it already landed.

## Minutes extraction has landed, and it reads a real meeting

**2026-08-11.** The pipeline that turns a set of minutes into cited claims about what each named
official did. Run end to end against the 2026-07-14 Bozeman City Commission minutes: 22 pages,
nine chunks, **44 claims stored**, every one carrying the verbatim sentence it came from and that
sentence's byte offset into the stored PDF.

Everything it produces is `held`. Every claim names a person, and nothing naming a person
auto-publishes — that rule predates the feature and is the reason the feature is allowed to exist.

### The design premise

**We do not trust the model — we test it against the bytes.** A claim arrives asserting a named
official did something, carrying a quotation it says supports that. `verifyClaims` goes and finds
that quotation in the stored artifact or discards the claim. There is no third outcome and no
"low confidence" bucket that quietly keeps the row.

This is also what makes a **free** model acceptable. A weaker model fabricates more often; it does
not fabricate text that then turns out to be present. The failure mode of a cheap model here is a
lower yield, not a wrong record. On the first real document the wall rejected roughly half of what
the model proposed.

Seven checks, each with adversarial tests written from the attacker's side:

| Rejection | What it catches |
|---|---|
| `quote-not-found` | The quotation is not in the document. The obvious one. |
| `quote-too-short` | "Yes." appears hundreds of times — locating it proves nothing. A check that passes and means nothing is worse than no check. |
| `subject-not-in-quote` | A real quotation pinned to someone it never mentions. |
| `wrong-role-in-quote` | A real quotation naming **two** officials in different roles, attributed to the wrong one. |
| `not-an-official` | A member of the public who spoke at public comment. |
| `unknown-action` | An action outside the enum. |
| `asserts-motive` | Motive language, however well cited — reusing the corrections log's own `motiveTerms`. |

`matter` is held to the same standard as the quote: it must be locatable in the document **and**
within `MATTER_WINDOW` (2000 chars) of its own citation. An unverifiable matter drops to `null`
and the claim survives — losing the context of a true fact is a small harm, asserting the wrong
context is a large one.

### What was built

- **Migration 072 `minute_claims`** — `quote` and `quote_offset` both NOT NULL, so the database
  refuses a citation nobody located. Addressed by `artifact_sha256`, not a document id: the claim
  is about a specific set of bytes. `status` defaults `held`.
- **Migration 073 `extraction_runs`** — every attempt, with its verbatim error, its rejected
  claims and its failed chunks stored as written rather than summarised to a count.
- **`services/extraction/{verify,openrouter,extractor,run,runs}.ts`**.
- **`POST /api/admin/pressroom/meetings/:id/extract`** — 202 immediately, work in the background,
  409 if one is already running. **`GET .../extract-runs`** reads the outcome.
- **69 tests** in `backend/test/extraction.test.ts`.

### Model selection — measured, not assumed

`OPENROUTER_API_KEY` lives in SSM Parameter Store `/commissionwatch/env`. Cost to date: **zero**.
Free-only is enforced in code by `assertFreeModel`, not in configuration, because the failure mode
of a typo is a bill.

**The first selection criterion is: not a reasoning model.** `nemotron-3-super-120b` spent its
entire budget thinking aloud and never emitted JSON — 27,000 characters of deliberation at 6,000
tokens, 209 seconds per chunk, zero claims on nine chunks of minutes that plainly record a 5-0
vote by name. Measured on one real chunk with reasoning disabled:

```
nvidia/nemotron-3-nano-30b-a3b:free   36.5s   25 claims   valid JSON   <- pinned
cohere/north-mini-code:free           43.6s   17 claims   valid JSON
poolside/laguna-s-2.1:free            71.7s   31 claims   valid JSON
inclusionai/ling-3.0-tiny:free         7.8s    0 claims   prose, no JSON
nvidia/nemotron-3-super-120b:free    209.5s    0 claims   prose, no JSON
```

**`openrouter/free` is allowlisted but deliberately NOT the default.** It is genuinely zero-priced,
but four identical calls were served by four different models — one a content-safety classifier
that returned nothing usable, another missing a claim its siblings caught. Inconsistent coverage
across a document is worse here than an outage, because it leaves no trace. `complete()` records
the model that *actually* answered, so a router's claims stay traceable to what wrote them.

### Seven defects, all found by running it rather than reading it

Recorded because each is a shape that will recur:

1. **Compose sets an absent variable to the empty string,** and `??` passes that straight through.
   `OPENROUTER_MODEL` was `""` on every deployment, so the documented default was unreachable in
   production while passing every test. The free-model guard then fired — a config bug wearing the
   safety check's costume.
2. **The pinned model stopped being free** mid-project. `assertFreeModel` refused to follow
   OpenRouter's 404 pointing at the paid slug, which is the guard working.
3. **nginx's 60-second `proxy_read_timeout`** turned a synchronous extraction into a bare HTML 504
   while the work carried on server-side. The same defect as the sweep 504, in a route written
   *after* fixing that one.
4. **An unreadable reply was indistinguishable from an empty one.** `readClaims` returned `[]` for
   prose, so nine successful chunks and zero claims were recorded `succeeded` — a document full of
   recorded votes reported as a meeting where nothing happened. Nothing lied; every layer passed an
   empty list along.
5. **`CHUNK_OVERLAP` guaranteed duplicate keys in one INSERT.** The overlap exists so a sentence
   spanning a boundary is wholly inside one chunk, so the overlap is read twice, and offsets
   resolve against the whole document — two identical keys, which Postgres refuses outright
   (`ON CONFLICT DO UPDATE command cannot affect row a second time`). The overlap that exists to
   avoid losing evidence was losing all of it.
6. **Truncated replies were discarded whole.** The token ceiling cut three of nine chunks
   mid-string, each having already emitted several complete, correct claims. `salvageObjects` now
   recovers them — and still records the chunk as failed, because the tail genuinely was not read.
7. **A quotation naming two officials could not say which one acted.** "…was made by Deputy Mayor
   Fischer and seconded by Commissioner Bode" — a claim saying *Fischer seconded* passed every
   check. Cues now carry a **direction**, because a roll call reads "Fischer – Aye; Commissioner
   Bode – Aye" and nearest-by-distance alone shifts every vote by one person.

### What remains

1. **~20% of each document is still unread.** Two of nine chunks fail with
   `OpenRouter returned no message content` — a different fault from truncation; the content field
   is absent entirely. The run is labelled `partial`, honestly, but the gap is real.
2. **No review screen.** Claims are reachable only through the API, so an operator cannot approve
   one from the console. `minute_claims.status` and the reviewer columns exist and are unused.
3. **Nothing is published.** Even an approved claim does not reach the public site. That is a
   separate, deliberate change — not a consequence of this one.
4. **`member_id` is never populated.** The column and its FK exist; nothing links a claim to a
   `members` row, or to an existing `votes` row.
5. **`members` holds placeholder fixtures** — "Avery Sample", "Riley Fixture". No real roster can
   be sourced: `bozemanmt.gov` answers 403 to everything, Granicus publishes no member list, and
   the minutes carry no roll call. This is why claims are gated on the **office the minutes print**
   rather than on a roster.
6. **One meeting.** Every other ingested meeting needs the same run, and there is no batch route.


## Live state

**https://commissionwatch.bmux.sh returns 200.** Verified from outside the host, with a valid Let's Encrypt certificate.

| | |
|---|---|
| Host | `i-0123456789abcdef0`, shared `*.bmux.sh` platform, t4g.medium (arm64), 4 GB |
| Containers | `commissionwatch-web`, `-backend`, `-db` (pgvector pg16), `-minio` — all healthy |
| Footprint | ~144 MB actual against 1408 MB of declared limits |
| Deploy dir | `/home/ec2-user/commissionwatch` on the host |
| Access | Gated at the Caddy layer to `184.166.213.70`. Everyone else gets 403 |
| Deployed | `9d2825c`, built 2026-08-14T21:36Z. **`SHARED_STACK_LIVE` is set, so every push to `main` deploys.** |
| Data | **The live host has swept.** `bozeman-granicus` was enabled by the operator on 2026-08-10 and has run twice; 339 meetings discovered, backfilling across sweeps (see above). Nothing is published yet — publication is a separate decision, made at `/admin/sources/:id/meetings` |

### Ingestion runs — the first public records have been fetched

**"Nothing ingests" stopped being true on 2026-08-09.** It was the single most important sentence
in this file for the product's whole life, and it is now wrong, so it is gone rather than softened.

`SourceScheduler` (`backend/src/services/ingestion/scheduler.ts`) is started from `index.ts`. It
reads `ingestion_sources.cron_expression` and `.enabled`, arms one `node-cron` job per enabled
source, takes a Postgres advisory lock keyed on the source id so one sweep runs at a time, writes
an `ingestion_runs` row **before** any work, and closes it `succeeded`, `partial` or `failed` with
every error text in the row. It **does not sweep on process start** — the first execution of any
source is its first cron tick, because a crash-looping container must never become a crawl of a
county web server. `SCHEDULER_ENABLED` defaults off under `NODE_ENV=test`.

**A real sweep ran against Gallatin County on 2026-08-09**, rate-limited to one request every two
seconds with the project's honest user agent. What landed locally:

| | |
|---|---|
| `meetings` | **7** (Weed Board ×4, Study Commission ×2, plus one more) |
| `agenda_items` | **40**, extracted from real agenda PDFs |
| `meeting_documents` | 11 |
| `artifacts` | 11, content-addressed, bytes in MinIO |
| `ingestion_runs` | 1, status `succeeded` |
| `ingestion_jobs` | 23, all terminal |

Two things the sweep taught us, both now in the spec:

- **AgendaCenter has been reorganised.** It rendered **three** categories on 2026-08-09
  (`cat3`, `cat2`, `cat4`) where the adapter's `GALLATIN_BODIES` constant names twelve. (An earlier
  version of this line said the *fixture* captured twelve. It does not — it holds those same three,
  and `gallatin-civicplus.test.ts` asserts it. Corrected 2026-08-10.) The constant is mostly wrong
  about what the site serves; it skips an unknown category loudly, so the failure mode is safe, but
  the list belongs in `ingestion_sources.config`.
- **Not every document is a PDF.** `/AgendaCenter/ViewFile/Agenda/_08062026-108` is a Word
  document. Parse records that as `parse_unsupported` and completes — the bytes are still stored
  and still citable. That meeting has 0 agenda items and the reason is recorded.

### Bozeman is the second source, and it has swept too

**A real sweep ran against `bozeman.granicus.com` on 2026-08-09**, 14-day lookback, one request
every **ten seconds**. What landed locally:

| | |
|---|---|
| `jurisdictions` | 1 — City of Bozeman |
| `commissions` | **16** |
| `meetings` | **18** (6 completed, 12 scheduled) |
| `agenda_items` | **88**, extracted from real agenda **HTML** |
| `meeting_documents` / `artifacts` | 8 |
| `ingestion_runs` | 2, both `succeeded` |

The second sweep re-fetched nothing — `artifacts_unchanged: 8` — which is the content address
doing its job.

Four things this source taught us:

- **The whole archive is one request.** `ViewPublisher.php?view_id=1` is 5.9 MB holding 1,135
  meetings across 16 bodies, 2013→2026, plus 17 upcoming. The year tabs are client-side. There is
  no per-year endpoint, which is the opposite of Gallatin.
- **`bozeman-access-spike.md` was wrong about several counts.** 519 City Commission meetings, not
  520; **16 bodies in total**, not "20+ others"; and 507/434 were City-Commission-only figures
  against 1,102/956 across all bodies. Corrections are inline in that document and in
  `backend/test/fixtures/bozeman-granicus/PROVENANCE.md`. Its **access** analysis held up exactly.
- **The archive's time column is the video clip's start, not the meeting's.** The 2026-08-04 City
  Commission row says 1:17 PM; that meeting's own agenda states an early start of 2:00 PM. Only
  upcoming meetings carry a time.
- **Agendas are HTML.** The parse stage only read PDFs, so every Bozeman agenda would have landed
  `parse_unsupported` with zero items. `services/ingestion/document-text.ts` now dispatches on the
  bytes, and `agenda-items.ts` learned dotted `G.1` markers and rejoins a marker the source put in
  its own element. The 2026-08-04 agenda yields 30 items.

**The robots.txt exception is now in force and is disclosed.** `bozeman.granicus.com/robots.txt`
is `Disallow: /` for this agent. We fetch anyway under the operator decision of 2026-08-04, at the
10-second `Crawl-delay` the file itself publishes, with the project's honest user agent. The
Methodology page carries the disclosure as of the same release, and three tests assert it is there.
**If that disclosure comes down, the adapter must be disabled with it** —
`respectRobotsTxt: true` makes it obey the file and discover nothing, which is the switch.

Enabling Bozeman is the same deliberate act as Gallatin, with one caveat:

```bash
npm run sweep -- --adapter bozeman-granicus --enable --lookback-days 14
```

**Use a short lookback the first time.** At 10 s per document a 365-day sweep runs for hours and
will blow the scheduler's 15-minute `sweepTimeoutMs`, leaving the run `failed` and its jobs queued
for the next tick until it catches up. Agenda packets (28 MB, 439 pages, 724 of them) are **not**
fetched unless `includePackets` is set.

The live host has **not** been swept: `ingestion_sources` rows are created **disabled**, so nothing
sweeps because a container started. Enabling Gallatin in production is a deliberate act:

```bash
npm run sweep -- --list                                    # what exists
npm run sweep -- --adapter gallatin-civicplus --enable     # enable and sweep once, now
```

**The adapter moved.** `agents/meeting-monitor/src/adapters/` is now
`backend/src/services/ingestion/adapters/`, with its contract suite in `backend/test/adapters/` and
its fixtures in `backend/test/fixtures/gallatin/`. `backend/Dockerfile`'s build context is
`./backend`, so a production image cannot contain a file from `agents/` — and the scheduler runs in
the backend. Those 68 contract tests had **never run in CI**; they do now.

### The running deployment now comes from CI

As of 2026-08-06 the live containers are the ones `deploy-aws` shipped over SSM, serving `71217e2`. Before that they had been started by hand over SSH on 2026-08-05, and the SSH version of the job could never have replaced them: the shared host's SSH private key is not retrievable from AWS by anyone, so it was blocked on a secret that does not exist to be supplied.

**Rewritten on 2026-08-06 to deploy over SSM Run Command** (`deploy/deploy-aws-ssm.sh`), which needs no key and no host address. Everything testable without AWS credentials is tested and green — payload construction, secret resolution, shared-host safety flags. Design: `docs/superpowers/specs/2026-08-06-ssm-deploy-design.md`.

**First real run, 2026-08-06.** `SHARED_STACK_LIVE` was set and `deploy-aws` executed. It authenticated as `commissionwatch-ci`, resolved both image pins to `25ba8b9`, and failed at `ssm:PutParameter` — the optional secret refresh. Diagnosis from the account: the CI user held exactly one inline policy, `commissionwatch-ecr-push-pull`, so `ssm:SendCommand` was missing as well; `/commissionwatch/env` had never been created; and `platform-aws-host` had no Parameter Store grant. **None of these are code defects** — the script did what it was told with the permissions it had.

**Second run, 2026-08-06 (`af7097f`, v0.2.0).** Failed at the same line, and that was informative: it proved `DEPLOY_ENV_FILE_AWS` was still set even though the IAM grants had landed. The Gitea *Variables* tab had been cleared, but the value is a **secret**, and secrets are a separate tab. The diagnostic block printed as designed and the job died before touching the host, so nothing on the box changed.

**Third run, 2026-08-06 (`71217e2`). The SSM round trip works end to end.** The host pulled both images, recreated `backend` and `web`, waited on `db` and `minio` health, and reported both containers serving `71217e2`. Secrets came from `/commissionwatch/env` — no DEGRADED fallback. Verified independently: `https://commissionwatch.bmux.sh/api/health`, `/api/version` and `/version.json` all return 200, and `/api/version` reports sha `71217e2`, built `2026-08-06T22:40:39Z`.

**The job still reported failure**, after the deploy had fully succeeded. Cause was in the workflow, not the deploy script: `cleanup() { [ -n "$TMPENV" ] && rm -f "$TMPENV"; }` as an `EXIT` trap. When a `&&` chain is the *last command of an EXIT trap* and its test fails, bash makes that the script's exit status — so a completely successful deploy exited 1 whenever `TMPENV` was empty. That is precisely the path taken when `DEPLOY_ENV_FILE_AWS` is unset, i.e. the normal one, which is why deleting the secret is what exposed a latent bug rather than causing a new one. Fixed with an `if`, which returns 0 with no else branch.

## Operational facts

Learned the hard way; each cost a failed deploy.

- **ECR repositories are `your-org/` prefixed** — `your-org/commissionwatch-backend`, `your-org/commissionwatch-frontend`. The CI user's IAM policy scopes to `repository/your-org/commissionwatch-*`, so an unprefixed path is denied. ECR reports both a wrong path and a missing repository as **403 on a blob HEAD**, never a 404, and never names the repository — so a 403 means check the path first, not the credentials.
- **Images must be `linux/arm64`.** The host is Graviton. An amd64 image builds cleanly and dies at startup with `exec format error`.
- **The host's instance role needed `ecr:BatchGetImage` on `your-org/*`.** The other products' repos are unprefixed, so `bmux-platform-host-ecr-pull` never covered ours. Fixed 2026-08-05 by adding that ARN pattern.
- **`ec2-user` cannot write to `/opt`.** `platform-aws` deploys to `/opt/platform-aws`, which must have been root-provisioned out of band. We deploy under `$HOME` instead, so no manual step is required per product.
- **Gitea `act_runner` runs jobs inside containers**, so a `services:` database answers to its service name (`postgres`), not `localhost`. The workflow probes both.
- **`actions/setup-node` had a corrupt runner cache**, failing with an `lstat` error naming a file from the action's own repo. Replaced with `container: node:22-bookworm`.
- **CI is Gitea Actions only.** Never add `.github/workflows/` — it does not run.
- **`POSTGRES_PASSWORD` is fixed at volume initialisation.** Changing the secret later will not change the database; rotation is an `ALTER ROLE` on the running instance.
- **SSM works on the host** (`AmazonSSMManagedInstanceCore` attached 2026-08-04). This is now the deploy path, not just a repair tool.
- **The shared host's SSH private key is unobtainable.** EC2 stores only the key pair's *name*; the private half belongs to whoever provisioned `platform-aws` and cannot be retrieved from AWS. Port 22 being open makes this look like a missing secret rather than a missing capability. Do not try to source it — that is a dead end, and it is why the old `deploy-aws` job could never go green.
- **`AWS_PROFILE` set but empty** makes every CLI call fail with *"The config profile () could not be found"*, which reads as missing credentials. Reproduced on the operator workstation 2026-08-06. `deploy-aws-ssm.sh` clears it when empty on both ends.
- **Secrets belong in SSM Parameter Store**, fetched by the host with its instance role. Never in the SSM command payload — `send-command` parameters sit in plaintext in command history for 30 days and in CloudTrail, readable by anyone in the account with `ssm:GetCommandInvocation`.
- **The instance role reads `/commissionwatch/*`, and only reads it.** The role is `platform-aws-host`, shared with the other products on the box, so the grant is an **inline** policy (`commissionwatch-param-read`) scoped to our path — it touches no managed policy and no other tenant. Applied and verified 2026-08-06. An earlier version of this file said the grant "is not ours to make"; **that was wrong** — the account holder has `AdministratorAccess`. See `deploy/README.md` §3. If the parameter is ever missing, deploys fall back to the `.env` on the host and run **DEGRADED**, loudly, rather than failing.
- **CI must not hold `ssm:PutParameter`.** The parameter is seeded once by hand and read by the host; the pipeline only sends commands. Setting `DEPLOY_ENV_FILE_AWS` reverses that — it makes every deploy push the secret through a runner and need a write grant. Verified 2026-08-06: with the secret set and no SSM policy on the CI user, the first failure is `PutParameter`, which reads as a broken deploy while concealing that `ssm:SendCommand` was also missing.
- **Nobody holds the plaintext of the env file, and nobody needs to.** It exists in `/home/ec2-user/commissionwatch/.env` on the host and, until 2026-08-06, in a Gitea Actions secret that is write-only. The host seeded Parameter Store from its own copy without anyone reading it — `deploy/README.md` §4. `/commissionwatch/env` is now a SecureString at version 1, 419 bytes, 8 keys, and the seed grant was revoked in the same session. Rotation means repeating that procedure, not recovering a copy from somewhere.
- **The `amazon/aws-cli` container fallback works** — verified 2026-08-06 with `aws` off `PATH`. The runners have docker but not the CLI.
- **`AWS_PAGER` must be set to `""`.** CLI v2 pages through `less(1)` and on a runner `TERM` is undriveable, so every `aws` call stalls on "Press RETURN" rather than failing. A deploy that looks slow rather than broken. Set on both ends and in the workflow job env.
- **Inside these containers, probe `127.0.0.1`, never `localhost`.** `/etc/hosts` maps `localhost` to `::1` too, busybox wget tries `::1` first, and nginx listens only on IPv4 — so `localhost` gives a flat `Connection refused`. **The `web` healthcheck used one**, so the container could never go healthy and `up -d --wait` would have blocked until timeout and failed the first automated deploy. Verified 2026-08-06 with the same image twice: `localhost` → unhealthy, `127.0.0.1` → healthy. Fixed.
- **Both images serve their build SHA** — `/version.json` from web, `/api/version` from the api, stamped from one `github.sha`. The deploy compares them through the web container and fails on skew (25), stale pull (26) or unreachable (24). The images roll independently, so a stack serving the old API behind the new UI is healthy by every other measure.

### Going public

**B3 no longer blocks this, as of 2026-08-10.** The published corrections log and the dispute route
exist and are tested; see the B3 section above. What remains before the gate comes down is an
operator decision, not a build.

Delete the two `@blocked` lines from the `commissionwatch.bmux.sh` block in `your-org/platform-aws`'s `caddy/Caddyfile`. **Do not** change the security group — its 443 allowlist is shared with seven other products, so opening it exposes all of them at once. Per-product exposure belongs in Caddy.

## Gaps — what is not built

Ordered by how much each blocks the product being real.

1. ~~**Nothing ingests.**~~ Closed 2026-08-09 by P1. The scheduler is wired, a real sweep has run, and the pipeline lands meetings, documents, artifacts and agenda items. Remaining: enable the source on the live host, and move the body list out of the adapter into `ingestion_sources.config`.
2. **W3 findings engine.** ~~and review queue~~ — the **review queue landed 2026-08-10** (B-a,
   above): `approval_requests`, a single severity threshold, claim-to-citation binding, and
   operator approval as the only thing that makes a finding public. What remains of this item is
   the *generated narrative* — a finding today is the detector's own sentence, not composed prose.
3. ~~**Bozeman adapter.**~~ Closed 2026-08-09 by P4. `backend/src/services/ingestion/adapters/bozeman-granicus.ts`, registered **disabled**, swept for real (below). `bozemanmt.gov` is still a blanket Akamai deny and is never fetched. ~~Outstanding from the same backlog item: the **public-records-request page**~~ — closed 2026-08-10 by P7, though it can draft nothing until `jurisdiction_records_law` is populated. See above.
4. ~~**MT CERS campaign finance**~~ (`cers-ext.mt.gov/CampaignTracker`). Closed 2026-08-10 — the
   adapter is written, registered **disabled**, and a real rate-limited sweep landed 384 filers,
   35 filed reports and 127 itemised transactions. See above. Outstanding from the same item: no
   public route and no frontend yet, no committee sweep, and the roster cursor named as a known
   limitation.
5. **W6 funding network layer.** Specced only — `docs/superpowers/specs/2026-08-04-funding-network-layer-design.md`.
6. ~~**W7 delivery channels.**~~ Built. Channels, routes, encryption, the Discord transport, and — as of B-e — cadence, SMS, and a self-serve subscriber surface on the same substrate. Nothing dispatches product events yet, because nothing ingests.
7. **Launch readiness**: ~~corrections and dispute policy~~ — **closed 2026-08-10 by B3**, see
   above. `/corrections` publishes the policy and the log, `/corrections/dispute` is the route, and
   disputes reach the operator queue. **This was the gate on making the site public**; the rest of
   this item is not. ~~public data export and licensing~~ — **closed 2026-08-10**: ten datasets in
   JSON and CSV at `/api/data`, CC BY 4.0 for the compilation and MIT for the code, described on
   `/data` with `Dataset` JSON-LD. Still outstanding: backups with a tested restore (see item 8 —
   `BACKUP_S3_URI` and the cron), accessibility, and shareability. Also outstanding from the same
   spec and deliberately not built: the **dated export archive**, so "what did this site say in
   March" is still unanswerable, and that is stated on `/data` rather than implied.
8. ~~**No database backups.**~~ Closed 2026-08-09 by P3. `deploy/backup.sh` takes a nightly
   `pg_dump -Fc` plus a MinIO mirror with 7 daily / 4 weekly retention and emits
   `ops.backup_succeeded` / `ops.backup_failed` through the delivery dispatcher.
   `deploy/restore-drill.sh` **has been executed**: 28 tables compared against the manifest,
   137 rows restored, no losses, 11 objects in the archive. Runbook: `deploy/README.md` §5.
   **Outstanding:** `BACKUP_S3_URI` is unset, so an archive currently never leaves the instance —
   that is a copy, not a backup. Setting it needs a bucket, which costs money and is the operator's
   call. The cron entry also still has to be installed on the host.
9. **No monitoring** — **mostly closed 2026-08-10 by the external monitor, with one operator task
   left.** See the section below. The probe is built, tested and green against production, and the
   periodic trigger it was missing is now `deploy/monitor-trigger.sh` — **scheduled workflows do not
   fire on this Gitea instance**, measured, not suspected, so the clock is a cron entry driving the
   `workflow_dispatch` that does fire. **Installing that cron entry is the operator task**; the
   exact command is in the monitor section. Still open and named there rather than left implicit:
   nothing notices if the trigger itself stops.
10. ~~**No admin authentication.**~~ Closed 2026-08-09 by A1. One operator class, `scrypt` from
    `node:crypto`, revocable server-side sessions in an httpOnly cookie, no public registration.
    The review queue is no longer blocked on it.

## Known defects and debt

- ~~**PRODUCTION IS DOWN as of 2026-08-09.**~~ **STALE — resolved.** As of 2026-08-14 the
  site is healthy and serving sha `9d2825c`: `/api/health`, `/api/version` and
  `/api/meetings` all answer, verified from outside the host. The entry is kept rather than
  deleted because the cause below — a crash-looping backend deploying as a success — is the
  defect it taught, and that fix is what makes this line safe to close. Original text
  follows. Deployed sha `1fb246f`. The frontend serves; the
  backend does not — `/api/health`, `/api/version` and `/api/meetings` all return 502. The host,
  the workflow log and ECR are not reachable from this repo, so the cause is not diagnosed here.
  Everything reproducible locally is green: migrations apply 1→33 on a fresh database, the image
  builds, the backend boots with only `DATABASE_URL`, and it uses 115 MB against a 512 MB limit.
  **Nothing has been pushed since**, deliberately — every push triggers a deploy onto the broken
  stack.
- ~~**A crash-looping backend deployed as a success.**~~ Fixed 2026-08-10, and it is why the
  incident above went out green. `docker compose up -d --wait` treats a service with **no
  healthcheck** as ready the instant its process starts; `backend` had none while `web`, `db` and
  `minio` all did, `web` depended on it with `condition: service_started`, and
  `restart: unless-stopped` restarted the dead container forever. The deploy script's
  version-skew check (24/25/26) never ran, because by then the deploy believed it had won.
  `backend` now has a healthcheck on its own `/api/health` — **127.0.0.1, never `localhost`** —
  `web` waits on `service_healthy`, the entrypoint names a migration failure instead of exiting
  silently, and `deploy/test-deploy-aws-ssm.sh` asserts every service in the deployed compose
  file declares a healthcheck. 53 assertions before, **61** now.
- **CI `deploy-aws` unverified.** The SSM round trip has not yet completed once from a runner. See above.
- ~~**Deploy pattern is push-based SSH**~~ — resolved 2026-08-06. No SSH key in CI, no rsync; secrets live in Parameter Store and are fetched by the host. Still push-based; a pull-based rollout watching ECR remains the better end state but is not blocking anything.
- **The instance-role grant for Parameter Store is outstanding**, so deploys run degraded. Not a defect in this repo — it needs whoever administers `your-org/platform-aws`. `deploy/README.md` §3 has the exact policy.
- **Images are tagged `:sha` and `:latest` only.** No `:version` tag: deriving one from `git describe` is unsafe on Gitea's shallow checkouts, where `--always` silently degrades to a bare SHA that looks like a valid answer. Rollback is by explicit pin instead, which works today.
- ~~**Homepage findings section is a placeholder constant.**~~ Resolved 2026-08-10, and the audit
  found a second defect underneath it. The constant is now `NO_FINDING_YET` and is **the honest
  empty state, meant to be rendered** — not a placeholder awaiting prose. There is nothing to fill
  in: no `findings` table, no endpoint, no hook, and the subject of a front-page claim on this site
  is a real, living, named official. The name `PLACEHOLDER_FINDING` was itself the hazard, because
  it invited the wrong repair.
  The second defect was the byline under it, which read *"Generated {today} · N meetings
  reviewed"*. **Both halves were false.** Nothing was generated — there is no finding above it —
  and `N` is what the meetings endpoint returned, a count of meetings in the record rather than a
  count of anything anybody reviewed. A site that exists to catch unsourced claims had two of them
  under its own masthead. It now reads *"N meetings in the published record"*, and the test that
  pinned the old wording now asserts `Generated` and `reviewed` are **absent**.
- ~~**`Layout.tsx` hardcodes "Last sweep 12 min ago."**~~ Fixed 2026-08-09. The masthead reads
  `GET /api/ingestion/status`, which reports the newest `finished_at` of a `succeeded` or
  `partial` run, and says **"No sweep yet"** whenever there is nothing to report — including
  while the request is in flight and when it fails. Seven tests, where there were none.
  Re-verified 2026-08-10: still true, no constant anywhere in `Layout.tsx`.
- ~~**`meetings` has no `adjourned_at` or `meeting_type`.**~~ Resolved 2026-08-10 by deleting the
  row. `meetings` has a `DATE`, a nullable `TIME`, a `location` and a `status`, and nothing else
  about the sitting — so `MeetingDetailPage`'s Adjourned row rendered the literal string
  "Not recorded" on every meeting that has ever existed and every meeting that ever will.
  "Not recorded" is a claim about the custodian's minutes; what it actually described was a column
  we never created. **A field that can only ever say one thing is not reporting**, and a field
  reporting our schema gap as the city's is worse than absent. Convened and Location stay: those
  columns are real, and their "Not recorded" is true of the source — Granicus publishes a time for
  upcoming meetings only. `meeting_type` was never referenced; the page derives a label from
  `status`, which is a real column. When an adjournment time is extracted from minutes it gets a
  column first, and a row second.
- ~~**No tests** for `MeetingDetailPage`, `StatusBadge`, `RundownViewer`.~~ Written 2026-08-10.
- ~~**`VoteBreakdown.tsx` may be unused.**~~ **Stale — it was never unused.** Verified 2026-08-10:
  `VotesPage.tsx` imports it and renders `<VoteBreakdown mode="roll-call" …>` in the expanded row,
  and `VotesPage.test.tsx` exercises it through the disclosure. Nothing was deleted. Its
  non-component exports (`VOTE_ORDER`, `VOTE_LABEL`, `tallyVotes`) moved to
  `components/vote-tally.ts` as part of the lint work below.
  **One real defect did turn up next to it**: `MeetingDetailPage` carries its own near-copy of
  `tallyVotes` and `outcomeOf`. Two implementations of vote arithmetic on a site whose whole
  product is vote arithmetic is a defect waiting for the two to disagree. Not merged in this pass —
  see the declined list.
- ~~**Ten frontend lint warnings.**~~ All ten cleared 2026-08-10, no rule disabled and
  `.eslintrc.json` untouched. Every one was `react-refresh/only-export-components`: a non-component
  export sharing a file with a component. Fixed by moving the exports to their own modules —
  `components/severity.ts`, `components/flag-labels.ts`, `components/vote-tally.ts`,
  `contexts/auth-context.ts` + `contexts/useAuth.ts`, `lib/AllProviders.tsx` — and repointing every
  importer. `meetingStatusLabel` in `MeetingsPage.tsx` had zero consumers repo-wide and was deleted.
- **The two backend lint warnings stay, and both are deliberate.** `errorHandler.ts`'s `_next` is
  **not removable**: Express identifies error middleware by `fn.length === 4`, so dropping the
  fourth parameter turns the error handler into ordinary middleware and errors stop being handled
  at all. `embeddings.ts`'s `_limit` is the `$2` of a documented Phase-3 contract in a function with
  no call sites; removing only the parameter would leave a signature reading "return everything",
  which is not what the module means. The honest fix for both is
  `argsIgnorePattern: "^_"` on `@typescript-eslint/no-unused-vars` — this codebase already uses a
  leading underscore to mean "intentionally unused" (`_index`, `_rowIndex`, `_req`,
  `_queryEmbedding`) and the config gives that convention no effect. That is a config change, so it
  is left for a decision rather than made unilaterally under a brief that forbids weakening config.
- **W1 critic findings were never fully cleared.** An orchestration bug capped repairs at 5 of 19. The remaining ones were partly fixed incidentally. Re-run the critics rather than trusting the old list.

### Declined in the 2026-08-10 defect sweep, with reasons

- **Moving the body lists into `ingestion_sources.config`.** This is a much larger change than the
  backlog entry implies, and doing it shallowly would be worse than not doing it. Three facts, all
  verified in the code rather than assumed:
  1. **Adapter construction is synchronous, boot-time and database-free.**
     `createDefaultRegistry()` builds both adapters with no arguments before `startIngestion` does
     any database work, and the module-level `gallatinCivicPlusAdapter` / `bozemanGranicusAdapter`
     singletons do the same at import. Reading config at construction means making the registry
     async or deferring adapter creation to sweep time. That is the actual work; the constant is
     not.
  2. **What `registration.ts` writes is unusable as a round trip.** `config.bodies` is
     `descriptor.bodies.map(b => b.key)` — slugs only. Gallatin's `catId` is dropped entirely, and
     `urban-parks-forestry-board` cannot regenerate `Urban Parks & Forestry Board`. The two adapters
     also take different shapes: Gallatin takes `{catId, name}[]`, Bozeman takes `string[]`.
  3. **The write is insert-only.** `registerSource` returns early when the row exists, so an
     existing deployment's `config` is frozen at first boot and no deploy would ever update it.
     `ensureCommissions` is likewise insert-only and never deletes, so shrinking a list orphans
     `commissions` rows.
  The five Bozeman meetings this was blocking are fixed directly instead (see the commit); the
  Gallatin list is stale but fails **safe** — an unknown category is skipped loudly, and the three
  categories the live site serves are all in the list with the right ids.
- **Correction to this file:** the line above said AgendaCenter "rendered three categories where the
  2026-08-04 fixture captured twelve." The **fixture holds three** (`cat2`, `cat3`, `cat4`) and
  `gallatin-civicplus.test.ts` asserts exactly that. Twelve exists only in the adapter's
  `GALLATIN_BODIES` constant. The discrepancy is constant-versus-reality, not fixture-versus-live.
- **Merging `MeetingDetailPage`'s private vote tally into `components/vote-tally.ts`.** Real debt,
  and it is a behaviour change rather than a move: the two implementations disagree on the
  zero-vote case (`unrecorded` versus `none`) and on labels, and `MeetingDetailPage` had no tests
  when the sweep started. It now does. Merging them belongs in a change that can be judged on its
  own, with the new tests as the safety net rather than written in the same breath.
- **`argsIgnorePattern` on the backend lint config**, and therefore the two remaining backend
  warnings. Reasons above.

## Invariants — do not break these

Full detail in `.claude/skills/commissionwatch-development/SKILL.md`.

- No unsourced claim reaches the public site. `funding_edges.source_artifact_id` is `NOT NULL` for this reason.
- Nothing naming a person auto-publishes. It goes to the operator review queue.
- Seed data never names a real person, and **seeds never run in production** — the seed deletes every row first, so an automatic seed would destroy ingested records. `docker-entrypoint.sh` refuses to seed when `NODE_ENV=production`.
- Describe the record, never the motive. No assertion of intent, corruption or illegality.
- Detection logic applies identically to every entity class. No detector may filter on entity type to select targets.
- Never silence a type error; never delete a test to go green.
- The database schema is the source of truth for types.

## Next steps, in order

> **The ordered plan now lives in
> `docs/superpowers/specs/2026-08-14-system-roadmap-design.md` § 11.** The list below is
> still accurate about the *operator* tasks (0, 0b, 0c, 1) and about the extraction work
> (1b–1g); the roadmap supersedes it for everything after that and adds the regions module,
> the event spine, transcripts, the governor and delivery. Read both.

0. **Populate `jurisdiction_records_law` for Bozeman and Gallatin County.** Twenty minutes of
   reading, and it is the difference between a letter that is right and a letter that is
   confidently wrong. It blocks P7 entirely and nothing else blocks it. Full instructions in the
   P7 section above. **This one cannot be delegated to an agent** — it is a person reading a
   statute and putting their name against the date.
0b. **Install the external monitor's cron entry.** One line, on an always-on machine, and until it
   is installed nothing checks the site periodically at all. Exact command in the monitor section
   above. Prefer a machine that is *not* the deploy host, so the clock does not go down with the
   thing it watches.
0c. **Rotate the superseded OpenRouter key.** Two keys were issued on 2026-08-11; the first was
   replaced within minutes but was written to `/commissionwatch/env` first, and Parameter Store
   retains prior versions. The key in use is the second one. Rotating costs nothing — OpenRouter
   keys are free to reissue — and the value must never appear in this repository or in an SSM
   command payload. **Operator action; cannot be delegated.**

1. **Enable Gallatin on the live host and install the backup cron.** The code for both landed
   2026-08-09; neither is switched on in production. `npm run sweep -- --adapter gallatin-civicplus
   --enable`, then the `17 4 * * *` entry from `deploy/README.md` §5. Set `BACKUP_S3_URI` at the
   same time, or accept that the backup has not left the instance.
1b. **Fix the two chunks per document that return no content.** ~20% of every set of minutes is
   currently never read. `OpenRouter returned no message content` means `readMessageText` found no
   string in `choices[0].message.content` — a *different* fault from the truncation already fixed,
   where content is absent entirely rather than cut short. Start by widening the error to report
   `finish_reason` and whether a `reasoning` field was populated; that diagnostic is what solved
   the last two extraction mysteries in minutes. Until it is fixed every run is honestly but
   permanently `partial`.
1c. **Build the claims review screen.** `minute_claims.status`, `reviewed_by`, `review_reason` and
   `reviewed_at` all exist and nothing writes them, so an operator cannot approve a claim from the
   console at all — the only door is `GET/POST /api/admin/pressroom/meetings/:id/…`. The screen
   needs to show the quotation beside its offset in the artifact, because the whole point is that
   a reviewer checks the citation rather than the claim. Follow the review queue (B-a) rather than
   inventing a second approval concept.
1d. **Populate `member_id`, and link a claim to its `votes` row.** The column and its FK to
   `members` exist and are never written. Blocked in practice by the roster problem below: matching
   "Deputy Mayor Fischer" to a member row needs member rows worth matching.
1e. **Get a real roster into `members`.** It currently holds seed fixtures — "Avery Sample",
   "Jordan Placeholder", "Riley Fixture", "Casey Example" — and those have reached a page before.
   No roster could be sourced on 2026-08-11: `bozemanmt.gov` is a blanket Akamai 403, Granicus
   publishes no member list, and the minutes carry no roll call, printing only surnames with
   offices. **Probe for a source before designing** — the office-gating in `verify.ts` was written
   precisely so extraction did not have to wait for this, and it should not be quietly replaced by
   a roster match until a sourced roster exists.
1f. **Extract the rest of the meetings.** One meeting has been done. There is no batch route and
   deliberately so — each run costs minutes of wall-clock against a rate-limited free model, and
   `isExtracting` guards only per-meeting concurrency. A batch runner should be a queue stage, not
   a loop in a route.
1g. **Decide what a published claim looks like.** Nothing reaches the public site even once
   approved, and that is a separate deliberate change — the same shape as the dormant alert
   delivery. A claim naming an official is the highest-stakes thing this project would publish, so
   the publication path deserves its own design pass rather than an `if (approved)` in a template.

2. **Prove CI deploy end to end.** Run `deploy-aws` and watch it succeed, so the manual deployment is no longer the only path that has ever worked.
3. **Move both body lists into `ingestion_sources.config`.** A city standing up a committee should
   not need a deploy. **The five skipped Bozeman meetings are no longer the reason to do it** —
   that was fixed directly on 2026-08-10 with a match-only `&`/`and` normalisation, an explicit
   alias for "Tax Increment Finance Advisory Board", and three upcoming-only bodies added to the
   list; all seventeen upcoming rows now resolve. What remains is the architecture: adapter
   construction is synchronous and database-free, `config.bodies` is written as slugs only and is
   lossy for both adapters, and `registerSource` never updates an existing row. See the declined
   list under Known defects for the detail before starting.
4. ~~**W3 review queue**~~ — landed 2026-08-10, see B-a above. What remains under W3 is the
   **generated narrative**: a finding is currently the detector's own sentence. The queue, the
   threshold, the citation binding and the audit trail are all in place to receive one.
5. ~~**Bozeman Granicus adapter**~~, landed 2026-08-09 and registered disabled. ~~The
   **public-records-request page** that goes with it is still outstanding~~ — landed 2026-08-10 as
   P7. The exception is now written on a promise that has a page behind it, and
   `MethodologyPage.test.tsx` asserts the link is there as part of the disclosure suite.
6. ~~**Status page** reading `ingestion_runs`~~ — fully closed 2026-08-10. P2 shipped it for the
   *operator* at `/admin/sources`; the **public** page is now at `/status`, reading the same tables
   through the same judgements and publishing figures rather than run text. See above.
7. Then W5 correlation, W6 funding network, W7 delivery channels, and the launch-readiness work.

## For future agents

- Read `.claude/skills/commissionwatch-development/SKILL.md` first. It holds the process and the invariants.
- **Probe external sources before designing against them.** Every significant plan change in this project came from a `curl`, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended.
- **Verify by running commands.** Do not report success from an agent's claim or a green pipeline. Both have lied in this project.
- When fanning out, give agents disjoint file ownership and forbid concurrent git writes — a shared index lock corrupts work.
- A check that could not run is `blocked`, never `pass`.
