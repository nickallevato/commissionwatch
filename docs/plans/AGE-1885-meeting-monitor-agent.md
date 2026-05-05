# AGE-1885: Meeting Monitor Agent — Implementation Plan

> **Status:** Draft — awaiting approval  
> **Author:** CTO  
> **Date:** 2026-05-05  
> **Revision:** 1

## Overview

Build the Meeting Monitor Agent as a standalone TypeScript package in `agents/meeting-monitor/` that scrapes Bozeman City Commission meetings, parses documents, generates rundown sheets, and flags anomalies. Stores all data in PostgreSQL using the existing schema (with required extensions).

## Architecture Decision

**Standalone worker package** (not embedded in the Express backend). Reasons:
- Decoupled scheduling — can run via cron, Docker service, or manual trigger
- Independent dependencies (Playwright, pdf-parse) don't bloat the API server
- Aligns with `agents/` directory convention and zero-permission security model
- Shares database config via environment variables (same Knex connection pattern)

## Component Breakdown

### 1. Schema Extensions (new migrations)

The existing schema covers `meetings`, `agenda_items`, `meeting_documents`, and `rundown_sheets`. We need:

| Migration | Table | Purpose |
|---|---|---|
| `007_create_members.ts` | `members` | Commission members (name, title, jurisdiction, term dates) |
| `008_create_votes.ts` | `votes` | Per-member vote records (meeting_id, agenda_item_id, member_id, vote: yes/no/abstain/absent) |
| `009_create_anomaly_flags.ts` | `anomaly_flags` | Flagged items (meeting_id, flag_type enum, description, severity) |

**Flag types:** `emergency_session`, `closed_door_vote`, `last_minute_agenda_change`, `quorum_issue`, `unanimous_controversial`, `missing_minutes`

### 2. Scraper (`agents/meeting-monitor/src/scraper/`)

**Target:** https://www.bozeman.net/government/city-commission

**Strategy:**
- Use **Playwright** (headless Chromium) — government sites often use JavaScript rendering
- Scrape meeting archive pages for meeting dates, agenda PDF links, minutes PDF links
- Handle pagination via URL pattern detection
- Rate limit: 2 requests/second with exponential backoff on 429/503
- Store raw URLs in `meetings` table (agenda_url, minutes_url)
- Idempotent: skip meetings already in DB (match on commission_id + date)

**Key files:**
- `scraper.ts` — main scrape orchestration
- `bozeman-commission.ts` — site-specific selectors and URL patterns
- `rate-limiter.ts` — request throttling utility

### 3. Document Parser (`agents/meeting-monitor/src/parser/`)

**Strategy:**
- **PDF parsing:** `pdf-parse` for text extraction from agenda/minutes PDFs
- **HTML parsing:** `cheerio` for any HTML-rendered meeting pages
- **Structured extraction:** Regex + heuristic patterns for Bozeman's document format:
  - Meeting date/time/location from header
  - Attendee roll call section → `members` table
  - Numbered agenda items → `agenda_items` table
  - Motion/vote sections → `votes` table
  - Notable quotes (attributed statements in minutes)

**Key files:**
- `pdf-parser.ts` — PDF text extraction + section splitting
- `html-parser.ts` — HTML document parsing
- `extractors/agenda.ts` — agenda item extraction
- `extractors/votes.ts` — vote record extraction
- `extractors/attendance.ts` — member/attendance extraction

### 4. Rundown Generator (`agents/meeting-monitor/src/rundown/`)

Produces structured JSON stored in `rundown_sheets.key_items` (JSONB):

```typescript
interface RundownSheet {
  meeting_date: string;
  attendance: { present: string[]; absent: string[] };
  agenda_item_count: number;
  key_votes: Array<{
    item: string;
    result: string;
    vote_split: string;
  }>;
  notable_quotes: Array<{
    speaker: string;
    text: string;
    context: string;
  }>;
  anomalies: string[];
  summary: string; // 2-3 sentence overview
}
```

**Key files:**
- `generator.ts` — assembles rundown from parsed data
- `summarizer.ts` — generates natural language summary (template-based, no LLM dependency in v1)

### 5. Anomaly Detector (`agents/meeting-monitor/src/anomalies/`)

Rule-based detection (no ML in v1):

| Flag Type | Detection Logic |
|---|---|
| `emergency_session` | Meeting scheduled < 48h before date, or agenda posted < 24h before |
| `closed_door_vote` | Keywords: "executive session", "closed session" in agenda items |
| `last_minute_agenda_change` | Agenda document modified after initial posting (if detectable) |
| `quorum_issue` | Attendance < majority threshold for the commission size |
| `unanimous_controversial` | Unanimous vote on items with public comment (stretch) |
| `missing_minutes` | Meeting marked completed but no minutes_url after 14 days |

**Key files:**
- `detector.ts` — runs all rules against parsed meeting data
- `rules/*.ts` — individual rule implementations

### 6. Integration Tests (`agents/meeting-monitor/src/__tests__/`)

- `scraper.integration.test.ts` — hits real Bozeman website, validates URL extraction
- `parser.integration.test.ts` — parses real downloaded PDFs, validates structure
- `pipeline.integration.test.ts` — end-to-end: scrape → parse → store → generate rundown
- Use `vitest` with longer timeouts for network calls
- Fixture PDFs committed for offline parser tests

## Package Structure

```
agents/meeting-monitor/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts              # CLI entry point + orchestration
│   ├── config.ts             # env vars, DB connection
│   ├── db.ts                 # Knex instance (shared config with backend)
│   ├── scraper/
│   │   ├── scraper.ts
│   │   ├── bozeman-commission.ts
│   │   └── rate-limiter.ts
│   ├── parser/
│   │   ├── pdf-parser.ts
│   │   ├── html-parser.ts
│   │   └── extractors/
│   │       ├── agenda.ts
│   │       ├── votes.ts
│   │       └── attendance.ts
│   ├── rundown/
│   │   ├── generator.ts
│   │   └── summarizer.ts
│   ├── anomalies/
│   │   ├── detector.ts
│   │   └── rules/
│   │       ├── emergency-session.ts
│   │       ├── closed-door.ts
│   │       ├── quorum.ts
│   │       └── missing-minutes.ts
│   └── __tests__/
│       ├── scraper.integration.test.ts
│       ├── parser.integration.test.ts
│       ├── pipeline.integration.test.ts
│       └── fixtures/
└── Dockerfile
```

## Dependencies

```json
{
  "dependencies": {
    "playwright": "^1.52.0",
    "pdf-parse": "^1.1.1",
    "cheerio": "^1.0.0",
    "knex": "^3.2.10",
    "pg": "^8.20.0",
    "dotenv": "^16.5.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^3.1.0",
    "@types/node": "^25.6.0"
  }
}
```

## Work Breakdown (Child Issues)

| # | Task | Complexity | Estimate |
|---|---|---|---|
| 1 | Schema extensions (migrations 007-009) | Low | 1h |
| 2 | Package scaffold + config + DB connection | Low | 1h |
| 3 | Bozeman scraper (Playwright) | Medium | 3h |
| 4 | Document parser (PDF + HTML extraction) | High | 4h |
| 5 | Rundown generator | Medium | 2h |
| 6 | Anomaly detector | Medium | 2h |
| 7 | Integration tests | Medium | 3h |
| 8 | Docker service + compose integration | Low | 1h |

**Total estimate:** ~17h across 2-3 staff engineers

## Risks

1. **Bozeman website structure changes** — Mitigated by selector-based scraping with clear error reporting when selectors fail
2. **PDF format variability** — Bozeman minutes may not follow consistent formatting. Mitigate with fixture-based tests and fallback extraction
3. **Rate limiting / IP blocking** — Mitigate with conservative rate limits and User-Agent identification
4. **Schema drift** — Migrations 007-009 must be compatible with existing 001-006. Test migration up/down locally first

## Execution Plan

1. Approve this plan
2. CTO creates 4 child issues (grouped for parallel work):
   - **Issue A:** Schema + scaffold (tasks 1-2) → Staff Engineer
   - **Issue B:** Scraper (task 3) → Staff Engineer  
   - **Issue C:** Parser + rundown + anomalies (tasks 4-6) → Staff Engineer
   - **Issue D:** Integration tests + Docker (tasks 7-8) → Staff Engineer (after A-C merge)
3. Issues B and C can run in parallel after A merges
4. Issue D depends on A+B+C
