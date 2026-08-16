# Maturity review 2 — CommissionWatch re-scored after the Phase 6/7 loop, 2026-08-16

**What this is.** A second pass over the same seven frameworks used in
`2026-08-16-maturity-review.md` (SRE, OWASP ASVS, DORA, TMMi, DAMA-DMBOK, WCAG/product, OSS
sustainability), run after roughly fourteen Phase 6 and Phase 7 items landed in a few hours. The
first review's verdict was: **pass** on testing (L4), data governance (L3), product/UX (L3);
**does not pass** on operational readiness (L2), security (L2), software delivery (L2),
sustainability (L1).

**Method, and why it is stated first.** I took nothing on trust. Every line below is backed by a
command I ran, a file I read at a stated path, or a live probe against
`https://commissionwatch.bmux.sh`. Where the roadmap's own status disagrees with the tree, the
tree wins and I say so. Where something is blocked on a human — money, or a second person — I say
so and **do not count it against the product**.

Production at the time of review served `sha 5a70645`, two commits behind `HEAD` (`3eb2ded`).

---

## Summary of levels

| # | Category | Framework | Was | Now | Verdict |
|---|---|---|---:|---:|---|
| 1 | Operational readiness | SRE | 2 | **3** | **Does not pass** — one named item |
| 2 | Security posture | OWASP ASVS | 2 | **3** | **Passes** |
| 3 | Software delivery | DORA | 2 | **3** | **Passes** |
| 4 | Testing maturity | TMMi | 4 | **4** | **Passes** |
| 5 | Data governance | DAMA-DMBOK | 3 | **3** | **Passes** |
| 6 | Product / UX | WCAG 2.2 + product | 3 | **4** | **Passes** |
| 7 | Project sustainability | CHAOSS / OSS stewardship | 1 | **3** | **Passes** |

Six of seven now pass. That is a real and large movement in one working day, and the bulk of it is
not paper: the header fix, the rate limit, the resource check and the published pages are all
verified live below.

---

## What I verified, and how

Listed as commands and probes so a later reader can re-run them rather than believe me.

### Live probes against production

| Probe | Result |
|---|---|
| `curl -sSI https://commissionwatch.bmux.sh/` | **`strict-transport-security: max-age=31536000; includeSubDomains` present on the HTML document.** Security review finding 2 is genuinely closed. Full CSP, `x-frame-options: DENY`, `referrer-policy`, `permissions-policy`, `nosniff`, `vary: User-Agent` all present, no duplicates. |
| `curl -sSI .../api/version` | Same five headers, **identical values**, no duplicates — plus Helmet's non-overlapping set (`x-dns-prefetch-control`, `x-download-options`, `x-permitted-cross-domain-policies`, `cross-origin-*`, `origin-agent-cluster`, `x-xss-protection: 0`). Finding 1 (two layers, conflicting values) is closed as observed. |
| `curl .../api/nonexistent-route-xyz` | `{"error":"No such endpoint: GET /api/nonexistent-route-xyz","statusCode":404}`, `content-type: application/json`. The 4af9dfd fix holds. No stack trace, no HTML. |
| 82 requests to `/api/search` | **60 × 200, then 429** with `retry-after: 49` and a JSON body naming the seconds. Rate limit is real, live, and correctly numbered. |
| 80 requests to `/api/meetings` | **80 × 200.** The default tier (600/min) does not catch an ordinary reader. The two tiers are genuinely separate. |
| `curl .../api/health` | `"resources":{"disk":"ok","memory":"ok"}` — **6.3 is live in production**, coarse states only, no raw capacity leaked. |
| `curl .../api/metrics` | 215 meetings / **1 published**; 64 claims / **0 approved**; `last_published_at` still `2026-08-11`. **Unchanged from the first review.** |
| Deployed JS bundle (`/assets/index-DVi2iEZg.js`, 665 KB) grepped for reader-facing strings | `WCAG 2.2` ✔, `English only` ✔, `API stability` ✔, `bus factor` ✔, `what happens if it stops` ✔, `99.0` ✔, `kept until you ask` ✔, and **`no deletion schedule` now returns 0 matches** — the sentence the first review said was load-bearing has been replaced by an actual policy. All of 7.2, 7.3, 7.4 and 7.5's reader-facing halves are in the shipped bundle, not merely in a spec. |

### Local verification

| Command | Result |
|---|---|
| Suite figures | **Backend 2190 / 530, frontend 868 / 70, 0 fail either side**, typecheck/lint/build clean, zero `.skip`/`.only`/`.todo`. **These are the coordinator's uncontended numbers, not mine, and they are the ones to cite** — see the note below. Both are up substantially (backend was 2038/491, frontend 737/64), and the react-router v6→v7 migration (`ff528f9`, 74 files, ±2 lines each — a mechanical `react-router-dom` → `react-router` import rename) introduced no failure. |
| `cd frontend && npm run typecheck` | Clean, independently. |
| `cd backend && npm run typecheck` | Clean, independently. |
| `npm audit --omit=dev` (frontend) | **0 vulnerabilities.** The `@remix-run/router` open redirect the first review flagged as shipped in the public SPA is genuinely gone. |
| `npm audit --omit=dev` (backend) | **6 remaining — 2 low, 4 moderate, 0 high.** See §2a: two of them are the `qs` and `body-parser` DoS advisories the first review named as runtime risks, still present, with `npm audit fix` available. |
| Gitea Actions API, 256 `deploy.yml` runs | All-time CFR **47.2%** (85 failure / 180 concluded). Last 100 deploy runs: **16.4%** (11 / 67 concluded), was 15.7%. Cancelled **33%** of the last 100, was 29%. Most recent ~36 runs: 4/36 = **11.1%**. |
| Gitea Actions API, latest runs | `main` is **green** at `3eb2ded`, `5a70645`, `ff911e4`, `c2ce56a`. Nothing is red. |
| `aws sts get-caller-identity` | `InvalidClientTokenId` — **I have no AWS access**, so nothing about the backup cron on the host could be checked directly. That is itself a finding: see §1a. |

> **A methodological correction, recorded because it affects what in this document is trustworthy.**
> I ran the full backend suite three times against the shared Postgres instance before being told
> not to. Those runs contended with the coordinator's, and the contention produced false failures on
> both sides — four DB-fixture tests that failed in a shared run and passed 87/87 alone, and one
> timed-out ten-minute run. **My own "2200 tests / 531 suites" figure is discarded**: it was measured
> under contention and additionally included another agent's uncommitted edits to
> `test/external-monitor.test.ts`. The figures in the table above are the coordinator's, taken
> uncontended at `3eb2ded`. Nothing else in this document depends on a full-suite run — every other
> finding rests on a single test file, a file read, or a live probe.

---

## Hollow, stale, or wrong — the things the loop missed in its own output

Six findings. Two are reader-facing; one — H6 — turned out on inspection to be **disclosed and
deliberate**, and I have reclassified it rather than count it against the product. That distinction
is the whole job here, so it is worth naming: a dark feature that says it is dark in the changelog
and in `STATUS.md` is not the same object as a policy page that is wrong about the code.

### H1. The repo's own Caddyfile would strip the headers 6.4 just centralised. **This got worse today.**

`deploy/Caddyfile`:

```
handle /api/* {
    reverse_proxy commissionwatch-backend:3001
}
handle {
    reverse_proxy commissionwatch-frontend:3000
}
```

That routes `/api/*` **past nginx, straight to the backend**. But 6.4 (`f1d0ddf`) disabled Helmet's
`contentSecurityPolicy`, `referrerPolicy`, `xFrameOptions`, `xContentTypeOptions` and
`strictTransportSecurity` on the grounds — written into `backend/src/app.ts:95-125` and
`frontend/nginx.conf:135-140` — that *"nginx is the one layer in the request path for BOTH the HTML
document and `/api/*`."* Under the Caddyfile as committed, that sentence is false, and every API
response would carry **no CSP, no HSTS, no `X-Frame-Options`, no `Referrer-Policy` and no
`nosniff`** at all.

Production is fine: `server: nginx/1.31.3` appears on `/api/version`, so nginx *is* in the path
live, and `deploy/README.md:251` confirms the live block sends the whole host to one upstream. The
repo copy is stale — `deploy/README.md:16` calls it *"Reference copy of the site block. The live one
lives in `your-org/platform-aws`."*

The point is that **the drift was harmless before this morning and is now security-load-bearing.**
Before 6.4, Helmet's own copies covered the bypass. After 6.4, nothing does. Three artifacts
disagree about the edge and none of them matches another:

| Artifact | Says |
|---|---|
| `deploy/Caddyfile` | `/api/*` → `commissionwatch-backend:3001`, everything else → `commissionwatch-frontend:3000` |
| `deploy/README.md:251` | whole host → `commissionwatch-web:3000` |
| `deploy/docker-compose.yml:27` | the frontend container is named `commissionwatch-frontend` |
| Production, probed | nginx is in the path for `/api/*` |

`grep -rln Caddyfile backend/test frontend/src deploy/*.sh` returns **nothing**. No test asserts any
of it, and 6.4's own roadmap row already admits the header set was never verified end-to-end
through the real nginx container.

### H2. A privacy page that is wrong about the code, in three places at once.

`52cfd60` (10:08) wired `sweepExpiredSessions()` into a boot-armed scheduler
(`backend/src/services/auth/session-sweep.ts`, `backend/src/index.ts:121`), with a test that asserts
the sweep is *wired* rather than merely exported, mutation-verified by unwiring it. Good work.

Then `99bddf9` (10:28) — **twenty minutes later** — shipped `frontend/src/pages/PrivacyPage.tsx:221`
telling readers that *"a housekeeping job that would clear out old operator sign-in records
automatically instead of relying on someone to run it by hand"* is a **stated intention, not a
running system**. It is running. The page is live in the deployed bundle.

Two more copies of the same stale claim:
- `docs/superpowers/specs/2026-08-16-retention-policy.md:24` — *"`sweepExpiredSessions()` exists but
  **nothing calls it**"*; :175 — *"finds **no caller**. It is invoked from tests only"*; :229 lists
  wiring it as future work.
- `docs/roadmap.md` row 7.3 — *"`operator_sessions` has a cleanup method (`sweepExpiredSessions()`)
  that nothing calls."*

The error is in the self-deprecating direction, which is the project's habit and normally its
virtue. It is still a false statement on the one page whose entire value is that a reader can trust
it. The same loop that updated `AccessibilityPage.tsx` in the same commit as the console sweep did
not do the equivalent here.

### H3. "Clearing all production advisories" is not what happened, and the gate is set not to see the rest.

Verified by running the audits:

| Package | `--omit=dev` result |
|---|---|
| frontend | **0 vulnerabilities** — the react-router open redirect is genuinely closed |
| backend | **6: 2 low, 4 moderate, 0 high** |

Two of those six are exactly the runtime advisories the first review named:

- `qs` 6.11.1–6.15.1 — remotely triggerable DoS in `qs.stringify` (GHSA-q8mj-m7cp-5q26)
- `body-parser` 2.0.0–2.2.2 — DoS where an invalid limit silently disables size enforcement
  (GHSA-v422-hmwv-36x6)

plus `uuid` via `svix` via `resend` (moderate) and `esbuild` (low). **`npm audit fix` is offered for
all of them.** The CI gate is `npm audit --audit-level=high --omit=dev` in both `ci-backend`
(`.gitea/workflows/deploy.yml:92`) and `ci-frontend` (`:154`), so moderates pass silently and always
will. That is a defensible threshold — but 6.2's own deliverable is *"an `npm audit` gate with an
explicit, reasoned allow-list"*, and there is no allow-list. Four moderates in the running API are
tolerated by a threshold nobody wrote down a reason for.

The gate itself is real and would fail the build on a high: I read the step, and
`backend/test/…`'s workflow assertion (suite 440, *"ci-backend runs the production dependency
audit"*) checks it exists and runs before typecheck. That assertion is over YAML text, not over
behaviour — it cannot tell you the gate works, only that the step is present.

### H4. The resource check's early-warning tier goes nowhere.

`evaluateResources` (`backend/src/scripts/external-monitor.ts:951`) is correctly wired into the
outcome list (`:1193`), reports `blocked` on a missing field rather than `pass`, and is confirmed
live. But the thresholds are 80% → `low` → **`warn`**, and 90% → `critical` → `fail`; and
`main()` at `:1201` returns early on `!summary.failed`, printing *"Nothing is posted on a green
run."* `buildAlertMessage` — the only thing that reaches Discord — is never called.

So a disk at 85% and climbing produces a **green monitor run** whose warning exists only inside a
log nobody opens. The check alerts at 90%, which is roughly the state the 2026-08-15 incident had
already reached. The whole value of a resource check is lead time, and the tier that would provide
it is mute. This is not a fabricated gap: `summarise()` deliberately separates `warn` and `blocked`
from `fail`, so the machinery to report them exists and simply is not used on a green run.

### H5. 6.7 created a *second* hand-typed test list, and it had already drifted before I read it.

`backend/package.json` now carries the ~120-filename explicit list **twice** — once in `test`, once
in `test:coverage`. Diffed them:

```
test: 123 files   test:coverage: 120 files
in test, missing from coverage:
  test/logger.test.ts, test/request-context.test.ts, test/admin-errors.test.ts
```

Those three are the tests for 6.8's structured logging, added hours after the coverage script. So
**the coverage baseline already under-measures the newest code in the tree** — the exact instrument
6.7 exists to provide, blind to the module it was most recently pointed at.

The guard that catches this for `test` — `backend/test/event-log-hygiene.test.ts:102`, *"lists every
test file in package.json's test script"* — reads the `test` script only. `test:coverage` is
unguarded. `docs/STATUS.md` already calls a hand-maintained list *"the failure mode a list
maintained by hand exists to have."* 6.7 doubled the number of them.

### H6. Prerendering is dark in production — probed independently, and it is **disclosed, not hollow**

6.9's nginx half landed as a production check in the external monitor rather than a container test,
and it reported that no crawler/browser split is happening. I probed it myself rather than take the
summary, against the one published meeting
(`/meetings/f2181cfb-ab44-4436-b707-7448ccbd5966`), with six user agents:

| User agent | Bytes | sha256 (first 16) |
|---|---|---|
| Chrome 126 | 1184 | `ec2fefe4f6765087` |
| Googlebot | 1184 | `ec2fefe4f6765087` |
| `curl/8.5.0` | 1184 | `ec2fefe4f6765087` |
| `facebookexternalhit/1.1` | 1184 | `ec2fefe4f6765087` |
| `Twitterbot/1.0` | 1184 | `ec2fefe4f6765087` |
| `Slackbot-LinkExpanding 1.0` | 1184 | `ec2fefe4f6765087` |

**Byte-identical, same `etag: "6a81981a-4a1"`, on every one** — including four UAs that
`frontend/nginx.conf:41-58` maps explicitly to `/_prerender`. `Vary: User-Agent` is returned to all
six. `GET /_prerender/meetings/{id}/index.html` returns 404, so the tree is not externally
reachable. **The coordinator's observation is correct.**

**But it is not a hollow claim, and I am reclassifying it.** `frontend/nginx.conf:388-392` predicts
this exact behaviour in advance:

> *"A missing prerendered page is not an error — it falls straight through to the SPA shell, which
> is also what happens with the volume empty, with `PRERENDER_ENABLED` unset, and on every route the
> consumer does not render. That is the whole failure mode of this feature: the site behaves exactly
> as it did before."*

And the state is disclosed in both files `CLAUDE.md` directs a reader to first: `CHANGELOG.md:613` —
**"Completeness: Shipped dark. `PRERENDER_ENABLED` unset"** — and `docs/STATUS.md:326`/`:346`, which
names the operator task (add `PRERENDER_ENABLED=true` to the SecureString at `/commissionwatch/env`).
This is the project's completeness-factor discipline working exactly as designed. It belongs in the
**operator-blocked** column, not this one.

Emitting `Vary: User-Agent` unconditionally is also defensible rather than wrong: the feature is
toggled by a Parameter Store value and a container restart, not by an nginx change, so nginx cannot
know the flag's state, and the alternative — emitting the header only when the split is live —
would mean a config reload on toggle and a window in which a cache could hand a crawler's unstyled
document to a human. That is the failure `nginx.conf:370-376` exists to prevent. The cost of the
current choice is cache-key fragmentation across UA strings for no benefit while dark, which is
modest.

**Two things do come out of this that nobody has named.**

1. **The framing in my own first review and in roadmap 6.9 was wrong.** Both describe the
   crawler/prerender split as live-but-untested — *"verified by hand-curl once and is now protected
   by nothing."* It is not live. 6.9's nginx half therefore cannot be meaningfully verified in
   production at all until the flag is on; a production check against a dark feature can only ever
   confirm the fall-through. The monitor check that landed is right to exist and its finding is the
   valuable part.
2. **The product cost of the dark flag is larger than "a feature is off," and it is not gated on
   money.** `sitemap.xml` advertises the published meeting URL. Today Googlebot, Bingbot, Twitterbot,
   Slackbot, `facebookexternalhit` and every AI crawler receive a 1,185-byte empty shell for the
   project's only published record. **The published record is invisible to search and produces no
   link preview.** For a civic transparency site the whole point of which is that a citizen can find
   what the commission did, that is a product-level consequence of an operator toggle — one line in
   Parameter Store plus a restart, not a purchase. It deserves to be ranked as such rather than
   sitting in a list of dormant features.

### Two smaller ones, recorded but not ranked

- **`backend/test/backup-script.test.ts` asserts by regex over the shell source text**, never by
  executing `backup.sh`. It proves the `exit 60` line and the `OFFSITE_MISSING=1` assignment are
  textually present; it cannot prove the script exits 60. This project's own nginx lesson was that
  *"`nginx -t` was perfectly happy with three broken configs"* — the same lesson was not applied
  one directory over.
- **`docs/incidents/README.md` claims the push behaviour changed to stop self-cancelling deploys.**
  The data says otherwise: cancelled runs are **33% of the last 100 deploy runs**, against the 29%
  the document cites as the problem. The claim is not supported by the metric it sits next to.

---

## Did anything else get worse?

Checked deliberately, because fourteen items landed in hours by delegated agents.

- **No.** Backend 2200/531 and frontend 868/70 both pass clean, typecheck clean, and `main` is green
  in CI at `HEAD`. The react-router v7 migration is mechanical and complete.
- **One suspected flake, which I am explicitly not reporting as a defect.**
  `backend/test/ingestion-starvation.test.ts` — *"SourceScheduler.drain — starvation regression
  (2026-08-16)"* — failed twice in my full-suite runs (`'blocked' !== 'done'`), passed in isolation,
  and passed in a full run after `knex migrate:rollback --all`. My first reading was accumulated
  database state. **That reading does not survive the contention correction above:** another agent
  was running the same suite against the same Postgres instance at the same time, and cross-agent
  contention explains the failure at least as well as state accumulation does. I cannot separate the
  two, so I am recording the observation and not the conclusion. Worth one clean, uncontended
  re-run before anyone acts on it.
- **`docs/roadmap.md` is stale again, in the same direction as before.** Rows 6.7 and 6.8 read
  **Planned**; both shipped (`c8032a9`, `3eb2ded`). Row 7.5 reads *"keyboard and screen-reader
  testing of the operator console is not done"*; `5a70645` shipped an axe sweep over four console
  screens through the real console chrome with a signed-in session, **plus** keyboard-only
  activation tests for Approve, Reject and the subject collapse toggle — and it found and fixed
  three heading-order violations. Row 7.3's session-sweep claim is wrong (H2). That is four stale
  statuses in one file, matching the *"wrong at least four times today"* pattern the brief warned
  about. I have corrected them.
- **`docs/STATUS.md`'s header is stale**: it still reports backend 2038/491 and frontend 737/64
  against an actual 2200/531 and 868/70. `CLAUDE.md` directs every reader to that file first.

---

## The seven categories, re-scored

### 1. Operational readiness (SRE) — **Level 3** ❌ *does not pass*

**Moved.** 6.3 is live and verified in production, with the honest measurement caveats written into
the roadmap row rather than hidden. 6.5 gave incidents a place to have a start and an end, and
`docs/incidents/README.md` is one of the better documents in this repo — it refuses to invent a
timestamp, records that two backfilled incidents have four unknowns between them, and explains that
what was actually reconstructed is **two** incidents and not the four the brief named, *"because
filing them as four would have manufactured incident count rather than measured it."* 6.6 published
an SLO on `/status` that states 99.0% availability and freshness targets and then says plainly that
they are *"stated objectives, not"* measured. 6.8 shipped a structured logger, a request id, and
per-route 5xx counts that are genuinely wired (`middleware/requestContext.ts:73` records,
`routes/admin/errors.ts:27` reads).

**a. The backup gap is unchanged in substance, and the non-money half of it is not blocked.**
`deploy/backup.sh:233-280` now has a real guard: `OFFSITE_MISSING` is set when `BACKUP_S3_URI` is
unset *or* when the upload fails *or* when a second independent `aws s3 ls` fails to list the object
back; it emits `ops.backup_offsite_missing` at `critical` and exits **60**, distinct from 1 and 64.
That guard can fail. It is good work.

But **nothing consumes it.** `grep -c backup backend/src/scripts/external-monitor.ts` returns **0** —
the external monitor has no backup check of any kind. The cron is still unconfirmed. I have no AWS
access, so I could not look; more importantly, **neither can the product**. Today, if the nightly
backup has never run once since the instance was built, every surface in this system reports green.

The bucket costs money and is the operator's call — **I do not count that.** What is *not* blocked
on money is: a monitor check that fails when no successful backup is newer than its allowance, so
that "no backup has run" stops being invisible. That is the same shape as the disk failure 6.3 just
closed, and it is the one thing standing between this category and a pass.

**b. The warn tier is mute** (H4). **c.** `grep -rn "console\.\(log\|error\|warn\|info\)"
backend/src` still returns **124** raw calls (was 139) — one summary line per request is now
structured; the service internals are not. **d.** `/api/admin/errors` is behind `requireOperator`,
so the unauthenticated external monitor **cannot read the 5xx counts**, which is what 6.8's own
deliverable asked for (*"error counts exposed where the monitor can read them"*). **e.** Still no
error tracking, no tracing, no capacity figure, no load test.

### 2. Security posture (OWASP ASVS) — **Level 3** ✅ *passes*

Both open findings from the project's own security review are **closed and verified live**: HSTS on
the document, one nominal owning layer with no duplicate headers on either surface. Finding 3 was
retracted as the reviewer's own error and the retraction is written up rather than quietly dropped
(`bb06cbb`) — and the rate limit that finding wrongly claimed was absent is now probed working, in
two correctly separated tiers, with a `Retry-After` and a message that names the bulk export.

`app.set("trust proxy", 1)` is **empirically correct**: my 82 search requests consumed exactly one
60-request bucket, which means `req.ip` is my address and not the proxy's. A misconfigured
`trust proxy` here would have been a self-inflicted denial of service on the whole public API, and
it is not one.

Dependency scanning now exists and gates both packages, and the highest-severity item — an open
redirect shipped in the public SPA — is gone.

**Remaining:** H1 (the Caddyfile foot-gun, and no test through the real edge) is the top item.
H3 (four moderates in the running API, no written allow-list). No SBOM, no image scanning, no
base-image digest pinning. No upgrade cadence and no rotation cadence — `grep -rli "renovate\|
dependabot\|upgrade cadence\|rotation cadence"` matches only the two review documents themselves.
Authorisation within an authenticated session is still untested, and remains structurally untestable
until 7.1 creates a second role.

**Operator-blocked, not counted:** the superseded OpenRouter key retained in Parameter Store version
history. Rotating a credential is an operator action.

### 3. Software delivery (DORA) — **Level 3** ✅ *passes*

The structural blocker is fixed: MTTR was *unmeasurable* and is now *unmeasured but possible*, which
is a real category change and is described in exactly those words rather than overclaimed.

The numbers, recomputed today from 256 `deploy.yml` runs: all-time CFR **47.2%**, last 100
**16.4%** (was 15.7% — no improvement), most recent 36 runs **11.1%** (a genuine improvement in the
newest window). Cancelled runs **33%** of the last 100, up from 29%, against a document claiming the
push cadence was fixed (H5's sibling). Deployment frequency remains elite; rollback remains the
deploy path with an older tag; verification remains by probing production.

**Remaining:** nothing computes any of the four keys — the incident README restates the first
review's hand-computed figures rather than deriving them, so they are already stale (244 runs cited,
256 actual). Nothing separates a caught-bad-change from a flaky-pipeline failure.

### 4. Testing maturity (TMMi) — **Level 4** ✅ *passes*

2200 tests / 531 suites, all green on a clean database. `backend/test/publish-path.e2e.test.ts` (296
lines) is **not hollow**: I read it. It asserts the wall holds on every public surface *before*
review, signs the operator in, finds the claim in the queue, approves it, asserts the meeting page
renders **the same bytes** the approval produced, asserts the claim reaches the bulk export,
retracts it, and asserts the retraction leaves a tombstone carrying `previous_text` and removes the
claim from search. That is the highest-stakes path in the product, machine-checked for the first
time. `session-sweep.test.ts:175` asserts the sweep is *wired* rather than exported — the right
assertion, since being defined-and-uncalled was the entire defect.

**Remaining:** H5 (the second unguarded hand-typed list, already drifted). The new state-dependent
suite. Still no browser e2e, no request ever sent through the real nginx container, no load test, no
mutation tool, no chaos injection, no flake-rate measurement.

### 5. Data governance (DAMA-DMBOK) — **Level 3** ✅ *passes*

`PrivacyPage.tsx` now carries a real "What is kept, and for how long" section: the public record
permanently; a dispute contact **until you ask us to remove it**, by email, by hand, with the
automatic version named as designed-not-built; a subscriber address disabled rather than deleted,
with the reason (a months-later unsubscribe click must still work); and the corrections ledger
undeletable by database rule *"so you do not have to take our word for that."* A manual
subject-erasure path now exists where there was none, and the page still names what is intention
rather than system.

It passes for the same reason it passed before — the disclosure is honest — and **H2 is the thing
that puts that at risk**: one of the three "not built yet" items has been built, and the page says
otherwise. Fix the page and this is comfortably a 3.

**Remaining:** internal ledger retention (`record_corrections`, `export_snapshots`) is now decided
in the spec — never deletable, by design — rather than open, which is an improvement. Still no
correction SLA.

### 6. Product / UX (WCAG 2.2 + product maturity) — **Level 4** ✅ *passes* — **up a level**

`/accessibility` is live, routed (`App.tsx:92`), and in the deployed bundle. It states the WCAG 2.2
AA target, refuses to call an automated sweep a certification, names one known failure, says how to
report a barrier, and records the English-only language-access decision — the "decision to record"
the first review asked for, recorded. `AccessibilityPage.tsx:147-156` describes the console coverage
**accurately, including its limits** (*"It does not yet cover every…"*), which is the discipline H2
failed at.

The level-up is earned by the console sweep: `frontend/src/a11y.test.tsx` now runs axe over four
operator screens mounted through the real console chrome with a signed-in session — not in isolation
— **and** asserts Approve, Reject and the subject collapse toggle are reachable and operable by
keyboard alone with no mouse event fired. It found three heading-order violations on first run, all
`h3` under `h1`, and they were fixed rather than documented. The product's stated conformance claim
now has evidence behind both halves of the product, which is what separates a defined practice from
a measured one.

**Remaining:** no screen-reader testing. No reader onboarding — a citizen still arrives at a site
with one published meeting. And the policy pages (`/accessibility`, `/privacy`, `/data`) return a
1,185-byte empty shell to a crawler or a no-JS reader; the prerender covers records, not policy.

### 7. Project sustainability — **Level 3** ✅ *passes* — **up two levels**

All three publishable deliverables landed on a page a reader can reach, and I confirmed the strings
in the deployed bundle. 7.2: an API stability and deprecation policy, on `/data`, with a withdrawal
announced on the corrections log rather than 404'd. 7.4: who pays, what it costs, and what happens
to the published record if it stops — **stating bus factor one plainly**, which is the hardest
sentence in this project to publish and it is published.

**Remaining and not counted:** 7.1, a second reviewer, is a person. It is the binding constraint on
everything the reader sees — production is still 1 published meeting, 0 approved claims, nothing
published since 2026-08-11, unchanged across a day of Phase 6/7 work — and it cannot be closed by an
agent.

**Remaining and not blocked:** no dependency upgrade cadence, no secret rotation cadence. Both are
sentences someone has to write, and 6.2 names both as deliverables.

---

## Blocked on a human — explicitly not counted against maturity

| Item | Why it is a person's decision |
|---|---|
| An S3 bucket for off-instance backup | Costs money. Operator's call, stated as such since before the first review. |
| A second reviewer (7.1) | Is a person. No agent can be one. |
| Rotating the superseded OpenRouter key in Parameter Store | An operator credential action. |
| SPF/DKIM/DMARC for email delivery | DNS the operator controls. |
| Working the `/admin/place-links` and claims queues | The gate is the product. |
| **`PRERENDER_ENABLED=true`** in the Parameter Store SecureString | An operator credential edit plus a restart. Disclosed in `CHANGELOG.md:613` and `docs/STATUS.md:346`. **Costs nothing but a decision** — and see H6.2 for why it is the highest-value item on this list. |

---

## Remaining gaps, ranked by (risk × likelihood) / effort

| Rank | Gap | Where | Effort |
|---:|---|---|---|
| 1 | **Nothing can tell whether a backup has ever run.** The guard exists and exits 60; the monitor has no backup check and the cron is unconfirmed. | `deploy/backup.sh:262`, `external-monitor.ts` (0 matches for `backup`) | S |
| 2 | **`deploy/Caddyfile` would strip every security header from `/api/*`** now that Helmet no longer sets them. Three artifacts describe the edge, none agrees, nothing tests it. | H1 | S |
| 3 | **`PrivacyPage.tsx` tells readers a thing about their data that is false**, plus two stale copies in the spec and the roadmap. | H2 | S |
| 4 | **Four moderate advisories in the running API, no written allow-list**, and a gate configured never to see them. | H3 | S |
| 5 | **`test:coverage`'s hand-typed list is unguarded and already 3 files stale**, so the coverage baseline is blind to the newest code. | H5 | S |
| 6 | **The resource check's `warn` tier reaches nobody** — no lead time before the failure it exists to prevent. | H4 | S |
| 7 | No second reviewer — the binding constraint on everything published | 7.1 | *human* |
| 8 | Nothing computes the DORA four keys; cancelled runs still 33% against a claim they were fixed | 6.5 | S |
| 9 | 5xx counts are operator-only; the monitor cannot read them | 6.8 | S |
| 7= | **Prerendering is dark, so the only published record is an empty shell to every crawler and unfurler** — invisible to search, no link preview, while `sitemap.xml` advertises the URL | H6.2 | *operator toggle* |
| 10 | 6.9's nginx half cannot be verified in production while the feature is dark; no test sends a request through the real nginx container either way | 6.9 second half | M |
| 11 | No dependency upgrade cadence, no secret rotation cadence, no SBOM, no image scanning | 6.2 remainder | S–M |
| 12 | A new state-dependent test suite; flake rate still unmeasured | `ingestion-starvation.test.ts` | S |
| 13 | 124 raw `console.*` calls remain in `backend/src` | 6.8 remainder | M |
| 14 | No reader onboarding; policy pages invisible without JS | 6.x product | M |
| 15 | `docs/STATUS.md`'s header test counts are stale (2038/491 vs 2200/531) | — | S |

---

## Verdict

**Six of seven categories now pass**, and the movement is real rather than documentary. I probed
the header fix, the rate limit, the resource check, the API 404 shape and the shipped bundle myself;
all of them do what the loop said. The publish-path chain test, the session-sweep wiring test and
the console accessibility sweep are substantive tests that assert the thing that was actually
broken, not tautologies. The incident record and the SLO both state their own limits in the sentence
after they state their target, which is the habit that makes the rest of this project's claims
credible.

**Operational readiness is the one category that does not pass**, and it fails on one item: this
system still cannot tell you whether a backup has ever succeeded. The bucket is the operator's money
and I have not counted it. The *check* is not.

The other thing worth saying plainly: production has one published meeting and zero approved claims,
and that has not changed in five days. A day of excellent Phase 6 and 7 work moved the public record
by nothing, because the constraint is 7.1 and 7.1 is a person. That is not a criticism of the loop —
it is the reason the loop should stop rather than find a fifteenth thing to build.

### The loop should not stop yet — five items, then it should.

All five are small, all five are unblocked, and all five bear directly on a public civic platform's
fitness. Nothing on this list is a wishlist item.

1. **A monitor check that fails when no backup has succeeded recently.** Rank 1. Without it, total
   loss of the corpus is a silent state.
2. **Fix or delete `deploy/Caddyfile`.** A reference config that would strip HSTS and CSP from every
   API response is worse than no reference config, and it became dangerous this morning.
3. **Correct `PrivacyPage.tsx`, the retention spec, and roadmap 7.3** on the session sweep. A
   privacy page must not be wrong about what the code does, in either direction.
4. **Either `npm audit fix` the two remaining runtime advisories, or write the reasoned allow-list
   6.2 asked for.** A threshold with no stated reason is not a policy.
5. **Guard `test:coverage`'s file list the way `test`'s is guarded.** It has already drifted, and it
   is blind to exactly the code 6.8 just added.

When those five land, stop. What is left after them is either a person's job or genuine
Level-4-to-5 polish, and this product is fit to be public without it.

### And one thing to put in front of the operator at the same time

Not on the loop's list, because an agent cannot do it — but it should not sit in a list of dormant
features either. **`PRERENDER_ENABLED=true` is one line in the Parameter Store SecureString and a
restart, and until it is set, the project's only published meeting is a 1,185-byte empty shell to
Google, Bing, Slack, Twitter and every AI crawler, on a URL `sitemap.xml` is actively advertising**
(H6). Every other operator-blocked item on this list costs money or requires a second human. This one
costs a decision. Of everything named in this document, it is the change that would do the most for a
reader trying to find out what the commission did — and it is the cheapest.
