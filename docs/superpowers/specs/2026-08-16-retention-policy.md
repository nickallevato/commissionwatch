# Retention policy — reader PII and internal ledgers

Roadmap 7.3. `PrivacyPage.tsx` (`frontend/src/pages/PrivacyPage.tsx`) already states the honest
absence of a schedule: "Personal information you gave us has no deletion schedule yet... that is
not a considered retention policy, it is the absence of one." This spec is the policy that closes
that gap — per store, what is kept, why, for how long, what enforces it, and whether a person can
have it removed on request.

**Method.** Every claim below is read from a migration, a service, or a command run against the
tree on 2026-08-16, not from prose. File paths and migration numbers are cited inline.

---

## Summary table

| Store | Personal data held | Deletable on request? | What enforces retention today |
|---|---|---|---|
| `alert_subscriptions` (legacy) | email | Yes — operator-only hard `DELETE` route | Nothing automatic |
| `delivery_channels` (subscriber rows) | email/phone, encrypted config | No — disable only, by design | Nothing automatic |
| `record_disputes` | free-text contact | No self-serve; operator can edit only via a correction | Nothing automatic |
| `dispute_notifications` | hashed address only | Cascades with its dispute | N/A — no plaintext to remove |
| `email_suppressions` | hashed address only | No — must persist by design | N/A — permanent by design |
| `record_corrections` | operator email (not reader PII) | **No — DB-enforced, not deletable, ever** | Trigger (migration 031) |
| `operator_sessions` | operator IP, user agent | Session ends on revoke; row itself is not purged automatically | `sweepExpiredSessions()` exists but **nothing calls it** |
| `export_snapshots` / `export_snapshot_runs` | none (public record only) | See existing spec — deletion refused | Schema bound (`_runs`); none (`_snapshots`, by design) |

---

## 1. Subscriber email addresses and delivery channels

**Tables:** `alert_subscriptions` (migration 012, `backend/migrations/012_create_alert_subscriptions.ts`)
and the unified `delivery_channels` / `channel_routes` / `deliveries` set (migrations 015, 024).

**What is kept.** `alert_subscriptions.email` in plaintext (it is a lookup key — migration 012
indexes it directly). `delivery_channels.config_encrypted` holds the channel's destination
(email address, phone number, or webhook URL) as an AES-256-GCM ciphertext keyed by
`CHANNEL_SECRET_KEY` (`backend/src/services/delivery/crypto.ts` — "Never stored, returned, or
logged in plaintext" per migration 015's own comment). Subscriber channels also carry
`verify_token` and `unsubscribe_token` (migration 024), each a bearer credential.

**Why it is kept.** These are addresses a person gave us specifically so we would write to them.
Retention is not incidental here — the record has to persist for the subscription to function.

**Deletion path.**
- `alert_subscriptions` has a hard `DELETE` route (`backend/src/routes/subscriptions.ts:242`,
  `router.delete("/:id", requireOperator, ...)`) — but it is **operator-gated**, not self-serve. A
  subscriber has no route that deletes their own row.
- One-click unsubscribe (`backend/src/routes/list-unsubscribe.ts`) and the `SubscriptionService`
  it calls **never delete** a `delivery_channels` row. The service's own comment
  (`backend/src/services/delivery/subscriptions.ts:267`) states the reason: "not... deleted so the
  unsubscribe token stays resolvable — a second click on the link in an old email must say 'you
  are unsubscribed', not 404." Unsubscribing sets `enabled = false` on the channel and its routes;
  the encrypted destination stays in the table.
- Nothing greps in this codebase performs a `DELETE` on `delivery_channels` at all.

**What enforces this.** Nothing. No job expires an unsubscribed or unverified channel; no code
path purges an old `alert_subscriptions` row. An address that unsubscribed in week one is still
present, disabled, indefinitely.

**Policy stated here, not yet built.** An unsubscribed or never-verified channel should have a
retention ceiling — proposed: purge the encrypted destination (not the row, so the unsubscribe
token keeps resolving) after a fixed window past `unsubscribe`/non-verification, e.g. 180 days.
**This is a decision, not a claim of existing behavior** — nothing implements it yet, and a person
who wants deletion sooner has no automated path today, only the operator's manual `DELETE` route
or a written request.

---

## 2. Dispute submissions (`record_disputes`)

**Table:** migration 039, `backend/migrations/039_create_record_disputes.ts`. **Service:**
`backend/src/services/disputes.ts`.

**What is kept, and no more.** Three fields, each length-capped by a database CHECK: `contested`
(≤300 chars), `account` (≤4000 chars), `contact` (≤200 chars free text). Migration 039's own header
is explicit about the ceiling: "No identity documents, no address, no account, no IP." There is no
IP or user-agent column — confirmed by reading the migration, not by the route's comment.

**The rate limiter stores nothing per submitter.** `RATE_LIMITS.perClientPerHour` /
`perClientPerDay` (`backend/src/services/disputes.ts:83-100`) run against an in-process
`FixedWindowLimiter` keyed by the caller's IP, held in memory only — "gone with the process." This
is a deliberate design choice to avoid a fourth piece of personal information (the submitter's IP)
landing anywhere durable; the two durable caps (`globalPerHour`, `perTargetOpen`) are counted from
`record_disputes` itself, which already holds no IP to leak.

**Why kept.** A dispute is the input to an operator decision, and `dispute_notifications`
(migration 092) needs the live `contact` value to send exactly one acknowledgement and one outcome
message — the address is deliberately **not** duplicated into the notification ledger (see §4).

**Deletion path.** No self-serve deletion exists — there is no dispute-holder token that resolves
to a delete route, unlike the unsubscribe token for subscriptions. `PrivacyPage.tsx` states the
only path today is a written request to the corrections address, handled manually. Migration 039
places no CHECK against updating or deleting `record_disputes` rows themselves (unlike
`record_corrections` — see §3), so an operator *can* scrub a `contact` value by hand; nothing
automates it.

**What enforces retention.** Nothing. A resolved dispute (status `upheld` or `declined`) is kept
exactly as long as an open one.

**Policy stated here.** Keep dispute rows themselves permanently — `status`, `reviewer_email`,
`review_reason` and the linked `record_corrections` row are part of the accountability trail for
*this project's own decision*, and deleting them would erase evidence of why a correction was or
was not made. But `contact` is reader-supplied PII with no accountability function once the dispute
is decided. Recommend: on operator request (the existing written-request path), the `contact`
column of a *decided* dispute may be redacted to `NULL` — this does not touch `status`,
`review_reason`, or the append-only `record_corrections` entry, so the decision trail survives even
when the contact does not. **Not yet implemented.**

---

## 3. `record_corrections` — not deletable, and that is the design

**Table:** migration 031, `backend/migrations/031_create_record_corrections.ts`. Widened by
migration 039 to admit `record_disputes` as a target.

**What is kept.** `target_table`/`target_id`, `field`, `old_value`/`new_value`, a mandatory
`reason`, and the acting operator's id **and** a snapshotted `operator_email` (migration 031's own
comment: captured "so the row survives the operator's deletion still naming who acted"). This is
the one place in the schema holding an operator's email as a durable, unremovable record.

**Why it cannot be deleted, and why that is right, not an oversight.** Migration 031's header
states the reasoning directly: "A transparency project that edits its own evidence has nothing left
to stand on." A `BEFORE UPDATE OR DELETE` trigger (`record_corrections_append_only()`) raises on
both operations — this is enforced by PostgreSQL, not by application convention. Migration 039's
`down()` documents the corollary: rolling back a widened CHECK "fails loudly once any dispute has
been logged... the log cannot be un-widened once it holds a decision." The table is built to be a
ratchet.

**The retention answer for this table is therefore not "how long" — it is "forever, and that is
the point."** A ledger that legally cannot be pruned is a retention decision already made by the
schema itself; this policy does not soften it, does not offer a subject-access deletion path for
it, and does not treat its unbounded growth as an open question to schedule work against.

**Growth, measured.** `docs/STATUS.md` and `docs/superpowers/specs/2026-08-16-maturity-review.md`
both record **14,528 rows in the test database**, growing every test run — this is a test-fixture
artifact of seed/teardown cycles hitting an append-only table, **not a production figure**, and
this spec does not have a production row count to cite (none was measured against `/api/metrics`
for this table). In production, growth is bounded by actual operator review decisions and dispute
resolutions — human-paced, not machine-paced.

**Personal data in this table.** `operator_email` is project-staff data, not reader PII, and staff
consent to that as a condition of holding the role — migration 031 treats it as an audit
requirement, not a privacy liability. No reader-supplied contact information is stored here; a
dispute's `contact` lives in `record_disputes`, joined only by `dispute_id`, and is not copied into
the correction row.

**Subject access.** There is no removal path for this table and none is proposed. If storage ever
forces the question, the answer is archival (moving old rows to cold storage, unreadable by the
live application) rather than deletion — this spec does not design that, since nothing today
indicates it is needed.

---

## 4. Operator sessions (`operator_sessions`) and the audit trail

**Table:** migration 023, `backend/migrations/023_create_operator_sessions.ts`. **Service:**
`backend/src/services/auth/operators.ts`.

**What is kept.** `token_hash` (SHA-256 of the session cookie, never the raw token — "a read of
this table therefore yields nothing anyone can present as a session"), `ip`, `user_agent`,
`created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`. `ip` and
`user_agent` are the personal data here, belonging to project operators (staff), not readers.

**Why kept.** Session validation and the sliding idle-expiry window need this row to exist for the
life of the session; `ip`/`user_agent` support incident investigation for the one account class
capable of publishing to the site.

**Lifecycle.** `revokeSession()` sets `revoked_at` on sign-out — the session stops being valid
immediately, but **the row is not deleted**. `validateSession()` refuses any session past
`idle_expires_at` or `absolute_expires_at`, but again leaves the row in place.

**What enforces cleanup.** `AuthService.sweepExpiredSessions()`
(`backend/src/services/auth/operators.ts:296-301`) exists and does exactly this — "Bounds table
growth. Nothing depends on it for correctness" — but a repo-wide search
(`grep -rn "sweepExpiredSessions" backend/src`) finds **no caller**. It is invoked from tests only.
**Nothing enforces this yet**: expired and revoked sessions accumulate in the table indefinitely
until an operator or a future scheduler calls this method.

**Policy stated here.** Wire `sweepExpiredSessions()` into the existing scheduler (the same
mechanism that drives ingestion) on a daily cadence, deleting sessions past `absolute_expires_at`.
This is low-risk since the method already exists and is already proven safe by its own tests — it
is a wiring gap, not a design gap. **Not yet done.**

---

## 5. `export_snapshots` / `export_snapshot_runs`

Covered in full by `docs/superpowers/specs/2026-08-16-export-archive-retention-design.md`, whose
conclusion this policy adopts without modification: **`export_snapshot_runs` needs no policy — a
unique constraint on `(run_day, outcome)` bounds it to at most 4 rows/day by schema, forever.
`export_snapshots` is a forward-only archive of what the public export contained on a given day,
and deletion from it is refused** — publication state is a mutable column
(`meetings.published_at`), so a pruned snapshot is unrecoverable, and pruning oldest-first destroys
exactly the withdrawn-material case the archive exists to answer. Measured against production on
2026-08-16: ~77 published rows/day, ~3 KB/day, ~1.1 MB/year at current publication rates.

Neither table holds personal information beyond public-record row ids, so this pairing is a
storage-growth question, not a PII question — included here for completeness because the roadmap
item named it explicitly, not because it changes the PII picture above.

---

## 6. Other stores checked and found not to need a retention position

- **`email_suppressions`** (migration 091) and **`dispute_notifications`** (migration 092) each
  store the reader's address as a SHA-256 hash only — never plaintext, by explicit design ("a
  suppression list is otherwise a second copy of the subscriber list... and it is the copy that
  outlives every unsubscribe"). `email_suppressions` is designed to be **permanent by nature**: its
  purpose is to persist after the subscribing relationship ends, so a suppression cannot expire
  without risking a re-send to someone who opted out. `dispute_notifications` carries
  `ON DELETE CASCADE` from `record_disputes` (migration 092's header: "a row about a message owed to
  a dispute that no longer exists is not a record of anything") — so it already inherits whatever
  the eventual dispute-contact policy in §2 decides, with no separate mechanism needed.
- **`operators`** (migration 022) holds staff credentials (scrypt-hashed passwords), not reader
  PII — out of scope for a reader-facing retention policy; staff account lifecycle is an operator
  administration question, not a privacy one.

---

## What this spec commits to, and what it does not

**Committed, and already true:**
- `record_corrections` is never deletable. Full stop. The trigger enforces it; this policy states
  it in the open rather than treating it as pending.
- `export_snapshots` deletion is refused, per the adopted spec.
- The dispute rate limiter stores nothing durable about a submitter's IP.

**Committed as a decision, not yet built** (each listed with what would need to change):
- Wire `sweepExpiredSessions()` into the scheduler. (§4 — smallest lift, method already exists.)
- A redaction path for `record_disputes.contact` on decided disputes, on request. (§2 — new code.)
- A time-boxed purge of the encrypted destination on unsubscribed/unverified `delivery_channels`
  rows. (§1 — new code, and a chosen window.)

**Explicitly not proposed:** any deletion path for `record_corrections`, and any age-based pruning
of `export_snapshots`. Both would contradict the reason those tables exist.
