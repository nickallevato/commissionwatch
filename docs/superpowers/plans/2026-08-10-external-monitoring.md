# External uptime and staleness monitoring

> Plan, 2026-08-10. Written before implementation, from probes rather than assumptions.
> Companion to `docs/STATUS.md` gap 9, "No monitoring".

## Why

Two failures, both of which happened or can happen without anyone finding out.

**One.** On 2026-08-09 production returned 502 on every `/api/*` route for about four hours. The
only reason anyone noticed was a person opening the site. Everything this codebase can say about
its own health — the masthead's sweep clock, `/admin/sources`, `/status` — is served *by the thing
that was down*. A watch that lives inside the process can only report while the process is alive,
which is exactly when it has nothing to report.

**Two.** A stalled scraper and a quiet month at City Hall look identical from outside. A source
that has not swept within its own `expected_interval_hours` is a failure that currently announces
itself to nobody. `/status` renders the verdict; nothing reads it.

So the monitor has to run somewhere else, decide for itself, and fail loudly where the failure
persists after the log scrolls away.

## What was probed first, and what the probes said

Nothing below is assumed.

| Question | How it was answered | Answer |
|---|---|---|
| Does this Gitea support `on: schedule`? | `GET /api/v1/version`, then the run history of every repository on the instance | **The software supports it at 1.25.5; this instance never fires it.** Eight workflows across 82 repositories declare a cron schedule and not one `schedule`-triggered run exists. See "The schedule does not fire on this Gitea" below, and what was shipped instead. |
| Can a runner reach the site through the Caddy IP gate? | Read the `deploy-aws` job log of run 26468 | Yes, on **`dh1`**: `attempt 1: http=200` against `https://commissionwatch.bmux.sh/api/health` at 03:59 on 2026-08-10. `ubuntu-latest` has never made an outbound request to the site, so its egress address is unproven and it is not used. |
| What do the three endpoints actually return? | `curl` against production | `/api/health` → `{"status":"ok","database":"connected",…}`; `/api/version` → `{"service":"backend","sha":"9004d34…","builtAt":…}`; `/version.json` → the same sha from the frontend image; `/api/ingestion/sources` → three sources, **all `enabled: false`**, all `last_success_at: null`, `last_successful_sweep_at: null`. |
| Can a probe run with no `npm install`? | `docker run node:22-bookworm` | Node **v22.23.2**, which strips TypeScript types natively. `node file.ts` runs. No install, no dependency, no lockfile, nothing to go stale. |

That last one settles the shape: the monitor is one dependency-free TypeScript file executed
directly by a stock Node image. A monitor whose green run depends on the npm registry being up is
a monitor that goes red for reasons that have nothing to do with the site.

## What it checks

Three probes, one HTTP request each, at most one retry.

1. **`GET /api/health`** — 200, JSON, and `database` is `connected`. A backend that answers while
   its database does not is a specific, nameable state and it is not health.
2. **`GET /api/version` and `GET /version.json`** — both 200, and **the two shas must be equal**.
   The images roll independently, so a stack serving yesterday's API behind today's UI is healthy
   by every other measure. That is the exact shape of the 2026-08-09 outage. A sha of `unknown` or
   an empty string fails rather than matching its twin: two unstamped images are not a verified
   deploy, they are two absences that happen to be equal.
3. **`GET /api/ingestion/sources`** — the public status feed. Each source is judged below.

## What counts as stale, and what deliberately does not

The feed carries a `silence.verdict` the server computed. The monitor **recomputes from the raw
figures** — `enabled`, `expected_interval_hours`, `last_success_at` — against its own clock. The
point of an external monitor is not to ask the subject how it is doing. Recomputing also catches a
server whose clock has drifted, which asking never would.

| Source state | Outcome | Why |
|---|---|---|
| `enabled: false` | **skipped** | Bozeman, Gallatin and MT CERS are registered and disabled. A source nobody switched on is not failing to sweep; it is switched off. Alarming here would make the monitor permanently red on the day it shipped. |
| enabled, `expected_interval_hours` null or ≤ 0 | **skipped** | Staleness is measured against a stated interval. With no interval there is no threshold, and inventing one would be this project publishing a figure nobody set. |
| enabled, interval set, `last_success_at` null | **warn — never swept** | Reported in the output, does **not** fail the run. The feed does not say *when* a source was enabled, so elapsed-since-enable cannot be computed, and the first minute after an operator enables Gallatin is exactly this state. Failing here would page somebody for switching a source on. |
| enabled, interval set, hours since success > interval | **fail — stale** | The one condition the brief names, and the only one where the arithmetic is complete. |
| enabled, interval set, within interval | **pass** | |

**In production today every source is disabled, so the source probe reports three skips and
passes.** That is correct rather than lucky: the monitor's subject is *whether what we turned on is
running*, and nothing is turned on. The moment Gallatin is enabled it enters *never swept*, and one
cron tick later — or a week later at `expected_interval_hours: 168` if the tick fails — it becomes
*stale* and the run goes red.

Zero records is likewise not a failure condition here. `lifetime_records` is on the console and the
public page in the failure colour already; a fresh deployment with an empty database is the
ordinary state of this system and a monitor that is red from the first minute is a monitor people
learn to ignore.

## Failure is the run, not a log line

The workflow **exits non-zero** on any failing probe. A red scheduled run sits in Gitea's run list
until somebody deals with it; a warning in a green run's log is gone the moment it scrolls.

**It does not report through the thing it monitors.** No POST to `/api/internal/events`. This is
the fallback reasoning from `docs/superpowers/specs/2026-08-04-delivery-channels-design.md`
§ "Transport, and why CI has a fallback", applied all the way: a deploy that broke the backend is
precisely when the backend cannot be trusted to say the deploy broke it. So when
`DISCORD_WEBHOOK_URL` is configured as a repository secret the monitor posts **directly** to it,
with the message saying in as many words that it bypassed the application's routing and why. When
no webhook is configured the failed run is the alert, and nothing else is invented — a second
channel nobody agreed to is not a feature.

Nothing is posted on a green run. A monitor that says "still fine" every fifteen minutes trains
its reader to mute it.

## Politeness

- User agent `CommissionWatchMonitor/1.0 (+https://commissionwatch.bmux.sh; uptime probe;
  admin@bmux.sh)` — honest, names the project, reachable. The same discipline the
  scrapers follow, pointed at our own site.
- 10-second timeout per request via `AbortSignal.timeout`.
- **One request per check per run**, and at most **one** retry, only on a transport error or a 5xx,
  after a 5-second pause. That absorbs a container restart and nothing more. A 4xx is not retried:
  it will say the same thing twice.
- Four requests per run, against our own host, at whatever interval the trigger gives it.

## Files

| File | What |
|---|---|
| `backend/src/scripts/external-monitor.ts` | **New.** The whole monitor: exported pure evaluation functions, then the I/O. One file because Node's type stripping runs a single file with no local imports and no build step; splitting it would buy a build. `main()` runs only when `--run` is on the argv, so importing it in a test probes nothing. |
| `backend/test/external-monitor.test.ts` | **New.** Fixtures for healthy, database disconnected, version skew, version sha unknown, stale source, never-run source, disabled source, and malformed responses of three kinds. Registered in `backend/package.json`'s `test` script. |
| `.gitea/workflows/monitor.yml` | **New.** `on: schedule` every 15 minutes, plus `workflow_dispatch` so the thing can be exercised on demand instead of by waiting. |
| `.gitea/workflows/deploy.yml` | The same probe as a post-deploy step, because the scheduler does not fire here. |
| `docs/STATUS.md` | Gap 9 updated. |

Nothing under `.github/workflows/`. Nothing in `frontend/src/pages/Admin*.tsx` or
`PressroomShell.tsx`. No new dependency in either package.

## How the workflow runs it

`runs-on: dh1` — the only runner proven to get 200 from the site. The step is a single

```
docker run --rm -v "$PWD:/w" -w /w -e DISCORD_WEBHOOK_URL node:22-bookworm \
  node backend/src/scripts/external-monitor.ts --run
```

Docker is already the tool this runner uses for the image build, so the dependency is one that is
proven present rather than hoped for. Pinning the image pins the Node version, and the secret
arrives in the environment rather than in the argument list.

## The schedule does not fire on this Gitea, and that is measured

Version 1.25.5 supporting the feature is not the same as this instance executing it, so it was
checked after the push rather than assumed. **It does not fire.**

- The workflow landed on the default branch at 04:16 UTC on 2026-08-10 and reports `state: active`
  in `GET /actions/workflows`. The 04:30 and 04:45 ticks passed with no run.
- Across **all 82 repositories** on `gitea.example.invalid`, **eight** workflows declare a cron
  schedule and the number of runs ever triggered by `schedule` is **zero**. `na/minobi`'s
  `watchdog.yml` asks for `*/5 * * * *`, has **20,493** runs, and every one of them is a `push`.
  Somebody in this environment already believes they have a watchdog, and they do not.
- `workflow_dispatch` fires (run 26478, this workflow, green against production) and `workflow_run`
  fires elsewhere, so it is the scheduler specifically and not Actions.

The likely cause is the instance's cron being disabled in `app.ini`. That is an operator change on
the Gitea host, outside this repository, and it is worth making: it would light up eight workflows
at once.

**What was done instead of shipping a workflow that never fires.**

1. The `schedule:` declaration stays. It is correct, costs nothing, and starts working the day the
   instance does.
2. `workflow_dispatch` is the trigger that works today, by one `curl` that answers 204. Anything
   holding a token can drive it on whatever interval the operator trusts — a hosted scheduled agent is
   the established pattern here, and `na/minobi`'s watchdog names it as its own fallback. The exact
   request is in the workflow's header comment.
3. **`deploy.yml` now runs the identical probe after every deploy.** Not a substitute for a periodic
   check and not offered as one — but it is aimed squarely at the failure that actually happened,
   because the existing "Verify the site responds" step proves only that `/api/health` returns 200,
   and a stack serving the old API behind the new UI returns 200 from both sides.

## Deliberately not built

- **No heartbeat / dead-man's-switch.** If Gitea itself stops running the schedule, nothing notices.
  Closing that needs a third party outside both systems, and every free one is an account and a
  vendor. Named here rather than left as an unstated assumption.
- **No paid vendor, no new account, no new hosting.** This is why it is built rather than bought.
- **No certificate-expiry check.** Caddy renews automatically; a failed renewal surfaces as a
  transport error on all three probes anyway.
- **No response-time thresholds.** A latency budget nobody has agreed to is a number invented on the
  spot, which is the failure mode this project exists to catch.
