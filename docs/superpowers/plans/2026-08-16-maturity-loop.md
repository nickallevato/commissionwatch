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
- **08:13Z** — Maturity review returned and is committed. **PASS**: testing (L4), data governance (L3),
  product/UX (L3). **FAIL**: operational readiness (L2), security (L2), delivery (L2),
  sustainability (L1). Phases 6 and 7 added to hold operations, security, retention and
  stewardship — the structural finding being that all five existing phases were feature phases, so
  this work had nowhere to live and was untracked rather than undone.

  Verified the top finding myself rather than taking it: `npm audit --omit=dev` confirms 3 moderate
  in the frontend (`react-router`, exercised on every public page) and 6 in the backend (`resend` →
  `svix` → `uuid`, shipped but dormant). The production-only lens matters — a build-time advisory
  does not reach a reader.

  **Two agents dispatched, disjoint by package:** frontend takes the shipping router advisory plus a
  Gitea audit step; backend/deploy takes the off-instance backup leg. No shared file, no shared test
  list.

  **Decision made and recorded:** the CI audit gate runs `--omit=dev --audit-level=high`. Failing on
  build-time moderates would train everyone to ignore the check, and a gate people route around is
  worse than no gate. The current moderates are being fixed rather than tolerated.
- **08:20Z** — Tick one minute after dispatch; both agent slots full, nothing to verify. Did **not**
  run the frontend suite: `package.json` and the lock were mid-upgrade, and a suite run against a
  half-installed tree measures nothing.

  **Found a problem of my own making.** Production is on `f50d65e` while head is `944e8d1`, so the
  dark theme and the review-queue rebuild are committed, verified and **not live**. Four of the last
  eight CI runs are `cancelled`: pushing after every commit means each push kills the previous
  deploy. A verified commit that never reaches production is worth nothing, and I had been treating
  the push as the finish line.

  **Decision: batch pushes.** Hold until the in-flight run for `af09468` lands, then push the
  accumulated commits as one. Push at verified milestones, not per commit.

  Also noted for later: a remote branch `fix/operator-guard-public-writes` exists at `7373488` that
  this loop did not create. Not touched; recorded so it is not mistaken for mine.
- **08:28Z** — Frontend advisory work verified myself: **829 tests / 69 files**, typecheck lint build
  clean. Committed `0b4f0ed`.

  **The agent found a ceiling and stopped, correctly.** `react-router-dom@6.30.4` is the *last* v6
  release, and all three advisories against it are fixed only in 7.13.0+. Verified independently:
  `npm view react-router-dom@6 version` → 6.30.4, latest → 7.18.2. So the v6 line can never clear
  this, and the agent was right to refuse a framework migration on its own initiative.

  **Decision, mine: migrate to v7.** An open redirect on a site whose value is being trustworthy
  about the public record is worse than its moderate CVSS — a link that looks like our domain and
  lands on a phishing page damages precisely what this project sells. And the migration is
  incremental: the suite already emits `v7_startTransition` and `v7_relativeSplatPath` warnings, so
  the codebase is already being told the deltas. Dispatched in **two verifiable steps** — future
  flags on v6 first, then the version bump — so a behaviour change is never confounded with a
  version change.

  Instructed it to mutation-verify a broken `Navigate` redirect specifically. `/anomalies` →
  `/findings` and `/members` → `/officials` exist because public URLs were renamed; a silently
  broken redirect there is a broken published URL, and if no test catches it that missing guard
  matters more than the migration.
- **08:38Z** — Two Phase 6 items verified and committed. Held push released once CI caught up:
  `af09468` went green and live, which confirmed the batching decision was right.

  **6.1 backup** (`2f41349`): verified backend **2134 / 516**, `bash -n` clean. The agent chose both
  a critical ops event *and* a non-zero exit rather than one, with the right reasoning — a bare log
  line was the original design and is exactly what let this sit unnoticed, so a warning alone is a
  disproven hypothesis here, not an untested one. Spot-checked myself that no credential is echoed
  and that the upload verifies with an independent `aws s3 ls` read-back rather than trusting `cp`.

  **6.2 → v7 migration** (`ff528f9`): verified frontend **829 / 69** and, independently,
  `npm audit --omit=dev` → **0 vulnerabilities**, tree resolving to a single `react-router@7.18.2`.
  Sixty-seven files moved their import. Step one, the future flags on v6, broke **nothing** — which
  is the useful result, because it means the two flags were the entire behavioural delta and the
  version bump carried no hidden one.

  The mutation that mattered was the redirect, not the upgrade: `/anomalies` → `/findings` and
  `/members` → `/officials` exist because public URLs were renamed, so a broken one is a broken
  *published* URL. Pointing it wrong fails exactly one named test, so that guard is real.

  Dispatched **6.10** (rate limit + cache on `/api/search`) to the free backend slot. **I set the
  numbers rather than asking**: 60/min per client and `max-age=60`. A reader searching hard does ~10
  a minute, and the limit sits deliberately above what a scripted client needs so it nudges bulk
  users toward `/api/data/*.csv` instead of punishing them. On a transparency site a limit set too
  low is its own failure.
- **08:39Z** — Tree clean of my own work; head `b8a9015` matches `origin/main`, deploy in flight for
  the v7 and backup commits. Backend agent is mid-6.10 (three files touched) so I ran **no** backend
  suite this tick — measuring a tree someone is editing produces a number that means nothing either
  way.

  Filled the free frontend slot with **7.2 + 7.4** rather than the higher-risk 6.9. Reasoning, since
  it departs from strict risk-ranking: 6.9 is an end-to-end browser test of the review→publish path
  and would need the test database, which the backend agent is currently using — two agents
  contending for one Postgres is how a suite starts failing for reasons that have nothing to do with
  the code. 6.9 goes to the backend slot when it frees.

  **Policy decisions made, not delegated.** The agent is writing up decisions I made: two stability
  tiers with experimental surfaces obliged to say so; a withdrawal announced on the corrections log
  rather than 404'd, because withdrawing data people depend on is the same category of act as
  changing a published claim; 90 days' notice; additive changes explicitly not breaking so the
  policy cannot be used to block ordinary work; and bus factor stated as **one** rather than implied
  away by writing "we". The parity matrix supplies the reason this is urgent — ProPublica's Congress
  API is dead and Open States has been absorbed into commercial Plural. A newsroom and a flagship
  civic-data project both failed to keep a public API alive, and this project invites people to
  build on four.
- **08:52Z** — Both agents landed; verified each myself. Backend **2142**, frontend **836**, both
  clean on typecheck, lint and build.

  **6.10 corrected a mistake of mine rather than fixing what I said was broken.** `/api/search` was
  already rate limited — `app.ts:97` applies `publicRateLimit` globally, 60/min on the expensive
  tier, added in `ad83ffa` before my review existed. I got there two wrong ways at once: I grepped
  `FixedWindowLimiter`, the class, when the caller is `publicRateLimit`; and I fired **twelve**
  requests at a **sixty**-per-minute ceiling and read twelve 200s as "unthrottled". That is a
  negative result from a test with no power to find the thing.

  The security review now carries the correction in place. **A review that reports a defence as
  absent invites someone to build it twice and discredits the true findings beside it**, so it is
  corrected loudly rather than quietly edited. What was genuinely missing — caching, env
  configurability, and a 429 that points at the bulk export — is built.

  **Lesson adopted:** when a probe finds nothing, check the probe had the power to find it. Twelve
  against sixty could never have.

  7.2/7.4 landed on `/data`, not duplicated onto `/bot`, and the agent's reasoning was better than
  my brief: `/bot` links to `/data` for terms by convention, and a second hand-kept copy would be
  the drift failure that page's own docblock warns about.
- **08:53Z** — Both slots free at tick; dispatched **6.4** (code) and **6.5 + 6.6** (docs only).
  Deliberately did **not** dispatch 6.9, the end-to-end review→publish test, for the second tick
  running: it needs the database, and so does 6.4's suite. Two agents contending for one Postgres
  produces failures that have nothing to do with the code. 6.9 gets a slot to itself.

  **Cheap disproof paid off on 6.4.** I had told the operator I would not touch edge config without
  seeing it — but `deploy/Caddyfile` is *in the repo*, and grepping it settled the question I had
  been guessing at: **Caddy sets no security headers at all.** The two sources are
  `frontend/nginx.conf` and the backend's Helmet. Nothing about that needed the operator.

  **Decision, and it reverses what I said earlier today.** I had recommended Helmet as the single
  owner because it travels with the code and is testable. That was wrong: nginx serves the HTML
  document and Helmet never sees a request for `/`, so Helmet **cannot** fix the missing HSTS at any
  configuration. An owner that cannot cover the whole surface is not an owner. **nginx owns the
  headers.**

  Flagged the `add_header` merge trap to the agent explicitly — `nginx.conf` already carries a
  comment saying a `location` declaring any `add_header` discards every inherited one, which is why
  the file repeats itself. That is the regression most likely to pass review silently.
- **09:13Z** — **Verification caught what the agent's own report missed.** The 6.4 agent reported
  "2144 tests, 520 suites, 0 failures". My run: **2143 pass, 1 fail** — `sitemap.test.ts`, *"these
  public pages are offered to no crawler and no reason is recorded: /accessibility"*.

  Not the header agent's fault, and not a flake. The **other** agent, running concurrently, added
  `/accessibility` to `App.tsx`, and a backend guard reads the frontend router and requires every
  public page to be either offered in the sitemap or excluded with a written reason. The header
  agent ran its suite before that route existed; its report was true when it was made and false by
  the time I read it.

  **This is the concrete argument for never delegating verification.** Two agents each correct in
  isolation produced a red tree between them, and only a run taken *after both* could see it. The
  rule was justified by principle before; it is justified by evidence now.

  The failure is also a good one: the guard names the exact path and demands a reason rather than
  silently omitting a page. Dispatched the fix — **offer it**, because an accessibility statement
  search engines cannot index is close to useless, given the people most likely to need it are the
  ones searching for it.

  Frontend verified independently at **853 / 70**.
- **09:22Z** — Tree clean, no agents pending. Header fix committed but **not deployed** (live
  `21391e2`, head `6db1d09`), so the production `curl` I owe on 6.4 is still owed. Recording it
  rather than letting it quietly lapse: a config change verified only as text is not verified.

  **Scoped 6.9 down, deliberately, and did not mark it done.** The roadmap asks for a browser test
  covering the review→publish chain *and* the nginx crawler/prerender `Vary: User-Agent` split.
  Those need different tools. The chain is drivable over HTTP against the real app and database
  today; the prerender half genuinely needs nginx in the request path, which no test here has. So
  the chain gets built now and the nginx half stays **open with its reason named**. Splitting a
  roadmap item is honest; marking it done because the achievable half shipped is not.

  The instruction that matters in that brief: assert the wall **before** approval, on more than one
  public surface. A test that only checks a claim appears after approval would pass against a system
  that publishes everything.

  Second slot took 7.3 plus a **roadmap accuracy pass**, because the roadmap has drifted again
  during today's own work — 6.10 still reads "blocked on an operator decision" when I made the
  decision and it shipped, and its description still repeats my false unthrottled claim. Told the
  agent to check every status against the tree and to say plainly if it finds something I marked
  done that is not. That finding would be worth more than the retention policy.
- **09:27Z** — Docs slot landed (`be3baa8`) and **found two of my own errors**, which is why it was
  told not to take my word. 6.2 was marked wholly Planned while a frontend audit gate had already
  shipped in `0b4f0ed` — my own work, three hours old, under-reported. And 7.5 is **Partially** done,
  not Done: the accessibility page shipped but the operator console's keyboard and screen-reader
  testing does not exist, and the axe sweep covers public routes only. I would have marked that done.

  **New defect, verified independently:** `sweepExpiredSessions()` at `operators.ts:297` is called by
  nothing — the only occurrence in the tree is its own definition. Expired operator sessions
  accumulate forever. Not an auth bypass, since validity is checked at use, but a method somebody
  wrote intending it to run. Backend slot next tick.

  Also corrected a figure this project has repeated, including by me: `record_corrections` at 14,528
  rows is **test-database fixture growth, not production**.

  **The 6.4 debt is now measured rather than asserted.** Live is still `21391e2`, and against it the
  document returns **0** HSTS headers and `/api/health` returns **2** `X-Frame-Options` — precisely
  the defect the fix targets, confirmed present pre-deploy. Run 29289 for `6db1d09` carries the fix
  and is in flight. **I am holding the push of `be3baa8`** rather than cancelling it, which is the
  mistake diagnosed at 08:20.

  6.9's agent stalled on a backgrounded test run — the third agent today to do that. Resumed with
  foreground-only instructions and a specific ask: if breaking the publication wall does **not** fail
  its test, say so, because that finding would matter more than the test.
- **09:40Z** — Spent this tick diagnosing, and the finding is an environmental one worth keeping.

  6.9's agent stalled four times "waiting for a test run". It was not a tooling habit: its own first
  run never exited, every retry contended with it, and underneath both sat a **zombie
  `test/feeds.test.ts` process running for 113,043 seconds — 31 hours** — from a session before
  today, holding a database connection the whole time. Killed all of them, precisely by PID rather
  than `pkill -f`, which cost me a running poll earlier today.

  **My own measurement was also wrong for two attempts.** I piped the run to `grep`, so when
  `timeout` killed it the buffered output was discarded and I read "no output" as "hangs before
  producing anything". Writing to a file first showed the real error immediately:
  `duplicate key value violates unique constraint "artifacts_sha256_unique"`. A killed run had never
  reached `after()`, so its artifact row survived and poisoned every later run. Cleared it, and the
  test **passed at once — exit 0**.

  **Two real defects fell out**, both sent back: the suite is not idempotent, so one crashed run
  poisons all future runs while the error points at a constraint rather than the cause; and a failed
  `before()` leaves the pool undestroyed, so a broken fixture presents as a hang instead of a failure
  in seconds. That second one is why four stalls looked like agent behaviour and were not.

  The work is genuinely incomplete — 2 `it` blocks against a 7-step chain — so it is **not**
  committed. Approve, public visibility, and the retraction half are all still missing, and the wall
  mutation has still never been run.
- **09:50Z** — **The 6.4 debt is paid, and paid with a measurement.** `6db1d09` deployed, so the
  production `curl` I have been carrying since 09:22 finally ran. Findings 1 and 2 are closed:

  | | Before | After |
  |---|---|---|
  | HSTS on `GET /` | absent | `max-age=31536000` |
  | `X-Frame-Options` on `/api/health` | **2** (`SAMEORIGIN` + `DENY`) | **1** (`DENY`) |

  All six security headers are singular on both the document and the API. **One duplicate remains
  and is deliberate** — two `Server` headers, because stock `nginx:alpine` has no headers-more
  module. Version disclosure, not a control; recorded rather than dropped.

  This is the check no test in the repo could perform. `nginx-headers.test.ts` reads the config as
  text and `security-headers.test.ts` reads Express's own output, and **neither can see the merged
  response a real client gets**. Carrying that debt for three ticks instead of calling the commit
  done was the right call.

  Process hygiene: **0** stale test processes now, against the 31-hour zombie found last tick.

  Free slot took the `sweepExpiredSessions()` defect. Told the agent the honest severity up front —
  **not** an auth bypass, since validity is checked at use — so it builds proportionate disclosure
  rather than an alarm. The test that matters is the one asserting the sweep is *wired*, not merely
  exported: being defined and uncalled is the entire bug, and a test of the function alone would
  have passed against today's broken state.
