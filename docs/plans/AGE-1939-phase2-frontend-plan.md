# AGE-1939: Phase 2 Frontend Integration Plan

## Overview

Integrate Phase 2 backend endpoints (members, votes, anomaly flags) into the existing React/TypeScript dashboard. The frontend uses React 18, React Router v6, TanStack Query, Tailwind CSS (dark mode), and Vite.

## Current State

- **Frontend**: 4 pages (Home, Meetings list, Meeting detail, 404), 3 components (Layout, RundownViewer, StatusBadge)
- **Data layer**: `fetchJson<T>()` wrapper + React Query hooks in `useMeetings.ts`
- **Backend Phase 2 endpoints ready**:
  - `GET /api/members` (list, filter by jurisdiction_id)
  - `GET /api/members/:id` (detail)
  - `GET /api/votes` (list, filter by meeting_id/agenda_item_id/member_id)
  - `GET /api/meetings/:id/votes` (votes for a meeting)
  - `GET /api/anomalies` (list, filter by meeting_id/flag_type/severity)
  - `GET /api/meetings/:id/anomalies` (anomalies for a meeting)

## Implementation Steps

### Step 1: TypeScript Types (types/index.ts)

Add new interfaces:

```typescript
export type VoteValue = "yes" | "no" | "abstain" | "absent";
export type AnomalyFlagType = "emergency_session" | "closed_door_vote" | "last_minute_agenda_change" | "quorum_issue" | "unanimous_controversial" | "missing_minutes";
export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface Member {
  id: string;
  name: string;
  title: string | null;
  jurisdiction_id: string;
  term_start: string | null;
  term_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vote {
  id: string;
  meeting_id: string;
  agenda_item_id: string;
  member_id: string;
  vote: VoteValue;
  created_at: string;
  updated_at: string;
}

export interface AnomalyFlag {
  id: string;
  meeting_id: string;
  flag_type: AnomalyFlagType;
  description: string | null;
  severity: AnomalySeverity;
  created_at: string;
  updated_at: string;
}
```

### Step 2: React Query Hooks (hooks/useMembers.ts, hooks/useAnomalies.ts)

**`hooks/useMembers.ts`** — new file:
- `useMembers(jurisdictionId?)` — fetches `/api/members?jurisdiction_id=...`
- `useMember(id)` — fetches `/api/members/:id`

**`hooks/useVotes.ts`** — new file:
- `useMeetingVotes(meetingId)` — fetches `/api/meetings/:id/votes`
- `useVotes(filters?)` — fetches `/api/votes` with optional filters

**`hooks/useAnomalies.ts`** — new file:
- `useMeetingAnomalies(meetingId)` — fetches `/api/meetings/:id/anomalies`
- `useAnomalies(filters?)` — fetches `/api/anomalies` with optional filters

### Step 3: New Components

**`components/VoteBreakdown.tsx`**
- Takes `votes: Vote[]` and `members: Member[]` as props
- Displays yea/nay/abstain/absent counts as colored pills
- Expandable section showing each member's vote
- Color: green (yes), red (no), gray (abstain), dim (absent)

**`components/AnomalyBadge.tsx`**
- Compact badge for use in meeting list cards
- Shows count of anomalies with severity-based coloring
- critical/high = red, medium = amber, low = gray

**`components/AnomalyCard.tsx`**
- Full anomaly display for detail/panel views
- Shows flag_type (formatted), severity badge, description
- Icon per flag type

**`components/MemberCard.tsx`**
- Profile card showing name, title, jurisdiction, term dates
- Compact design consistent with existing card patterns

### Step 4: New Pages

**`pages/MembersPage.tsx`** — route: `/members`
- Jurisdiction filter dropdown (reuse pattern from MeetingsPage)
- Grid of MemberCard components
- Empty state when no members

**`pages/AnomaliesPage.tsx`** — route: `/anomalies`
- Filter by severity and flag_type
- List of AnomalyCard components with meeting links
- Empty state

### Step 5: Modify Existing Pages

**`pages/MeetingDetailPage.tsx`**
- Add vote breakdown per agenda item (fetch votes + members, group by agenda_item_id)
- Add anomaly flags section below rundown (fetch meeting anomalies)
- Use VoteBreakdown and AnomalyCard components

**`pages/MeetingsPage.tsx`**
- Add AnomalyBadge to each meeting card (fetch anomalies per visible meeting, or batch)
- Show anomaly count badge next to StatusBadge

**`pages/HomePage.tsx`**
- Add "Recent Anomalies" panel showing latest flagged items

### Step 6: Navigation & Routing

**`App.tsx`** — add routes:
- `/members` → MembersPage
- `/anomalies` → AnomaliesPage

**`components/Layout.tsx`** — add nav items:
- "Officials" (UsersIcon) → `/members`
- "Anomalies" (AlertIcon) → `/anomalies`

### Step 7: MSW Mock Data

Update `mocks/data.ts` with mock members, votes, and anomaly flags.
Update `mocks/handlers.ts` with handlers for all new endpoints.

### Step 8: Testing

- Add tests for new hooks (mock fetch responses)
- Add tests for VoteBreakdown, AnomalyBadge, AnomalyCard, MemberCard
- Add tests for MembersPage and AnomaliesPage
- Verify no regressions in existing meeting tests

## File Change Summary

| File | Action | Complexity |
|------|--------|------------|
| `src/types/index.ts` | Modify | Low |
| `src/hooks/useMembers.ts` | Create | Low |
| `src/hooks/useVotes.ts` | Create | Low |
| `src/hooks/useAnomalies.ts` | Create | Low |
| `src/components/VoteBreakdown.tsx` | Create | Medium |
| `src/components/AnomalyBadge.tsx` | Create | Low |
| `src/components/AnomalyCard.tsx` | Create | Low |
| `src/components/MemberCard.tsx` | Create | Low |
| `src/pages/MembersPage.tsx` | Create | Medium |
| `src/pages/AnomaliesPage.tsx` | Create | Medium |
| `src/pages/MeetingDetailPage.tsx` | Modify | Medium |
| `src/pages/MeetingsPage.tsx` | Modify | Low |
| `src/pages/HomePage.tsx` | Modify | Low |
| `src/App.tsx` | Modify | Low |
| `src/components/Layout.tsx` | Modify | Low |
| `src/mocks/data.ts` | Modify | Medium |
| `src/mocks/handlers.ts` | Modify | Low |
| Tests (various) | Create | Medium |

## Risks

1. **API response shape mismatch** — Backend returns `{ data: T[], total: number }` for list endpoints, but existing frontend hooks expect raw arrays. The hooks must unwrap `.data` from paginated responses.
2. **N+1 fetches on MeetingsPage** — Fetching anomalies per-meeting in the list view could be chatty. Mitigation: use the bulk `GET /api/anomalies?meeting_id=...` endpoint, or fetch all anomalies once and index client-side.
3. **Vote display without members context** — VoteBreakdown needs member names alongside votes. Must co-fetch members when displaying votes.

## Estimated Effort

~6-8 hours for a single engineer. No architectural changes needed — this is additive work following established patterns.

## Delegation

Assign to **Staff Engineer 2** (agent `4f334dc0-9b6e-41d6-a543-9d05408639ec`) per issue instructions.
