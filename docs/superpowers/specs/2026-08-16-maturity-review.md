# Maturity review — CommissionWatch against industry frameworks, 2026-08-16

**What this is.** An assessment of the project against named, recognised maturity frameworks —
SRE/operational readiness, OWASP ASVS, DORA, TMMi-style testing maturity, DAMA-style data
governance, WCAG/product maturity, and open-source sustainability — rather than against a rubric
invented for the occasion. The artefact under review is `docs/roadmap.md`, including the
*Gaps this roadmap does not name* section added earlier today.

**Method.** Every finding below cites a file, a command I ran, or a live probe against production.
Where the roadmap or `docs/STATUS.md` already names something, I say so and credit it rather than
re-filing it. Where something is **refused on principle**, I say so and do **not** file it as a gap.

**The structural finding, before the categories.** `docs/roadmap.md` has five phases and every one
of them is a *feature* phase. There is no phase, section or line item anywhere in it for operations,
security, data retention, or sustainability. The project does a great deal of this work — it is
simply recorded in `docs/STATUS.md` prose, in `deploy/README.md`, and in commit messages, where it
has no status, no owner and no sequence. **Roughly half the findings in this document are not
"nobody did the work"; they are "the work has no place to be tracked."** That is why the deliverable
is two new phases rather than a list of tasks.

---

## Summary of levels

| # | Category | Framework | Level (1–5) | Verdict |
|---|---|---|---:|---|
| 1 | Operational readiness | SRE / Google SRE workbook | **2** | **Does not pass** |
| 2 | Security posture | OWASP ASVS | **2** | **Does not pass** |
| 3 | Software delivery | DORA four keys | **2** | **Does not pass** |
| 4 | Testing maturity | TMMi | **4** | **Passes** |
| 5 | Data governance | DAMA-DMBOK | **3** | **Passes, conditionally** |
| 6 | Product / UX | WCAG 2.2 + product maturity | **3** | **Passes** |
| 7 | Project sustainability | CHAOSS / OSS stewardship | **1** | **Does not pass** |

Levels are the conventional five-point scale: 1 initial/ad-hoc, 2 repeatable, 3 defined, 4 measured,
5 optimising.

---

## 1. Operational readiness (SRE) — **Level 2**

### What is genuinely strong

- **The monitor is out-of-process, and the reasoning for that is written down.**
  `.gitea/workflows/monitor.yml` lines 6–17 record the 2026-08-09 four-hour 502, where every
  in-application health surface was served by the process that was down. A watch inside the process
  can only report while the process is alive. This is the correct conclusion and most projects never
  reach it.
- **The monitor is actually running, on a 15-minute tick, and `docs/STATUS.md` is stale in saying it
  is not.** Queried the Gitea API today: monitor runs 29214, 29219, 29224, 29228, 29233, 29239,
  29244, 29249 land at 00:00, 00:15, 00:30, 00:45, 01:00, 01:15, 01:30, 01:45 local, with the most
  recent at 02:06. 580 successful monitor runs total. `docs/STATUS.md:2411` still calls installing
  that clock "the operator task". **It is done.**
- **A restore drill exists and has been executed.** `deploy/restore-drill.sh` restores into a scratch
  database on the running instance and compares row counts; `docs/STATUS.md:2402` records the result
  — 28 tables, 137 rows, no losses, 11 objects. *A backup nobody has restored is a hypothesis* is the
  script's own opening comment. This is above the industry norm, not at it.
- **Rollback is the deploy path with an older tag** (`deploy/deploy-aws-ssm.sh:37`), so the rollback
  procedure is the procedure that runs daily rather than one nobody has exercised.
- **The deploy asserts the deployed sha**, not merely that containers started — `EXPECT_SHA` in
  `deploy.yml:454`, plus the external monitor re-run against the new commit with a settle policy
  (`deploy.yml:525–550`). The 2026-08-10 fix for `docker compose up -d --wait` treating a
  healthcheck-less service as ready is exactly the class of defect this closes.
- **`blocked` is a first-class check state**, distinct from pass and fail (0.5.0). A check that cannot
  determine an answer does not report success.

### What is missing

**a. Backups never leave the instance, and it is not confirmed that any backup runs at all.**
`deploy/backup.sh:34–36` — `BACKUP_S3_URI` "left unset by default"; `deploy/README.md:293` — "while
it is unset the archive never leaves the instance"; `docs/STATUS.md:2404–2406` — "an archive
currently never leaves the instance — that is a copy, not a backup. … The cron entry also still has
to be installed on the host." Database, MinIO object store, and every backup archive are on one
t4g.medium. Instance loss is total loss of the corpus and of every operator decision recorded against
it. The blocker is stated as cost, which makes this the point where the sustainability gap (§7)
becomes an availability gap. **Highest-ranked finding in this document.**

**b. There is no SLO and no error budget.** `grep -rn -i "\bSLO\b|error budget|uptime target|99\.9"`
across `docs/`, `deploy/`, `README.md` and `.gitea/workflows/` returns **zero hits**. Nothing defines
what "up" means for this site, so nothing can say whether the 2026-08-09 outage was a breach, and
there is no basis for deciding how much reliability work is enough. For a site whose product claim is
*we are watching* — and whose own `SECURITY.md` lists "denial of collection" as a vulnerability class
— an availability objective is a product statement, not an ops nicety.

**c. No structured logging, no error tracking, no tracing.** Neither `backend/package.json` nor
`frontend/package.json` contains `pino`, `winston`, `sentry`, `opentelemetry`, `prom-client` or
`datadog`. `backend/src` holds **139** raw `console.log/error/warn` calls. Diagnosing a production
500 means SSM-ing a `docker logs` and reading unstructured text. There is no way to answer "how many
500s did we serve yesterday, and on which route."

**d. The monitor checks liveness, not resources — and the resource failure has already happened.**
The external monitor checks HTTP reachability, database connectivity, sha agreement between
`/api/version` and `/version.json`, release drift, and ingestion staleness. It does **not** check disk,
memory, or database size. On 2026-08-15 the deploy host filled its disk; the release failed, the site
stayed up, and **nothing alerted** — `docs/STATUS.md:165–167` records exactly this: *"A green check
suite plus a healthy site does not mean the release deployed."* The lesson was recorded; no check was
added. `record_corrections` at 14,528 rows and growing (0.5.0) is the same shape arriving again.

**e. There is no incident record.** Two real incidents exist as prose in `docs/STATUS.md` — the
4-hour 502 and the disk exhaustion — with no structured start time, end time, detection method or
resolution. There is no postmortem template and no incident log. This is what makes MTTR unmeasurable
in §3, and it is what makes "were we better this quarter than last" unanswerable.

**f. No capacity planning.** The security review's finding 3 explicitly labels itself as *reasoned
from the code path and the host's documented sizing, not from a measured degradation* and says it
"should not be cited as a measured limit". There is no load test and no headroom figure for a 4 GB
host shared with Caddy, Postgres and four other product stacks.

**Not gaps.** No on-call rotation and no paging: there is one operator, and a pager for a team of one
whose failure signal is already a red Gitea run and a Discord webhook would be ceremony. Recorded as
a deliberate scope decision, not a deficiency.

---

## 2. Security posture (OWASP ASVS) — **Level 2**

### What is genuinely strong

- **`SECURITY.md` is a real threat model, and a domain-specific one.** It names *publishing without
  review*, *forging the record*, *denial of collection*, *reader PII enumeration* and *SSRF via
  delivery channels* as vulnerability classes, and — unusually — states what is explicitly **not** a
  vulnerability (the open read API, published findings naming officials, infrastructure identifiers in
  `deploy/`). Most commercial products do not have this. It is better than a STRIDE table.
- **The security review of 2026-08-16 probed production rather than asserting.** It states its own
  limits — no authenticated testing, no dependency audit, no load testing, no ingestion-path pentest —
  which is what makes the rest of it trustworthy.
- **Verified sound in that review, and I did not re-litigate:** CORS not exploitable (probed both
  ways), no stack traces in errors, correct session cookie flags with the reasoning in a comment, no
  account enumeration on sign-in, strict CSP (`script-src 'self'`, `object-src 'none'`, no
  `unsafe-eval`), no secret ever committed across the full history.
- **Secrets never enter an SSM payload, and CI enforces it.** `deploy/test-deploy-aws-ssm.sh` runs as
  the `ci-deploy-script` job with the security property stated in the workflow comment
  (`deploy.yml:161–164`): `send-command` parameters are retained in plaintext for 30 days and land in
  CloudTrail on a host shared with seven other products.
- **An audit trail exists for operator decisions** — migration `071_create_operator_actions.ts`, and
  every review decision appends a `record_corrections` row in the same transaction as the update.
- **Unauthenticated public writes were found and closed** (2026-08-14), including the one that could
  have published a finding naming a living official under the project's byline.

### What is missing

**a. There is no dependency or CVE scanning anywhere, and there are real CVEs today.**
`grep -ril "npm audit\|dependabot\|renovate\|snyk\|trivy\|syft\|sbom\|cyclonedx\|osv-scanner"` across
every `.yml`, `.json`, `.md`, `.sh` and `.ts` in the repository returns **exactly one file** — the
security review spec, saying the audit was not run. I ran it:

| Package | Result |
|---|---|
| `backend` | **9 vulnerabilities — 2 low, 4 moderate, 3 high** |
| `frontend` | **15 vulnerabilities — 1 low, 6 moderate, 7 high, 1 critical** |

The honest reading, because inflating this would make the next one harder to see: **most are
build-time only** — `esbuild`/`vite` dev-server issues, `postcss` source-map path traversal,
`@babel/core` arbitrary file read, `brace-expansion` DoS via `eslint`/`glob`. Those matter for a
developer machine and for CI, not for a visitor. But three are **runtime dependencies of shipped
code**:

- `@remix-run/router` → `react-router-dom` — **open redirect via protocol-relative URL**
  (GHSA-2j2x-hqr9-3h42). Shipped in the SPA bundle serving the public site.
- `qs` — remotely triggerable DoS in `qs.stringify` (GHSA-q8mj-m7cp-5q26). Express dependency.
- `body-parser` — DoS where an invalid limit silently disables size enforcement
  (GHSA-v422-hmwv-36x6). Express dependency.

`npm audit fix` is offered as available for all of them. **The finding is not "these three CVEs" —
it is that nobody would have known.** Nothing in CI runs an audit, no bot opens upgrade PRs, and the
next set will arrive equally unseen. On a project that asks readers to trust what it publishes about
named people, an unmonitored dependency tree is a credibility risk as much as a technical one.

**b. No supply-chain controls.** No SBOM is generated, ECR images are not scanned, and nothing signs
or verifies the images the host pulls. The deploy pins by sha tag (good), but sha-pinning proves
*which* image, not *what is in it*. There is no provenance attestation and no base-image update policy
— `node:22-bookworm` is pulled fresh on every CI job with no pinned digest.

**c. Secret rotation is a documented procedure with no cadence, and one known-superseded key is
still un-rotated.** `deploy/README.md:244` and `docs/STATUS.md:2348` describe *how* to rotate;
nothing states *when*, and no expiry is tracked. `docs/STATUS.md:2565` records that a superseded
OpenRouter key was written to `/commissionwatch/env` before replacement and **Parameter Store retains
prior versions** — so a live-in-history credential is outstanding, filed only as item 0c in a
STATUS list and on no roadmap.

**d. Two of the three findings from this project's own security review are unfixed and unscheduled.**
Verified against production today:

```
$ curl -sI https://commissionwatch.bmux.sh/
server: Caddy
server: nginx/1.31.3
(no strict-transport-security)
```

HSTS is still absent on the HTML document (finding 2), and two layers still both answer with security
headers and nobody owns the result (finding 1). Finding 3 — `/api/search` unthrottled and uncached —
is deliberately deferred to an operator's judgement about a rate-limit number, which is correct; but
"deferred to the operator" is not the same as "scheduled", and it has no due date.

**e. Authorisation within an authenticated operator session has never been tested**, by the security
review's own admission. There is no test that an operator session cannot reach a route it should not,
because there is one operator class and therefore nothing to separate — which is a reason it has been
low-risk so far, and the exact reason it will bite the day a second role appears (§7's second
reviewer).

**Not gaps.** No bug bounty (stated and reasoned in `SECURITY.md`). No WAF or managed anti-bot layer
(forbidden by the project's own scraping-conduct line, and a WAF in front of an open-data API is
mostly a way to block researchers). No MFA on the operator account — worth an operator decision, but
with one account seeded from Parameter Store and no registration route, it is a smaller gap than it
looks; recorded here rather than filed.

---

## 3. Software delivery (DORA) — **Level 2**

The task asks which of the four keys this project can measure *today*. I computed them from the Gitea
Actions API rather than estimating.

| DORA key | Measurable today? | Value, measured |
|---|---|---|
| **Deployment frequency** | **Yes** | 244 `deploy.yml` runs on `push`; 88 concluded `success`. 45 commits on 2026-08-16 alone, 84 on 2026-08-15. **Elite band on frequency.** |
| **Change failure rate** | **Yes** | All-time: **84 failures / 172 concluded** (excluding 71 `cancelled`) = **48.8%**. Last 100 deploy runs: **11 / 70 concluded = 15.7%**. DORA elite is 0–5%, high 10–15%. **This project sits at the medium band on its best recent window.** |
| **Lead time for changes** | **Partially** | Computable from commit time → deploy run completion, but nothing computes it, and 71 `cancelled` runs (the workflow's concurrency group superseding a run) mean many commits never deploy individually — so the naive per-commit figure would be wrong. |
| **Mean time to restore** | **No** | There is no incident record anywhere with a start and an end. The 2026-08-09 four-hour outage and the 2026-08-15 disk exhaustion exist only as prose. **MTTR cannot be computed and therefore cannot be improved.** |

### What is genuinely strong

- **Trunk-based, fully automated, every push to `main` deploys.** No manual gate, no release branch,
  no change-approval board — the configurations DORA associates with elite performance.
- **The pipeline's failure modes are documented in the pipeline itself.** `deploy.yml` carries about
  180 lines of comment recording traps that each cost a red build once: an unset Gitea variable
  rendering as its own *name* rather than empty (runs 28290, 28306), `AWS_PAGER` stalling every call
  on `less(1)`, `--platform linux/arm64` because the host is Graviton, `actions/checkout` needing
  `node` inside the job container. This is unusually good institutional memory.
- **A failed deploy leaves the previous version serving** — verified by the 2026-08-15 disk incident,
  where the pull failed before anything replaced the running containers.
- **Verification is by probing production, not by CI going green.** `curl /api/version` is stated
  repeatedly as the only check worth trusting, and `docs/STATUS.md` records that both a green pipeline
  and an agent's claim have lied in this project.

### What is missing

**a. Nothing computes any of the four keys.** All the data exists in the Gitea API — I extracted three
of them in one query — and no dashboard, script or test reads it. A 15.7% change failure rate is
information the project would act on if it could see it.

**b. The 48.8% all-time change failure rate is not analysed.** Some of those 84 failures are
infrastructure (missing secrets, the disk); some are real test failures caught correctly. Nothing
separates them, so nothing distinguishes "the pipeline caught a bad change" — which is the pipeline
working — from "the pipeline is unreliable", which erodes trust in red builds. That distinction is
the whole value of the metric.

**c. `cancelled` is 29% of recent deploy runs** and is currently interpreted by hand each time
(`docs/STATUS.md:250` explains it as the concurrency group superseding a run). Nothing asserts that
interpretation, so a genuinely cancelled-because-broken run reads identically to a superseded one.

---

## 4. Testing maturity (TMMi) — **Level 4** ✅

**This is the strongest category by a wide margin, and the roadmap does not claim credit for it.**

### What is genuinely strong

- **Volume with structure**: backend **2038 tests / 491 suites**, frontend **737 / 64**, both
  typecheck- and build-clean (`docs/STATUS.md:6–7`).
- **Contract tests against captured real fixtures**, each fixture directory carrying its own
  `PROVENANCE.md` (`backend/test/fixtures/bozeman-granicus/`, `backend/test/fixtures/mt-cers/`). This
  is the right answer for adapters against third-party HTML.
- **Guards are mutation-verified in both directions**, as a stated project rule — a guard must be
  *seen* to fail when the thing it guards is broken. `feature-registry-audit.test.ts` reproduced a
  live defect **unprompted on its first run**, failing with both dead feature-key names before either
  was removed. `test/migrations-selfcontained.test.ts` audits the live schema for the
  `A OR (B AND C)` nullable-CHECK class after four instances shipped in one day, and was verified to
  bite by injecting one.
- **Leak detection that cannot pass by looking too early.** The event-log hygiene check was moved to
  `posttest` after `node --test`'s file sorting ran it 114th of 403 suites, where it would have
  reported every not-yet-run suite as clean. That is a subtle failure mode caught and fixed.
- **Automated accessibility assertions over 15 public routes through the full app**
  (`frontend/src/a11y.test.tsx`), built on `axe-core`'s typed API after `vitest-axe` was rejected
  because its typings would have required a cast or a suppression — both barred by the project's own
  rules. It found a real violation on its first run.
- **Infrastructure verified by running it, not by linting it.** The nginx config was checked by
  running it in a container and curling every path class; `nginx -t` was "perfectly happy" with three
  broken configs, including a 301 emitting an unreachable absolute `Location`.

### What is missing

**a. There is no coverage measurement on the backend at all.** `frontend/package.json:12` has
`"test:coverage": "vitest run --coverage"`. `backend/package.json` has no equivalent. 2038 tests, and
no one knows what fraction of `backend/src` they touch — or, more usefully, which modules they touch
*not at all*. The error handler had zero test references until 2026-08-14, and writing tests for it
immediately found two real defects; coverage is exactly the instrument that finds the next
`error-handler.ts`.

**b. The backend test list is ~120 filenames hand-typed into `package.json`.** A test file not in
that string does not run. There is now an audit for it (added in 0.5.0, after the trap was hit), but
the underlying design remains a hand-maintained list — the same shape as `MethodologyPage.test.tsx`'s
`ROUTED_PATHS`, which `docs/STATUS.md:426` describes as "the failure mode a list maintained by hand
exists to have." A glob with an explicit deny-list inverts the default safely.

**c. No browser end-to-end test.** No `playwright`, `cypress` or `puppeteer` in either
`package.json` — the only match for e2e-ish tooling is `@testing-library/user-event`, which is
component-level. The paths never exercised by a machine are the highest-stakes ones: operator sign-in
→ claims review → approve → the claim appearing on a public page; the nginx crawler/prerender split
and its `Vary: User-Agent`; the Caddy + nginx + Helmet header stack. Each of those was verified by
hand-curl once and is now protected by nothing.

**d. No load or performance test.** Confirms the security review's own caveat on finding 3, and there
is no regression signal for the queue, the full-text search, or the prerender consumer.

**e. No mutation-testing tool.** No Stryker. The project mutation-verifies *by hand*, which is
genuinely better than most projects do — and does not scale to 491 suites. A tool would tell it which
of those 2038 tests would still pass with the code deleted.

**f. No chaos or failure injection.** The pipeline's realistic failure modes — an adapter 403, an
OpenRouter rate-limit, Postgres unavailable mid-transaction, MinIO unreachable — are handled in code
and never exercised as injected faults.

**g. Flake rate is unmeasured, and there are known order-dependent suites.**
`--test-concurrency=1` is a serialisation workaround, not a property. `prerender.test.ts` "silently
assumes the `events` table is nearly empty" and fails once the table holds >200 older rows —
*including on "a withdrawn meeting kept its prerendered page", the worst failure this system can
produce* (`docs/STATUS.md:205–209`). That is a flake on the most important assertion in the suite,
filed as F9b and unresolved. Nothing tracks retry counts or intermittent failures.

---

## 5. Data governance (DAMA-DMBOK) — **Level 3** ✅ *conditionally*

### What is genuinely strong

- **Provenance is content-addressed and reader-checkable.** Every citation carries a sha256; `/api/source/{sha256}`
  opens the exact stored bytes with `?offset=&len=` so a reader lands on the quoted span. The project
  fixed a bug where fragments never leave the browser precisely because the citation had to be
  *usable*, not merely present.
- **Correction and retraction paths exist in both directions**, and are published surfaces rather than
  internal state: `/corrections` (policy and log), `/corrections/dispute` (the route in), claim
  retraction and meeting unpublish both revoking what announced them.
- **`record_corrections` is append-only by migration 031.** DELETE is forbidden, which is the feature.
- **Licensing is explicit and separated**: CC BY 4.0 for the compilation, MIT for the code, described
  on `/data` with `Dataset` JSON-LD and a 799-line `DataLicensePage.tsx`.
- **PII is actively minimised.** Donor home addresses were deliberately deleted (`PrivacyPage.tsx:95`);
  the rate limiter's docblock explains it keeps no row per submitter because that would mean
  collecting a fourth piece of personal information from someone filing a dispute; `/metrics`'
  roster provenance publishes a distribution and **no body or jurisdiction name**, with a test
  asserting the payload contains no name from any row of `jurisdictions`.
- **Provenance is enforced as all-or-nothing.** `members_provenance_check` refuses a row with a URL
  and no hash, because such a row "reads as sourced in every listing and proves nothing."

### What is missing

**a. Reader PII has no retention policy, and the privacy page says so in as many words.**
`frontend/src/pages/PrivacyPage.tsx:189` — *"Personal information you gave us has no deletion schedule
… indefinitely. That is not a considered retention policy, it is the [absence of one]."* Subscriber
email addresses, phone numbers, and dispute-filer addresses accumulate forever. **The disclosure is
exactly right and is why this category still passes** — the project told the truth rather than
inventing a schedule. But `SECURITY.md` names reader PII as the project's most sensitive asset, and
the mitigation for an asset you cannot protect is to stop holding it.

**b. There is no subject-access or deletion path.** Unsubscribe removes a subscription. Nothing lets
a person ask what is held about them, or ask for it to be erased. For a project that holds the
personal data of people who *did not choose to be public* — the phrase is `SECURITY.md`'s own — this
is the missing counterpart to the corrections log it already offers to people who did.

**c. Internal ledgers have no retention policy and are already named as growing.**
`record_corrections` holds 14,528 rows in the test database and grows every run, with DELETE
forbidden; `export_snapshot_runs` and `export_snapshots` have no policy, and migration 105 already
flags `row_ids` as jsonb will not scale past this corpus (0.5.0). `docs/STATUS.md` says of the first:
*"it is the same growth shape as the event log was, and it deserves a decision before something
does."* Agreed — and there is nowhere to file that decision.

**d. No correction SLA.** The corrections log and dispute route exist; nothing published states how
quickly a correction is acted on. For a site whose entire pitch is *we will fix what we get wrong*,
the timeliness half of that promise is unstated.

---

## 6. Product / UX maturity — **Level 3** ✅

### What is genuinely strong

- **WCAG 2.2 AA is an explicitly named conformance target with computed ratios**
  (`docs/superpowers/specs/2026-08-04-launch-readiness-design.md:281–336`), including the alternate
  page ground "because it is exactly what gets skipped", and — notably — a refusal to claim AAA where
  a AAA criterion happens to be met, "because conflating the two makes the conformance claim less
  trustworthy." Most projects never name a target at all.
- **Severity is never carried by colour alone.** `SeverityMark` uses a numeral and an `sr-only` span,
  which is why theming the console was cheap.
- **Mobile is real, not responsive-by-accident**: public tables reflow to cards below `sm` with
  explicit ARIA roles, because `display: block` strips a table's implicit semantics in every browser.
- **"Failure and emptiness are different states, and must look different"** is a stated design rule
  (console design language, rule 8) that found two real defects on the two screens whose entire
  purpose is that somebody looks. The reader map now distinguishes **four** kinds of empty.
- **Error recovery and honesty in copy** are treated as first-class: `PublicExtractionReading` is a
  discriminated union whose unmeasured branch has **no `unread_fraction` field at all**, so no
  component can reach for a flattering zero by accident.
- **Contributor documentation is excellent** — `CONTRIBUTING.md` with one-command setup *and its
  caveats*, non-negotiable rules, and "no new runtime dependency without a reason that survives the
  question"; `README.md` with a "Verify a claim yourself" section.

### What is missing

**a. There is no accessibility statement, and no conformance audit record.**
`grep -rn -i "accessibility statement"` returns nothing outside the design spec. The WCAG 2.2 AA
target lives in a spec a reader will never open. There is no `/accessibility` page stating what is
claimed, what is known non-conforming, and how to report a barrier. For a civic-transparency site —
adjacent to public-sector accessibility expectations, and one whose audience explicitly includes
people using assistive technology to follow local government — this is the UX gap with an external
expectation attached.

**b. Automated a11y is the floor, not the ceiling.** `axe-core` catches roughly a third of WCAG
criteria by construction, and `color-contrast` is excluded (correctly — jsdom has no canvas). Nothing
exercises the operator console with a keyboard or a screen reader. The roadmap's own top-priority
item is *keyboard review*, which cannot be built well without that.

**c. There is no reader onboarding.** Contributor onboarding is strong; a citizen arriving at `/` gets
a site with **1 published meeting** and no path that explains what they are looking at, why there is
one, or what to do next. The `/status` page does this well *for someone who found it*.

**d. Internationalisation is absent and undecided.** `frontend/index.html` is `<html lang="en">` and
that is the whole of it. **I am not filing this as a feature gap** — English-only is defensible for
Bozeman and Gallatin. I am filing it as a *decision to record*: the project has never written down a
language-access position, and a civic platform that expands to other jurisdictions (Phase 4.2) will
hit one that has a legal one.

---

## 7. Project sustainability — **Level 1** ❌ *weakest category*

### What is genuinely strong

- `CONTRIBUTING.md` is unusually good, and `README.md` has a "Pointing it at your own city" section
  that is most of self-hosting already.
- MIT-licensed, public repo, public mirror, no vendor lock beyond Postgres and S3-compatible storage.
- The parity matrix (2026-08-16) has already done the sustainability *research*: the ProPublica
  Congress API is dead, and Open States has been absorbed into commercial Plural and is deprecating
  public tooling. Both verified. That is the right homework.

### What is missing

**a. Bus factor is 1, and the roadmap names the symptom but not the cause.**
`git shortlog -sne --all` returns two identities: `CommissionWatch <noreply@…>` with 431 commits (the
agent) and `Nick Allevato` with 43. **One human.** Every operator-only task in `docs/STATUS.md` — the
four open decisions, the backup cron, the OpenRouter key rotation, the records request for the roster,
reading the Montana statute for `jurisdiction_records_law` (explicitly "cannot be delegated to an
agent") — has exactly one person who can do it. And that person is the same person who reviews every
claim.

The roadmap's *Gaps* §1 correctly identifies review throughput as the binding constraint and correctly
says the answer is to make a reviewer faster. **It does not say that the reviewer is singular.**
Production confirms the shape, probed today at `/api/metrics`:

```
meetings_total 215, meetings_published 1
claims_total 64, claims_approved 0
median_days_to_publish 28, last_published_at 2026-08-11
```

Nothing has been published in five days. Making one reviewer twice as fast is a 2× improvement on a
resource of size one. There is no second reviewer, no reviewer role separate from the operator role
(§2e — there is only one operator class), and no onboarding path for one.

**b. There is no funding position, and cost is already blocking a resilience control.**
`SECURITY.md` says "volunteer watchdog project with no bounty programme." Nothing states who pays for
the host, the domain, the OpenRouter tokens, or the S3 bucket the backups need — and
`docs/STATUS.md:2405` blocks off-instance backup precisely because "it costs money and is the
operator's call." That makes §1a a funding gap wearing an ops gap's clothes.

**c. There is no API deprecation or stability policy.** The roadmap's *Gaps* §5 names the *external*
half of this — what happens if a source we depend on is withdrawn. The mirror image is unnamed: this
project publishes `/api/data`, `/api/data/ocd.json`, `/feed.xml`, `/feed.rss` and an MCP endpoint, and
invites people to build on them, with **no version prefix, no `Sunset` header support, and no stated
stability tier.** `grep -rn -i "deprecat|/api/v1|sunset"` across `backend/src/routes/`, `docs/`,
`README.md` and `CONTRIBUTING.md` finds one hit — the roadmap sentence about Open States. The parity
matrix's own recommendation ("announced on the corrections log rather than 404'd … decided now rather
than at the moment of withdrawal") is the right answer and is filed nowhere actionable.

**d. There is no dependency health or upgrade policy.** No Renovate, no Dependabot, no stated upgrade
cadence, no supported-Node window. Combined with §2a, the dependency tree is both unmonitored and
unmaintained by policy.

**e. There is no succession or continuity statement.** If the operator stops, the site keeps serving
until the AWS bill lapses, the review queue never moves again, and no reader is told. For a project
whose two cited cautionary tales are both *institutions that could not keep a public data service
alive*, the absence of a "what happens if this stops" statement is the sustainability finding that
matches its own research.

---

## Deliberate absences — **not filed as gaps**

Recorded explicitly so a future reader does not re-file them, and so this review cannot be read as
asking the project to abandon its principles.

| Absence | Why it is a decision, not a gap |
|---|---|
| **Audio recordings / transcription pipeline** | Probed 2026-08-15: the media answers 403 to an honest UA and 200 to a browser string. Reaching it requires fingerprint spoofing, which is the project's hard line. A test asserts the media hosts never enter `allowedOrigins`. |
| **The human review gate as the throughput constraint** | The gate is the product. The roadmap says so; I agree, and the correct response is reviewer *speed*, never gate *weakening*. |
| **Email delivery being dark** | Deliberate and load-bearing. The DNS blocker (SPF/DKIM/DMARC) is a real unowned task and is filed below as such; the darkness itself is not a defect. |
| **No `.github/workflows`** | CI is Gitea. A "fixed" workflow nobody executes is worse than a visibly broken one. |
| **No SSH deploy path** | Impossible, not merely undone — the shared host's private key is not retrievable from AWS by anybody. |
| **No Redis / no queue service** | Postgres `SKIP LOCKED`. One fewer thing to operate on a 4 GB shared host. |
| **No local-meeting data standard adopted** | There is not one. OCD is the nearest and is effectively frozen; the project ships an OCD export anyway. |
| **No Legistar adapter** | Probed and closed — neither Bozeman nor Gallatin is a Legistar tenant. |
| **No Firecrawl / managed anti-bot layer** | Forbidden by the scraping-conduct line, and it returns derivatives that cannot back a sha256 citation. |
| **No bug bounty** | Stated and reasoned in `SECURITY.md`. |
| **No on-call rotation / paging** | Team of one. Ceremony, not reliability. |
| **English-only UI** | Defensible for the pilot jurisdictions. Filed as a *decision to record*, not a feature to build. |

---

## Already true, and the roadmap does not say so

| Fact | Evidence |
|---|---|
| **The external monitor's 15-minute clock is installed and firing.** | Gitea runs 29214/29219/29224/29228/29233/29239/29244/29249 at :00/:15/:30/:45 local; 580 successful monitor runs. `docs/STATUS.md:2411` still calls installing it "the operator task" — **stale**. |
| **A restore drill exists and has been run.** | `deploy/restore-drill.sh`; result at `docs/STATUS.md:2402` — 28 tables, 137 rows, 11 objects, no losses. |
| **WCAG 2.2 AA is a stated conformance target with computed contrast ratios.** | `2026-08-04-launch-readiness-design.md:281–336`. |
| **Automated accessibility testing runs over 15 public routes.** | `frontend/src/a11y.test.tsx`. |
| **Change failure rate and deployment frequency are computable from data that already exists.** | Gitea Actions API; computed in §3 above. |
| **A genuine, domain-specific threat model is published.** | `SECURITY.md`. |
| **Rollback is the deploy path with an older tag** — an exercised procedure, not a written one. | `deploy/deploy-aws-ssm.sh:37`. |

---

## Gaps ranked by (risk × likelihood) / effort

Effort is rough: **S** = under a day, **M** = a few days, **L** = a week or more or needs money.

| Rank | Gap | Risk × likelihood | Effort | Roadmap item |
|---:|---|---|---|---|
| 1 | **Backups never leave the instance; the nightly cron may not be installed** | Catastrophic × plausible — one instance holds DB, objects and archives | S (config) + L (bucket costs money) | 6.1 |
| 2 | **No dependency/CVE scanning; 24 live advisories including a shipped open redirect** | Moderate × certain-to-recur | S | 6.2 |
| 3 | **No incident record → MTTR unmeasurable** | Moderate × certain | S | 6.5 |
| 4 | **No resource monitoring — the disk failure already happened silently** | Moderate × recurring | S | 6.3 |
| 5 | **No second reviewer / bus factor 1 on the binding constraint** | High × certain | M–L (a role, not a feature) | 7.1 |
| 6 | **HSTS on the document + one owner for security headers** | Low × certain | S | 6.4 |
| 7 | **No backend coverage measurement** | Moderate × certain | S | 6.7 |
| 8 | **No reader-PII retention policy or deletion path** | Moderate × moderate | M | 7.3 |
| 9 | **No SLO / error budget** | Moderate × certain | S (writing it), M (measuring it) | 6.6 |
| 10 | **No API deprecation and stability policy** | Moderate × eventual-certainty | S | 7.2 |
| 11 | **No structured logging or error tracking** | Moderate × certain | M | 6.8 |
| 12 | **No browser end-to-end test on the review→publish path** | High × low-today, rising | M | 6.9 |
| 13 | **No accessibility statement page** | Low × certain | S | 7.5 |
| 14 | **No funding / continuity statement** | Moderate × eventual | S to write, L to solve | 7.4 |
| 15 | **`/api/search` unthrottled; no load test** | Moderate × low | S (limit) + M (test) | 6.10 |
| 16 | **Secret rotation has no cadence; one superseded key outstanding** | Moderate × low | S | 6.2 |
| 17 | **Internal ledger retention (`record_corrections`, snapshots)** | Low × rising | M | 7.3 |

---

## Verdict

Stated plainly, because it is the acceptance criterion.

### Categories that **PASS** at a level appropriate for a public-facing civic transparency platform

- **Testing maturity — Level 4.** Not merely adequate: contract-tested adapters against provenanced
  fixtures, guards mutation-verified in both directions, a schema audit written after a class of
  constraint defect was found four times in one day, and infrastructure verified by running it rather
  than linting it. The gaps here (no coverage number, no e2e, no load test) are instrumentation gaps
  on top of a genuinely mature practice, not holes in it.
- **Data governance — Level 3, conditionally.** Provenance, licensing, correction and retraction are
  all defined, published and enforced in the schema. It passes **because** the one real gap — reader
  PII with no retention schedule — is *disclosed on the public privacy page in plain words* rather
  than papered over. That disclosure is the thing that makes the rest of the governance claim
  credible. It stops passing the day the disclosure is softened without the policy being written.
- **Product / UX — Level 3.** A named WCAG 2.2 AA target with computed ratios, automated a11y over 15
  routes, real mobile semantics, and a design language that treats "failure" and "empty" as different
  states. The missing accessibility statement is a publication gap, not a conformance gap.

### Categories that **DO NOT PASS**

- **Operational readiness — Level 2.** Liveness monitoring is excellent and correctly located outside
  the process. Everything else is missing: **backups that never leave the instance and a nightly cron
  that may not be installed**, no SLO, no resource checks despite a disk-exhaustion incident, no
  structured logging, and no incident record. A civic platform's implicit promise is *we are watching
  and we will still be here* — the first half is instrumented, the second is not.
- **Security posture — Level 2.** The *design* work is Level 4: a real domain-specific threat model, a
  production-probed review that states its own limits, secrets kept out of SSM payloads with a CI test
  enforcing it, and a serious unauthenticated-write defect found and closed. The *hygiene* work is
  Level 1: **no dependency scanning of any kind, 24 live advisories including an open redirect in the
  shipped SPA**, no SBOM, no image scanning, no rotation cadence with one superseded credential
  outstanding, and two of the project's own three security findings unfixed and unscheduled. A
  platform asking readers to trust what it publishes cannot leave its dependency tree unwatched.
- **Software delivery (DORA) — Level 2.** Elite on deployment frequency and on delivery
  *architecture* — trunk-based, fully automated, rollback exercised, verification by probing rather
  than by a green check. But **change failure rate is 15.7% on the last 100 deploys and 48.8%
  all-time**, MTTR is not measurable at all because no incident is recorded with a start and an end,
  and **nothing computes any of the four keys** even though three are already sitting in an API.
- **Project sustainability — Level 1.** **Bus factor 1**, on a project whose own roadmap identifies a
  human review gate as the binding constraint. No funding position, and cost is already blocking a
  backup control. No API deprecation policy on endpoints the project invites others to build on —
  after researching two organisations that failed at exactly that. No dependency upgrade policy, no
  succession statement.

### The one-sentence version

**CommissionWatch is a Level 4 engineering practice running on a Level 1 institution.** The code is
tested better than most commercial products, the record it publishes is more carefully sourced than
its own sources are, and the whole of it depends on one person, one instance, and one un-copied
backup. Everything in Phases 6 and 7 of the roadmap follows from that sentence.
