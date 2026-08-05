# W7 — Delivery Channels (Discord + admin-configurable routing)

> Status: approved 2026-08-04
> Extends the existing notification subsystem. Admin UI depends on W3's authenticated surface.

## Goal

Route both engineering events (build, deploy, release) and product events (anomaly flagged, finding published, ingestion degraded) to Discord, with channels and routing rules configurable by the operator rather than hardcoded.

## Why this is a refactor, not an addition

The current subsystem treats email as the only channel:

- `alert_subscriptions` has an `email` column
- `notifications` has `email_status` and `email_sent_at`
- `NotificationService` reacts to an in-process `anomaly.detected` EventEmitter

Adding `discord_status` beside `email_status` would repeat itself for every future channel. Instead, channel becomes a first-class concept and email becomes one channel type among several.

**Constraint: the existing email path keeps working throughout.** New tables are additive. The email flow migrates onto the new dispatcher only once the dispatcher is proven, and its tests must stay green at every commit.

## Data model

### `delivery_channels`
`id`, `channel_type` (`discord` | `email` | `webhook`), `name`, `config_encrypted` (bytea), `enabled`, `created_at`, `updated_at`.

The Discord webhook URL is a credential and lives in `config_encrypted`, AES-256-GCM, key from `CHANNEL_SECRET_KEY` in the environment. It is never stored in plaintext, never logged, and never committed.

### `channel_routes`
`id`, `channel_id`, `event_type`, `min_severity` (nullable), `jurisdiction_id` (nullable), `enabled`.

A route is "send events of this type, at or above this severity, for this jurisdiction, to this channel." Absent filters mean no filtering.

### `deliveries`
`id`, `channel_id`, `event_type`, `payload` (jsonb), `dedupe_key`, `status` (`pending` | `sent` | `failed` | `skipped`), `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at`.

Deliberately the same shape as `ingestion_jobs` — durable, retried with backoff, and inspectable. A failed Discord post is a row you can read, not a lost log line.

`dedupe_key` is unique per channel: the same anomaly can never notify the same channel twice.

## Events

**Product events**, emitted by the application:

| Event | Payload |
|---|---|
| `anomaly.flagged` | flag type, severity, meeting, jurisdiction, link |
| `finding.approved` | title, jurisdiction, approver, link |
| `finding.published` | title, jurisdiction, link |
| `ingestion.source_degraded` | source, consecutive failures, last success, error |
| `ingestion.run_failed` | source, run id, error |
| `meeting.ingested` | jurisdiction, meeting date, item and vote counts |

**Engineering events**, emitted by CI:

| Event | Payload |
|---|---|
| `ci.build_failed` | job, commit, run URL, log tail |
| `ci.deploy_succeeded` | environment, commit, version |
| `ci.deploy_failed` | environment, commit, error |
| `release.shipped` | version, commit range, summary |

## Transport, and why CI has a fallback

Product events go straight to the dispatcher in-process.

CI events POST to `/api/internal/events` with a bearer `CI_EVENT_TOKEN`, so they obey the same admin-configured routing as everything else.

**If that request fails or times out (3s), the CI script posts directly to `DISCORD_WEBHOOK_URL` instead.** This matters: a deploy that broke the backend is exactly when the backend cannot be trusted to tell you the deploy broke. The fallback message is marked as having bypassed routing, so it is obvious why it looks different.

This mirrors the existing `scripts/ci-notify-tracker.sh` pattern, which already files CI failures into Tracker. Tracker notification stays — Discord is added alongside, not substituted.

## Discord specifics

These are the details that make an integration work in production rather than in a demo:

- **Rate limit:** 5 requests per 2 seconds per webhook. Honor `429` and its `retry_after` value rather than blind retry.
- **Size limits:** content 2000 chars; embed title 256; description 4096; 25 fields per embed; 10 embeds per message; 6000 chars total across embeds. Payloads are truncated to fit with an explicit ellipsis, never silently.
- **Batching:** a bulk ingestion can flag 40 anomalies at once. The dispatcher batches events of the same type within a short window into one message of up to 10 embeds, so a sweep produces one notification rather than forty.
- **Presentation:** embeds colored by severity, with a link back to the relevant page on the site.

## Security

The admin UI accepting a webhook URL creates two risks that must be closed:

1. **SSRF.** An operator-supplied URL is a request the server will make. Discord channel URLs are validated against an allowlist of `discord.com` and `discordapp.com` hosts, HTTPS only. Generic `webhook` channels resolve the host and reject private, loopback, and link-local address ranges.
2. **Credential disclosure.** The API never returns a stored webhook URL. Reads return a masked form showing host and last four characters only. Writes are accepted but never echoed back.

Admin routes require W3's authenticated session. Until W3 lands, channel configuration is environment-only and the admin endpoints are not mounted.

## Testing

- Rate-limit handling: a mocked `429` with `retry_after` is respected, not hammered.
- Truncation: an oversized payload is cut to Discord's limits with a visible marker.
- Batching: 40 events in the window produce one message with 10 embeds and an overflow count.
- Dedupe: the same anomaly delivered twice inserts one row and posts once.
- Encryption round-trip: a stored URL is unreadable in the raw column and recoverable through the service.
- Masking: no API response contains a full webhook URL — asserted against every channel endpoint.
- SSRF: URLs pointing at `localhost`, `127.0.0.1`, `169.254.169.254`, and private ranges are rejected.
- CI fallback: when `/api/internal/events` times out, the script posts directly and marks the message as bypassing routing.
- The existing email notification tests keep passing at every commit.

## Out of scope

- Slack, Teams, SMS. The channel abstraction makes them small later; building them now is speculation.
- Per-user Discord DMs.
- Two-way interaction (Discord commands driving the app).
