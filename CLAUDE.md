# CommissionWatch

AI-powered civic transparency. Open-source watchdog agents monitoring local government —
Bozeman City Commission and Gallatin County, MT.

## Read this first

**`docs/STATUS.md`** — what is actually true right now: the live deployment, the gaps, the known
defects, the operational traps, and the ordered next steps. Read it before starting work.

**`.claude/skills/commissionwatch-development/SKILL.md`** holds the development process and the
project invariants. Invoke it before planning or implementing anything substantial. It covers the
brainstorm → spec → plan → fan-out pipeline, the rules for parallel agents, and the constraints
that make published output defensible.

**Live:** `https://commissionwatch.bmux.sh` — deployed and healthy. Ingestion is wired as of
2026-08-09 and a real Gallatin sweep has run locally; the live source is registered **disabled**
until an operator enables it. See `docs/STATUS.md`.

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
| Agents | `agents/meeting-monitor` — scraper, parser, anomaly detectors, rundown generator |
| CI/CD | **Gitea Actions only** — `.gitea/workflows/deploy.yml` |
| Deploy | Docker Compose behind Caddy, images to ECR, shipped over **SSM Run Command** — never SSH |
| Domain | `commissionwatch.bmux.sh` |

## Layout

```
backend/    Express API, migrations, seeds
frontend/   React SPA
agents/     Watchdog agents
deploy/     Caddy + compose for production
docs/       specs, plans, roadmap
```

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
