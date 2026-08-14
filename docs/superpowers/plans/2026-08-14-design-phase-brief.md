# Design-phase brief — what still needs a spec

> Written 2026-08-14 as a handoff. The operator asked for **a design phase covering everything not
> yet built**, after the build work recorded in `docs/STATUS.md` § 2026-08-14.
>
> Read first: `docs/STATUS.md`, then
> `docs/superpowers/specs/2026-08-14-system-roadmap-design.md` (the roadmap — *what* and *why*,
> already decided). This file is the list of specs that roadmap still needs, with the constraints
> each must satisfy. Per `.claude/skills/commissionwatch-development/SKILL.md` the pipeline is
> **brainstorm → spec → plan → fan-out → verify → commit**, and these are all at the spec stage.

## State at handoff

`main` is green and deployed: backend **1308 tests / 308 suites**, frontend **485 / 45**, backend
lint 1 warning / 0 errors, frontend 0 problems. Every push to `main` deploys.

**Built:** the operator guard, the `agents/` deletion, the crawler door (robots + walled sitemap +
nginx), the regions module (migration 074), error-handler tests and its two fixes, the
accessibility pass.

**Not built, and the subject of this brief:** everything below.

---

## 1. The event spine — `docs/superpowers/specs/…-event-spine-design.md`

Roadmap §3. The highest-leverage cohesion change, and every delivery channel depends on it.

Must specify: the persisted `events` table and its relationship to the existing `deliveries` /
`channel_routes` / `resolveRoutes` machinery; where `DeliveryDispatcher` is constructed (it is
currently never constructed by the server — its only live caller is `scripts/emit-ops-event.ts`);
replay semantics after a restart; and the ordering guarantee, if any.

**The invariant to design to:** an event is emitted *only* for a `published` object. Then no
consumer needs its own publication check, and the wall stops being enforced in eleven places. State
explicitly what happens when an object is unpublished after an event was emitted.

## 2. The published claim — `…-published-claim-design.md`

Roadmap §4, and **`STATUS.md` next-step 1g calls this genuinely undecided.** The highest-stakes
thing this project would publish: a claim naming a living official.

Must answer: what the reader sees; how the citation is rendered and addressed; whether a claim is
its own page (see §6 below); what an operator approves *exactly* (the sentence? the triple?); what
retraction looks like given `record_corrections` is append-only; and how a claim's published form
stays pinned to what the operator read when they approved it.

**Do not** allow generated narrative prose. Assemble from verified claims with deterministic code.

## 3. The LLM governor — `…-llm-governor-design.md`

Roadmap §4. Pass 2 over `services/extraction/`'s existing output.

Constraints already decided: free-only through prototype (`assertFreeModel` stays), production may
move to a paid model later, so the model is a swappable pin. The governor is a **judge, never an
author** — it sees only the ±2,000-char window and the claim triple, never pass 1's reasoning;
emits a constrained verdict including `unsupported_fragments` so it must *point*; never rewrites.
Hallucinated-name detection is mechanical, not LLM. Severity is a deterministic table; a
model-proposed severity is `alwaysHold: true`.

Also in scope: the **claims review screen** (`minute_claims.status`, `reviewed_by`,
`review_reason`, `reviewed_at` all exist and nothing writes them, so no operator can approve a
claim at all today) — follow B-a rather than inventing a second approval concept.

## 4. Corpus throughput — `…-extraction-throughput-design.md`

Roadmap §5, and the binding constraint on everything else: `/api/data` publishes **1 meeting,
0 votes, 0 findings**.

Must cover: the `OpenRouter returned no message content` fault leaving ~20% of every document
unread (start by widening the error to report `finish_reason`); **batch extraction as a queue
stage, not a loop in a route**; a sourced roster (probe before designing — none could be found on
2026-08-11); and the `VoteEvent` wrapper, because *"the motion failed 2–3" is not currently a
first-class fact in the database*.

## 5. Transcripts — `…-transcripts-design.md`

Roadmap §6. `bozeman.granicus.com/videos/{clip_id}/captions.vtt` returns real WebVTT.

Must cover: the `transcript` document kind and the `MediaPlayer.php` → `clip_id` extraction;
`transcript_absent` for the 8-byte stub (5 of 14 sampled clips — "published nothing" and "published
an empty transcript" are different statements); VTT into `artifact_texts` and search; and
speaker attribution anchored on the minutes, **never on audio** — `>>` is a CEA-608 *change*
marker, not an identity.

**Probe Gallatin's broadcast route first.** It is genuinely unknown.

## 6. Delivery — `…-delivery-design.md`

Roadmap §7, in ascending order of risk: RSS/Atom, the query-feed, Discord (webhook, **not** a
gateway bot), the record receipt, outbound email, inbound email.

Email must not ship before: the `email_status = 'sent'` lie is fixed (the digest scheduler runs
daily in production against a dry-run sender), a suppression table exists, `List-Unsubscribe`
headers are set, and the one-commit cutover `STATUS.md` specifies is done — moving email onto the
dispatcher and dropping `alert_subscriptions` **together**, because splitting it double-sends. Also
`POST /api/alerts` returns the `verify_token` in its 201 body today.

The two operator-requested extras: **the query is the subscription** (`/feed?q=…`, no account, no
PII) and **the weekly record receipt** (dated snapshot + sha256 manifest to a public git repo,
which also answers "what did this site say in March", currently stated as unanswerable on `/data`).

## 7. Server rendering and reach — `…-server-rendering-design.md`

Roadmap §8. The crawler door is open but every page still returns a 525-byte shell, and ~69% of AI
crawlers execute no JavaScript.

Must cover: SSR or prerender for one URL per meeting / agenda item / finding, with a real per-page
title, meta description and absolute self-referencing canonical; server-rendered `Dataset` and
`Event` JSON-LD (the existing `Dataset` JSON-LD is inside a React component and will likely never
be seen); the OCD-shaped export validated in CI; the `/bot` page; and 429 / `Retry-After` handling
in `services/ingestion/`, which exists in the SMS and OpenRouter clients but not in the crawl layer.

## 8. Vocabulary and the design system — `…-vocabulary-and-ui-design.md`

Roadmap §3 and §10. Do this **before** the surfaces above multiply the rename cost.

`finding` / `official` / `meeting` / `document` / `artifact` / `source`, enforced by a test in the
existing idiom. Today the list is at `/members` while the page says "Officials"; the nav says
"Findings", the URL says `/anomalies`, the headline says "Flagged for review", and the body copy
says "nothing here is a finding."

Plus: one provenance component set used by both tiers; the `components/ui/` extraction (the
operator console is currently better-built than the reader's site); and the `<Absence>` empty-state
grammar.

---

## Open decisions the specs must not silently resolve

1. **What a published claim about a named person looks like** — §2 above. Genuinely undecided.
2. **Whether email happens at all**, given RSS + query-feed + Discord cover delivery with no
   consent regime and no PII. The operator said yes; worth re-asking once the query feed exists.
3. **`rundown_sheets`** — revive on the claims path, or retire the table. It has no writer since
   the `agents/` deletion.
4. **Who the product is for.** No one has shown *residents* paying for local meeting alerts; every
   civic nonprofit that built keyword alerts killed the feature, while two funded companies sell it
   to realtors, homebuilders, law firms and GR teams.

## Operator tasks nobody can delegate

Read the statute and fill the region record — **and confirm which edition**, since MCA 2-6-1006 was
rewritten effective 2026-07-01 and the P7 instructions point at the superseded one. Install the
external-monitor cron. Set `BACKUP_S3_URI` (there is currently no backup, only a copy). Rotate the
superseded OpenRouter key. Decide whether the Caddy allowlist comes down — the defect that argued
for keeping it up is closed and verified in production.
