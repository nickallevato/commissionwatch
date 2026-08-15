# The `claim_publication` gate — a design question for the operator

**Status: SPEC ONLY. Nothing here is implemented, and it must not be implemented without the
operator.** Written 2026-08-16 during the second autonomous loop, after finding that the switch
named `claim_publication` was wired to nothing.

---

## What is actually true today

`claim_publication` shipped in the 0.4.0 manifest with this description:

> An approved claim renders for the public inside the meeting it was extracted from, at
> `#claim-{id}`, serving the pinned `rendered_text` bytes that were approved rather than a re-render.
> Approval is still a wall: this switch decides whether approved claims are shown, never whether a
> claim needs approving.

Two of those sentences are true statements about the system. The third — *this switch decides
whether approved claims are shown* — is false. The key appears nowhere outside `manifest.ts`.

**Approved claims are already public**, through **six** surfaces, none of them gated. This document
first said three; that was wrong, and the correction matters because it widens what a switch would
have to reach:

| Surface | Module | Reached by |
|---|---|---|
| Syndication feeds | `services/feeds/entries.ts` | `routes/feed.ts` |
| Bulk open data | `services/export/datasets.ts` | `routes/data.ts` |
| Corrections log | `services/public-corrections.ts` | `routes/corrections.ts` |
| The meeting's own claims API | `services/review/claims.ts` → `listPublicClaims` | `GET /api/meetings/:id/claims` |
| **Prerendered public pages** | `services/prerender/pages.ts` | reuses `listPublicClaims` whole |
| **The MCP server** | `services/delivery/mcp.ts` | reuses `listPublicClaims` whole |

All six go through the wall — `whereClaimPublic`, migration 087's predicate: approved, unretracted,
meeting public — so the **wall is intact and was never the problem**. The defect is only that the
console advertises a control over these surfaces that does not exist.

The last two are the awkward ones for any gating design. A prerendered page is a **file already
written to disk**; turning a flag off does not unwrite it, and the consumer only rewrites a page when
an event tells it to. So a switch over claims would have to enqueue a re-render of every affected
meeting to take effect at all — which is a very different operation from "stop serving", and it is
the kind of thing an operator would reasonably expect a switch to do instantly.

## Why the loop did not simply wire it

The obvious change is to make each of those three call sites consult `featureEnabled("claim_publication")`.
Doing that would have been wrong in two independent ways, and both are worth stating because they
generalise beyond this key.

**1. It is a live-content change disguised as a wiring fix.** The registry's documented resolution
falls off to **off** in every failure mode. So wiring the gate makes the flag off by default, which
on the next deploy **removes claims that are public in production right now** — from feeds readers
have subscribed to, from an open-data export somebody may have forked, and from the corrections log,
which is the surface a person uses to see that a claim about them was changed. A transparency
project silently withdrawing published material because of an internal refactor is worse than the
missing switch.

**2. It breaks the property 0.4.0 was built on.** With no row in `features`, behaviour is
byte-identical to 0.3.0. That is why the drain, prerender and MCP suites pass unmodified rather than
rewritten, and it is the reason the registry could be trusted at all. A key whose introduction
changes behaviour with no row present is not a compatibility layer.

The reverse — giving this one key a default of *on* — breaks the other invariant: **resolution falls
off to off in every failure mode**, including a database the process cannot reach. A `publishes` key
that defaults on is a key that publishes when the registry is broken.

So the question is genuinely undecided, and it is the operator's.

## The question

**Should an already-public surface ever acquire a switch?** Three answers, with what each costs.

### Option A — no switch; delete the key permanently

Approved claims are public because an operator approved them one at a time, against a wall that
cannot be flagged away. That approval *is* the decision, and a second switch that can retract forty
approvals at once is a bulk operation the review path deliberately refuses to have
(`claims.ts`: *"There is no bulk approve, and there must not be one"*).

- **Cost:** no kill switch if generated claims turn out to be systematically wrong. Retraction
  remains per-claim, through the existing retraction path.
- **Honest, and consistent with the review design.**

### Option B — a switch that defaults on, for this key only

Preserves current behaviour exactly and gives an operator one lever to pull.

- **Cost:** breaks "falls off to off". Requires the manifest to carry a per-key default and the
  resolver to honour it, which means an unreachable database now publishes.
- **Mitigation to evaluate:** default-on *only* when the registry read succeeded and returned no
  row, and off when the read failed. That distinction is expressible — `resolve()` already reports
  its `source` — but it makes the resolution rule materially harder to state, and a rule an operator
  cannot recite is a rule they will misjudge under pressure.

### Option C — a switch that defaults off, plus a one-time migration writing `enabled = true`

The row exists from the moment the key does, so no deploy ever removes public content, and the
resolver keeps its single rule.

- **Cost:** the audit log opens with a change nobody made. `features_audit.reason` is `NOT NULL` for
  a reason — every row is supposed to be a decision by a named operator. A migration-authored row
  either lies about that or needs an explicit "system, at introduction" actor, which is a new concept
  in a table built to avoid exactly that ambiguity.
- **This is the option the loop would pick if forced**, because it keeps the resolution rule intact
  and never withdraws published material — but it should be chosen deliberately, not by default.

## What must be true whichever is chosen

- **The wall does not move.** `whereClaimPublic` stays exactly where it is, and no flag value causes
  an unapproved or retracted claim to render. This document is about a switch over *approved* claims
  only.
- **If a switch is added, the console must say what turning it off actually removes** — three named
  surfaces, one of which is a syndication feed that readers already hold. "Published claims" as a
  title does not convey that unsubscribing happens on someone else's machine.
- **A person's correction must not be hideable.** If `corrections.ts` is gated, an operator could
  make a correction about a named person invisible while the original claim stayed cited elsewhere.
  If any surface is exempt from the switch, it is that one, and the reason belongs on the row.

## The related key

`generated_narrative` was removed alongside it. That one is simpler: it describes a findings composer
that **does not exist in the codebase**. There is nothing to gate. It returns when a composer does,
and its manifest entry should be written from what the composer actually does, not from what was
planned for it.

## Recommended next step

Do not implement any of this from a loop. Bring the three options to the operator, confirm whether a
`publishes` key may ever default on, and only then write the plan. Until then the honest state is the
one this loop shipped: **the console shows four switches, and all four do something.**
