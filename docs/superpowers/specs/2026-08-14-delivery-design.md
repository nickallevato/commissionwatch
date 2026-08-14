# Delivery

> Design of record for roadmap §7. Written 2026-08-14.
>
> **Depends on `2026-08-14-event-spine-design.md`. Nothing here may be built first.** Every channel
> below reads `events`. A channel built before the spine carries its own copy of the publication
> wall, and the first one to get it slightly wrong publishes a withheld claim about a named person.

The order below is ascending risk. Ship it in that order; each step is independently useful and each
one is reversible until email.

| | Channel | Consent regime | PII stored | Reversible |
|---|---|---|---|---|
| 1 | RSS / Atom | none | none | yes |
| 2 | The query feed | none | none | yes |
| 3 | Discord webhook | operator-configured | none | yes |
| 4 | The record receipt | none | none | yes (append-only) |
| 5 | Outbound email digest | double opt-in | email address | **no** |
| 6 | Inbound email subscribe | double opt-in | email address | **no** |

Steps 1–4 have no consent regime, store no personal data, and can be withdrawn by deleting a route.
Steps 5–6 put a stranger's email address in the database. That is the line, and it is why the brief
re-asks whether email happens at all once the query feed exists.

---

## 1. RSS / Atom

`GET /feed.xml` (Atom 1.0) and `GET /feed.rss` (RSS 2.0), served by the backend, proxied by nginx
under the same `location ^~ /api/`-style precedence care the sitemap needed — the existing
`location ~* \.(txt|xml|json|csv|ics|map|webmanifest)$` regex block will capture `/feed.xml` and try
to serve it from disk. **This is the exact trap that would have 404'd every bulk export**; it must
get an explicit `location = /feed.xml` proxy block and a container-run curl test, because `nginx -t`
only proves the config parses.

Content: one entry per event of `subject_kind IN ('meeting','finding','claim','document')` — the
`ops` filter from the event spine, asserted by a test on the consumer.

Each entry carries:
- a stable `<id>` — the event id, as a URN. Never the URL, which can change.
- `<updated>` from `occurred_at`
- a title and a summary assembled by the **same deterministic renderers** the public pages use. The
  feed is not a second place where a sentence about a named person is composed. Import the renderer;
  do not re-implement it.
- a link to the on-site anchor (`/meetings/{id}#claim-{id}` for claims — a claim is not a page, per
  the published-claim spec)
- the source citation in the entry body, because a feed item that leaves the citation behind is an
  unsourced claim in a reader's inbox

**Retractions appear as their own entries.** `{subject}.retracted` renders as an entry titled
"Withdrawn: …" pointing at the tombstone. A feed that only ever adds is a feed that propagates
mistakes and never the correction.

Cache with `ETag`/`Last-Modified` from the newest event's `occurred_at`, and a `Cache-Control` of a
few minutes. Feed readers poll hard.

## 2. The query feed — "the query is the subscription"

One of the two operator-requested extras, and the one that plausibly makes email unnecessary.

```
GET /feed.xml?q=<terms>&jurisdiction=<id>&type=<event_type>&severity=<min>
```

The subscription **is the URL**. No account, no email address, no token, no row in a subscribers
table, nothing to leak and nothing to unsubscribe from. A user searches on the site, likes the
result, and copies the feed link out of the same page.

Constraints:

- The query runs through the **same** search path as `/search`, which already reaches the
  publication wall through `whereMeetingPublished` with a qualified column for its four-table join.
  Do not write a second query builder.
- Bounded: a max term length, a max result count, and rejection of a query that produces an
  unbounded scan. A public endpoint that accepts arbitrary query text is a public endpoint someone
  will use as a load generator.
- The query is echoed in the feed's `<title>` and `<subtitle>` so a reader with six saved feeds can
  tell them apart.
- No query logging beyond aggregate counts. The point of this channel is that it holds nothing about
  anyone; keeping a log of who searched for which official's name would give it back the property it
  was designed to avoid.
- 429 with `Retry-After` on abuse, per §7's rate-limiting requirement.

## 3. Discord

**A webhook, not a gateway bot.** A gateway bot needs a persistent connection, a token with far more
scope than posting, presence in a server's member list, and an ongoing operational relationship with
Discord. A webhook is a URL, posts to one channel, and can be revoked by whoever owns the channel
without involving us. There is no requirement here a bot satisfies and a webhook does not.

Almost all of this exists: `services/delivery/discord.ts` (575 lines, embed building, truncation,
rate limits, backoff), the dispatcher's batching, and encrypted-at-rest channel config in
`channels.ts`. What is missing is the thing the event spine supplies — something that calls
`dispatch()` when a record is published.

So the work here is small and mostly configuration:

- Routes for the new event types, using the prefix matching the event-spine spec adds
  (`meeting.*`, `finding.*`, `claim.*`) — without it an operator routes `*` to save effort and
  silently subscribes a public channel to ops events.
- The admin channels page already exists at `/admin/channels`.
- **A public Discord channel is a public consumer**, so it filters `subject_kind <> 'ops'`. An ops
  channel is a *separate* channel row with its own webhook, and the plan must make that separation
  explicit rather than leave it to an operator's route configuration.
- Embeds link to the on-site anchor and carry the citation, same rule as the feed.

## 4. The weekly record receipt

The other operator-requested extra, and the answer to a question `/data` currently states as
unanswerable: *what did this site say in March?*

Weekly, a job writes a dated snapshot to a public git repository:

```
receipts/2026-08-17/
  meetings.csv          published meetings, as of the snapshot
  findings.csv          published findings
  claims.csv            approved, unretracted claims, with rendered_text and render_sha256
  sources.csv           artifact sha256, fetch url, fetch time, http status
  MANIFEST.sha256       sha256 of every file above
  README.md             what this is, what changed since last week, how to verify
```

Why a git repo rather than an API: the point is a record we cannot quietly revise. A commit history
in a repository we do not solely control the visible history of — mirrored, cloned, watched — is a
much stronger claim than "our database says so". It also means a retraction is *visible as a diff*,
which is exactly the accountability this project asks of others.

Rules:

- The snapshot contains **only** what was public at snapshot time. Same wall, same helpers.
- No personal data beyond what is already published: official names as printed in records.
- `MANIFEST.sha256` lets anyone verify a file they were handed came from a given week.
- Generation failure is an ops event and shows on the status page. A receipt series with a silent
  gap is worse than none.
- The README diff section is generated, factual, and mechanical: counts added, counts retracted, and
  the retraction reasons. No narrative.

The publishing credential is a deploy key in Parameter Store, fetched by the host — **never in an
SSM command payload**, which is retained in plaintext for 30 days and lands in CloudTrail.

## 5. Outbound email — and the four things that must be true first

> **Deferred, 2026-08-14.** Sections 5 and 6 are deferred by
> `2026-08-14-notification-and-dispute-loop-design.md`, which ships *transactional* mail — the
> dispute acknowledgement and outcome, and subject notice at publication — without a subscriber
> list. That removes the argument that email must ship early because disputes need a reply.
> Nothing below is cancelled; §5a–§5c remain **preconditions for transactional mail too**, and the
> re-ask stands. §5d, the one-commit cutover, does not apply to transactional mail, because there
> is no `alert_subscriptions` path to collide with.

**Email must not ship until all four of these are done.** They are not preconditions in the
soft sense.

### a. The `email_status = 'sent'` lie

Confirmed in the code on 2026-08-14. `services/email-delivery.ts` line 161 logs
`EmailDeliveryService [dry-run]: to=… subject="…"` when no Resend client is configured — and the
caller at lines 65 and 119 then writes `email_status: "sent", email_sent_at: now()` regardless.

There is a second defect underneath it: `initResend` is `async` and is called **un-awaited from a
synchronous constructor**. `this.resend` is therefore null for some window after construction *even
when `RESEND_API_KEY` is set*, so early sends silently take the dry-run path and are recorded as
sent.

Meanwhile `DigestScheduler` runs `0 6 * * *` and `0 6 * * 1` in production against exactly this
service. **Production has been recording sent emails that were never sent, daily.**

The fix, before anything else: `sendEmail` returns a discriminated result; a dry run writes
`email_status = 'dry_run'`, never `'sent'`; the client is constructed synchronously or awaited
through a factory; and a `sent` status requires a provider message id. Add `'dry_run'` to the status
constraint. This is a bug fix that should land on its own, ahead of the rest of this spec.

### b. A suppression table

`email_suppressions`: address hash, reason (`unsubscribed`, `bounced_hard`, `complained`,
`operator_block`), timestamp, source. Checked before every send, by the sender, not by the caller.
A hard bounce or a spam complaint suppresses permanently and automatically via the provider webhook.
Without this, one complaint route damages deliverability for every future recipient and there is no
mechanism that stops the second send.

Store the address hashed where the address itself is not needed for sending, so a suppression list
does not become a second copy of the subscriber list.

### c. `List-Unsubscribe` and `List-Unsubscribe-Post`

Both headers, one-click (RFC 8058). Gmail and Yahoo require it for bulk senders. The link must work
without a login and must not require the recipient to identify themselves beyond the token.

Also required before first send: SPF, DKIM and DMARC on the sending domain, and a `From` that is not
`alerts@commissionwatch.org` — the current default, which is **not the deployed domain**
(`commissionwatch.bmux.sh`) and will fail alignment.

### d. The one-commit cutover

`STATUS.md` specifies this and the reason is arithmetic: moving email onto the dispatcher while
`alert_subscriptions` still drives `EmailDeliveryService` means both paths fire and every subscriber
gets two copies. Moving email onto the dispatcher **and** dropping `alert_subscriptions` must be one
commit, one migration, one deploy. Not a branch that is half-merged, not a flag that is on in one
process and off in another.

Also: `POST /api/alerts` returns the `verify_token` in its 201 body today. That token is the thing
that proves the subscriber controls the address; returning it to the caller means the caller can
verify an address they do not own. Fix it in the same commit — it is a consent hole, not a cosmetic
one.

### What outbound email actually is, once those are true

A **digest**, not an alert stream. Daily or weekly, one message, assembled from `deliveries` rows
the dispatcher deferred — the `cadence` column and the `deferred` status already exist for exactly
this and the dispatcher already writes them. Double opt-in. Every message carries the citation and
the unsubscribe. Nothing in an email says anything a public page does not already say.

## 6. Inbound email subscribe

Subscribe by sending mail to `subscribe@…`, unsubscribe by replying `STOP` or mailing
`unsubscribe@…`.

This is the highest-risk channel and the ordering is deliberate. `From:` is trivially forgeable, so
**an inbound message is a request, never a subscription**. It always triggers the same double
opt-in confirmation an on-site signup does — which means the inbound path adds convenience and zero
new trust. If that confirmation step were skipped, anyone could subscribe anyone.

Requirements: inbound webhook from the mail provider with signature verification; SPF/DKIM result
recorded on the request; the suppression table checked *before* sending a confirmation, so an
unsubscribed address cannot be re-solicited by forging mail from it; rate limiting per source
address; and a hard cap on confirmations sent per address per day.

The subject line becomes the query when it parses as one — which makes the inbound channel a way to
subscribe to a query feed by email, and reuses §2 rather than inventing a second subscription model.

## Two channels beyond the list

The brief asked for two more. These are the two, and both were chosen because they carry no consent
regime and no PII — the same property that makes §§1–4 safe.

**a. `GET /calendar.ics` — the meeting calendar as a subscribable feed.** A `CalendarPage` and a
`services/calendar/` module already exist. Publishing upcoming published meetings as a webcal
subscription puts this project's data into the one application every resident, reporter and lobbyist
already keeps open. It is the cheapest reach in the entire roadmap: no account, no email, no app,
and the subscription updates itself. Agenda items go in the description with a link back; a
cancelled or rescheduled meeting updates in place through `UID` + `SEQUENCE`, which is a correction
mechanism the format gives for free.

**b. `GET /.well-known/…` + an MCP endpoint — the machine channel.** Ryan's thesis was being the
authority layer: who determines what shows up in AI. Sections 1–4 make the data *findable*; this
makes it *callable*. A small read-only MCP server over the published corpus (search meetings, get a
meeting, get an official's votes, get a claim with its citation) means an assistant can answer
"what did the Bozeman commission do about the Ordinance 2145 rezone" from the record rather than
from a summary of a summary. Every response carries the artifact sha and the source URL, so the
citation survives the hop — which is the whole point, and it is the same property the GEO research
says drives citation.

It reuses the public API and the same wall. It is a thin protocol adapter over routes that already
exist, so it is cheap; and it is the only channel here that changes *who* the consumer is.

## Tests the plan must require

- Every feed, the Discord embed builder, the calendar and the MCP adapter each exclude
  `subject_kind = 'ops'` — one test per consumer, on the consumer.
- An unpublished meeting, a held finding, a held claim and a retracted claim are absent from every
  channel. Parameterise over channels so a new channel added later fails until it is covered.
- `/feed.xml` is proxied, not served from disk — run nginx in a container and curl it, alongside a
  regression curl of `/api/data/meetings.csv`.
- A retraction produces a feed entry and a Discord correction.
- A dry-run email never writes `email_status = 'sent'`.
- A suppressed address is not sent to, asserted at the sender.
- `POST /api/alerts` does not return `verify_token`.
- An inbound subscribe request with a forged `From` results in a confirmation request and no
  subscription.
- The record receipt manifest hashes match the files, and a retracted claim is absent from the next
  snapshot while remaining in the prior one.

## Open question the operator owns

**Does email happen at all?** Sections 1–4 plus the calendar and MCP cover delivery with no consent
regime, no PII, and nothing to breach. Email adds reach into inboxes that do not subscribe to feeds
— which is a real audience, probably the largest one — at the cost of becoming a custodian of
personal data and of a permanent deliverability obligation. The operator said yes. The brief says
re-ask once the query feed exists, and this spec agrees: build 1–4, watch what people actually use,
then decide with evidence rather than in advance.
