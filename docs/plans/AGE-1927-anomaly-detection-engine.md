# AGE-1927: Anomaly Detection Engine — Implementation Plan

**Status:** Draft — pending approval
**Author:** CTO Agent
**Date:** 2026-05-05

---

## 1. Current State Assessment

### What exists

The anomaly detection service (`backend/src/services/anomaly-detection.ts`) implements 5 of 6 flag types:

| Flag Type | Status | Trigger Signal |
|-----------|--------|----------------|
| `emergency_session` | Implemented | `meeting.status === "emergency" \|\| "special"` |
| `missing_minutes` | Implemented | No `minutes_url` after 14 days (idempotent) |
| `quorum_issue` | Implemented | Present voters < ceil(total_members/2) + 1 |
| `last_minute_agenda_change` | Implemented | `agenda_item.created_at` < 24h before meeting |
| `unanimous_controversial` | Implemented | All votes same on public_hearing/zoning/budget/ordinance items |
| `closed_door_vote` | **Not implemented** | — |

### Gaps identified

1. **Missing detector:** `closed_door_vote` has no implementation
2. **No idempotency:** Only `missing_minutes` checks for existing flags before insert — all others will create duplicates on re-run
3. **No batch mode:** Detection is per-meeting only (POST `/meetings/:id/detect-anomalies`)
4. **No automation:** Detection never runs automatically after scraping/parsing
5. **No unit tests:** Only API integration tests exist; detection logic is untested in isolation
6. **No audit trail:** Flags are inserted but there's no record of when detection ran or what version of rules produced them
7. **No `agenda_item_id` on flags:** Item-level anomalies (`last_minute_agenda_change`, `unanimous_controversial`) can't link back to the specific agenda item

---

## 2. Detection Rules Design

### 2.1 `closed_door_vote` (new)

**Signal:** Votes recorded on agenda items that occur during an executive/closed session.

**Detection approach:**
- Check `agenda_items` for the meeting where `category` contains "executive_session", "closed_session", or "executive" keywords
- If any such agenda item has associated votes in the `votes` table, flag it
- **Severity:** `high` (votes in closed session are inherently less transparent)
- **Edge case:** Some jurisdictions legitimately vote to enter/exit executive session — exclude items whose title matches "motion to enter/exit executive session"

### 2.2 Improved detection signals (existing rules)

| Rule | Current | Improvement |
|------|---------|-------------|
| `emergency_session` | Checks `status` field only | Also scan agenda title/description for "emergency" keyword when status is "regular" (parser may not set status correctly) |
| `missing_minutes` | 14-day threshold | Add configurable threshold; escalate severity at 30/60/90 days |
| `quorum_issue` | Quorum = ceil(n/2)+1 | Fix: standard quorum is majority = floor(n/2)+1, not ceil+1. Make configurable per jurisdiction. |
| `last_minute_agenda_change` | Returns after first match | Count all late items; include item titles in description for auditability |
| `unanimous_controversial` | Returns after first match | Flag each unanimous item separately; track the specific agenda_item_id |

---

## 3. Architecture Plan

### 3.1 Service refactor: `anomaly-detection.ts`

**Idempotency strategy:** Before inserting, delete existing auto-detected flags for the meeting, then insert fresh. This is simpler than upsert and ensures stale flags from changed data are cleaned up.

```
detectAnomalies(db, meetingId):
  1. Fetch meeting + related data in parallel
  2. Run all check functions
  3. Within a transaction:
     a. DELETE FROM anomaly_flags WHERE meeting_id = ? AND id NOT IN (manually created flags)
     b. INSERT new flags
  4. Return flags
```

**Problem:** We need to distinguish auto-detected flags from manually created ones. Add a `source` column: `'auto' | 'manual'` (default `'auto'`).

### 3.2 Schema migration (012)

```sql
ALTER TABLE anomaly_flags ADD COLUMN agenda_item_id UUID REFERENCES agenda_items(id) ON DELETE CASCADE;
ALTER TABLE anomaly_flags ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'auto';
CREATE INDEX idx_anomaly_flags_agenda_item ON anomaly_flags(agenda_item_id);
```

### 3.3 Batch detection endpoint

```
POST /api/anomalies/detect-batch
Body: { commission_id?, date_from?, date_to?, limit? }
```

Queries meetings matching filters, runs `detectAnomalies` for each, returns summary:
```json
{ "meetings_scanned": 42, "flags_created": 7, "flags_by_type": { ... } }
```

Rate-limit to prevent abuse. Default limit: 100 meetings per call.

### 3.4 Post-scrape automation hook

After the meeting-monitor scraper stores new meetings, it should trigger detection. Two options:

| Approach | Pros | Cons |
|----------|------|------|
| **A. In-process call** — scraper calls detection service directly | Simple, synchronous, immediate | Couples scraper to backend service |
| **B. HTTP trigger** — scraper POSTs to batch endpoint after run | Decoupled, uses existing API | Requires backend to be running during scrape |

**Recommendation:** Option B. The scraper already writes to the DB; after completing a scrape run, POST to `/api/anomalies/detect-batch` with the date range of discovered meetings. This keeps the scraper focused on scraping and the backend owning detection logic.

### 3.5 Detection run audit log

Add a `detection_runs` table:

```sql
CREATE TABLE detection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  flags_created INTEGER NOT NULL DEFAULT 0,
  rules_version VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

Each `detectAnomalies` call logs a run. `rules_version` is a semver string bumped when detection logic changes, enabling auditability of which rules produced which flags.

---

## 4. Implementation Tasks

### Phase 1: Fix foundations (2 subtasks)

| # | Task | File(s) | Complexity | Risk |
|---|------|---------|------------|------|
| 1.1 | Migration 012: add `agenda_item_id`, `source` to anomaly_flags; create `detection_runs` table | `backend/migrations/012_*.ts` | Low | Low — additive schema change |
| 1.2 | Make detection idempotent: transaction-wrap delete+insert, filter by `source='auto'` | `backend/src/services/anomaly-detection.ts` | Medium | Medium — must not delete manual flags |

### Phase 2: Improve detection rules (3 subtasks)

| # | Task | File(s) | Complexity | Risk |
|---|------|---------|------------|------|
| 2.1 | Implement `closed_door_vote` detector | `anomaly-detection.ts` | Medium | Low |
| 2.2 | Fix quorum calculation (floor(n/2)+1), report all late agenda items individually, flag each unanimous item separately, populate `agenda_item_id` | `anomaly-detection.ts` | Medium | Medium — changes existing behavior |
| 2.3 | Add `rules_version` constant and detection run logging | `anomaly-detection.ts` | Low | Low |

### Phase 3: Batch & automation (2 subtasks)

| # | Task | File(s) | Complexity | Risk |
|---|------|---------|------------|------|
| 3.1 | Add `POST /api/anomalies/detect-batch` endpoint | `backend/src/routes/anomalies.ts` | Medium | Low |
| 3.2 | Add post-scrape HTTP trigger in meeting-monitor | `agents/meeting-monitor/src/index.ts` | Low | Low — optional, fails gracefully |

### Phase 4: Testing (2 subtasks)

| # | Task | File(s) | Complexity | Risk |
|---|------|---------|------------|------|
| 4.1 | Unit tests for all 6 detection rules with mock meeting data | `backend/test/anomaly-detection.test.ts` | Medium | Low |
| 4.2 | Integration test for batch endpoint and idempotency | `backend/test/anomalies.test.ts` | Medium | Low |

### Total: 9 subtasks across 4 phases

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Idempotency refactor deletes manual flags | High | Filter delete by `source = 'auto'`; add integration test verifying manual flags survive re-detection |
| Quorum formula change alters existing flags | Medium | Existing flags are point-in-time snapshots; re-running detection will update them. Document the change. |
| Batch endpoint overwhelms DB on large date ranges | Medium | Default limit of 100 meetings; sequential processing with early exit on error |
| `closed_door_vote` false positives on procedural votes | Low | Exclude items matching "motion to enter/exit executive session" pattern |

---

## 6. Testing Strategy

All detection rules must be testable with mock data (no real DB required for unit tests):

- **Unit tests:** Each check function receives a mock `Knex` instance with pre-configured query results. Tests verify correct flag type, severity, description, and null returns for non-matching data.
- **Integration tests:** Seed a test DB with known meeting data, run detection, verify flags are created correctly and idempotently.
- **Edge cases:** Empty meetings (no agenda items, no votes), meetings with all members absent, meetings with only procedural items.

---

## 7. Constraints Checklist

- [x] Integrates with existing meetings/agenda_items pipeline (uses same tables, FK relationships)
- [x] Testable with mock meeting data (unit tests with mock Knex)
- [x] Severity scoring transparent and auditable (detection_runs table, rules_version, descriptive flag text)
