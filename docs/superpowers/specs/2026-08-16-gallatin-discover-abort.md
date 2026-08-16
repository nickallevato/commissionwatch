# Gallatin `discover` AbortError — probe findings

2026-08-16. Investigation only; no code changed.

## What was asked

`gallatin-civicplus` has `lifetime_records: 0` after weeks enabled. The queue shows three
pending `discover` jobs, one with `attempts=1` and `last_error: "AbortError: This operation was
aborted"`. `d886bce` (phase-1 draining) proves the job is now being *tried* — the question is why
the try aborts.

## 1. What the adapter actually does

Read: `backend/src/services/ingestion/adapters/gallatin-civicplus.ts` and
`backend/src/services/ingestion/adapters/http.ts`.

`discoverMeetings(since)`:
1. Fetches `robots.txt` once (cached in-memory for the adapter's lifetime).
2. Fetches `GET /AgendaCenter` (the index — one rendered year per category).
3. For each of the 12 configured categories, computes `years >= sinceYear` that are **not**
   the year already rendered by the index, and issues one
   `POST /AgendaCenter/UpdateCategoryList` per (category, year) pair.

All requests go through `createPoliteTransport` (`adapters/http.ts`), which is:
- Serialized: `maxConcurrency` 1 via a promise chain (`queue = queue.then(...)`).
- Paced: `GALLATIN_MIN_DELAY_MS = 2000` — a floor of 2s between requests.
- Individually timed out: `DEFAULT_TIMEOUT_MS = 30_000`. Each `perform()` call opens its own
  `AbortController`, arms `setTimeout(() => controller.abort(), timeoutMs)`, and clears it in a
  `finally`. **This is the only source of `AbortError` in the whole path.**

Two things worth stating precisely because they rule out the other two candidate origins named
in the task:
- **Not the sweep deadline.** `SweepDeadlineReached` (`scheduler.ts`) is a distinct thrown type
  with its own message (`"sweep reached its Nms deadline..."`), not an `AbortError`, and it fires
  from `drain()`, not from inside a fetch.
- **Not a caller-supplied `AbortSignal`.** `worker.ts` builds a per-job `signal:
  this.controller.signal` in the handler context (`dispatch()`, line ~405), but
  `handlers.ts`'s `discover(ctx)` (line 444-447) never reads `ctx.signal` — it calls
  `source.adapter.discoverMeetings(since)` with no signal at all. The worker's shutdown signal
  is not wired into the adapter's transport. So a worker stop/restart cannot be the origin of
  this particular error either — it would just kill the process, not hand back a clean
  `AbortError` for `queue.fail()` to record.

So the abort is exclusively `createPoliteTransport`'s own 30-second per-request timer firing on
some single request inside a `discoverMeetings()` call.

## 2. Probing the real source

All probes run from this sandbox, honest UA (`CommissionWatch/0.1 ...`), 2s spacing between
requests (matching `GALLATIN_MIN_DELAY_MS`), following redirects.

```
$ curl -sS -A "$UA" -w "http=%{http_code} size=%{size_download} time=%{time_total}" \
    https://www.gallatinmt.gov/robots.txt
http=200 size=816 time=0.37s

$ curl -sS -A "$UA" -L -w "http=%{http_code} size=%{size_download} time=%{time_total}" \
    https://www.gallatinmt.gov/AgendaCenter
http=200 size=116939 time=0.65s
```

`robots.txt` disallows `/admin`, `/search`, a few legacy `.asp`/`.aspx` paths and others, but
**not** `/AgendaCenter` or `/AgendaCenter/UpdateCategoryList` — the adapter's own robots gate
(`guard()`) would not block either of the URLs it fetches. No `Crawl-delay` applies to `*`
(only to `Siteimprove`/`Siteimprovebot`, 20s — not us).

`UpdateCategoryList` POST, one category, three repeats at 2s spacing:
```
attempt 1: http=200 size=2484 time=0.34s
attempt 2: http=200 size=2484 time=0.30s
attempt 3: http=200 size=2484 time=0.33s
```

Full simulated discover pass — all 12 configured categories (`catId` 3,7,14,8,5,10,11,12,13,2,15,4),
one POST each, 2s spacing, matching the adapter's own pacing:
```
cat=3  http=200 time=0.34s
cat=7  http=200 time=0.64s
cat=14 http=200 time=0.68s
cat=8  http=200 time=0.63s
cat=5  http=200 time=0.64s
cat=10 http=200 time=0.75s
cat=11 http=200 time=0.77s
cat=12 http=200 time=0.64s
cat=13 http=200 time=0.65s
cat=2  http=200 time=0.35s
cat=15 http=200 time=0.65s
cat=4  http=200 time=0.35s
```

No degradation across the run, no 429/403, no challenge page, no Cloudflare/Akamai markers (the
site is IIS 10 / CivicPlus, standard headers, permissive CSP). This whole simulated pass — robots
+ index + 12 category POSTs — completed in **about 30 seconds total** (12 × 2s pacing + ~0.5s
average response), the same shape a real `discoverMeetings()` call takes with the default
365-day lookback (`sinceYear` ≈ current year − 1, which the index's own rendered-year filtering
reduces to at most one extra year per category — not a multi-year backfill of 2018-2026).

**Repeated more than once** (robots + index fetched twice more during this session, category POST
issued 3+ times): every response was fast and every response was 200. **The source, from this
network path, is not intermittent — it is consistently fast and healthy.**

## 3. Timeout arithmetic

- Per-request timeout: 30,000 ms (`DEFAULT_TIMEOUT_MS`, `http.ts`), not overridden anywhere —
  `ingestion_sources.config` is jsonb but nothing reads a timeout override out of it for this
  adapter.
- Observed response times: 0.3-0.8 s. Headroom to the timeout: ~29 s, i.e. ~40-100x margin.
- Sweep deadline: 15 minutes (`sweepTimeoutMs`, `scheduler.ts`), vs. an estimated ~30 s full
  discover pass. Headroom: ~30x.

Nothing in the measured numbers gets within an order of magnitude of either timeout.

## 4. Deterministic or intermittent?

**Could not determine from here — and that is itself the finding.** Every probe from this
sandbox, run at the project's own pacing, across robots.txt, the index, and all 12
category endpoints, individually and repeated, came back in under a second. I could not
reproduce a slow or hanging response at all, let alone one that clears 30 seconds.

That rules out "the source is generally slow" and "the source degrades under sustained polite
traffic" as explanations reachable by probing from here. It does **not** rule out:
- A transient stall specific to the production egress path (this sandbox and the production
  host are different networks; I have no way to probe from the production host itself).
- A one-off cold-start effect (DNS resolution, TLS handshake, first-connection latency) that
  a curl warm run wouldn't show.
- Something that only reproduces under different conditions than 2-second, single-request-at-a-time
  pacing — which is exactly what the adapter uses, so this is a low-probability explanation, but
  not a zero one.

What would settle it: the actual `last_error` is just the string `"AbortError: This operation was
aborted"` with no attached URL or elapsed time. **The adapter and transport do not log which
request timed out, or how long it had been running when it did.** That is the single missing
instrument. Recommend: on catch inside `perform()` (or one level up, wherever the error is about
to be thrown), log `request.url` and elapsed ms since `lastRequestAt`/request start before
rethrowing. The next `attempts=1` failure would then say which of the ~14 requests (robots,
index, or which category/year POST) stalled, and for how long — turning "could not determine"
into a one-sweep answer.

## 5. Recommended fix — sized

Two independent, small changes:

**A. Instrument the timeout (do this first, before touching timeout values).** Add the
url+elapsed-time log noted above. Cost: a few lines in `createPoliteTransport`'s `perform()`,
one log line. This is what turns the next occurrence into a diagnosis instead of another
unexplained `AbortError`. **Small — under an hour including a test asserting the log fields.**

**B. Do not change the 30s timeout or the 2s pacing yet.** The measured numbers give no evidence
that 30s is too short for this source. Widening it blind would be exactly the "reasoning from an
AbortError string" the task warned against. If instrumentation in (A) later shows a specific
request stalling near 30s on a specific endpoint, *then* raising that endpoint's timeout (or
adding a bounded retry with backoff on `AbortError` specifically, distinct from the existing
`queue.fail()` retry which already re-attempts the whole `discover` job) is the next-sized
change — but only after the number exists to size it against.

If instrumentation instead shows the failure correlates with sweeps that also touch other
sources' shared work, or with deploy/restart timing, that points at process lifecycle rather than
the adapter at all, and the fix is elsewhere (graceful shutdown draining in-flight fetches before
`SIGTERM`, which is a worker-level change, not an adapter one).

## 6. Duplicate `discover` accumulation — deliberate or omission?

**Omission, not deliberate.** Cited:

`backend/src/services/extraction/stage.ts`, `enqueueExtraction` (lines ~153-173): before
inserting a new `extract` job, it calls `queuedExtraction(db, meetingId)` and, if one is already
queued, throws `ExtractionUnavailable(..., 409)` naming the existing job id. This dedup-before-
insert pattern exists in the codebase and is exercised from `routes/admin/pressroom.ts`.

`backend/src/services/ingestion/scheduler.ts`, `runSweep` (lines ~483-513): every sweep
unconditionally does

```ts
const since = new Date(this.now().getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);
await this.options.queue.enqueue("discover", { since: since.toISOString() }, runId);
```

with no prior check for an existing pending/failed `discover` job for the same source. And
`IngestionQueue.enqueue` itself (`queue.ts`, line ~639) is a bare `insert` — no `onConflict`, no
existence check, no stage-level dedup at all. It relies entirely on callers to dedup, which
`enqueueExtraction` does and `runSweep` does not.

There is no comment, test, or spec text anywhere in `scheduler.ts` or `queue.ts` arguing that
piling up one `discover` job per sweep is intentional — nothing resembling the deliberate
"partial run, backlog carries forward" reasoning documented for `SweepDeadlineReached`. Compared
to that pattern (which *is* explicitly designed and commented), the absence of any discussion
here reads as a gap: the extraction dedup was written for a route that a human operator can hit
repeatedly by clicking a button; the discover path was written assuming one job resolves (success
or terminal blocked) well before the next cron tick, and nobody revisited that assumption once a
job could sit failed-and-retrying across multiple sweep boundaries. Recommended fix, small: before
`queue.enqueue("discover", ...)` in `runSweep`, check for an existing pending/failed `discover`
job for the source (same shape as `queuedExtraction`) and skip enqueueing a new one if found —
or, if the intent is that a fresh `since` should supersede a stale one, cancel/supersede the old
job explicitly rather than leaving both to run. Either is a same-sized change to `runSweep` plus
a query helper; sizing depends on which behavior is wanted, which is a product decision, not
implementation difficulty.

## 7. The sequencing question — should this wait on reviewer throughput?

**No — the discover/abort fix should not wait, but enabling `gallatin-civicplus` more broadly
should be paced against review capacity, and those are two different gates.**

Reasoning:
- Fixing the abort (instrumenting, then possibly re-sizing a timeout) makes Gallatin's
  `discover` stage succeed. `discover` only writes meetings and documents
  (`upsertMeeting`/`upsertMeetingDocument` in `handlers.ts`) and enqueues `fetch` jobs — it does
  not itself produce named-person claims. Claims come later, from `analyze`/`extract`/`govern`
  stages running over fetched documents, which is gated by the existing review queue
  (`docs/STATUS.md` § B-a) and by `IMMEDIATE_SEVERITIES`/publish filtering already documented in
  `CLAUDE.md`'s "Deliberately dormant" section for notification, and by `review_state` for
  publication generally.
- So the immediate consequence of fixing discover alone is: Gallatin's meeting/document catalog
  starts filling in. That is useful and low-risk on its own — it is the same kind of write
  Bozeman's adapter already does at scale.
- The consequence that **does** need throttling against reviewer throughput is downstream:
  once documents are fetched and reach `analyze`/`extract`, Gallatin will start generating
  anomaly flags that land in the review queue, the same way Bozeman's do. With 64 unreviewed
  claims already outstanding and one reviewer, adding a second source's flag volume on top,
  unpaced, would make the backlog worse, not better — a transparency project whose review queue
  is visibly drowning is itself a credibility problem.
- The two are separable in the codebase: `discoverMeetings`/`fetchDocument` running does not
  imply `analyze`/`extract` run at the same rate — but nothing currently rate-limits or pauses
  detection stages independent of fetch stages, so in practice, once fetch succeeds, the existing
  pipeline will carry claims into the queue at whatever pace fetch produces documents.

**Recommendation:** fix and ship the discover/abort instrumentation now — it is small, safe, and
does not by itself grow the review backlog. Before (or concurrent with) that visibly increasing
Gallatin's fetch throughput at scale, an operator decision is needed on review capacity: either
add a second reviewer, or throttle Gallatin's effective ingestion rate (e.g. a smaller
`lookbackDays` for the first several sweeps, or a manual gate before `analyze`) so its claim
output doesn't compound on top of the existing 64-item backlog. That throttle is a config/process
decision, not a code fix, and is out of scope for this investigation.
