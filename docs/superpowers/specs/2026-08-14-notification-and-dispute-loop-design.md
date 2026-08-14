# Notification, and the dispute loop

> Design of record, added 2026-08-14 at the operator's request: a notification system tied into the
> dispute system — and, because that covers the notification that actually matters, a deliberate
> **deferral of the subscriber email work** in `2026-08-14-delivery-design.md` §5 and §6.
>
> Companions: `2026-08-14-published-claim-design.md` (what may be published about a person),
> `2026-08-14-delivery-design.md` (the channels), `2026-08-14-event-spine-design.md` (the trigger).

## The argument

The delivery spec sorted six channels by risk and put email last, because email is where this
project stops being a publisher and starts being a custodian of other people's personal data. That
ordering is right for *subscriptions* — a stranger's address, held indefinitely, for a digest they
may stop wanting.

It is the wrong frame for the notification this project most needs to send.

`services/disputes.ts` says it plainly in its own header: a dispute produces a row and an audit
entry, and **"nothing else: no edit to the record, no public statement, no email to anyone."** So a
person who found a claim about themselves, typed out a contested account of it, and left a contact —
gets silence. They cannot tell whether it arrived. They cannot tell what was decided. The reference
`CW-XXXXXXXX` exists to be "quoted down a phone line and typed back into an email", and there is no
email.

That is the gap. It is a **transactional** notification: one message, to one person, who initiated
the exchange, about their own matter. It needs no subscriber table, no digest scheduler, no
preference centre, and no consent regime beyond the act of submitting the dispute. The PII handling
is already built and already careful — `contact` is bounded at 200 characters, checked by a database
constraint, never published (migration 039's CHECK permits exactly one `review_state`), and the
service stores no IP address, no user agent and no identity.

**So this ships, and §5/§6 defer.** Not cancelled — deferred, with the re-ask the delivery spec
already scheduled, once the query feed exists and there is evidence about what people actually use.

## The two notification kinds

### a. Dispute acknowledgement and outcome — build this

Three messages, and only three:

| Trigger | Message |
|---|---|
| dispute received | "We received a dispute. Your reference is `CW-XXXXXXXX`. We will write once it has been reviewed." |
| dispute upheld | "Reference `CW-…`: the record has been corrected / the claim has been withdrawn." + link |
| dispute declined | "Reference `CW-…`: we reviewed this and made no change. Here is what the record rests on." + link to `/source/{sha}` |

Rules, each of which is a mechanism:

- **The acknowledgement contains no dispute content.** Not the contested text, not the account, not
  the target. Only the reference and what happens next. The reason is in §c below and it is the
  central security property of this feature.
- **The outcome message contains only what is already public** — the corrected record, the tombstone,
  or the citation. It never quotes the submitter back to themselves and never contains another
  person's dispute.
- **No message is ever sent for a dispute that is still `received`** beyond the one acknowledgement.
  A silent queue is a real complaint and the answer is to review faster, not to send progress
  updates that leak throughput.
- **The decision is recorded before the message is queued**, in the same transaction, per the event
  spine. A notification about a decision that rolled back is worse than none.

### b. Subject notice at publication — build this, and it settles open question 9a

The published-claim spec left this to the operator: does a named subject get notice before
publication, or only a dispute route after? Tying notification to the dispute system answers it, and
the answer is **notice at publication, not before**, with the dispute link in the message.

The reasoning, now that the loop exists on both ends:

- Pre-publication notice hands a subject a window to object to an *accurate* record, and creates an
  implicit negotiation over what gets published. That is a different editorial posture than this
  project has, and a worse one.
- Notice *at* publication with a working dispute route gives the subject the thing that actually
  matters — the ability to contest, promptly, with a reply — without giving anyone a veto.
- It is also the honest version. "We published this about you and here is how to contest it" is a
  statement this project can defend. "We are thinking about publishing this" is a negotiation.

Mechanics: triggered by `claim.approved` and `finding.published` from the event spine, to the
official's **published contact address of record** — the address the jurisdiction itself publishes
for that seat, stored with provenance (source URL, fetch time, artifact sha) exactly like any other
fact, and never an address obtained by any other route. If there is no sourced address, there is no
notice, and the absence is visible in the console rather than assumed.

One message per subject per publication batch, so approving eleven claims about one official sends
one email listing eleven links, not eleven emails. The dispatcher's batching already does this and
is the reason to route it through the dispatcher rather than sending directly.

### c. What this must not become

**A dispute contact is an address a stranger typed into a public form.** Anyone can submit a dispute
naming a victim's address as the contact, and we will then send that victim mail. The existing rate
limits bound the volume — `perClientPerHour: 3`, `perClientPerDay: 10`, `globalPerHour: 30`,
`perTargetOpen: 5` — and they are the right shape, but they bound *quantity*, not *misuse*.

So the acknowledgement is deliberately content-free and self-cancelling:

> We received a dispute about a record on commissionwatch.bmux.sh. Your reference is CW-XXXXXXXX.
> If you did not submit this, no action is needed and we will not write again.

No target, no contested text, no account, no name. Someone who receives this in error learns only
that a form exists, which is public knowledge. If the acknowledgement echoed the dispute, the form
would become a way to send arbitrary text to arbitrary addresses over this project's domain and
reputation — an open relay with extra steps, and the fastest possible way to lose the sending domain.

Further requirements:

- **Suppression applies here too.** The delivery spec's `email_suppressions` table is a precondition
  for *any* outbound mail, transactional included. A hard bounce or a complaint suppresses the
  address, and a suppressed address is never written to — including for an acknowledgement.
- **`contact` is free text and must be parsed, not assumed.** It is 200 characters of whatever the
  submitter typed: an email, a phone number, a postal address, a sentence. Send only when it parses
  as a single valid email address. Otherwise the dispute is `no_notification_channel`, visible in the
  console, and the operator can act on it by hand. Do not guess, and do not attempt SMS from a field
  that was never described as a phone number.
- **One acknowledgement per dispute, ever.** Idempotent on `dispute_id`, enforced by a unique index,
  so a retry or a re-submitted form cannot become a second message.
- **No open-tracking, no click-tracking, no pixels.** A person contesting a record about themselves
  should not have their reading of our reply logged. This is the same instinct that keeps IP
  addresses out of `record_disputes`.

## How it is built

**Through the dispatcher, on the event spine.** Not a direct `EmailDeliveryService` call from the
dispute route.

- `dispute.received`, `dispute.upheld`, `dispute.declined`, `claim.approved`, `finding.published`
  are already the spine's events, or trivially added.
- The three dispute events are `subject_kind: 'ops'`-adjacent but are **not** `ops` — they are about
  a record and must reach exactly one address. They need a new `subject_kind` value, `dispute`, whose
  publication check is *inverted*: a dispute event is emitted only for a dispute that is **not**
  public, because migration 039 permits no other state. That is the same shape as the `.retracted`
  exemption in the event spine — a different check, not an absent one.
- **A `dispute` event must never route to a broadcast channel.** A route resolving `dispute.*` to a
  Discord webhook or a feed would publish a contest that the schema forbids publishing. Enforce it
  in `resolveRoutes`: `dispute` events resolve only to `direct` channels, and a test asserts a
  wildcard route cannot pick them up. This is the single highest-risk defect available in this
  feature and it must be a constraint, not a convention.

That means a new channel owner kind — `direct`, alongside the existing `operator` and `subscriber` —
whose config is a single address supplied per-send rather than stored. A direct channel holds no
credential and no destination at rest; the destination comes from the dispute row or the sourced
official record at send time, and is not persisted in `delivery_channels`.

**The email defects block this.** Everything in `2026-08-14-delivery-design.md` §5a–§5c is a
precondition for transactional mail as much as for a digest:

- the `email_status = 'sent'` lie must be fixed — a dry run must write `dry_run`. Telling a disputant
  "we replied" when nothing was sent is worse in this context than in any other.
- `initResend` must not be an un-awaited async call from a synchronous constructor.
- suppression, SPF/DKIM/DMARC, and a `From` on the deployed domain — the current default
  `alerts@commissionwatch.org` is **not** `commissionwatch.bmux.sh` and will fail alignment.

**§5d — the one-commit cutover — does not apply**, and that is the main reason this can ship ahead of
the subscriber work. The cutover exists because `alert_subscriptions` and the dispatcher would
double-send to a subscriber list. There is no subscriber list here. Transactional mail is a new path
to a new kind of destination and collides with nothing.

## What defers, and what the deferral costs

Deferred: delivery §5 (outbound digest subscriptions) and §6 (inbound email subscribe). Both stay
specced and neither is cancelled.

What that gives up: reach into inboxes belonging to people who do not use feeds — probably the
largest audience. That is a real cost and it should be stated rather than rationalised away.

What it avoids, for now: a subscriber table, a preference centre, an indefinite retention obligation,
a consent audit trail, a deliverability reputation dependent on bulk sending, and the forged-`From`
inbound path that made §6 the highest-risk channel in the roadmap.

The re-ask is unchanged from the delivery spec: build feeds, the query feed, the calendar and the
receipt, watch what people use, then decide with evidence. **This spec does not change that
decision; it removes the argument that email must ship early because disputes need a reply.** They
do, and now they get one, without a subscriber list.

`DigestScheduler` keeps compiling and keeps passing tests, per the dormant-services rule in
`CLAUDE.md`, and must stop running its daily job against a dry-run sender in production — that is
part of the §5a fix, not a separate task.

## Tests the plan must require

- A dispute event never resolves to a Discord, feed, or wildcard route — asserted against
  `resolveRoutes`, with a `*` route present in the fixture.
- The acknowledgement body contains none of `contested`, `account`, `target_table`, or `target_id`.
- A `contact` that is not a single valid email address produces no send and a visible
  `no_notification_channel` state.
- A suppressed address receives no acknowledgement.
- Exactly one acknowledgement per dispute, across a retry and a duplicate submission.
- An upheld dispute's outcome message contains only public content — asserted by rendering it for a
  target whose meeting is unpublished and finding the message empty rather than leaking.
- Subject notice fires on `claim.approved` only for an official with a **sourced** contact address,
  and eleven claims about one official produce one message.
- A rolled-back review decision produces no notification.
- A dry-run send writes `dry_run`, never `sent`.

## Open questions

**Should a declined dispute's message include the operator's reason?** Specified as no — it links to
the citation instead. `review_reason` is written for an audit log and for an operator's future self,
not for the person it is about, and a candid internal note read as a reply is how a correction
process becomes an argument. If the operator wants to reply substantively, that should be a
deliberate written response with its own field, not a repurposed internal one.

**Postal notice where there is no email?** The `contact` field admits a postal address and some
disputants will use one. Out of scope here, but worth naming: a printed letter is the most credible
notice this project could send and the least automatable. Recommendation: surface it in the console
as a task, and let the operator decide per case.
