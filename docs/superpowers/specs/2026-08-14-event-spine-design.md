# The event spine

> Design of record for roadmap §3. Written 2026-08-14.
>
> Read first: `docs/superpowers/specs/2026-08-14-system-roadmap-design.md` §3, and
> `docs/superpowers/plans/2026-08-14-design-phase-brief.md` §1.
>
> **Every delivery channel in §6 depends on this spec.** Nothing in the delivery spec may be built
> before the `events` table and the drain exist, because each channel built first would carry its
> own copy of the publication check, and that is the defect this spec exists to prevent.

## The problem, stated exactly

There are two problems, and they compound.

**One: the dispatcher is not connected to anything.** `DeliveryDispatcher` in
`backend/src/services/delivery/dispatcher.ts` is 643 lines of durable, batching, retrying,
consent-gating delivery machinery. Grep for its constructor and you find `src/scripts/emit-ops-event.ts`
and two test files. The server never constructs one. Every channel it can drive — Discord, SMS —
is reachable only by a human running a script by hand. The product has a delivery system and no
way to deliver.

**Two: the publication wall is re-enforced per consumer.** `services/publication.ts` already
carries the wall for HTTP reads, and its own header documents the count: seven routes on the
meetings router, three on the anomalies router. A finding is public only when
`review_state = 'published'` **and** its meeting is published. That is two conditions, joined by an
`orWhereExists`, and it is subtle enough that `whereFindingPublic` needed a fourteen-line comment
explaining why a flag with no meeting is exempt.

Now add RSS, a query-feed, Discord, a record receipt, outbound email, inbound email. Six new
consumers, each of which must independently re-derive that same two-part condition, in a query
shape none of the existing helpers fit. The first one to get it slightly wrong publishes a
generated claim about a named person that an operator withheld.

## The design in one sentence

**An event is a durable row that is written only for an object that is already public, and every
consumer reads events instead of reading tables.**

The wall moves from *n* consumers to one emitter. A consumer that reads `events` cannot leak an
unpublished object, because an unpublished object has no event to read.

---

## 1. The `events` table

Migration `075_create_events.ts`.

```
id              uuid   pk   default gen_random_uuid()
event_type      text   not null
subject_kind    text   not null    -- 'meeting' | 'finding' | 'claim' | 'document' | 'ops'
subject_id      uuid   null         -- null only for subject_kind = 'ops'
jurisdiction_id uuid   null  references jurisdictions(id) on delete set null
severity        text   null
payload         jsonb  not null default '{}'
dedupe_key      text   not null
occurred_at     timestamptz not null default now()
dispatched_at   timestamptz null
revoked_at      timestamptz null
revoked_reason  text   null
created_at / updated_at
```

Constraints, each of which is doing work:

```sql
CHECK (subject_kind IN ('meeting','finding','claim','document','ops'))
CHECK (subject_kind = 'ops' OR subject_id IS NOT NULL)
CHECK (severity IS NULL OR severity IN ('info','low','medium','high','critical'))
CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL)
CREATE UNIQUE INDEX events_dedupe ON events (dedupe_key);
CREATE INDEX events_undispatched ON events (occurred_at)
  WHERE dispatched_at IS NULL AND revoked_at IS NULL;
CREATE INDEX events_subject ON events (subject_kind, subject_id, occurred_at);
```

Three notes on choices that could plausibly have gone the other way.

**`dedupe_key` is globally unique, not unique per channel.** `deliveries` already has a
`(channel_id, dedupe_key)` unique index, and that stays — it is what stops a repeat *delivery*. The
new index is a level up: it stops a repeat *event*. A publish that runs twice because an operator
double-clicked, or because a retry re-entered the transaction, must produce one event, not two that
then fan out to every channel twice. The default key is `{event_type}:{subject_kind}:{subject_id}`
for state-change events, which makes "this meeting was published" idempotent by construction. An
event that legitimately recurs for the same subject — a sweep completing — appends a discriminator
the emitter supplies.

**`subject_id` is not a foreign key.** There is no one table to point at; the subject is a meeting
or a flag or a claim. A polymorphic FK would need five nullable columns and five constraints to say
exactly one is set. More importantly, the event is a record that *something was announced*, and it
must survive the subject being deleted — a deleted meeting does not retroactively un-announce
itself. Same reasoning as `minute_claims.artifact_sha256`, which deliberately is not an FK to
`artifacts`.

**The partial index carries the `revoked_at IS NULL` clause.** The drain's hot query is "what have
I not sent that I am still allowed to send", and putting both predicates in the index means a
revocation removes the row from the drain's working set rather than merely being filtered out of it.

## 2. The emitter, and the invariant

`backend/src/services/events/emit.ts`:

```ts
export async function emitEvent(db: Knex | Knex.Transaction, event: EventInput): Promise<EmitResult>
```

**The invariant: `emitEvent` refuses to write an event whose subject is not public, and the refusal
is a thrown error, not a silent skip.**

The check is not "the caller promises". It is a re-read of the subject through the *existing*
publication helpers, inside the same transaction, immediately before insert:

| `subject_kind` | The check |
|---|---|
| `meeting` | `findPublishedMeeting(trx, subject_id)` returns a row |
| `finding` | `findPublicFinding(trx, subject_id)` returns a row |
| `claim` | `minute_claims.status = 'approved'` **and** its meeting is published |
| `document` | its meeting is published, or it has no meeting and its artifact is public |
| `ops` | exempt — see below |

This deliberately re-runs the same query the caller just satisfied. That redundancy is the point:
the wall is asserted at the moment of emission by code that has no other job, so a caller that
forgets, or a caller written in six months by someone who has not read `publication.ts`, cannot
produce a public event. It is one extra indexed primary-key lookup per publish. Publishes are rare.

**`ops` is exempt and must be routed differently.** Ops events — a sweep failed, a source went
stale, backup missing — are about the system, not about a record, and they have no publication
state to check. They must never reach a public consumer. The rule: **a consumer serving the public
web filters `subject_kind <> 'ops'`, and this is asserted by a test, not by convention.** The
existing `services/delivery/ops-events.ts` keeps its shape and becomes an `emitEvent` caller with
`subject_kind: 'ops'`.

`emitEvent` takes `Knex | Knex.Transaction` and callers **must** pass the transaction that performed
the publish. An event committed while its publish rolled back announces something that did not
happen. The review queue's approve path already runs in a transaction; the event insert joins it.

### Where the emitters go

Exactly five call sites, and no others without a spec amendment:

1. `services/review/queue.ts` approve → `finding.published`
2. the meeting publish path → `meeting.published`
3. the claims review screen's approve (spec §3, LLM governor) → `claim.approved`
4. `services/ingestion/` sweep completion and failure → `ops.sweep.*`
5. the unpublish paths → `*.retracted` (§4 below)

Detection does **not** emit. `detectAnomalies` produces flags; most are held; the ones that are not
held are already `published` and the review path is what announces them. A detector that emitted
directly would be a second emitter with a second copy of the wall, which is the thing being removed.

## 3. The drain, and where the dispatcher is finally constructed

The dispatcher stays exactly as it is. It is good, tested, and its batching and backoff are correct.
What changes is that something constructs it and feeds it.

`backend/src/services/events/drain.ts` — an `EventDrain` that claims undispatched events with the
project's existing queue idiom, the same `FOR UPDATE SKIP LOCKED` pattern `services/ingestion/queue.ts`
uses. No Redis, no new dependency, and two server processes cannot double-dispatch:

```sql
SELECT id FROM events
WHERE dispatched_at IS NULL AND revoked_at IS NULL
ORDER BY occurred_at ASC, id ASC
LIMIT $1
FOR UPDATE SKIP LOCKED
```

For each claimed row: call `dispatcher.dispatch(...)`, then set `dispatched_at`. **In that order.**
If the process dies between them the event is re-dispatched, and `deliveries`' existing
`(channel_id, dedupe_key)` unique index absorbs it as a duplicate. The other order loses events
silently. Prefer the failure mode the schema already defends against.

`dispatched_at` means *handed to the dispatcher*, not *delivered*. Delivery outcome lives in
`deliveries.status`, where it already lives. Two columns, two questions, no overlap.

**Construction:** one `EventDrain` and one `DeliveryDispatcher` per server process, built in the
app's composition root alongside the ingestion scheduler, started after migrations, and stopped on
`SIGTERM` via the dispatcher's existing `flushAll()` — which was written for exactly this and has
never been called by a running server. Behind an env flag (`EVENT_DRAIN_ENABLED`) defaulting to
**off**, so this ships and runs in production dark before any channel is routed. A dark drain over
an empty routes table sends nothing and proves the loop.

## 4. Ordering, replay, and unpublication

**Ordering.** Global ordering is not guaranteed and no consumer may assume it. Per-subject ordering
is: events for one `(subject_kind, subject_id)` are dispatched in `occurred_at, id` order, because
the drain's `ORDER BY` is total and a subject's events are serialised by the transaction that
writes them. That is enough for every consumer contemplated — a feed sorts by its own timestamp; a
retraction must follow its publication, and it does.

**Replay after restart** is not a feature to design; it is the absence of one. Undispatched rows are
still undispatched, and the drain picks them up on next tick. There is no in-memory queue to lose.
This is the entire reason events are a table rather than an EventEmitter.

**Replay on demand** — for a channel added later that wants backfill — is `dispatched_at = NULL` on a
selected set, and it is an operator action recorded in `operator_actions`, never an automatic
behaviour. State it in the runbook: re-dispatching is safe against `deliveries`' dedupe index only
while the dedupe key is unchanged, so a replay intended to *actually re-send* must be a new event,
not a reset.

**Unpublication after emit.** The brief demands this be stated explicitly, so:

*An event that has been dispatched cannot be recalled.* A Discord webhook post is gone; an RSS item
is in a reader's cache. Pretending otherwise would be the most dangerous kind of comfortable
fiction in this project.

The mechanism is therefore two-part, and honest about the split:

- **Not yet dispatched** (`dispatched_at IS NULL`): unpublishing sets `revoked_at` and
  `revoked_reason`. The partial index drops it and it never sends. This is a real recall and the
  common case, because the drain tick is seconds and a mistaken publish is usually caught in
  minutes.
- **Already dispatched**: `revoked_at` is still set — the ledger must record that what was announced
  is no longer true — and a **new** event is emitted, `{subject}.retracted`, carrying the original
  event's id. Consumers that can act on it do: a feed emits a tombstone item, Discord posts a
  correction, the record receipt shows the change between snapshots. Consumers that cannot, cannot,
  and the spec says so rather than implying a guarantee.

The retraction event is the one case where an event is emitted for an object that is **not**
public — that is its whole purpose. `emitEvent` permits `event_type` ending in `.retracted` to skip
the publication check, and *requires* that the subject is currently non-public, which is the
inverse assertion. Not an exemption from checking; a different check.

Every unpublish path must call this. The set is small and finite today (the review queue's edit
path, meeting unpublish, claim rejection after approval) and the plan must enumerate it, because a
publication wall with an un-instrumented back door is worse than none — it is a wall people trust.

## 5. Event types

Namespaced, dot-separated, `{subject}.{past-tense verb}`. The vocabulary spec (§8) owns the nouns;
this spec owns the shape. Initial set:

```
meeting.published        finding.published        claim.approved
meeting.updated          finding.retracted        claim.retracted
meeting.retracted
document.published       ops.sweep.failed         ops.source.stale
```

`channel_routes.event_type` already supports a `WILDCARD_EVENT_TYPE` of `*`. Add prefix matching
(`meeting.*`) in `resolveRoutes` — without it every new event type needs a new route row per
channel, and operators will route `*` to avoid the chore, which silently subscribes public channels
to ops events. Make the easy thing the safe thing.

## 6. What this spec does not do

It does not move email onto the dispatcher. That is §6's one-commit cutover and splitting it
double-sends.

It does not add a public `/api/events` endpoint. The event log includes ops events and revocation
reasons; exposing it is a separate decision with its own wall, and the public-facing equivalent is
the feed in §6.

It does not change `deliveries`, `delivery_channels`, or `channel_routes` beyond the prefix matching
in §5. The dispatcher is not the problem.

## 7. Tests the plan must require

- `emitEvent` throws for an unpublished meeting, an unpublished finding's meeting, a `held` flag,
  and a `held` claim — one test each, because they are four different queries.
- An event emitted in a transaction that rolls back leaves no row.
- The same publish run twice yields one event row.
- The drain dispatches in `occurred_at` order for one subject.
- A process crash between dispatch and `dispatched_at` re-dispatches and produces zero extra
  `deliveries` rows. (Simulate by calling the drain's claim/dispatch steps directly.)
- **A public consumer never sees `subject_kind = 'ops'`.** Asserted against the consumer, not the
  emitter.
- Revoking an undispatched event stops it; revoking a dispatched one emits `.retracted`.
- `resolveRoutes` prefix matching: `meeting.*` matches `meeting.published`, does not match
  `ops.sweep.failed`, and `*` still matches everything.

## 8. Open questions

**Does the drain belong in the API process or the ingestion worker?** Specified above as the API
process for simplicity. If the API is ever scaled to more than one replica this is still correct —
`SKIP LOCKED` makes it safe — but it becomes wasteful. Revisit only when a second replica exists.

**Retention.** `events` grows without bound. It is small (one row per publish) and it is an audit
record, so the default is: never delete. Say so explicitly rather than leaving a future operator to
invent a cleanup job that quietly erases the announcement history.
