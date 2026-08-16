# CommissionWatch — Roadmap

> Last updated: 2026-08-04

## Overview

This roadmap outlines the implementation plan for CommissionWatch, an AI-powered civic transparency platform. Work is sequenced in four phases, with each phase building on the prior one.

## Phase 1 — Foundation (MVP)

**Goal:** Ship a working demo with one agent monitoring one jurisdiction.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 1.1 | Repo setup + scaffolding | Public repo, monorepo structure, Docker Compose, CI | Done |
| 1.2 | Public web dashboard (MVP) | React 18 + Vite single-page app — landing page, jurisdiction browser, meeting rundown viewer, agent status overview. Light editorial design, serif headlines, single red accent, mobile-responsive. | Planned |
| 1.3 | Core agent orchestrator | Claude Code harness integration, zero-permission security model, explicit tool grants with tests | Done |
| 1.4 | Meeting Monitor Agent | Scrape Bozeman city council agendas/minutes, parse PDF/HTML, generate quick rundown sheets, flag anomalies | Planned |
| 1.5 | Data layer setup | PostgreSQL + pgvector schema, MinIO for document storage | Planned |
| 1.6 | Docker Compose deployment | Full stack (backend, frontend, db, minio) running via `docker compose up` | Done |
| 1.7 | AWS demo deployment | Single instance on AWS, DNS on Route53, <$20/mo target | Done |

**Dashboard MVP details (1.2):**

> Visual direction is defined by the approved
> [production design spec](superpowers/specs/2026-08-04-commissionwatch-production-design.md).
> That spec supersedes any earlier dark-mode description of this deliverable.

- React 18 + Vite 5 + Tailwind, TypeScript throughout
- Investigative/editorial look: light paper background, serif headlines, sans-serif for data,
  tabular numerals, and a single red accent
- Sourced citation chips on every generated claim
- Landing page with project mission and value proposition
- Jurisdiction browser — select city/county to view commission data
- Meeting rundown sheet viewer — display agent-generated summaries
- Agent status overview — which agents are running, last run time, findings count
- Non-partisan, clean, trustworthy design language
- Mobile-responsive layout
- Starts with mock data; wires up to backend API when available

**Meeting Monitor Agent details (1.4):**
- **Scraper/ingestor:** Fetch agendas and minutes from the Bozeman City Commission website. Handle pagination, session archives, rate limiting.
- **Document parser:** Parse PDF and HTML meeting documents. Extract structured data — date, attendees, agenda items, motions, votes, notable quotes.
- **Quick Rundown Sheet generator:** Auto-generate 1-page structured meeting summaries covering attendance, votes, key items, and notable quotes.
- **Anomaly flagging:** Detect and flag emergency sessions, closed-door votes, last-minute agenda changes, quorum issues.
- **Data model:** PostgreSQL schema for meetings, agenda_items, votes, members, quotes, and flags.
- **Integration tests:** End-to-end tests against real Bozeman commission data validating scraping, parsing, and rundown generation.
- **Data sources:** Bozeman City Commission (primary), Gallatin County Commission (stretch goal).
- **Tools required:** Web scraper (scoped to government sites), PDF parser, database write (meetings tables).
- **Schedule:** After each commission meeting (configurable polling interval).

## Phase 2 — The Money Trail

**Goal:** Connect campaign finance to voting records and surface conflicts of interest.

**Starts when:** Phase 1 ships.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 2.1 | Follow-the-Money Agent | OpenFEC + Montana campaign finance API integration | Planned |
| 2.2 | Vote Tracker Agent | Record votes, detect patterns, cross-reference donors | Planned |
| 2.3 | Cross-reference engine | Automated votes ↔ donations correlation | Planned |
| 2.4 | Money trail visualizations | Interactive graphs showing donor → PAC → candidate → vote → contract flows | Planned |
| 2.5 | Alert system | Email + webhook notifications for flagged items | Planned |

## Phase 3 — Deep Intelligence

**Goal:** Add deep-dive investigation capabilities and expand jurisdiction coverage.

**Starts when:** Phase 2 ships.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 3.1 | Member Profiler Agent | Build and maintain dossiers on commission members | Planned |
| 3.2 | Document Digger Agent | Monitor public records, OCR, entity extraction, anomaly detection | Planned |
| 3.3 | Deep Dive Reports | On-demand investigation reports triggered by pattern detection | Planned |
| 3.4 | Vector search | Semantic search across all ingested documents via pgvector | Planned |
| 3.5 | Jurisdiction expansion | Gallatin County + additional Montana jurisdictions | Planned |

## Phase 4 — Scale & Community

**Goal:** Enable community adoption and multi-state expansion.

**Starts when:** Manually promoted from backlog.

| # | Deliverable | Description | Status |
|---|---|---|---|
| 4.1 | Agent SDK | Community-contributed watchdog agent framework | Planned |
| 4.2 | Multi-state expansion | Standardized jurisdiction onboarding for other states | Planned |
| 4.3 | Plugin system | Modular data source connectors | Planned |
| 4.4 | Self-hosting docs | One-click deploy, comprehensive self-hosting guide | Planned |

## Pilot Jurisdiction

**Bozeman, MT (City Council)** and **Gallatin County, MT** are the initial targets. The platform is designed to scale to any of the 90,000+ US local government bodies.

## Phase 5 — Interface

| # | Deliverable | Description | Status |
|---|---|---|---|
| 5.1 | One palette | Point `tailwind.config.ts` colours at the `--cw-*` custom properties, with a guard test, so the palette has one definition instead of two hand-synchronised copies. Worth doing on its own merits. | Planned |
| 5.2 | Dark theme — operator console | `/admin/*` first: it is where a person spends hours, and it has a real component library rather than inline class strings. | Planned |
| 5.3 | Dark theme — public site | Higher care: prerendered pages, and the light editorial identity is deliberate. Needs an explicit operator decision. | Planned |

**Dark theme (5.1–5.3), added 2026-08-16 at the operator's request.**

> Design of record: [dark theme spec](superpowers/specs/2026-08-16-dark-theme-design.md).

This is **not** reopening the decision that produced the light identity. What the 2026-08-14 roadmap
deleted was *dead config* — `darkMode: "class"` with `<html class="dark">` shipped permanently, so
every `dark:` variant was always on and the shell painted grey before React mounted. That deletion
said a later dark mode would be "a token swap, not a rewrite", and this exercises the option it left
open.

**The premise needs fixing first, which is why 5.1 exists.** Checked 2026-08-16: `index.css` defines
42 `--cw-*` properties and `tailwind.config.ts` defines the same palette again as flat hex literals.
They agree because someone typed the values twice. Swapping the variables under a media query would
restyle the body and leave every `bg-paper` / `text-ink` / `text-accent` class light — worse than no
dark theme at all. **5.1 is a prerequisite, and it is worth shipping even if 5.2 and 5.3 never are.**

Two findings already in hand: a complete dark palette drafted and checked against the production
tokens (the deep red accent `#B03A2E` goes muddy on a dark ground and needs `#E0705E`), and the
observation that severity here is never carried by colour alone — `SeverityMark` uses a numeral and
an `sr-only` span — which removes the usual expensive part of theming a status UI.

## Design Principles

- **Non-partisan** — facts over politics, sunlight as disinfectant
- **Citizen-first** — built for people watching government, not sold to government
- **Open source** — MIT licensed, self-hostable, transparent
- **Agent-powered** — proactive monitoring, not passive dashboards
- **Privacy-respecting** — only processes publicly available data
