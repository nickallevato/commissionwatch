> **SUPERSEDED — built and shipped dark, marked 2026-08-16.**
>
> Verified present on 2026-08-16: `backend/migrations/024_unify_subscription_delivery.ts` and the
> `delivery_channels` consumers in `backend/src/services/delivery/`.
>
> **Built is not on.** These surfaces are deliberately dormant behind `EVENT_DRAIN_ENABLED` and
> send no product events. Superseded here means the code exists, not that delivery is live.
>
> The unchecked boxes below are **not outstanding work**. They are the step-by-step transcript
> of work that shipped; nobody went back to tick them. They are left unticked rather than ticked
> retroactively, because ticking a box nobody watched pass would be a claim, and this project does
> not make those. Read `CHANGELOG.md` and `docs/STATUS.md` for what is actually true now.

# Subscriptions and Delivery Unification Implementation Plan (B-e)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse two rival implementations of one idea into one. `origin/main` ships `alert_subscriptions` + `notifications` + a digest scheduler that `/api/health` reports **running right now, delivering to nobody**, beside a W7 delivery layer with channels, routes, a dispatcher and a Discord transport that **no subscriber can reach**. This makes the delivery layer the single substrate and expresses a subscription in its terms.

> A subscription is a **destination** (email, webhook, SMS, Discord) plus a **filter** (jurisdiction, event type, minimum severity) plus a **cadence** (immediate, daily, weekly).

**Sources, in precedence order:**
1. `docs/superpowers/specs/2026-08-04-delivery-channels-design.md` — W7, approved. Read it first. Everything it specifies stands.
2. `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` § "B-e" — the deltas, and one explicit reversal (SMS).

**Do not re-derive** what W7 already settled: AES-256-GCM `config_encrypted`; the API never returning a webhook URL; SSRF defence; admin routes requiring the authenticated session; subscription tokens classified as credentials. Those are implemented in `src/services/delivery/` and stay as they are.

## Global Constraints

- Never silence a type error; never delete or skip a test to go green.
- The database schema is the source of truth for types.
- **No native/node-gyp dependencies.** No Twilio SDK — the REST API is one HTTPS POST with basic auth, and `node:crypto` covers request-signature validation.
- Tests must never hit the network. Inject `fetch`.
- Register every new test file in `backend/package.json`'s `test` script.
- Migration numbering continues from `023_create_operator_sessions.ts`.
- **W7's standing constraint: the existing email path keeps working throughout and its tests stay green at every commit.** `subscriptions.test.ts`, `notifications.test.ts`, `notification-service.test.ts`, `digest-scheduler.test.ts` and `alert-flow.integration.test.ts` must not be edited to accommodate this work.
- **Nothing here starts sending.** `CLAUDE.md`: alert subscriptions, the digest scheduler and email delivery "must keep compiling and passing tests, but send nothing until the review queue ships — emailing generated claims about named officials would bypass the publication gate." That applies to every channel this plan adds, SMS included. This work builds the substrate; it does not open the tap.

## The one thing that could go wrong, and the design that prevents it

Back-filling `alert_subscriptions` into `delivery_channels` creates a second record of the same subscriber. If both the legacy `EmailDeliveryService` and the new dispatcher could send email, every verified subscriber would be notified twice.

They cannot, and the reason is structural rather than a flag someone must remember to set: `DeliveryDispatcher.sendBatch` already marks any non-`discord` channel `skipped` with the reason recorded on the row. Email therefore has exactly one sender — the legacy path — for this release. This plan **adds an `sms` transport and does not add an `email` one.** Cutting email over to the dispatcher and dropping `alert_subscriptions` is the separate change W7 and B-e both call for, and it belongs after this one has been live.

There is a test whose only job is to hold that line.

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/024_unify_subscription_delivery.ts` | `cadence`, `owner_kind`, subscriber identity columns, `sms` channel type, `deferred` delivery status, per-route send cap. |
| `backend/migrations/025_backfill_subscriber_channels.ts` | Existing `alert_subscriptions` rows expressed on the unified model. The old table is left intact and read-only. |
| `backend/src/services/delivery/subscriptions.ts` | `SubscriptionService` — subscribe, verify, unsubscribe, read by token. Subscriber-scoped, never operator. |
| `backend/src/services/delivery/sms.ts` | Twilio REST over injected `fetch`, request-signature validation, `STOP`/`START` keyword handling. |
| `backend/src/services/delivery/dispatcher.ts` | Cadence deferral, the SMS transport, and the per-day cap. |
| `backend/src/routes/alerts.ts` | Public self-serve: `POST /api/alerts`, `GET/PATCH/DELETE /api/alerts/:token`, `GET /api/alerts/verify/:token`. |
| `backend/src/routes/admin/channels.ts` | Operator-only channel and route management, behind `requireOperator`. |
| `backend/src/routes/sms.ts` | `POST /api/sms/inbound` — Twilio's inbound webhook, signature-checked. |
| `backend/test/subscription-service.test.ts`, `backend/test/sms.test.ts`, `backend/test/alerts-routes.test.ts`, `backend/test/admin-channels.test.ts` | New behaviour. |
| `frontend/src/pages/SubscribePage.tsx` (+ test) | Public self-serve, in the editorial design system. |
| `frontend/src/pages/AdminChannelsPage.tsx` (+ test) | Operator channel list and route management. |

---

### Task 1: Schema deltas — migration 024

Spec deltas 1 and 2, plus what SMS needs.

| Change | Why |
|---|---|
| `channel_routes.cadence` — `immediate\|daily\|weekly`, default `immediate` | W7's routes are implicitly immediate. This is the column that lets the existing digest scheduler drive the others instead of running as a parallel system. |
| `delivery_channels.owner_kind` — `operator\|subscriber`, default `operator` | An operator's Discord webhook and a reader's email address can share a table but must not share a permission model. Every admin route filters to `operator`; every self-serve route to `subscriber`, scoped to the token holder. |
| `delivery_channels.verified`, `verify_token`, `unsubscribe_token`, `verified_at` | A subscriber destination is unconfirmed until its holder proves control of it. Tokens are credentials (launch-readiness § data handling) and are unique. |
| CHECK: `owner_kind <> 'subscriber' OR (verify_token IS NOT NULL AND unsubscribe_token IS NOT NULL)` | A subscriber row without tokens is unreachable and unremovable by its own holder. The database refuses to hold one. |
| `channel_type` CHECK extended with `sms` | Spec § B-e, the recorded reversal of W7's out-of-scope line. |
| `channel_routes.daily_send_cap` (nullable int) | SMS costs money per message. NULL means uncapped, which is right for every free channel. |
| `deliveries.status` CHECK extended with `deferred` | A message held for a digest, or held because a cap was hit, is neither sent nor failed nor skipped. Reusing `skipped` would make "we decided not to" indistinguishable from "we will, later". |

**Trap:** `delivery_channels.name` is `UNIQUE`. That is correct under the unified model and must stay: one destination is one channel, and the filters live in its routes. A reader subscribing to two jurisdictions gets one channel and two routes — which is exactly the shape `alert_subscriptions`' `(email, jurisdiction_id)` unique key was approximating.

- [ ] Write migration 024 with all of the above. `down` reverses each.
- [ ] Apply it; confirm the existing delivery tests still pass untouched.

### Task 2: Back-fill — migration 025

- [ ] For each `alert_subscriptions` row: upsert a `delivery_channels` row (`channel_type='email'`, `owner_kind='subscriber'`, `name` = the email address, `config_encrypted` = the encrypted `{ email }`, `verified` carried across, tokens carried across), then insert a `channel_routes` row (`event_type='anomaly.flagged'`, `jurisdiction_id`, `cadence` = `digest_only ? 'daily' : 'immediate'`).
- [ ] Two subscriptions from one address to two jurisdictions collapse to one channel and two routes. That is the point, not a lossy conversion.
- [ ] `CHANNEL_SECRET_KEY` may be absent when migrations run. **A migration that throws leaves the deploy dead**, so the back-fill skips with a loud log when the key is missing and is safe to re-run once it is present. Idempotent by `name` and by `(channel_id, event_type, jurisdiction_id)`.
- [ ] The old table is **not** modified and **not** dropped.

### Task 3: `SubscriptionService`

- [ ] `subscribe({ channel_type, destination, jurisdiction_id, event_type, min_severity, cadence })` → creates or reuses the subscriber channel, adds the route, returns the verify token **once**.
- [ ] `verify(token)` → marks verified, stamps `verified_at`, clears the token. Idempotent.
- [ ] `unsubscribe(token)` → disables every route on that channel and the channel itself. Idempotent.
- [ ] `readByToken(token)` → the subscriber's own view: masked destination, their routes. **Never the raw destination** — W7's masking rule applies to subscriber channels for the same reason it applies to operator ones.
- [ ] Every method is scoped to `owner_kind = 'subscriber'`. An operator channel id handed to a self-serve route is a 404, not a 403 — the caller has no business learning it exists.
- [ ] SMS destinations require confirmed opt-in **before first send**, which is a stricter bar than email's. Enforced in the dispatcher, not only here.

### Task 4: SMS transport

- [ ] `sms.ts`: `TwilioClient` with injected `fetch`, `accountSid`, `authToken`, `fromNumber`. POST form-encoded to `https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` with basic auth. No SDK.
- [ ] E.164 validation on destinations. Reject anything else before it is stored.
- [ ] `validateTwilioSignature(authToken, url, params, header)` — HMAC-SHA1 over the URL concatenated with sorted key/value pairs, compared with `timingSafeEqual`. Pure `node:crypto`.
- [ ] Inbound keyword handling: `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` unsubscribe; `START`, `YES`, `UNSTOP` resubscribe; `HELP` returns the help text. Case-insensitive, whitespace-trimmed.
- [ ] `POST /api/sms/inbound` rejects an unsigned or wrongly-signed request with 403 **before** looking anything up.

### Task 5: Dispatcher — cadence, cap, SMS

- [ ] A route whose `cadence` is not `immediate` produces a `deferred` delivery row and sends nothing now. The digest scheduler picks those up.
- [ ] `sms` channels send through `TwilioClient`. A channel that is `owner_kind='subscriber'` and not `verified` is `skipped` with that reason on the row — consent is enforced at the transport, so no future caller can route around it.
- [ ] Per-day cap: count today's `sent` deliveries on the route's channel; at or over `daily_send_cap`, the row becomes `deferred` with the reason, **never dropped silently**.
- [ ] Email remains `skipped`. There is a test asserting the dispatcher does not send email, so the double-send this plan's back-fill could otherwise cause is impossible by construction.

### Task 6: Routes

- [ ] `src/routes/alerts.ts` — public. `POST /api/alerts` (subscribe), `GET /api/alerts/verify/:token`, `GET /api/alerts/:token` (own view, masked), `PATCH /api/alerts/:token` (cadence/severity), `DELETE /api/alerts/:token` (unsubscribe). Mounted at `/api/alerts`. `/api/subscriptions` is untouched.
- [ ] `src/routes/admin/channels.ts` — behind `requireOperator`, mounted inside the admin router so the guard is not optional. Lists and manages `owner_kind='operator'` channels and their routes. **Reads are masked; a write is accepted and never echoed back.**
- [ ] `src/routes/sms.ts` — mounted at `/api/sms`, needs `express.urlencoded` for Twilio's form encoding.

### Task 7: Frontend

- [ ] `SubscribePage` at `/subscribe`: pick a jurisdiction, an email address, a cadence; explains verification. Editorial design system, not the archive's dark markup.
- [ ] `AdminChannelsPage` at `/admin/channels`, behind `ProtectedRoute`: the operator's channels with masked config, their routes, and an add-channel form. **The form shows a masked value and accepts a replacement — it never reads a credential back to populate itself.** That is W7's rule and the invariant B-e restates.
- [ ] Add `/subscribe` to the masthead nav only if `chrome-links.test.tsx` stays green; it walks the nav and asserts every link resolves.

### Acceptance

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test -- --run
```

- The five legacy email suites pass **unedited**.
- The dispatcher sends no email, asserted.
- No unverified subscriber destination is ever sent to, asserted.
- An unsigned inbound SMS request is refused, asserted.
- No API response contains a raw webhook URL, phone number or subscriber email, asserted.
- No new runtime dependency.
