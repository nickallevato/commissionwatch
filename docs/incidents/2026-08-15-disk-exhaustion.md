# Incident: deploy host ran out of disk; releases stopped landing while the monitor reported green

## Summary

The deploy host's disk filled. `deploy-aws` failed twice extracting a Docker layer
(`no space left on device`), so two releases' worth of commits stopped landing while production
kept serving the previous good sha and answering health checks 200 — a failed deploy behaving
correctly by leaving the old version running. Nothing alerted, because the monitoring that existed
at the time checked whether the *site* was up, not whether the *release that should be live* was
live, and the site was up throughout. The site itself was never at risk; the backlog of committed,
tested, pushed changes simply did not reach production for the duration.

## Timeline

All times UTC unless stated otherwise.

| | Time | Source |
|---|---|---|
| **Start** (the fault began — disk fills, first failed deploy) | unknown clock time, 2026-08-15 | `docs/STATUS.md:137` — run 29009 failed; `docs/CHANGELOG.md:461–478` |
| **Detected** (someone or something noticed) | unknown — no run ID or timestamp records a human or automated actor first flagging it; the operator's own resolution (disk cleared) is the first *recorded* human action | `docs/STATUS.md:6` |
| **Resolved** (the fault stopped — disk cleared, backlog deployed) | ~22:15Z, 2026-08-15 | `docs/STATUS.md:6` — "The deploy host's disk was cleared by the operator at ~22:15Z on 2026-08-15, so the 0.4.0 backlog is deployed" |
| **Fix landed** (the underlying blind spot — no drift detection — was actually fixed) | 2026-08-16, in the 0.5.0 release | `docs/CHANGELOG.md:92–124` — the release-drift check and the `blocked` `CheckState` |

- **Start → Detected:** unknown. No source records when a human or system first noticed the disk
  was full or that deploys had stopped landing, as opposed to when the operator acted to fix it.
- **Detected → Resolved:** unknown for the same reason — the only firm anchor is the resolution
  time itself. The project's own account of the *drift window* — "production served `72c10b0` for
  about four hours while the head of main moved several commits ahead" (`external-monitor.ts:303`)
  — describes how long the release lagged, not a measured detection-to-resolution interval, and no
  clock time marks when that four-hour window began.

## Detection

**Nobody's monitoring caught this while it was happening; it was found afterward, by review.** At
the time, the external monitor (`backend/src/scripts/external-monitor.ts`) already existed and was
running on a 15-minute tick, but it checked HTTP reachability, database connectivity, sha agreement
between `/api/version` and `/version.json`, and ingestion staleness — never whether the *commit that
should be live* was the commit actually live. Every one of those checks passed throughout the
window, because the previous good release was healthy. `docs/CHANGELOG.md:100–102`: "the monitor
reported **success every fifteen minutes across the entire window**. It was not silent about the
drift — it was emitting the green signal an operator would cite to conclude nothing was wrong."

Separately, `deploy.yml`'s own CI run failed loudly (run 29009, `deploy-aws` step) — every check job
(`ci-backend`, `ci-frontend`, `ci-deploy-script`, `build-and-push`) stayed green on the same sha, and
only `deploy-aws` failed, on the instance, extracting a Docker layer. That failed run was visible in
Gitea's run list, but nothing in the record says when a human read it versus when the operator
separately noticed and cleared the disk. (`docs/STATUS.md:135–167`, `docs/CHANGELOG.md:461–478`)

## What broke

`deploy-aws` extracts Docker image layers onto the host's disk before swapping containers. The disk
was full (root cause of *why* it filled is not diagnosed in any source read for this record — the
runbook explicitly says to diagnose before deleting, because the npm cache named in the error is a
symptom of a full disk, not necessarily what filled it: `docs/STATUS.md:151–157`). The layer
extraction failed with `no space left on device`, and the SSM command finished `Failed`. Because the
image pull failed before any container was replaced, production kept running the previous good sha
— the pipeline's failure mode is "leave the old version running," which is correct behaviour, and it
is exactly what made the fault invisible to every check that only asked "is the site up."

## Impact

No reader-facing outage — `/api/health` answered 200 throughout, and `/api/version` correctly
reported the *old* sha. What was lost was **freshness**: for the duration of the window, several
committed, CI-passed, pushed changes did not reach production, including the extraction
de-duplication, the taxonomy mirror guard, the `ALERT_FROM_EMAIL` fix, and the dated export archive
loop (`docs/CHANGELOG.md:307–316`). The failure mode this incident demonstrates is the one named in
`docs/STATUS.md:166–167`: "A green check suite plus a healthy site does not mean the release
deployed."

## Resolution

The operator cleared disk space on the host and re-ran the deploy, landing the backlog at ~22:15Z
on 2026-08-15. (`docs/STATUS.md:6`)

## What changed as a result

- **The release-drift check**, `evaluateReleaseDrift` in `backend/src/scripts/external-monitor.ts`,
  added in 0.5.0 specifically to compare the live sha against the commit that *should* be live —
  something no earlier check did. (`docs/CHANGELOG.md:92–124`)
- **A fourth `CheckState`, `blocked`**, distinct from `pass`/`warn`/`fail`, for every case where the
  drift comparison could not be made (unreadable `/api/version`, missing expected head, unparseable
  timestamp) — so an unanswerable question is never reported as a confident answer in either
  direction.
- **A settle policy** (3 re-reads, 10 seconds apart) so a probe landing mid-swap during a *good*
  deploy is not misread as drift — `docs/CHANGELOG.md:125–142`.
- **`DEFAULT_MAX_DRIFT_MINUTES = 30`**, measured from three real green pipelines rather than
  guessed, so the check is quiet on an ordinary deploy and fires well before a genuine multi-hour
  stall.
- Documented runbook addition: diagnose the disk before pruning (`docker image prune -af` would
  remove the images a rollback needs) — `docs/STATUS.md:151–160`.
- This record itself — before this incident, MTTR for this class of fault was unmeasurable because
  no timestamp of any kind was kept; even now, only the resolution time survives.

## Source

`docs/STATUS.md:6` (release summary), `docs/STATUS.md:126–167` (0.4.0 section, "the deploy that did
not happen"), `docs/CHANGELOG.md:307–316` and `:459–478` (0.4.0 changelog), `docs/CHANGELOG.md:92–124`
(0.5.0 changelog, the release-drift check), `backend/src/scripts/external-monitor.ts:286–313`
(`DEFAULT_MAX_DRIFT_MINUTES` docblock, the four-hour figure and the false-green observation). Gitea
run ID `29009` for the failed deploy; no run ID recorded for detection.
