# CommissionWatch — Architecture

## Overview

CommissionWatch is an agent-orchestrated civic monitoring system. Each jurisdiction gets a set of watchdog agents that independently collect, analyze, and cross-reference public government data.

## Security Model

**Zero-permission-first.** Every agent starts with no tool access. Permissions are granted explicitly per-agent, per-tool, with tests verifying the boundary. This prevents accidental data leaks, rate-limit violations, or unintended side effects.

## System Components

### Agent Orchestrator
- Schedules agent runs per jurisdiction on configurable cadence
- Manages agent lifecycle: register, configure, grant tools, run, report
- Budgets LLM usage across agents to stay within quota
- Sequences work: some agents chain (Phase 2 after Phase 1), others are manually promoted

### Data Layer
- **PostgreSQL** — structured data (votes, members, meetings, donations)
- **pgvector** — semantic search across documents and transcripts
- **MinIO** — raw document/media storage (PDFs, recordings, images)

### Ingest Pipelines
- Web scrapers for government meeting sites (agendas, minutes, video)
- API connectors (OpenFEC, state campaign finance portals)
- FOIA response processors (OCR, entity extraction)
- Social media monitors (public statements by officials)

### Output Layer
- Quick Rundown Sheet generator (per-meeting summaries)
- Deep Dive Report generator (pattern-triggered investigations)
- Follow-the-Money visualization engine
- Alert/notification system (email, webhook, RSS)
- Public web dashboard (Next.js)

## Tech Stack

| Component | Technology |
|---|---|
| Agent Runtime | Claude Code harness |
| Backend API | Python / FastAPI |
| Database | PostgreSQL + pgvector |
| Object Storage | MinIO |
| Frontend | Next.js |
| Deployment | Docker Compose |
| Hosting | AWS (<$20/mo) |
| CI/CD | GitHub Actions |

## Deployment

Single Docker Compose stack for self-hosting:
- `backend` — FastAPI app + agent orchestrator
- `frontend` — Next.js dashboard
- `db` — PostgreSQL with pgvector extension
- `minio` — S3-compatible document storage
- `worker` — Background agent runner

Production demo runs on a single AWS instance with DNS on Route53.
