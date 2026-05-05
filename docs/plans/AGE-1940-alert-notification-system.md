# Alert & Notification System — Implementation Plan

**Issue:** AGE-1940
**Status:** Draft, pending approval
**Author:** CTO
**Date:** 2026-05-05

---

## Context

CommissionWatch has anomaly detection running (AGE-1926) with 5 of 6 detector rules implemented in `backend/src/services/anomaly-detection.ts`. Anomaly flags are stored in the `anomaly_flags` table with types (`emergency_session`, `closed_door_vote`, `last_minute_agenda_change`, `quorum_issue`, `unanimous_controversial`, `missing_minutes`) and severities (`low`, `medium`, `high`, `critical`).

The product spec (v3, board-approved 2026-05-04) lists alert triggers as an MVP requirement and the Alert & Briefing Agent (Agent 6) as a Phase 2 deliverable. This plan bridges the gap: a lightweight notification system that completes the MVP feature set without building the full Agent 6.

---

## 1. MVP Scope Decisions

### Delivery Channels (MVP)

| Channel | MVP? | Rationale |
|---------|------|-----------|
| **Email** | Yes | Lowest friction — users already expect email alerts from civic tools. Use Resend (free tier: 100 emails/day, no SMTP infra). |
| **In-app notification feed** | Yes | Simple DB-backed feed displayed on the dashboard. Zero external dependency. |
| **Webhook** | No (Phase 2) | Requires endpoint validation, retry logic, and security signing. Overkill for initial users. |
| **SMS** | No (Phase 3+) | Cost, compliance (TCPA), and carrier registration overhead. |

### Trigger Rules (MVP)

Alerts fire based on anomaly severity, not individual flag types. This avoids per-type configuration complexity while still giving users meaningful filtering.

| Severity | Behavior | Delivery |
|----------|----------|----------|
| `critical` | Immediate alert | Email + in-app |
| `high` | Immediate alert | Email + in-app |
| `medium` | Batched into daily digest | Email (6:00 AM local) + in-app |
| `low` | Batched into weekly digest | In-app only |

Users cannot configure custom thresholds in MVP. The severity-to-delivery mapping is hardcoded but centralized in a config object for easy future extraction.

### Subscription Model (MVP)

**Per-jurisdiction subscriptions.** Users subscribe to one or more jurisdictions and receive alerts for all anomalies detected within that jurisdiction's commissions.

Rationale: The current data model ties anomaly flags to meetings, meetings to commissions, and commissions to jurisdictions. Per-jurisdiction is the natural subscription boundary and avoids requiring users to understand the commission hierarchy upfront.

Phase 2 adds per-commission and per-anomaly-type filtering as optional narrowing on top of jurisdiction subscriptions.

---

## 2. Architecture

### Event Flow

```
detectAnomalies(db, meetingId)
    │
    ├── (existing) inserts rows into anomaly_flags
    │
    └── (new) emits anomaly.detected event
              │
              ▼
        NotificationService.processAnomalyEvent(flags[])
              │
              ├── resolve subscriptions (jurisdiction ← commission ← meeting)
              ├── create notification records (one per subscriber per flag)
              ├── for critical/high: queue immediate email delivery
              └── for medium/low: mark for digest batching
```

### Components

1. **Event emitter** — Lightweight in-process EventEmitter. No message broker for MVP (the detection pipeline and notification pipeline run in the same Node.js process). Decoupled enough that swapping to Redis/BullMQ later requires changing only the emit/listen wiring.

2. **NotificationService** (`backend/src/services/notification.ts`) — Resolves subscriptions, creates notification records, dispatches to delivery channels. Pure service, no HTTP routes of its own.

3. **EmailDeliveryService** (`backend/src/services/email-delivery.ts`) — Wraps the Resend SDK. Renders email from templates. Handles send + status tracking.

4. **DigestScheduler** (`backend/src/services/digest-scheduler.ts`) — Cron job (node-cron) that runs daily at 06:00 UTC. Collects undelivered `medium` notifications, groups by subscriber + jurisdiction, renders digest email, marks as delivered. Weekly digest runs Mondays at 06:00 UTC for `low` severity.

5. **Notification API routes** (`backend/src/routes/notifications.ts`):
   - `GET /api/notifications` — List notifications for authenticated user (filters: read/unread, jurisdiction_id, severity)
   - `PATCH /api/notifications/:id/read` — Mark as read
   - `PATCH /api/notifications/read-all` — Mark all as read
   - `GET /api/notifications/count` — Unread count (for badge)

6. **Subscription API routes** (`backend/src/routes/subscriptions.ts`):
   - `GET /api/subscriptions` — List user's subscriptions
   - `POST /api/subscriptions` — Create subscription (body: `{ jurisdiction_id, email }`)
   - `DELETE /api/subscriptions/:id` — Unsubscribe
   - `PATCH /api/subscriptions/:id` — Update preferences (email_enabled, digest_only)

### Authentication Note

The current backend has no auth system. For MVP, subscriptions are identified by email address (no login required). The `POST /api/subscriptions` endpoint accepts an email + jurisdiction and sends a confirmation/verification email. Each subscription gets a unique unsubscribe token for one-click opt-out. This is the same pattern used by newsletter services and avoids blocking on a full auth system.

---

## 3. Data Model

### New Tables

#### `alert_subscriptions`

```sql
CREATE TABLE alert_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,
  email_enabled   BOOLEAN NOT NULL DEFAULT true,
  digest_only     BOOLEAN NOT NULL DEFAULT false,
  verified        BOOLEAN NOT NULL DEFAULT false,
  verify_token    VARCHAR(64) NOT NULL,
  unsubscribe_token VARCHAR(64) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(email, jurisdiction_id)
);

CREATE INDEX idx_subscriptions_jurisdiction ON alert_subscriptions(jurisdiction_id);
CREATE INDEX idx_subscriptions_email ON alert_subscriptions(email);
CREATE INDEX idx_subscriptions_verify_token ON alert_subscriptions(verify_token);
```

#### `notifications`

```sql
CREATE TABLE notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
  anomaly_flag_id   UUID NOT NULL REFERENCES anomaly_flags(id) ON DELETE CASCADE,
  severity          anomaly_severity NOT NULL,
  read              BOOLEAN NOT NULL DEFAULT false,
  email_status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (email_status IN ('pending', 'queued', 'sent', 'failed', 'skipped')),
  email_sent_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(subscription_id, anomaly_flag_id)
);

CREATE INDEX idx_notifications_subscription ON notifications(subscription_id);
CREATE INDEX idx_notifications_anomaly ON notifications(anomaly_flag_id);
CREATE INDEX idx_notifications_pending_email ON notifications(email_status, severity)
  WHERE email_status = 'pending';
```

### Migration Plan

- **Migration 012**: Create `alert_subscriptions` table
- **Migration 013**: Create `notifications` table

No changes to existing tables required.

---

## 4. Implementation Phases

### Phase A: Data Model & Subscription API (Est. 4h)

1. Write migrations 012 and 013
2. Implement subscription CRUD routes (`/api/subscriptions`)
3. Implement email verification flow (send verify email, confirm endpoint)
4. Add unsubscribe-by-token endpoint (`GET /api/subscriptions/unsubscribe/:token`)
5. Input validation (email format, jurisdiction exists, duplicate check)

**Risks:** None significant. Standard CRUD + token flow.

### Phase B: Notification Service & Event Wiring (Est. 5h)

1. Create `NotificationService` with `processAnomalyEvent(flags[])` method
2. Wire EventEmitter into `detectAnomalies()` — emit after successful flag insert
3. Resolve subscriptions: flag → meeting → commission → jurisdiction → subscribers
4. Create notification records with correct severity and email_status
5. Add notification API routes (`/api/notifications`)

**Risks:**
- The subscription resolution chain (flag → jurisdiction) involves 3 joins. Index on `meeting_id` in anomaly_flags and `commission_id` in meetings already exist. Add index on `jurisdiction_id` in alert_subscriptions (included in schema above).
- `detectAnomalies()` currently has no idempotency (AGE-1927 gap). If detection runs twice, duplicate flags create duplicate notifications. Mitigation: the `UNIQUE(subscription_id, anomaly_flag_id)` constraint on notifications prevents duplicate delivery. This is sufficient for MVP; full idempotency is AGE-1927's scope.

### Phase C: Email Delivery (Est. 4h)

1. Add `resend` package dependency
2. Implement `EmailDeliveryService` with send method and status tracking
3. Create email templates (immediate alert, daily digest, weekly digest, verification, unsubscribe confirmation)
4. Wire immediate delivery for critical/high severity notifications
5. Environment config: `RESEND_API_KEY`, `ALERT_FROM_EMAIL`

**Risks:**
- Resend free tier (100 emails/day) is sufficient for MVP with a single jurisdiction. Monitor usage.
- Email deliverability: Use Resend's managed domain initially. Custom domain (e.g., alerts.commissionwatch.org) can be configured later.

### Phase D: Digest Scheduler (Est. 3h)

1. Add `node-cron` dependency
2. Implement daily digest job (06:00 UTC): collect pending medium-severity notifications, group by subscriber, render digest email, send, update status
3. Implement weekly digest job (Monday 06:00 UTC): same for low-severity
4. Add graceful shutdown handling for cron jobs
5. Add health check integration (report last digest run time)

**Risks:**
- Single-process cron means digests don't run if the server is down. Acceptable for MVP. Phase 2 can move to a separate worker process or use pg-boss for persistence.

### Phase E: Testing & Integration (Est. 3h)

1. Unit tests for NotificationService (subscription resolution, severity routing)
2. Integration tests for subscription and notification API endpoints
3. Integration test for the full flow: detect anomaly → notification created → email queued
4. Manual E2E test: subscribe, trigger detection, verify email received

**Total estimated effort: ~19h across 5 phases**

---

## 5. Dependencies & Blockers

| Dependency | Status | Impact |
|------------|--------|--------|
| Anomaly detection (AGE-1926) | Implemented | Required — notifications trigger from anomaly flags |
| Detection idempotency (AGE-1927) | Planned | Non-blocking — UNIQUE constraint on notifications prevents duplicate delivery |
| Auth system | Not started | Non-blocking — email-based subscriptions bypass auth for MVP |
| Frontend dashboard (AGE-1939) | Planned | Non-blocking for backend; notification feed UI can be a separate frontend task |

---

## 6. What This Plan Does NOT Cover

- **Webhook delivery** — Phase 2, requires signing keys, retry policies, endpoint validation
- **RSS feed** — Phase 2, low effort but low priority vs. email
- **Custom threshold configuration** — Phase 2, requires auth + user preferences UI
- **Per-commission / per-type filtering** — Phase 2, extends subscription model
- **Full Alert & Briefing Agent (Agent 6)** — Phase 2+, this plan delivers the notification plumbing that Agent 6 will later orchestrate
- **Rate limiting** — Should be added when auth lands; not critical for email-verified subscriptions

---

## 7. New Dependencies (npm packages)

| Package | Purpose | Size |
|---------|---------|------|
| `resend` | Email delivery API | ~50KB |
| `node-cron` | Digest scheduling | ~15KB |

Both are well-maintained, MIT-licensed, and have zero native dependencies.
