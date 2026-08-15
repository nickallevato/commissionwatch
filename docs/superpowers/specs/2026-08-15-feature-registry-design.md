# Feature registry — an operator switch for what is shipped dark

**Date:** 2026-08-15
**Status:** design of record for 0.4.0
**Supersedes:** nothing. Extends the env-var flag convention in `drain.ts`, `consumer.ts`, `mcp.ts`.

## The problem

Three features are shipped dark — the event drain, prerendering, and the MCP server — and each is
gated by a `process.env` read. That convention was right for shipping them and is wrong for
operating them:

- **Turning one on requires a redeploy.** The value lives in a SecureString at
  `/commissionwatch/env`; changing it means editing Parameter Store and re-running the SSM deploy.
  An operator deciding at 11pm that the drain is misbehaving cannot turn it off in under ten
  minutes, and the ten minutes are spent on the thing that is already going wrong.
- **There is no record of who turned it on.** Every other consequential act in this codebase writes
  an audit row with an actor and a reason — approving a claim, approving a place link, publishing a
  finding. Enabling the delivery pipeline is a larger act than approving one claim and currently
  leaves no trace at all.
- **The operator cannot see the state.** Nothing in the console says which features are live. The
  answer is spread across a compose file, a Parameter Store value, and three source comments.

And the forward problem: this release adds features that **should not be public on merge** — a
generated narrative about a named official, a publication path for approved claims. The project's
existing answer to "not ready" is a `process.env` read, which means every one of them would need a
Parameter Store edit and a redeploy to evaluate. That does not scale, and a flag nobody can flip is
a flag nobody evaluates.

## What this is not

**A feature flag is not a wall.** The publication wall, the review gate, the claim wall, and the
"nothing naming a person auto-publishes" invariant are not features and get no flag. There is no
row that can turn them off, and `feature-registry-audit.test.ts` asserts the registry's key set
contains nothing that could.

This distinction is the whole design. A registry that can disable a safety property is a worse
artifact than no registry, because it converts an invariant into a setting — and a setting is
something somebody eventually changes at 11pm for a reason that made sense at the time.

The registry gates **whether a capability runs**, never **whether a check applies**.

## Resolution order

A flag resolves through three sources. The order is chosen so the failure modes all fall the same
way — off.

```
1. env kill switch   FEATURE_<KEY>=false|0|no|off   →  OFF, unconditionally
2. registry row      features.enabled                →  that value
3. env legacy        <LEGACY_ENV_NAME>=true|1|yes|on →  that value
4. default                                           →  OFF
```

**Why the env kill switch outranks the database.** The registry is read from Postgres. The scenario
that most demands turning a feature off is the one where the feature is hammering Postgres, and a
switch that needs a healthy database to say "stop" does not work when it matters. `FEATURE_*=false`
is honoured from the environment alone, needs no query, and cannot be overridden from the console —
so an operator who has lost the console still has a lever, and the lever survives a restart because
it lives in the deploy config.

It is deliberately **one-directional**: env can force a feature off, never on. Forcing on from the
environment would reintroduce the untraceable enable this design exists to remove.

**Why the legacy env read stays.** `MCP_ENABLED`, `PRERENDER_ENABLED` and `EVENT_DRAIN_ENABLED` are
documented in `deploy/docker-compose.shared.yml`, in `docs/STATUS.md`, and in the operator steps
that were written yesterday. Removing them would silently change the meaning of a deploy config
that is currently correct. With no registry row present, behaviour is **byte-identical to today** —
which is also what keeps the existing drain, consumer and MCP test suites honest rather than
rewritten.

## Reading a flag without a query per request

`mcpEnabled()` is synchronous and called on every request to `/mcp`. Making flag resolution async
would push a promise into that path and into `nginx`-adjacent code that has no business awaiting a
database.

So the registry is **cached in process**, and the cache is the only thing the read path touches:

- `FeatureRegistry.get(key)` is synchronous and reads the cache.
- A poller refreshes every `FEATURE_POLL_INTERVAL_MS` (default 5,000). The backend and any worker
  process each run their own, which is how a toggle propagates to a process that did not serve the
  request that made it.
- A write through the admin route invalidates the writing process's cache immediately, so the
  operator's own next page load reflects what they just did rather than showing them stale state
  for up to five seconds and inviting a second click.
- **Until the first successful load, every key resolves through env and default only** — that is,
  off unless a legacy env var says otherwise. A process that cannot reach the database does not
  enable anything, and never blocks startup waiting to find out. The cache tracks `loadedAt` and
  the console displays it, because "the switch says on" and "this process has confirmed the switch
  says on" are different facts and the operator screen must not conflate them.

Five seconds of skew is acceptable for every key in the registry and is stated in the console. It
would not be acceptable for a wall, which is one more reason walls are not in here.

## The audit trail

Every write records `features_audit`: the key, `enabled_from`, `enabled_to`, the operator, the
timestamp, and a **required reason**. Same shape and same requirement as the place-link and claim
review paths — approve and reject each demand a reason there, and this is a larger act than either.

A no-op write — setting a flag to the value it already has — is rejected rather than recorded, so
the audit log reads as a list of changes and not a list of clicks.

## The schema

Migration `104_create_features.ts`.

```
features
  key              text primary key      -- snake_case, matched against the registry's allow-list
  enabled          boolean not null default false
  updated_at       timestamptz not null default now()
  updated_by       uuid null references operators(id)
  update_reason    text null

features_audit
  id               bigserial primary key
  key              text not null
  enabled_from     boolean null           -- null on the first write for a key
  enabled_to       boolean not null
  operator_id      uuid null references operators(id)
  reason           text not null
  created_at       timestamptz not null default now()
```

`features.key` carries **no foreign key to a table of valid keys**, deliberately: the set of real
features is a property of the deployed code, not of the data, and a row for a key this build does
not know about must be inert rather than an error. `FeatureRegistry` resolves only keys in its
compiled `FEATURES` manifest and ignores the rest — a row left behind by a rolled-back deploy does
nothing, which is the behaviour a rollback needs.

`update_reason` is nullable on `features` (it mirrors the most recent write, and a row created by a
migration seed has no operator behind it) and NOT NULL on `features_audit`, where every row has a
writer by construction. Following `098_null_safe_check_constraints.ts`: **no CHECK on this table
spans a nullable column**, because a CHECK that evaluates to NULL is satisfied and this project
shipped four of those in one day.

## The manifest

`backend/src/services/features/manifest.ts` — the compiled list. Each entry states the key, a
human title, what turning it on actually does, its risk, and the legacy env name if it has one.

| key | legacy env | what it does when on |
|---|---|---|
| `event_drain` | `EVENT_DRAIN_ENABLED` | The drain dispatches product events to routed channels. |
| `prerender` | `PRERENDER_ENABLED` | The consumer writes static documents for crawlers. |
| `mcp_server` | `MCP_ENABLED` | `POST /mcp` and `/.well-known/mcp.json` answer instead of 404. |
| `claim_publication` | — | An approved claim renders inside its meeting for the public. |
| `generated_narrative` | — | The findings composer drafts prose **into the review queue**. |
| `dated_export_archive` | — | `/api/data/archive` serves point-in-time exports. |

`generated_narrative` deserves its note here: **on** means drafts reach the operator queue, not the
public. There is no flag value that publishes generated prose about a person, because the review
gate is a wall.

Every manifest entry carries `risk: 'low' | 'publishes' | 'sends'`. `publishes` means turning it on
changes what a stranger can read; `sends` means it emits something that leaves the building and
cannot be recalled. The console groups by risk and demands a typed confirmation for `sends`, which
today is `event_drain` alone.

## The console

`/admin/features`, `GET`/`PUT /api/admin/features`, behind `requireOperator` like everything else
mounted after that line in `routes/admin/index.ts`.

The screen states, per feature: the resolved value, **the source that decided it** — kill switch,
registry, legacy env, or default — the last change with its actor and reason, and this process's
`loadedAt`. Naming the deciding source is the point: an operator who flips a row and sees no change
must be told that `FEATURE_EVENT_DRAIN=false` is in the deploy config, rather than concluding the
console is broken and flipping it again.

A feature whose value is forced by a kill switch renders its control **disabled, with the reason**,
because a control that accepts a click and changes nothing is worse than no control.

## What this does not solve

- **A flag is not a migration.** Turning on `prerender` still requires a rebuild, because the
  consumer walks the event log and nothing replays an old publish. The console states that
  requirement on the row rather than leaving it in `docs/STATUS.md`.

  **Correction, found while implementing F1b:** this document called that a *seed*, and it is not
  one. `seeds/` holds `001_pilot_data.ts` and nothing else; the real thing is
  `npm run prerender:rebuild` → `src/scripts/prerender-rebuild.ts`. The distinction matters because
  an operator told to "run the seed" will look in `seeds/`, find no such file, and reasonably
  conclude the step is already done — on the one step this release documents as not optional.
- **Nothing here schedules extraction.** That is gated on the truncation work, not on a switch.
- **The email defect is unaffected.** `event_drain` on with SPF/DKIM/DMARC unconfigured and
  `ALERT_FROM_EMAIL` pointed at a domain we do not deploy still fails alignment. The console says so
  on the row, and the fix is separate.
