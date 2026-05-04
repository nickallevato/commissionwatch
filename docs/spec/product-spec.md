# CommissionWatch — Product Specification v3

> Board-approved 2026-05-04. All open design questions resolved.

## Decisions

| Question | Decision |
|---|---|
| **Name** | "CommissionWatch" for now; may rebrand to Open*/Claw*/Clip* naming later |
| **LLM Strategy** | Claude Code harness with **zero permissions** to start. Build exact tools needed and hook in incrementally. Tests for permission boundaries. |
| **Pilot Scope** | Broad — all 6 agents planned, but **sequenced**, not simultaneous. Some phases kick off when prior ones finish; others manually backlogged to manage quota. |
| **License** | Free and open source. MIT (maximum adoption, gift to the world). |
| **Repo** | Public GitHub repo. Open source from day one. |
| **Demo Hosting** | Containerized on AWS (<$20/mo), DNS on existing Route53 domain. |

## Vision

An open-source, AI agent-powered civic watchdog platform. Pre-built government monitoring agents that auto-generate rundown sheets, deep-dive research, and follow-the-money investigations on local commissions — starting with Bozeman, MT and Gallatin County, scaling to any jurisdiction worldwide.

**Not SaaS sold to governments. Built for citizens watching government.** Open source, self-hostable, a gift to the world.

## Landscape Analysis

Nothing like this exists in the current space.

| Existing Tool | What it does | Gap |
|---|---|---|
| OpenCouncil (open-source) | Transcribes council meetings, speaker recognition | Single-channel, no agents, no cross-referencing |
| Civic-AI-Recap | Public hearing transcription | Passive summarization only |
| FEC MCP Server | AI access to OpenFEC campaign finance data | Data access only, no proactive monitoring |
| OpenSecrets / FollowTheMoney.org | Campaign finance databases | No AI layer, no local government coverage |
| Curate/FiscalNote, Cloverleaf AI | Commercial SaaS for government document monitoring | Closed-source, sold TO governments, not watching them |

**Our differentiation:**
1. **Adversarial by design** — built for citizens, not government
2. **Agent-powered cross-dataset correlation** — connects campaign finance, votes, contracts, and meeting transcripts automatically
3. **Proactive alerting** — agents surface issues, not passive dashboards
4. **Local-first** — targets 90,000+ US local government bodies where commercial tools have zero coverage
5. **Open source & self-hostable** — transparency tool must itself be transparent

## Core Architecture

Built on Claude Code harness with zero-permission-first security model. Six pre-built watchdog agents orchestrated per jurisdiction:

1. **Meeting Monitor Agent** — scrapes agendas/minutes, generates quick rundown sheets
2. **Vote Tracker Agent** — records votes, detects patterns, cross-references donors
3. **Follow-the-Money Agent** — traces campaign finance, flags conflicts of interest
4. **Member Profiler Agent** — maintains dossiers, detects position-vote discrepancies
5. **Document Digger Agent** — monitors public records, OCRs documents, flags anomalies
6. **Alert & Briefing Agent** — synthesizes findings, generates briefings and alerts

### System Layers

- **Agent Orchestrator** — schedules, manages, budgets agents per jurisdiction
- **Data Layer** — PostgreSQL + pgvector + MinIO + ingest pipelines
- **Output Layer** — rundown sheets, deep dives, money maps, alert feed, dashboard

## Pre-Built Watchdog Agents

### 1. Meeting Monitor Agent
- Scrapes/ingests agendas, minutes, video from commission websites
- Auto-transcribes meetings, identifies speakers
- Generates **quick rundown sheets**: who attended, what was voted on, key quotes, surprises
- Flags unusual items (emergency sessions, closed-door votes, last-minute agenda additions)

### 2. Vote Tracker Agent
- Records every vote by every commission member
- Detects voting pattern changes, bloc voting, unusual dissents
- Cross-references votes against campaign donors and lobbyist activity
- Generates scorecards and trend reports

### 3. Follow-the-Money Agent
- Connects to OpenFEC, state campaign finance APIs, lobbying disclosures
- Traces donation flows: donor → PAC → candidate → vote → contract
- Flags conflicts of interest (donor gets contract, commissioner votes on own interest)
- Generates **follow-the-money reports** with visual money trails
- Monitors for dark money patterns and shell entity structures

### 4. Member Profiler Agent
- Builds and maintains dossiers on each commission member
- Tracks public statements, social media, financial disclosures
- Detects discrepancies between public positions and voting records
- Cross-references business interests, property records, family connections

### 5. Document Digger Agent
- Monitors public records, FOIA responses, permits, contracts, budgets
- OCRs and indexes scanned documents
- Extracts key entities, amounts, dates, and relationships
- Flags anomalies: no-bid contracts, budget line items that spike, permits issued unusually fast

### 6. Alert & Briefing Agent
- Synthesizes findings from all other agents
- Generates daily/weekly briefings per jurisdiction
- Sends configurable alerts (email, webhook, RSS)
- Produces **deep dive research reports** on-demand when patterns are detected
- Powers the public dashboard

## Output Products

| Product | Description | Frequency |
|---|---|---|
| **Quick Rundown Sheet** | 1-page summary of a commission meeting | Per meeting |
| **Weekly Briefing** | Digest of all agent findings for a jurisdiction | Weekly |
| **Deep Dive Report** | In-depth investigation when agents detect patterns | On-demand |
| **Follow-the-Money Map** | Visual graph of money flows | Updated continuously |
| **Member Scorecard** | Voting record + donor profile per official | Updated per vote |
| **Alert Feed** | Real-time stream of flagged items | Continuous |

## Tech Stack

- **Agent Runtime:** Claude Code harness (zero-permission start, explicit tool grants only)
- **Backend:** Python (FastAPI)
- **Database:** PostgreSQL + pgvector for semantic search
- **Document Store:** MinIO (S3-compatible, self-hostable)
- **Frontend:** Next.js — public dashboard, admin panel, report viewer
- **Deployment:** Docker Compose (primary)
- **Hosting:** AWS instance <$20/mo, DNS via Route53
- **Data Sources:** OpenFEC API, state campaign finance APIs, government meeting sites, FOIA portals
- **License:** MIT

## Brand & Identity

- **Tone:** Fearless but fair. Non-partisan. Sunlight-as-disinfectant.
- **Working name:** CommissionWatch (may evolve to Open*/Claw*/Clip* branding)
- **Visual:** Clean, serious, trustworthy. Dark mode default. Accent: amber/gold.
- **Tagline:** "AI-powered civic transparency"

## Implementation Phases (Sequenced)

### Phase 1 — Foundation (MVP)
- GitHub repo setup (public, open source, MIT)
- Core agent orchestrator + Claude Code harness integration
- Zero-permission security model with explicit tool grants + tests
- Meeting Monitor Agent (Bozeman city council as pilot)
- Quick Rundown Sheet generation
- Basic self-hosted web dashboard
- Docker Compose deployment
- Deploy to AWS demo instance

### Phase 2 — The Money Trail (starts when Phase 1 ships)
- Follow-the-Money Agent (OpenFEC + Montana campaign finance)
- Vote Tracker Agent
- Cross-reference engine (votes ↔ donations)
- Follow-the-money visualizations
- Alert system (email + webhook)

### Phase 3 — Deep Intelligence (starts when Phase 2 ships)
- Member Profiler Agent
- Document Digger Agent
- Deep Dive Report generation
- Vector search across all ingested documents
- Expand to Gallatin County + additional MT jurisdictions

### Phase 4 — Scale & Community (backlogged, manual promotion)
- Agent SDK for community-contributed watchdog agents
- Multi-state expansion
- Plugin system for new data sources
- Self-hosting documentation and one-click deploy
