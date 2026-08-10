# CommissionWatch

**A public record of what your local government actually did, with the document behind every line of it.**

CommissionWatch scrapes the agendas, minutes and meeting archives a city or county already publishes, stores every document by its SHA-256, extracts the meetings, agenda items, officials and votes out of it, and publishes the result as a searchable site and a bulk open-data export. It currently watches the **City of Bozeman** and **Gallatin County, Montana**.

It is a watchdog project, not a government product. Built for citizens watching government; not sold to government.

Live: **https://commissionwatch.bmux.sh**

---

## What it does, precisely

| | |
|---|---|
| **Collects** | One adapter per source. Politely: one request every 2–10 seconds, never concurrent, an honest user agent naming the project, and a document whose bytes have not changed is never fetched again |
| **Stores** | Every fetched document is content-addressed and kept. Every stage after `fetch` reads a stored artifact, never the live web, so parsing and analysis run at full speed against a source that is blocked or offline |
| **Extracts** | Meetings, agenda items, documents, and per-field extraction confidence. Agenda diffs across republished versions |
| **Flags** | Six meeting detectors — emergency sessions, missing minutes, quorum issues, last-minute agenda changes, unanimous votes on controversial items, closed-door votes. Three more flag types exist for records-derived findings. A flag is a reason to look, never a conclusion |
| **Withholds** | Nothing publishes automatically. A sweep produces a *candidate*; an operator produces a *publication*. Anything naming a person goes to a review queue and stays there until a named human approves it |
| **Publishes** | The site, a full-text search, a public corrections log, a public collection-status page, a meeting calendar with iCal feeds, and a bulk data export under CC BY 4.0 |
| **Refuses** | It does not assert motive, intent, corruption or illegality. It does not score or rank officials. It does not predict votes. It does not transcribe video. It does not accept payment to publish, suppress or prioritise anything |

### The invariants

These are not style preferences. Breaking one is a defect, and each has a test.

- **No unsourced claim reaches the public site.** Every published assertion traces to a stored artifact with a content address.
- **Nothing naming a person auto-publishes.** It goes to the operator review queue.
- **Describe the record, never the motive.** Generated text says what happened, when, and in what order.
- **Failures are disclosed, not swallowed.** Every failure lands in a database row with its error text, and `/status` reads from those rows. A transparency project that silently stops collecting is worse than one that says so.
- **Detection logic applies identically to every entity class.** No detector may filter on entity type to select targets.
- **The database schema is the source of truth for types.**

---

## Running it

Everything below has been executed on a Linux machine with Node 22 and the Docker Compose plugin.

```bash
git clone https://github.com/nickallevato/commissionwatch.git
cd commissionwatch
bash scripts/dev-setup.sh
```

That starts Postgres and MinIO, installs both packages, applies all 39 migrations and loads the demonstration seed. It is idempotent — re-running it is safe. Then, in two terminals:

```bash
cd backend  && npm run dev      # API on http://localhost:3001
cd frontend && npm run dev      # site on http://localhost:3000
```

**Three caveats, because a setup script that lies is worse than one that is manual.** They are written out in [`CONTRIBUTING.md`](CONTRIBUTING.md#the-one-command-setup-and-its-caveats):

1. The compose stack binds **fixed host ports** — 5432, 9000, 9001. If something already holds one, the container fails to start and the script stops there.
2. `backend/.env` is created but **nothing in the Node process reads it**. There is no `dotenv` dependency. The local defaults live in `backend/knexfile.ts` and `backend/src/services/storage.ts`, and they already match the compose stack.
3. **No ingestion source is enabled.** Setting one up is not the same as pointing it at a county's web server, and the second is a decision a person makes.

### Checks

What CI runs, and what a change has to pass:

```bash
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
```

The backend suite needs the database up. It runs against `commissionwatch_test`, which `scripts/dev-setup.sh` creates.

---

## Pointing it at your own city

The adapter contract is the seam. Adding a jurisdiction means writing one module and adding it to one array; it does not touch core code, and the contract suite tells you when you are done.

**Read [`docs/ADAPTERS.md`](docs/ADAPTERS.md) before you start.** It has the contract, the two worked examples, the fixture and `PROVENANCE.md` discipline, the scraping-conduct rules, and — importantly — the list of things that are **not configuration yet**. Body lists are hardcoded constants in each adapter, jurisdictions are seeded by migration, and `ingestion_sources.config` is written once at first boot and never updated. An afternoon is a realistic estimate for a source that publishes a clean listing page. It is not a config-file exercise.

The honest first step is not code. It is `curl`:

```bash
curl -sS -A 'CommissionWatch/0.1 (civic transparency project; +https://commissionwatch.bmux.sh)' \
  -w 'http=%{http_code} size=%{size_download} final=%{url_effective}\n' \
  -o /dev/null -L 'https://your-city.gov/AgendaCenter'
```

Every significant design change in this project came from a probe, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended on an Akamai wall.

---

## The data

`/data` describes the dataset, its schema, its licence, how often it changes, and what is withheld and why. The export is public, unauthenticated, and needs no key:

```bash
curl https://commissionwatch.bmux.sh/api/data                    # the manifest
curl https://commissionwatch.bmux.sh/api/data/meetings.csv       # one table
curl https://commissionwatch.bmux.sh/api/data/agenda_items.json
```

Every row that derives from a document carries the SHA-256 of the stored copy it was read out of, so you can fetch the same file from the government and check byte for byte that it is the one this project parsed. **Only records an operator has published are exported.**

`/calendar` publishes an iCalendar feed per jurisdiction at `/api/calendar/{jurisdiction_id}.ics`.

### Licence

Three layers, licensed separately, because they are three different questions.

| Layer | Licence |
|---|---|
| **The compiled dataset** — the selection, structure and generated text | **CC BY 4.0**. Attribute to `CommissionWatch — commissionwatch.bmux.sh` |
| **The code** — everything in this repository | **MIT**, per [`LICENSE`](LICENSE) |
| **The underlying government documents** | Public records. **No licence asserted.** They are not ours, and their bytes are not redistributed here |

The dataset licence covers the compilation, not the facts. That a commissioner voted no on 14 July is not copyrightable and needs nobody's permission.

---

## Stack

Verify against `package.json` rather than trusting prose — `docs/spec/architecture.md` misstated this for months.

| Part | Reality |
|---|---|
| Backend | Express 5 + TypeScript, Node 22, Knex migrations |
| Database | PostgreSQL 16 + pgvector |
| Object storage | MinIO (S3-compatible) |
| Frontend | React 19 + Vite + Tailwind (**not** Next.js) |
| Queue | Postgres `SKIP LOCKED` — no Redis |
| Search | PostgreSQL full-text. No vector database, no API key, no per-call cost |
| CI | **Gitea Actions only** — `.gitea/workflows/`. Never add `.github/workflows/`; it does not run here |
| Deploy | Docker Compose behind Caddy, images to ECR, shipped over **SSM Run Command** — never SSH |

```
backend/    Express API, migrations, seeds, ingestion adapters, scheduler
frontend/   React SPA
agents/     Watchdog agent scaffolding
deploy/     Caddy, production compose, the SSM deploy script and its runbook
docs/       Specs, plans, and the adapter authoring guide
scripts/    dev-setup.sh and the database init SQL
```

---

## Where to read next

| | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **What is actually true right now** — the live deployment, the gaps, the known defects, the operational traps and the ordered next steps. Read it before starting work. It records what is true, not what was planned |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work on this: the setup and its caveats, the checks, the review bar, and the rules that are not negotiable |
| [`docs/ADAPTERS.md`](docs/ADAPTERS.md) | Writing an adapter for a new jurisdiction |
| [`deploy/README.md`](deploy/README.md) | Production deployment, secrets, backups and the restore drill |
| `.claude/skills/commissionwatch-development/SKILL.md` | The development process and the project invariants |

## Contributing

Contributions are welcome, and this is an open-source gift to the world. Open an issue first if the change is substantial — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

Code: [MIT](LICENSE). Data: CC BY 4.0. See [the licence table above](#licence).
