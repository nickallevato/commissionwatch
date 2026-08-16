# CommissionWatch

AI-powered civic transparency. Open-source watchdog agents monitoring local government —
Bozeman City Commission and Gallatin County, MT.

## Read this first

**`CHANGELOG.md`** — what shipped, by release, with a **completeness factor** on every feature
(shipped / shipped dark / operator-gated / blocked / refused). A feature listed without saying how
finished it is reads as finished, which is the same failure this project exists to refuse about the
public record.

**`docs/STATUS.md`** — what is actually true right now: the live deployment, the gaps, the known
defects, the operational traps, and the ordered next steps. Read it before starting work.

**`.claude/skills/commissionwatch-development/SKILL.md`** holds the development process and the
project invariants. Invoke it before planning or implementing anything substantial. It covers the
brainstorm → spec → plan → fan-out pipeline, the rules for parallel agents, and the constraints
that make published output defensible.

**Live:** `https://commissionwatch.bmux.sh` — deployed and healthy. **All three sources are enabled
and collecting as of 2026-08-16**: `bozeman-granicus` (1,639 records), `gallatin-civicplus` (43, its
first ever — the discover stage had been failing on an unretried transient abort), and `mt-cers`
(137, first sweep, at one request every five seconds). `fetch` drains continuously via
`FETCH_WORKER_ENABLED`; without it the queue could not converge, since a nightly fifteen-minute
window fetches ~90 documents against hundreds discovered. See `docs/STATUS.md`.

Current design of record:
`docs/superpowers/specs/2026-08-04-commissionwatch-production-design.md`

## Stack

Verify against `package.json` rather than trusting prose — `docs/spec/architecture.md` misstated
the stack for months.

| Part | Reality |
|---|---|
| Backend | Express 5 + TypeScript, Node 22, Knex migrations |
| Database | PostgreSQL 16 + pgvector |
| Storage | MinIO (S3-compatible) |
| Frontend | React + Vite + Tailwind (**not** Next.js) |
| Queue | Postgres `SKIP LOCKED` — no Redis |
| Ingestion | `backend/src/services/ingestion/` — source adapters, queue, worker, scheduler |
| Detection | `backend/src/services/anomaly-detection.ts` and `agenda-diff.ts` |
| CI/CD | **Gitea Actions only** — `.gitea/workflows/deploy.yml` |
| Deploy | Docker Compose behind Caddy, images to ECR, shipped over **SSM Run Command** — never SSH |
| Domain | `commissionwatch.bmux.sh` |

## Layout

```
backend/    Express API, migrations, seeds, ingestion adapters, detectors
frontend/   React SPA
deploy/     Caddy + compose for production
docs/       specs, plans, roadmap
```

There is no `agents/` directory. There was one — `agents/meeting-monitor`, a standalone vitest
package with its own scraper, parser, detectors and rundown generator — and it was deleted on
2026-08-14. It had become a second, worse analysis engine writing to the same `anomaly_flags`
table: a bare insert that duplicated every flag on re-run and never set `review_state`, against a
backend version that is transactional, resolves review state, and keeps a `detection_runs` ledger.
Its tests ran in no CI job, its scraper still pointed at the Akamai-blocked `bozeman.net`, and its
gitignored `dist/` held compiled modules whose source no longer existed. The working code had
already migrated: adapters to `backend/src/services/ingestion/adapters/` with contract suites in
`backend/test/adapters/`, detection to `backend/src/services/anomaly-detection.ts` and
`agenda-diff.ts`. A watchdog agent here is a service in `backend/`, not a separate package.

## Commands

```bash
# Backend
cd backend && npm run typecheck && npm test && npm run build

# Frontend
cd frontend && npm run typecheck && npm test && npm run build

# Full stack
docker compose up -d
```

Backend tests need PostgreSQL: `docker compose up -d db`.

## Hard rules

- Never silence a type error — no `any`, no `@ts-ignore`, no cast to quiet the compiler
- Never delete or skip a test to go green
- The database schema is the source of truth for types
- No unsourced claim reaches the public site
- Nothing naming a person auto-publishes — it goes to the operator review queue
- Probe external data sources before designing against them
- CI is **Gitea Actions**. Never add `.github/workflows/` — it does not run here, and a
  "fixed" workflow nobody executes is worse than a visibly broken one. Runner labels in use:
  `ubuntu-latest` for checks, `dh1` for build and deploy.
- Gitea's `act_runner` runs jobs inside a container, so a `services:` database answers to its
  service name, not `localhost`
- **CI logs are readable.** Scoped Gitea token at `~/.config/commissionwatch/gitea.env` (never commit it): read `/actions/runs`, `/runs/{id}/jobs`, `/jobs/{id}/logs`. Read the log before theorising.
- **Deploy over SSM, never SSH.** The shared host's SSH private key is not retrievable from AWS by
  anyone, so an SSH deploy job can never go green. Do not add one back, and do not go looking for
  the key. `deploy/deploy-aws-ssm.sh` is the single deploy path — CI and operator both call it
- Never put secrets in an SSM command payload — `send-command` parameters are retained in plaintext
  for 30 days and land in CloudTrail. They go in Parameter Store, fetched by the host

## Deliberately dormant

Alert subscriptions, the digest scheduler, and email delivery exist in `backend/src/services/`.
They must keep compiling and passing tests, and they still send no product events.

The review queue **shipped on 2026-08-10** (`docs/STATUS.md` § B-a), so the gate they were waiting
on now exists. Turning delivery on is a separate, deliberate change — not a consequence of this
one. What is already true is the narrower guarantee: only a `published` finding can be notified
about. `detectAnomalies` emits published flags only, and `NotificationService` filters its own
re-query, because `IMMEDIATE_SEVERITIES` is exactly the severities the default review threshold
holds — without both filters the pipeline would withhold a generated claim from the site and
email it in the same breath.
