# Corrections and disputes — the last gate before the site is public

> Plan, 2026-08-10. Backlog item **B3** (launch readiness: "corrections and dispute policy").
> The Caddy IP allowlist is the only reason `commissionwatch.bmux.sh` is not public. B3 says a
> published correction log and a route for a named person to contest a record are required
> **before** the gate comes down. This is that work.

## Why this is a gate and not a feature

The project publishes claims about named, living people. A transparency project that cannot be
corrected in public has no answer when it is wrong, and "email us" is not an answer — it produces
no record anyone else can check. Two things have to exist before a stranger can reach this site:

1. a **public log** of what this site has changed and why, and
2. a **route** by which a person named in a record can contest it, that reaches a human.

Both already have most of their substrate. `record_corrections` (migration 031) is an append-only
store of who/when/field/old/new/why, with a `BEFORE UPDATE OR DELETE` trigger. The operator review
queue (migration 038, `docs/STATUS.md` § B-a) is the surface where a person decides. **Nothing
here builds a parallel log or a parallel queue.** A second audit log is two logs that can disagree,
and the one that disagreed would be believed at random.

## What is being built

| # | Thing | Where |
|---|---|---|
| 1 | `GET /api/corrections` — the public projection of `record_corrections` | `services/public-corrections.ts`, `routes/corrections.ts` |
| 2 | `POST /api/corrections/disputes` — unauthenticated dispute intake | `services/disputes.ts`, same router |
| 3 | Dispute review on the existing operator queue | `routes/admin/review.ts`, `AdminReviewPage` |
| 4 | `/corrections` — the stated policy **and** the log | `pages/CorrectionsPage.tsx` |
| 5 | `/corrections/dispute` — the form | `pages/DisputePage.tsx` |
| 6 | Methodology § 7 and the colophon rewritten to point at them | `MethodologyPage.tsx`, `Layout.tsx` |

## Decisions

### D1 · Only corrections to records that are public **now** appear

A correction row names a target (`target_table`, `target_id`) and, in `old_value`, a fact about it.
Publishing the row for a record the operator has withheld would disclose the withheld record — its
existence, its id, and a sentence of its content. So the projection carries a publicity test **per
target table**, and the test routes through `services/publication.ts` rather than retyping the rule:

| `target_table` | Public when |
|---|---|
| `meetings` | that meeting has `published_at IS NOT NULL` — `whereMeetingPublished` |
| `agenda_items` | its meeting is published |
| `meeting_documents` | its meeting is published |
| `anomaly_flags` | `whereFindingPublic` says so (approved **and** its meeting published) |
| `review_policy` | **never.** A threshold is our operating configuration, not a record about anyone |
| `record_disputes` | **never.** See D5 |

Consequences that are intended, not oversights:

- A correction to an unpublished meeting is **absent**, and becomes visible the moment the meeting
  is published. Asserted in both directions, the way `search.test.ts` asserts the wall.
- **Unpublishing hides the correction that unpublished it.** That is the same rule applied
  consistently: after an unpublish the record is not public, so nothing about it is. The page says
  so in plain words rather than implying the log is a complete history of every edit ever made.
- A *rejected* finding stays `held`, so its rejection never surfaces. That falls out of
  `whereFindingPublic` with no extra rule.

### D2 · The log publishes the change and the reason, never the operator's address

Exposed: when, what kind of record, which field, the old and new values, the stated reason, the
dispute reference if one prompted it, and a link to the record. Withheld: `operator_id` and
`operator_email`. The accountable editor is named on the Methodology page; republishing a mailbox
on every row invites spam and adds no accountability that the masthead does not already carry.

### D3 · Correction reasons are scanned for motive, at the one choke point

Every reason in `record_corrections` is now publishable, including the ones B-a's approve/reject
write. The invariant *describe the record, never the motive* therefore has to hold for all of them.
`appendCorrectionRow` in `services/pressroom/corrections.ts` is the single writer every path already
uses, so the `motiveTerms` scan goes **there** and nowhere else. It throws `CorrectionError(…, 400)`;
`routes/admin/review.ts` learns to map that error, which it did not need to before.

### D4 · A dispute is not a finding, and does not become one

Tempting and wrong: write a dispute as an `anomaly_flags` row so it inherits `approval_requests`.
That would make an unauthenticated stranger's assertion a *finding* — the same object the detectors
produce, on the same publish path, one operator misclick from being published as this project's own
claim. Disputes get their own table, `record_disputes`, and appear on the **same operator screen**
under their own tab with their own two decisions. Shared surface, shared audit log, different type.

### D5 · A dispute is never published, and the column says so

`record_disputes.review_state` is `NOT NULL DEFAULT 'held'` with `CHECK (review_state = 'held')`.
One legal value. A dispute is a private communication from a member of the public that may name
people and may be wrong; publishing it is not something this product does. The CHECK is what keeps
that true when somebody later adds a read route without thinking about it. There is also no public
read route for disputes at all — the CHECK is the second lock, not the first.

### D6 · The dispute route never edits a record

`POST /disputes/:id/uphold` records the decision and updates nothing else. Upholding says *we agree
this looks wrong*; the correction that follows goes through the existing correction path, carrying
`dispute_id`, so the record's own change is still an operator's deliberate act with its own reason.
This is what keeps "it never edits a record directly" a mechanism rather than a promise.

### D7 · The end-to-end trail

```
POST /api/corrections/disputes
   └─ record_disputes row (reference CW-XXXXXXXX, status received, review_state held)
   └─ record_corrections { target_table: record_disputes, field: status, → received }
        │
operator: POST /api/admin/review/disputes/:id/uphold  { reason }
   └─ record_corrections { target_table: record_disputes, field: status, received → upheld }
        │
operator: POST /api/admin/pressroom/corrections { …, dispute_id }
   └─ record_corrections { target_table: meetings, field: location, old → new, dispute_id }
   └─ appears on /corrections as "Prompted by dispute CW-XXXXXXXX"
```

Three rows, one table, joinable in both directions: dispute → its decisions (by `target_id`), and
dispute → the corrections it caused (by `dispute_id`).

### D8 · Migration 039 adds `record_corrections.dispute_id`

`ALTER TABLE … ADD COLUMN` is DDL; the append-only trigger is `FOR EACH ROW BEFORE UPDATE OR DELETE`
and a nullable column with no default does not rewrite rows, so nothing fires. The `target_table`
CHECK is widened to admit `record_disputes`, exactly as 038 widened it for `anomaly_flags`. The
rollback narrows it again and will fail loudly once a dispute is logged — the same honest failure
038 documents.

### D9 · The policy states no clock that nothing enforces

The Methodology page currently promises "2 business days", "10 business days", "24 hours",
"3 business days". **Nothing in this codebase measures, tracks or alerts on any of them.** They are
four unenforced promises on the page whose subject is not making unenforced claims. They are
replaced by what is actually true and checkable: a dispute is read by a person, it reaches the
operator queue on submission, it is never published, no record is edited without a stated reason,
and every correction to a published record appears on `/corrections`. `MethodologyPage.test.tsx`'s
assertion on `"10 business days"` is rewritten to assert the opposite — that no `business days`
promise is on the page — because the behaviour changed deliberately.

## Abuse cases for the dispute route, and the answer to each

It is an unauthenticated public write. Before shipping it, what a bad actor does with it:

| Attack | Answer |
|---|---|
| **Flood the queue** from one host | In-memory fixed-window limiter: 3 / hour and 10 / day per client IP → 429 with `Retry-After`. No storage, no PII |
| **Distributed flood** from many hosts | Global database cap: 30 disputes in any rolling hour, site-wide → 429. Bounds the queue regardless of source |
| **Brigade one record** | Per-target cap: 5 undecided disputes on one target → 429, with a message that does not confirm whether that target has disputes |
| **Enumerate withheld records** by submitting against guessed ids | The target must resolve **through the publication wall**. Unpublished and non-existent both answer the same 404, exactly as `findPublishedMeeting` does |
| **Storage bomb** — a 50 MB account | Length caps in the database *and* at the route: contested ≤ 300, account ≤ 4000, contact ≤ 200 chars |
| **Use the form as a mail relay / spam megaphone** | Nothing is emailed to anyone and nothing is published. The form has no output an attacker can aim at a third party. This is the strongest property here and it is structural |
| **Stored XSS via the account text** | Rendered by React as text, on an operator screen only. No `dangerouslySetInnerHTML` anywhere on the path |
| **Defame someone in a submission** | Never published (D5). Seen by an operator, who is the moderation |
| **Spoof `X-Forwarded-For` to evade the per-IP limit** | `app.set("trust proxy", 1)` — exactly one hop, Caddy. Express then takes the rightmost XFF entry, which is the one Caddy appended, not one the client wrote |
| **Harvest identity documents we asked for** | We ask for none. Three fields: what is contested, your account of it, a contact. Data we do not hold cannot leak |

Deliberately **not** built, and named rather than silently omitted: CAPTCHA (a third-party
dependency and an accessibility tax on the one route a wronged person most needs), account
registration (contesting a record about you should not require an account here), email
acknowledgement (**the brief forbids sending email**, and the reference is returned on screen
instead), and any automatic expiry or auto-resolution of a dispute — for migration 038's reason,
a status set by a clock reads in the log exactly like a decision a person made.

## Task list

### Backend

1. **`migrations/039_create_record_disputes.ts`** — self-contained, no `../src/` import.
   `record_disputes`; `record_corrections.dispute_id`; widen the `target_table` CHECK.
2. **`src/services/rate-limit.ts`** — `FixedWindowLimiter`: bounded key map, prune on write,
   `check(key, now)` → `{ allowed, retryAfterSeconds }`. Pure, no clock of its own.
3. **`src/services/disputes.ts`** — reference generation (Crockford-ish base32, no ambiguous
   glyphs), `submitDispute`, `listDisputes`, `getDispute`, `decideDispute`. Publicity check for the
   target routed through `publication.ts`.
4. **`src/services/public-corrections.ts`** — `listPublicCorrections`, per-table publicity via
   `whereMeetingPublished` / `whereFindingPublic`, plain-words summary, no operator identity.
5. **`src/services/pressroom/corrections.ts`** — motive scan inside `appendCorrection`; optional
   `disputeId` on both inputs.
6. **`src/routes/corrections.ts`** — `GET /`, `POST /disputes`. Mounted at `/api/corrections`.
7. **`src/routes/admin/review.ts`** — `GET /disputes`, `GET /disputes/:id`,
   `POST /disputes/:id/uphold`, `POST /disputes/:id/decline`; map `CorrectionError`.
8. **`src/app.ts`** — `trust proxy`, mount the router.
9. **`test/public-corrections.test.ts`** and **`test/disputes.test.ts`**; both registered in
   `package.json`'s `test` script, which enumerates every file by path.

### Frontend

10. `types/index.ts` — `PublicCorrection`, `DisputeRecord`, response envelopes.
11. `pages/CorrectionsPage.tsx` + test — policy above, log below.
12. `pages/DisputePage.tsx` + test — the three-field form, the reference, the refusals verbatim.
13. `components/DisputeQueue.tsx` + test — the disputes tab inside `/admin/review`.
14. `pages/AdminReviewPage.tsx` — the tab strip: Findings | Disputes.
15. `App.tsx` routes; `Layout.tsx` colophon link; `MethodologyPage.tsx` § 7 and its test;
    `mocks/handlers.ts` so the chrome walk resolves.

### Land it

16. Full verification gate; `docs/STATUS.md`; commit and push.

## Invariants this must not break

- The artifact is never mutated. Nothing on this path touches `artifacts`.
- Describe the record, never the motive — now enforced on every audit-log reason (D3).
- Nothing naming a person auto-publishes. A dispute may name people and is `held`, always (D5).
- No unsourced claim reaches the public site. A dispute is not a claim this site makes.
- One audit log. `record_corrections` is the only one, and 039 widens it rather than adding another.
