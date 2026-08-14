# The findings review queue — B-a, and B-b's replacement

> Date: 2026-08-10
> Spec: `docs/superpowers/specs/2026-08-09-archive-salvage-design.md` §§ B-a, B-b
> Archive source: the archived 91-commit branch — `024_create_approval_workflows.ts`,
> `src/services/approval.ts`, `frontend/src/pages/ApprovalsPage.tsx`
> Migrations: **038**

## Why now

B-a was paused on 2026-08-09 because it "cannot be designed honestly until something has been
ingested for it to review." That condition is met: real sweeps have landed Gallatin and Bozeman
records, `anomaly_flags.review_state` exists, and records-derived and person-naming flags are
written `held`.

The consequence is the thing being fixed. **A `held` flag can never reach the public, because
there is no path that sets `review_state` to `published`.** The invariant "nothing naming a
person auto-publishes" is currently enforced by there being no publish path at all. That is safe
and useless. This change makes it safe and useful.

## What is being built

1. `approval_requests`, ported from the archive and redesigned (below).
2. A **single severity threshold** — `review_policy`, one row — in place of the archive's
   declined `execution_policies` engine.
3. The operator queue at `/admin/review`, reading held findings with their evidence, and
   approving, rejecting or editing-with-reason.
4. Every decision appended to the existing `record_corrections`. One audit log.
5. Approval as the only thing that flips a finding public, routed through `publication.ts`.

## The decisions

### D1 · `approval_requests`, and what changes from the archive

| Archive | Here | Why |
|---|---|---|
| `reviewer_user_id → users` | `reviewer_operator_id → operators`, `ON DELETE SET NULL` | A1 landed one operator class. There is no `users` table. |
| `requested_by_agent_id → agent_registry` | **dropped** | The orchestration framework it referenced was not adopted. A column referencing a table that does not exist is not a port. |
| `meeting_id NOT NULL` | **nullable** | Migration 027 made `anomaly_flags.meeting_id` nullable and added `artifact_id`; a records-derived flag has no meeting. `NOT NULL` here would make exactly the flags that are *always* held unqueueable. |
| `unique(anomaly_flag_id)` | kept | One flag, one request. |
| `status` includes `expired` | **excluded** — see D3 | |
| `expires_at DEFAULT NOW() + 72h` | kept, but computed from `review_policy.review_window_hours` | |

`reviewer_email` is snapshotted beside `reviewer_operator_id`, the same reasoning migration 031
gives: an audit row must still name who acted after the operator row is gone.

### D2 · One severity threshold, not a workflow engine

`review_policy` is a singleton table — `id uuid`, plus `singleton boolean UNIQUE CHECK
(singleton)` so a second row is a constraint violation rather than a silent ambiguity about
which policy is in force.

- `hold_at_or_above anomaly_severity NOT NULL DEFAULT 'high'`
- `review_window_hours integer NOT NULL DEFAULT 72 CHECK (> 0)`

A flag is written `held` when **either** a detector held it explicitly (names a person,
records-derived) **or** its severity is at or above the threshold. The threshold can only add
holds; it can never release one a person-naming rule made. `held = alwaysHold || severity >=
threshold` is the whole engine.

Default `high` is a behaviour change and is meant to be: `emergency_session`,
`closed_door_vote`, `quorum_issue` and an over-30-day `missing_minutes` stop auto-publishing.
Production holds zero flags, so nothing that is public today stops being public.

`execution_policies`, `execution_policy_runs`, the stage validator and the run-state machine are
not ported. B-b's record of why stands.

### D3 · What an expiry means here

**An expiry is a staleness marker, never a disposal.** A request past `expires_at` and still
`pending_review` is *reported* overdue: the queue badges it, sorts it first, and the console
shows the count. The flag stays `held`. Nothing publishes, nothing is rejected, no state is
written.

So `approval_request_status` is `pending_review | approved | rejected` and there is no `expired`
value and no sweeper. The archive had both, and `expireStaleApprovals()` wrote a terminal status
from a timer. Two objections, and either is sufficient:

- A terminal status set by a clock reads, in the queue and in the audit log, exactly like a
  decision a person made. The one thing this table exists to record is who decided.
- A status only a background job writes is a job that can be missing, and then "expired" silently
  means "the job ran" rather than "the window passed". Deriving it at read time cannot drift.

The requirement that an expired request must not silently publish is met by construction: there
is no code path from elapsed time to `review_state = 'published'`.

### D4 · No unsourced claim is approvable — enforced

`approveFinding` refuses with **409** when the finding resolves to zero citations. Citations are
resolved mechanically, in this order:

1. `anomaly_flags.artifact_id` — a records-derived flag's own document.
2. Any 64-hex value under a metadata key ending in `sha256` — this is how P5's
   `last_minute_agenda_change` carries `from_sha256`/`to_sha256`.
3. Artifacts attached to the finding's meeting through `document_versions → meeting_documents`.

(3) is what makes a meeting-derived finding approvable at all, and it is honest: the meeting
record the claim describes was extracted from those stored bytes. A meeting with no stored
artifact has nothing behind it and its findings cannot be approved — which is the correct
refusal, not a gap.

The console shows every citation with its sha256, source URL, byte size and the document it came
from, beside the claim text. That is the claim-to-citation binding.

### D5 · Describe the record, never the motive — enforced on the edit path

Edit-with-reason is the one place a human types free text that will be published. The new value
is scanned, word-bounded, against a motive lexicon (corrupt, bribe, kickback, fraud, illegal,
deliberately, conspired, …) and refused with 400 naming the term. Reusing P7's approach, which
already scans generated letters.

### D6 · One wall, in `publication.ts`

`whereFindingPublic(db, query)` and `findPublicFinding(db, id)` join `publication.ts`'s existing
meeting helpers. Two conditions, one place:

- `review_state = 'published'`, and
- either no meeting, or a meeting with `published_at NOT NULL`.

The second half closes a pre-existing hole: `GET /api/anomalies` filtered only on `review_state`,
so an auto-published flag on an unpublished meeting leaked the meeting's existence and a sentence
of its content. Every public path that can return a flag goes through the helper.

The `anomaly.detected` event is filtered to published flags, and `NotificationService` re-queries
through the same rule — otherwise the threshold would hold a critical finding from the site and
email it at the same moment, since `IMMEDIATE_SEVERITIES` is exactly `critical` and `high`.

### D7 · One audit log

`appendCorrectionRow` is exported from `services/pressroom/corrections.ts` and used by the review
service, so decisions land in `record_corrections` beside publication and correction. Migration
038 extends that table's `target_table` CHECK to admit `anomaly_flags` and `review_policy`.

`recordCorrection` itself is **not** reused: it writes `updated_at`, and `anomaly_flags` has no
such column. The log writer is shared; the update is not.

`record_corrections` has a `BEFORE UPDATE OR DELETE` trigger and no FKs, so tests cannot clean
up. Every assertion keys on ids the run generated.

## Tasks

| # | File | What |
|---|---|---|
| 1 | `backend/migrations/038_create_review_queue.ts` | enum, `approval_requests`, `review_policy` + its row, CHECK extension. No `../src` import. |
| 2 | `backend/src/services/review/policy.ts` | load/update policy, severity rank, `resolveReviewState` |
| 3 | `backend/src/services/review/evidence.ts` | citation resolution (D4) |
| 4 | `backend/src/services/review/language.ts` | motive lexicon + scan (D5) |
| 5 | `backend/src/services/review/queue.ts` | list, get, ensure requests, approve, reject, edit |
| 6 | `backend/src/services/publication.ts` | `whereFindingPublic`, `findPublicFinding` |
| 7 | `backend/src/services/pressroom/corrections.ts` | export `appendCorrectionRow` |
| 8 | `backend/src/routes/admin/review.ts` + `admin/index.ts` | `/api/admin/review/*` |
| 9 | `backend/src/routes/anomalies.ts`, `routes/meetings.ts` | use the wall helper |
| 10 | `backend/src/services/anomaly-detection.ts` | apply policy, ensure requests, filter the event |
| 11 | `backend/src/services/notification.ts` | published-only |
| 12 | `backend/src/services/records/requests.ts` | ensure a request for each held flag |
| 13 | `backend/test/review-queue.test.ts` | the suite, registered in `package.json` |
| 14 | `frontend/src/types/index.ts` | queue shapes |
| 15 | `frontend/src/pages/AdminReviewPage.tsx` + test | the console screen |
| 16 | `frontend/src/App.tsx`, `pages/AdminHomePage.tsx` | route and surface |
| 17 | `docs/STATUS.md` | record it |

## The gate

```bash
docker compose up -d db
cd backend  && npm run typecheck && npm run lint && npm test
cd frontend && npm run typecheck && npm run lint && npm test -- --run
bash ./deploy/test-deploy-aws-ssm.sh
```

Baselines not to regress: backend 798 / 205, frontend 297 / 32, deploy 61 / 0, zero lint errors
either side (backend keeps its two deliberate warnings).

## Deliberately not built

- A second reviewer, roles, or any multi-stage route. B-b's revisit condition is unchanged.
- Notification of a new queue item. Nothing in the delivery layer sends product events yet, and
  opening that on this change would make approval and delivery one decision instead of two.
- Bulk approve. Approving in a batch is approving without reading, on the one screen whose entire
  purpose is that somebody read it.
