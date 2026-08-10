# Contributing to CommissionWatch

This project publishes claims about named public officials, sourced from documents it fetched from government web servers. That is what most of the rules below are for. They are not ceremony — each one exists because a specific failure was found, usually in this repository.

Start with [`docs/STATUS.md`](docs/STATUS.md). It records what is actually true right now: the live deployment, the gaps, the known defects and the operational traps. It is the most useful file in the repository and it is kept honest deliberately.

---

## The one-command setup, and its caveats

```bash
git clone https://github.com/nickallevato/commissionwatch.git
cd commissionwatch
bash scripts/dev-setup.sh
```

The script starts Postgres and MinIO in Docker, installs both packages, applies every migration and loads the demonstration seed. It is idempotent. It was executed end to end on 2026-08-10 against Node v22.22.2 and Docker Compose v5.1.4 on Linux, twice — once cold and once again to prove re-running is safe.

Three things it does not paper over.

**1. The compose stack binds fixed host ports.** `db` takes `127.0.0.1:5432`, `minio` takes `9000` and `9001`. There is no port variable. If you already run Postgres on 5432 the container will not start, and the script stops there with the compose error rather than continuing into a confusing migration failure. Either stop the other service, or edit the ports in `docker-compose.yml` and export a matching `DATABASE_URL`.

**2. `backend/.env` is created and nothing reads it.** There is no `dotenv` dependency anywhere in `backend/src`, and `docker-compose.yml` has no `env_file`. That file is the template for the `.env` the *deployed host* holds, seeded from SSM Parameter Store, and a checklist of every variable the code reads. Locally, the defaults in `backend/knexfile.ts` and `backend/src/services/storage.ts` already match the compose stack, so `npm run dev` works with nothing exported. To override one, export it in your shell.

*(Until 2026-08-10 that file also carried the wrong Postgres credentials — `commwatch:commwatch-secret`, which are the MinIO ones. Anyone who did export it got an authentication failure against a database that was running fine. Fixed, and mentioned here because it is exactly the class of thing this section is for.)*

**3. No ingestion source is enabled, and enabling one is a decision.** Sources are registered `disabled`. Switching one on means this machine starts fetching a real county's web server, at a rate their operations team may notice. `npm run sweep -- --list` shows what exists; `--enable` is deliberate. Read [`docs/ADAPTERS.md` § Scraping conduct](docs/ADAPTERS.md#scraping-conduct) first.

**A trap the script now removes.** `scripts/init-databases.sql` creates `commissionwatch_test`, but only on the *first* initialisation of the data volume. A volume carried over from an older checkout never runs it, and `npm test` then fails on a database that does not exist while everything else works. The script creates it if it is missing.

**A trap the script cannot remove.** The `pgdata` volume survives a branch change. If you switch to a branch with a different migration history, `pretest` dies with *"The migration directory is corrupt, the following files are missing"*. That is branch divergence, not a bad checkout. `docker compose down -v && docker compose up -d db` recreates it; nothing of value is lost, because local contents are synthetic seed rows.

---

## The checks

What CI runs, and the bar for any change:

```bash
docker compose up -d db

cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

The frontend needs no database. The backend suite does, and it runs against `commissionwatch_test`.

**Running one backend suite** — the runner takes an explicit file list, not a glob:

```bash
cd backend
NODE_ENV=test node --import tsx --test --test-concurrency=1 test/data-export.test.ts
```

**Register every new backend test file in the `test` script in `backend/package.json`.** The list is explicit, so a test file that is not in it silently never runs — which is worse than a failing test, because it looks like coverage.

**Running against an isolated database.** Several agents and branches share one Postgres locally. `TEST_DATABASE_URL` overrides the test connection:

```bash
docker exec commissionwatch-db-1 psql -U postgres -c 'CREATE DATABASE cw_test_mybranch'
cd backend
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cw_test_mybranch npm test
```

---

## Rules that are not negotiable

Each of these has cost this project a real failure.

### Never silence an error

No `any`. No `@ts-ignore`, no `@ts-expect-error`, no cast to quiet the compiler. No deleted or skipped test, and no weakened lint config. A test referencing an undefined constant means the constant is missing, not that the test is wrong.

The frontend is at **zero lint problems** and stays there. The backend carries exactly **two warnings**, both deliberate and both documented in `docs/STATUS.md`; do not add a third and do not "fix" those two by changing the config.

### The database schema is the source of truth

Read the migrations before assuming a column exists. This one has caught several people, so here is the specific trap:

> **`meetings` has no `scheduled_at`.** It has a `DATE`, a *nullable* `TIME`, a `location` and a `status`. The zone those are expressed in is `jurisdictions.timezone` (default `America/Denver`). There is no adjournment column and no meeting title — the name a reader calls the sitting is `commissions.name`.

A meeting with no published time must never become midnight. A `TIME` cast in the server's zone is wrong by six or seven hours for Montana. Both mistakes have been made here and both are now pinned by tests.

### Nothing publishes itself

`meetings.published_at` is the wall. A row with `NULL` there does not appear in any public API response — and "any" is not aspirational, it is a test that walks every public path taking a meeting id. Every public query goes through `backend/src/services/publication.ts`. **Do not retype the predicate.** A rule written in ten places is a rule that will be nine-tenths true after the next change.

If you add a public surface that does *not* take a meeting id — a search, an export, a feed, a log — it needs its own wall test, asserted **in both directions**: withheld and absent, then published and present. Absence alone also holds for a query that is simply broken, and on an empty database the two are indistinguishable.

### No unsourced claim

Every published assertion traces to a stored artifact with a content address. If you add a field to the export or a line to a page, ask what document it came from and make the answer visible. Where the schema records no source — the officials roster, for instance — say so in words rather than rendering a blank, because a blank reads as a lost source.

### Describe the record, never the motive

Generated and published text says what happened, when, and in what order. It does not assert intent, corruption or illegality. `appendCorrectionRow` scans every operator-typed reason against a lexicon for exactly this, and the public-records letter generator scans its own output. A finding may say minutes were published ninety days later; it may not say someone meant it.

### Detection is uniform

No detector may filter on entity class — nonprofit, union, business PAC, developer — to select its targets. Beyond being the stated principle, uniform treatment is what makes a finding defensible when someone alleges bias.

### CI is Gitea Actions

`.gitea/workflows/`. **Never add `.github/workflows/`** — it does not run here, and a "fixed" workflow nobody executes is worse than a visibly broken one.

### No new runtime dependency without a reason that survives the question

The iCal feed is emitted by hand because an `.ics` file is text. The CSV export is written by hand because RFC 4180 is a quoting rule. Search is PostgreSQL rather than a vector database. No native or node-gyp dependencies: the production host is arm64 and an amd64 build dies at startup with `exec format error`.

---

## Probing before designing

**The single highest-value habit in this project.** Before designing anything that touches an external system, probe it. Every significant plan change so far came from a `curl`, not from reasoning:

- Bozeman moved to `bozemanmt.gov` and is Akamai-blocked; the hardcoded scraper URL was stale and its selectors had never been validated.
- The real archive was at `bozeman.granicus.com`, found by following a DNS CNAME chain after HTTP probing dead-ended — 1,135 meetings across 16 bodies, 2013→2026, in one 5.9 MB request.
- Gallatin is CivicPlus AgendaCenter with a permissive `robots.txt`, which is why Gallatin shipped first.

```bash
curl -sS -w 'http=%{http_code} size=%{size_download} final=%{url_effective}\n' -o /dev/null -L "$URL"
```

Follow redirects, try a browser user agent before concluding a site is unreachable, and **when HTTP probing dead-ends, look at DNS**.

Never write a spec that assumes an endpoint exists.

---

## Scraping conduct

The full rules, with the vendor-`robots.txt` exception and the hard line on evasion, are in [`docs/ADAPTERS.md` § Scraping conduct](docs/ADAPTERS.md#scraping-conduct). The two-sentence version:

**Fetch politely and honestly** — low rate, one request at a time, a user agent naming the project and carrying a contact, aggressive caching, no re-fetching of unchanged bytes.

**If a source requires fingerprint spoofing, TLS/JA3 manipulation, CAPTCHA solving or proxy rotation, stop.** That is not politeness with an asterisk, it is defeating an access control. The finding is "not accessible by acceptable means" and the answer is a public-records request. Do not build it; ask the operator.

---

## Working on a change

1. **Read `docs/STATUS.md` first.** Then the relevant spec under `docs/superpowers/specs/`.
2. **Open an issue** for anything substantial, before the code. A design disagreement is cheap in an issue and expensive in a diff.
3. **Write the test first** where you can, and make it fail for the right reason before you make it pass.
4. **Branch.** Do not commit to `main`.
5. **Run the full gate** above. Not a subset, and not a claim that it passes — the real command output. Both a green pipeline and an agent's assertion have lied in this project.
6. **Commit incrementally**, with a message body that explains *why*. The body is the part that is read in a year; the subject is not.
7. **Update `docs/STATUS.md`** if you changed what is true.

### Commit messages

Present tense, no ticket prefix required, and a body that explains the reasoning rather than restating the diff. The diff already says what changed.

```
Short line saying what this does

Why it was done this way, what the alternative was, and what would break
if someone undid it. Name the failure it prevents, since the next reader
will otherwise assume the simpler version is fine.
```

### Frontend design

The public site is an editorial newspaper-of-record system, and it is a shared one. Use the tokens in `frontend/tailwind.config.ts` and nothing else — **no new palette entry**. Display serif headings, tabular numerals for figures, `tracking-label` micro-labels, hairline rules, one red accent used sparingly. Public pages render inside the existing `Layout` so they carry the masthead and colophon; the operator console has its own shell and the two must not be mixed.

Accessibility is a requirement, not a pass: severity and vote outcome are never conveyed by colour alone, tables are real `<table>` elements with `<caption>` and scoped headers, and wide content scrolls inside its own container so the page body never scrolls sideways.

---

## Reporting a problem with the published record

If you are here because CommissionWatch published something about you or about a record you know, you do not need a GitHub account. The site has a dispute route at `/corrections/dispute` and a published corrections log at `/corrections`. A dispute is never gated on identifying yourself.

## Licence

By contributing you agree that your code is licensed under the [MIT licence](LICENSE), and that any data or documentation contribution is licensed under CC BY 4.0, matching the two layers described in the [README](README.md#licence).
