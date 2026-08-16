# Incident records

This directory exists because MTTR — mean time to restore, one of the DORA four keys — was
**unmeasurable** as of 2026-08-16, for one reason: no incident anywhere in this project's history
had a recorded start time and end time. The project had lived through real incidents and narrated
them honestly in `docs/STATUS.md` prose, but prose with no timestamp cannot be aggregated. This
directory is where that changes going forward, and two real incidents are backfilled below as far
as their record actually supports.

## Format

One file per incident, at `docs/incidents/YYYY-MM-DD-short-slug.md`, copied from
[`TEMPLATE.md`](./TEMPLATE.md). The date in the filename is the incident's start date, or its
detection date if the start is unknown.

**Non-negotiable fields:** start time, detection time, resolution time (and a separate "fix landed"
time if the underlying cause was fixed later than the symptom was resolved). These four are the
only reason MTTR becomes computable at all — an incident record without them is exactly the prose
this directory replaces, just moved to a new file.

**Where a timestamp is genuinely unknown, the field says "unknown."** Both incidents backfilled
below have at least one unknown timestamp, and one has three of four. A backfilled record with an
invented time is worse than a gap: it makes MTTR look computed when it is guessed, and a guessed
number that later gets treated as measured is a worse failure than an honest blank. See each
incident file's Timeline table for exactly which fields are known and which are not, and why.

## Incidents on file

| Date | Incident | Timestamps known |
|---|---|---|
| [2026-08-09](./2026-08-09-crash-loop-502.md) | Crash-looping backend, 502 on every `/api/*` route, "about four hours" | **None** — start, detection, and resolution are all unknown to the clock; only the fix-landed date (2026-08-10) is known, with no time of day |
| [2026-08-15](./2026-08-15-disk-exhaustion.md) | Deploy host ran out of disk; releases stopped landing while the external monitor reported green throughout | **One of four** — resolution (~22:15Z) is known; start, detection, and the exact fix-landed time are unknown |

**Total: 2 incidents backfilled. Both have at least one genuinely unknown timestamp; the first has
three of the four unknown.** No timestamp in either file was estimated — every "unknown" is a
deliberate refusal to invent one, not an oversight. See each file's Timeline table for the citation
behind every field that *is* filled in.

Two incidents is fewer than the four items named when this record was scoped — "the deploy host
filling its disk, the crash-looping deploy, the four-hour outage, the monitor reporting green
through a window where deploys had stopped landing." Reconstructing them found that these describe
**two** incidents, not four: the crash-loop and the four-hour outage are cause and symptom of the
same 2026-08-09 event, and the disk exhaustion and the false-green monitor window are cause and
symptom of the same 2026-08-15 event. Filing them as four would have manufactured incident count
rather than measured it.

## What this makes measurable, and what it doesn't yet

**MTTR is still not computable from these two records**, because neither has a complete
start-to-resolution pair. The 2026-08-15 incident has a resolution time but no detection or start
time to measure *from*. The 2026-08-09 incident has neither end. What this directory does provide,
starting now, is a place for the *next* incident to be recorded with real timestamps at the time it
happens — which is the only way this ever becomes measurable, because a timestamp reconstructed
after the fact from prose that was never written to preserve one is not recoverable no matter how
carefully the file is written.

## The DORA four keys — what is measurable today, and what isn't

Re-measured 2026-08-16, directly against the Gitea Actions API (`${GITEA_URL}/api/v1/repos/${GITEA_REPO}/actions/runs`,
paged to exhaustion, filtered to `deploy.yml@refs/heads/main`). This supersedes the figures first
taken by `docs/superpowers/specs/2026-08-16-maturity-review.md` §3 and restated by
`2026-08-16-maturity-review-2.md`, both of which were already several hours and several deploys old
by the time this file was last touched. MTTR's status is unchanged from "unmeasurable" to "not yet
measured, but now possible" by this directory's existence, not by anything below.

| DORA key | Measurable today? | Value, and why |
|---|---|---|
| **Deployment frequency** | **Yes** | 257 `deploy.yml` runs on `push` (1 still in progress); 96 concluded `success`. Elite band, unchanged in character from the earlier count. |
| **Change failure rate** | **Yes** | All-time: 84 failures / 180 concluded (excluding 76 `cancelled`) = **46.7%**. Last 100 concluded deploy runs: 11 / 67 = **16.4%**. DORA elite is 0–5%, high 10–15% — this project sits at the medium band on its best recent window, both essentially unchanged from the prior measurement (48.8% and 15.7%). |
| **Lead time for changes** | **Partially** | Computable in principle from commit time → deploy run completion, but nothing computes it today, and see *Cancelled runs*, below, for why the naive per-commit figure would be wrong. |
| **Mean time to restore (MTTR)** | **No, not yet** | This directory now exists and the *reason* it didn't exist is fixed, but neither backfilled incident has a complete start→resolution pair, so there is nothing to aggregate yet. MTTR becomes measurable the next time an incident is recorded with real timestamps at the time it happens. |

### Cancelled runs distort deployment frequency's sibling metric and lead time — and the fix made it worse, not better

**33% of the last 100 deploy runs are `cancelled`**, up from the 29% this file previously cited as
the problem — and that 29%→33% move is itself now superseded by a cleaner, directly-measured
before/after split around the moment the fix was decided.

`deploy.yml` runs under a concurrency group, so pushing again while a deploy is still in flight
cancels the in-flight run rather than queuing behind it. During periods of rapid iteration — commits
landing minutes apart — each push can cancel the deploy the previous push had just triggered, so a
`cancelled` run usually means "superseded by a newer push," not "this deploy broke."
`docs/STATUS.md:250` already carries this reasoning, restated here because it is the reason lead time
is only "partially" measurable above: a naive per-commit lead-time figure would count every
superseded commit as never having deployed, when in fact its successor deployed on its behalf almost
immediately.

**This project's own development loop changed its push behaviour once this pattern was
diagnosed** — batching related changes rather than pushing on every small commit — specifically
because repeated pushes were seen cancelling their own in-flight deploys. The batching decision was
made and recorded around 08:20Z on 2026-08-16 (`docs/superpowers/plans/2026-08-16-maturity-loop.md`,
tick "08:20Z"). Measured directly against the Gitea API rather than assumed:

| Window | Cancelled | Concluded runs | Rate |
|---|---:|---:|---:|
| Last 100 concluded runs **before** 08:20Z | 30 | 100 | **30.0%** |
| Every concluded run **since** 08:20Z | 4 | 11 | **36.4%** |

**The rate did not improve after the batching decision — it got worse, on the numbers available.**
This is worth recording plainly rather than softened: a fix the project's own log describes as
adopted specifically to stop this did not stop it in the window measured so far.

Two honest caveats belong next to that number rather than instead of it. First, the post-decision
sample is **11 runs** — small enough that four cancellations either way would swing the rate by
roughly nine points, so this is not strong evidence of the fix failing, only evidence that it has
not (yet) shown up as working. Second, "cancelled" here still means what it meant before: usually a
push superseded by a newer one, not a broken deploy — so a higher cancellation rate in a small,
recent window is also consistent with a burst of legitimately rapid, correct iteration (this loop
landed roughly a dozen items in the hours around the decision) rather than a regression in push
discipline. Both readings are consistent with the same eleven data points, and the sample is too
small to choose between them. What can be said without qualification is that **the rate has not
dropped**, so the claim that batching "fixed" the cancellation pattern is not supported by the metric
it sits next to, and should not be repeated as settled until a larger post-decision sample says
otherwise.

The 76 all-time `cancelled` runs are excluded from the change-failure-rate denominator above for the
same reason as before: a cancelled run is not a caught bad change, and folding it into the failure
count would overstate how often the pipeline is actually catching something wrong, rather than being
superseded by something newer.
