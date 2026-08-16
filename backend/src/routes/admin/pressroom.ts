import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import db from "../../config/database";
import { emitEvent, retractSubject } from "../../services/events";
import type { IngestionQueue } from "../../services/ingestion/queue";
import type { SourceScheduler } from "../../services/ingestion/scheduler";
import {
  CorrectionError,
  listCorrections,
  publishMeeting,
  publishMeetings,
  recordCorrection,
  unpublishMeeting,
} from "../../services/pressroom/corrections";
import {
  getMeetingDetail,
  listMeetingsForSource,
  MEETING_PAGE_MAX,
} from "../../services/pressroom/meetings";
import { getRun, ReparseError, reparseMeeting, reparseRun } from "../../services/pressroom/runs";
import {
  listRecentRuns,
  readQueueStats,
  readRunWork,
} from "../../services/pressroom/queue-stats";
import { ExtractionUnavailable } from "../../services/extraction/run";
import { enqueueExtractionBatch, MAX_EXTRACT_BATCH, enqueueExtraction } from "../../services/extraction/stage";
import { enqueueGovernance } from "../../services/governor/stage";
import { enqueueLocation, LocationUnavailable } from "../../services/locate/stage";
import { isExtracting, listRuns } from "../../services/extraction/runs";
import { listSources, setSourceEnabled } from "../../services/pressroom/sources";

/**
 * `/api/admin/pressroom` — the operator console's API.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so every path here
 * 401s without a live session. That is the boundary; the browser's
 * `ProtectedRoute` is only a courtesy.
 *
 * The two action routes need the ingestion queue and scheduler, which live in
 * `index.ts` and are wired to MinIO. They arrive through the seam below rather
 * than being constructed here — the same shape as `registerDigestStatus` in
 * `routes/health.ts`, and for the same reason: a route module that builds an
 * object store makes the regular test suite need one, and CI runs Postgres and
 * nothing else. Unregistered, the action routes answer 503 and say why, which
 * is honest about the capability being absent rather than throwing.
 */

const router = Router();

export interface PressroomStack {
  queue: IngestionQueue;
  scheduler: SourceScheduler;
}

let stack: PressroomStack | null = null;

/** Hands the console the live queue and scheduler. Called once, from index.ts. */
export function registerPressroomStack(next: PressroomStack | null): void {
  stack = next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badId(res: Response, what: string): void {
  res.status(400).json({ error: `Invalid ${what} id`, statusCode: 400 });
}

function requireStack(res: Response): PressroomStack | null {
  if (stack !== null) return stack;
  res.status(503).json({
    error: "Ingestion is not running in this process, so there is nothing to act on",
    statusCode: 503,
  });
  return null;
}

function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof CorrectionError || err instanceof ReparseError) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

router.get("/sources", async (_req, res, next) => {
  try {
    const data = await listSources(db);
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

interface ToggleBody {
  enabled?: unknown;
  reason?: unknown;
}

/**
 * Turn a source on or off.
 *
 * The lever that was missing. Sources register disabled on purpose, and before
 * this the only code that could undo that was `src/scripts/sweep.ts` — which
 * the production image does not contain, because `backend/Dockerfile` copies
 * `dist/` and `migrations/` and never `src/`. The console showed three disabled
 * sources and offered no way to enable one, so the live site could only be
 * brought up with hand-written SQL on the host.
 *
 * `enabled` must be a real boolean. Accepting `"yes"` or `1` here would let a
 * typo in a fetch body read as a decision, and this is the decision that starts
 * hitting a county's web server.
 */
router.patch(
  "/sources/:id",
  async (req: Request<{ id: string }, unknown, ToggleBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "source");

      const body = req.body ?? {};
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be true or false", statusCode: 400 });
        return;
      }
      if (typeof body.reason !== "string" || body.reason.trim() === "") {
        res.status(400).json({
          error: "reason is required: enabling a source is a decision, and a decision has a reason",
          statusCode: 400,
        });
        return;
      }

      const result = await setSourceEnabled(db, id, {
        enabled: body.enabled,
        reason: body.reason,
        actor: actorOf(req),
      });

      // A newly enabled source has no cron task until the scheduler re-arms:
      // `start()` reads the enabled set once. Re-arming here is what makes the
      // toggle mean "this sweeps nightly" rather than "this sweeps nightly
      // after the next deploy". The stack is absent in tests, and the toggle
      // is still a valid, recorded decision without it.
      if (stack !== null) await stack.scheduler.refresh();

      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

/**
 * Sweep now. Distinct from re-parse, which touches no network at all.
 *
 * **Returns as soon as the sweep is launched, not when it finishes.** It used
 * to await the whole thing, and the comment here claimed "the sweep has run by
 * the time this returns" — true for a small source and impossible for a large
 * one. `frontend/nginx.conf` sets no timeouts on `location /api/`, so it takes
 * nginx's default 60-second `proxy_read_timeout`. On 2026-08-10 an operator
 * started the first Bozeman sweep, which had 339 documents to fetch at the
 * 10-second crawl-delay we publish; at 60 seconds the browser got a gateway
 * timeout whose HTML body carried no `error` field, and the console reported
 * *"bozeman-granicus could not be swept"* about a sweep that was working
 * perfectly and ran on for another 15 minutes.
 *
 * So the response is now genuinely a 202: accepted, running, watch the run. The
 * truth about how it went lives in the `ingestion_runs` row, which is where a
 * sweep's outcome has always belonged and is what the monitor reads.
 *
 * The 409 is decided before launching, from the in-process in-flight set. The
 * cross-container advisory lock still guards correctness; it just cannot be
 * consulted without holding a transaction open for the sweep's lifetime, which
 * is the thing we are no longer willing to make an HTTP client wait for.
 */
router.post("/sources/:id/sweep", (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return badId(res, "source");
  const live = requireStack(res);
  if (live === null) return;

  if (live.scheduler.isSweeping(id)) {
    res.status(409).json({
      error: "A sweep of this source is already running",
      statusCode: 409,
    });
    return;
  }

  // Detached on purpose. Every outcome, including a throw, is already recorded
  // on the run row by `runSweep`; this catch exists so an unhandled rejection
  // cannot take the process down.
  void live.scheduler.sweepSource(id).catch((error: unknown) => {
    console.error(`Sweep of source ${id} threw outside its run`, error);
  });

  res.status(202).json({
    outcome: { kind: "started", sourceId: id },
    message:
      "Sweep started. It runs at the source's published crawl-delay and may take a while; " +
      "watch the run for progress.",
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * `GET /queue` — the shared queue's current shape.
 *
 * Jobs are claimed globally and oldest-first, so the queue rather than the
 * source is the thing that behaves, and nothing in the product could see it.
 * That blind spot is what let `gallatin-civicplus` read **Healthy** for days
 * while it had ingested nothing at all: every sweep it ran drained
 * `bozeman-granicus`'s older backlog instead of its own single `discover` job.
 *
 * Placed before `/runs/:id` and the other id-scoped routes for the same reason
 * `/meetings/publish` is: `queue` is a literal segment and must not be read as
 * an id.
 *
 * No verdict is returned — see the note in `queue-stats.ts` on why "starved" is
 * the console's word to compose and not this endpoint's to assert.
 */
router.get("/queue", async (_req, res, next) => {
  try {
    res.json(await readQueueStats(db));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** How many recent sweeps `/runs` will return at most. */
export const MAX_RECENT_RUNS = 25;

/**
 * `GET /runs` — the most recent sweeps across every source, newest first.
 *
 * The console could show one run per source and no history, so a pattern
 * repeating *across* sweeps had nowhere to appear — and that pattern was the
 * whole diagnosis on 2026-08-16: five consecutive sweeps, own work zero every
 * time, while `processed` looked healthy because each was draining somebody
 * else's backlog.
 *
 * Declared before `/runs/:id` so `runs` is not read as an id.
 */
router.get("/runs", async (req, res, next) => {
  try {
    const raw = req.query.limit;
    const parsed = typeof raw === "string" ? Number(raw) : 5;
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_RECENT_RUNS) {
      res.status(400).json({
        error: `limit must be an integer from 1 to ${MAX_RECENT_RUNS}`,
        statusCode: 400,
      });
      return;
    }
    const data = await listRecentRuns(db, parsed);
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

router.get("/runs/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "run");

    const detail = await getRun(db, id);
    if (detail === null) {
      res.status(404).json({ error: "Run not found", statusCode: 404 });
      return;
    }

    // `counts.processed` is every job this sweep completed, whichever run
    // enqueued it. `work.own_completed` is how much of that was its own, and the
    // difference is what it did for somebody else's backlog. A sweep reporting
    // healthy `processed` and zero own work is a sweep that never started its
    // source — the shape nobody could see until this was returned.
    res.json({ ...detail, work: await readRunWork(db, id) });
  } catch (err) {
    next(err);
  }
});

router.post("/runs/:id/reparse", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "run");
    const live = requireStack(res);
    if (live === null) return;

    res.status(202).json(await reparseRun(db, live.queue, id));
  } catch (err) {
    fail(res, err, next);
  }
});

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

router.get("/meetings/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");

    const detail = await getMeetingDetail(db, id);
    if (detail === null) {
      res.status(404).json({ error: "Meeting not found", statusCode: 404 });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

interface SourceMeetingsQuery {
  published?: string;
  limit?: string;
}

/**
 * What a source has ingested, and whether it is public yet.
 *
 * Without this the console could open a meeting by id and could discover no ids
 * — workable for a sweep that lands three records, impossible for one that
 * lands a decade. Publication is a per-record decision, so the person making it
 * needs the list of records awaiting one.
 *
 * `published` is tri-state on purpose: absent means everything, which is how an
 * operator checks that what they published is actually live.
 */
router.get(
  "/sources/:id/meetings",
  async (req: Request<{ id: string }, unknown, unknown, SourceMeetingsQuery>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "source");

      const { published, limit } = req.query;
      if (published !== undefined && published !== "true" && published !== "false") {
        res.status(400).json({ error: "published must be true or false", statusCode: 400 });
        return;
      }

      let parsedLimit: number | undefined;
      if (limit !== undefined) {
        parsedLimit = Number(limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MEETING_PAGE_MAX) {
          res.status(400).json({
            error: `limit must be an integer between 1 and ${MEETING_PAGE_MAX}`,
            statusCode: 400,
          });
          return;
        }
      }

      const result = await listMeetingsForSource(db, {
        sourceId: id,
        ...(published === undefined ? {} : { published: published === "true" }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      });
      res.json({ ...result, total: result.meetings.length });
    } catch (err) {
      next(err);
    }
  },
);

interface BulkPublishBody {
  meeting_ids?: unknown;
  reason?: unknown;
}

/**
 * Publish a reviewed selection in one action.
 *
 * Explicit ids rather than "publish everything from this source": the operator
 * chooses, and the request records exactly what they chose. A
 * publish-by-filter route would let a filter that drifted between the screen
 * and the server publish records nobody looked at.
 */
router.post(
  "/meetings/publish",
  async (req: Request<Record<string, string>, unknown, BulkPublishBody>, res, next) => {
    try {
      const body = req.body ?? {};
      if (!Array.isArray(body.meeting_ids)) {
        res.status(400).json({ error: "meeting_ids must be an array", statusCode: 400 });
        return;
      }
      const ids = body.meeting_ids;
      if (!ids.every((id): id is string => typeof id === "string" && UUID_RE.test(id))) {
        res.status(400).json({ error: "meeting_ids must all be uuids", statusCode: 400 });
        return;
      }
      if (typeof body.reason !== "string" || body.reason.trim() === "") {
        res.status(400).json({
          error: "reason is required: publication is a decision, and a decision has a reason",
          statusCode: 400,
        });
        return;
      }

      const reason = body.reason;
      const actor = actorOf(req);
      // One transaction over the whole batch, for `publishMeetings`' reason: a
      // partial publish that also partially announced would tell readers about
      // records the log cannot explain. Only the meetings that actually changed
      // are announced — an already-published one is not republished, so there is
      // nothing new to say about it.
      const result = await db.transaction(async (trx) => {
        const published = await publishMeetings(trx, ids, reason, actor);
        await announcePublished(trx, published.published);
        return published;
      });
      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

interface ExtractBatchBody {
  limit?: unknown;
}

/**
 * Queue up to `limit` meetings' minutes for extraction in one request.
 *
 * `docs/STATUS.md` item 1f refused a batch route until extraction became a
 * queue stage — a batch runner had to be "a queue stage, not a loop in a
 * route". `services/extraction/stage.ts` is that stage now, so this route is
 * a thin caller of `enqueueExtractionBatch`: it validates the request and
 * discloses the result, nothing more.
 *
 * `limit` is required and has no default. An operator spending minutes of a
 * rate-limited free model's quota states the number; a bare POST would be
 * guessing on their behalf. `MAX_EXTRACT_BATCH` is a hard ceiling enforced as
 * a 400, never a silent clamp — see the constant's docblock for why.
 *
 * A sibling of `/meetings/publish` immediately above: both are batch actions
 * addressed by a literal path segment under `/meetings`, not by `:id`, so
 * neither is reachable by, nor shadows, the id-scoped routes below. Placed
 * before them for the same reason `/meetings/publish` is.
 */
router.post(
  "/meetings/extract-batch",
  async (req: Request<Record<string, string>, unknown, ExtractBatchBody>, res, next) => {
    try {
      const live = requireStack(res);
      if (live === null) return;

      const { limit } = req.body ?? {};
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
        res.status(400).json({
          error: "limit is required and must be a positive integer",
          statusCode: 400,
        });
        return;
      }
      if (limit > MAX_EXTRACT_BATCH) {
        res.status(400).json({
          error: `limit must not exceed ${MAX_EXTRACT_BATCH} — a batch this large spends a rate-limited free model's quota an operator has not actually authorised`,
          statusCode: 400,
        });
        return;
      }

      const result = await enqueueExtractionBatch(db, live.queue, limit);

      res.status(202).json({
        limit,
        enqueued: result.enqueued,
        skipped: result.skipped,
        message:
          `Queued ${result.enqueued.length} extraction job(s); skipped ${result.skipped.length} ` +
          "meeting(s) (see skipped[].reason). Every claim any of them produce is held for review — " +
          "nothing naming a person is published without an operator.",
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Queue this meeting's minutes for extraction.
 *
 * A route rather than a script, for the reason `services/extraction/run.ts`
 * spells out: the production image ships no `src/`, so an operator action that
 * lives in a CLI script does not exist on the deployment.
 *
 * It **enqueues**. The previous version fired `void runExtraction(...)` — an
 * unawaited promise in a request handler, which a deploy or a restart mid-run
 * silently destroyed, leaving an `extraction_runs` row `running` forever. The
 * work now owns an `ingestion_jobs` row: it survives a restart, retries with
 * backoff, holds in a visible `blocked` state, and has a queue depth an
 * operator can look at. The 202 carries the job id.
 *
 * Everything it produces is **held**. Every claim names a person, and nothing
 * naming a person auto-publishes — that rule predates this feature and is the
 * reason the feature is allowed to exist at all.
 */
router.post("/meetings/:id/extract", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");
    const live = requireStack(res);
    if (live === null) return;

    // Two different "already going": a run the worker has started, and a job
    // waiting to be claimed. `enqueueExtraction` refuses the second.
    if (await isExtracting(db, id)) {
      res.status(409).json({
        error: "An extraction of this meeting is already running",
        statusCode: 409,
      });
      return;
    }

    const queued = await enqueueExtraction(db, live.queue, id);

    res.status(202).json({
      ...queued,
      status: "queued",
      message:
        "Extraction queued. A worker claims it and takes a few minutes; poll " +
        "GET /meetings/:id/extract-runs for the outcome. Every claim it produces " +
        "is held for review — nothing naming a person is published without an operator.",
    });
  } catch (err) {
    if (err instanceof ExtractionUnavailable) {
      res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
      return;
    }
    next(err);
  }
});

/**
 * Read locations out of this meeting's agenda.
 *
 * Deterministic parsing, not a model: an address is a formatted string and a
 * model is the wrong tool for a well-formed pattern. What comes out is
 * geocoded through the US Census service — keyless, public domain, and terms
 * that permit storing the result, which matters because geocoding at render
 * time would leak a reader's browsing to a third party.
 *
 * Everything it writes is `held`. A pin is a claim about where a decision
 * happened and it names a place on a public map; the review gate that covers a
 * claim covers this too.
 *
 * Separate from `/extract` because it reads the agenda rather than the minutes
 * and answers a different question, and separate from `/govern` because
 * re-running it after a geocoder change is a deliberate act.
 */
router.post("/meetings/:id/locate", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");
    const live = requireStack(res);
    if (live === null) return;

    const queued = await enqueueLocation(db, live.queue, id);

    res.status(202).json({
      ...queued,
      status: "queued",
      message:
        "Location pass queued. It reads addresses out of the parsed agenda and " +
        "geocodes them; every place link it writes is held for review.",
    });
  } catch (err) {
    if (err instanceof LocationUnavailable) {
      res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
      return;
    }
    next(err);
  }
});


/**
 * Ask the governor to judge this meeting's claims.
 *
 * Pass 2, and it is a **judge, never an author**. It receives the ±2,000
 * character window and the claim triple, never pass 1's reasoning — a judge
 * shown the advocate's argument agrees with it — and it emits a verdict that
 * must *point*, naming the fragments it says are unsupported.
 *
 * It cannot approve anything. Nothing it returns sets `status = 'approved'`; a
 * `supported: false` marks the claim and sorts it to the bottom of the operator
 * queue, and it is never deleted. A judge with a 5% error rate that
 * auto-discarded would silently lose one true claim in twenty, and a
 * transparency project cannot have a mechanism that quietly drops records.
 *
 * Separate from `/extract` on purpose rather than chained to it: re-judging
 * after a model or prompt change is a thing an operator does deliberately, and
 * the unique index on (claim, model, prompt_version, window sha) makes a re-run
 * over unchanged bytes a no-op.
 */
router.post("/meetings/:id/govern", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");
    const live = requireStack(res);
    if (live === null) return;

    const queued = await enqueueGovernance(db, live.queue, id);

    res.status(202).json({
      ...queued,
      status: "queued",
      message:
        "Governor pass queued. It judges the claims already extracted from this " +
        "meeting and changes only the order and the annotation of the review " +
        "queue — it approves nothing and deletes nothing.",
    });
  } catch (err) {
    if (err instanceof ExtractionUnavailable) {
      res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
      return;
    }
    next(err);
  }
});

/**
 * This meeting's extraction attempts, newest first.
 *
 * The counterpart to the 202 above: since the work outlives the request, this
 * is where its outcome is read. It reports `rejected` and `failed_chunks` in
 * full rather than as counts, because "the model invented quotations",
 * "the model misattributed real ones" and "the model was throttled" are three
 * different problems that all render as a small number of stored claims.
 */
router.get("/meetings/:id/extract-runs", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");
    const data = await listRuns(db, id);
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

/** This meeting's extracted claims, held ones included. */
router.get("/meetings/:id/claims", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");

    const data = await db("minute_claims")
      .where({ meeting_id: id })
      .orderBy("quote_offset", "asc")
      .select(
        "id",
        "subject_name",
        "member_id",
        "action",
        "matter",
        "quote",
        "quote_offset",
        "artifact_sha256",
        "model",
        "prompt_version",
        "status",
        "created_at",
      );
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

router.post("/meetings/:id/reparse", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "meeting");
    const live = requireStack(res);
    if (live === null) return;

    res.status(202).json(await reparseMeeting(db, live.queue, id));
  } catch (err) {
    fail(res, err, next);
  }
});

interface PublishBody {
  reason?: unknown;
}

function actorOf(req: Request): { id: string | null; email: string | null } {
  return { id: req.operator?.id ?? null, email: req.operator?.email ?? null };
}

/**
 * Announce meetings that have just gone public — in the transaction that
 * published them.
 *
 * This is the emitter the event spine was missing, and it is load-bearing for
 * more than meetings. `approveFinding` and `approveClaim` both emit only when
 * their subject is *already* public, which is correct: approving a finding on a
 * meeting an operator has withheld is a legitimate act, and `emitEvent` refuses
 * to announce something no reader can see. The consequence is that those
 * approvals produce no event at all, and until this function existed nothing
 * ever announced them — the meeting went out and its findings and claims were
 * public and unannounced.
 *
 * Wrapped in an outer transaction by each caller so the emit and the publish
 * commit together; `publishMeeting` and `publishMeetings` open a savepoint
 * inside it rather than a second connection. An event committed while its
 * publish rolled back announces something that did not happen, and a publish
 * committed without its event is a record nobody is told about.
 *
 * Re-publishing is a real operation — that is how publishing over a known
 * defect is recorded — and `emitEvent`'s dedupe key makes the second
 * announcement a no-op rather than a second notification to every subscriber.
 */
async function announcePublished(trx: Knex.Transaction, meetingIds: string[]): Promise<void> {
  for (const meetingId of meetingIds) {
    const row = await trx("meetings")
      .join("commissions", "commissions.id", "meetings.commission_id")
      .where("meetings.id", meetingId)
      .first<
        { jurisdiction_id: string | null; commission_name: string | null; date: string } | undefined
      >(
        "commissions.jurisdiction_id as jurisdiction_id",
        "commissions.name as commission_name",
        trx.raw("meetings.date::text as date"),
      );
    if (row === undefined) continue;

    await emitEvent(trx, {
      event_type: "meeting.published",
      subject_kind: "meeting",
      subject_id: meetingId,
      jurisdiction_id: row.jurisdiction_id,
      payload: {
        title: `${row.commission_name ?? "Meeting"}, ${row.date}`,
        meeting_id: meetingId,
        meeting_date: row.date,
      },
    });
  }
}

router.post(
  "/meetings/:id/publish",
  async (req: Request<{ id: string }, unknown, PublishBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "meeting");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      // The publish and its announcement share one transaction. `publishMeeting`
      // takes the transaction as its executor and opens a savepoint inside it.
      const result = await db.transaction(async (trx) => {
        const publication = await publishMeeting(trx, id, reason, actorOf(req));
        await announcePublished(trx, [id]);
        return publication;
      });
      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

/**
 * The mirror image of `announcePublished`, and it was missing.
 *
 * Publishing a meeting announced it; unpublishing said nothing to anyone. The
 * asymmetry is the dangerous direction: an operator who publishes in error and
 * then withdraws had, until now, a site that stopped showing the record while
 * every consumer that had already been told still believed it. A publication
 * wall with an un-instrumented back door is worse than no wall, because people
 * trust it.
 *
 * `retractSubject` is called **after** the unpublish and **inside** the same
 * transaction. That ordering is the whole mechanism: it asserts the subject is
 * no longer public, which is only true once the row above has been written.
 *
 * It reports what it could and could not recall, and this function does not
 * pretend the difference away. An event still queued never sends — a real
 * recall, and the common case, because the drain tick is seconds. One already
 * dispatched is marked revoked and answered with a `meeting.retracted` event,
 * because a Discord post is gone and an RSS item is in a reader's cache.
 *
 * A failure here does **not** fail the unpublish. The record is off the site,
 * which is the part that matters; leaving the operator with a 500 and a meeting
 * that is actually withdrawn would invite them to try again and doubt what they
 * are looking at. It is logged, and the events stay revocable.
 */
async function announceWithdrawn(
  trx: Knex.Transaction,
  meetingId: string,
  reason: string,
): Promise<void> {
  try {
    await retractSubject(trx, {
      subject_kind: "meeting",
      subject_id: meetingId,
      // `unpublishMeeting` already requires a reason and records it in the
      // corrections log; carrying the same words onto the revocation keeps one
      // explanation rather than two that can disagree.
      reason: reason.trim() === "" ? "withdrawn by an operator" : reason,
    });
  } catch (error) {
    console.error(
      `pressroom: unpublished meeting ${meetingId} but could not revoke its events`,
      error,
    );
  }
}

router.post(
  "/meetings/:id/unpublish",
  async (req: Request<{ id: string }, unknown, PublishBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "meeting");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      const result = await db.transaction(async (trx) => {
        const unpublished = await unpublishMeeting(trx, id, reason, actorOf(req));
        await announceWithdrawn(trx, id, reason);
        return unpublished;
      });
      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

interface CorrectionsQuery {
  target_table?: string;
  target_id?: string;
}

router.get(
  "/corrections",
  async (req: Request<unknown, unknown, unknown, CorrectionsQuery>, res, next) => {
    try {
      const { target_table, target_id } = req.query;
      if (target_id !== undefined && !UUID_RE.test(target_id)) return badId(res, "target");

      const data = await listCorrections(db, {
        ...(target_table === undefined ? {} : { targetTable: target_table }),
        ...(target_id === undefined ? {} : { targetId: target_id }),
      });
      res.json({ data, total: data.length });
    } catch (err) {
      next(err);
    }
  },
);

interface CreateCorrectionBody {
  target_table?: unknown;
  target_id?: unknown;
  field?: unknown;
  new_value?: unknown;
  reason?: unknown;
  /**
   * The dispute this correction answers, if one prompted it.
   *
   * Optional, and validated when present rather than ignored when wrong. The
   * column has existed since migration 039 and the public log has been
   * rendering *"Prompted by dispute CW-…"* off it, but until now no operator
   * screen could set it — so upholding a dispute and then correcting the record
   * produced two rows that nothing joined, and the end-to-end trail the feature
   * was designed around did not connect.
   */
  dispute_id?: unknown;
}

router.post(
  "/corrections",
  async (req: Request<Record<string, string>, unknown, CreateCorrectionBody>, res, next) => {
    try {
      const body = req.body ?? {};
      if (typeof body.target_table !== "string" || body.target_table === "") {
        res.status(400).json({ error: "target_table is required", statusCode: 400 });
        return;
      }
      if (typeof body.target_id !== "string" || !UUID_RE.test(body.target_id)) {
        return badId(res, "target");
      }
      if (typeof body.field !== "string" || body.field === "") {
        res.status(400).json({ error: "field is required", statusCode: 400 });
        return;
      }
      if (typeof body.reason !== "string" || body.reason.trim() === "") {
        res.status(400).json({
          error: "reason is required: a correction without one is an edit",
          statusCode: 400,
        });
        return;
      }
      // `null` is a legitimate new value — a field can be corrected *to*
      // nothing — so it is accepted, while a number or an object is not.
      if (
        body.new_value !== null &&
        body.new_value !== undefined &&
        typeof body.new_value !== "string"
      ) {
        res.status(400).json({ error: "new_value must be a string or null", statusCode: 400 });
        return;
      }
      // Absent and explicitly null both mean "no dispute prompted this". A
      // malformed id is refused here rather than stored: `record_corrections`
      // has no foreign key to catch it, for migration 031's reason.
      if (
        body.dispute_id !== null &&
        body.dispute_id !== undefined &&
        (typeof body.dispute_id !== "string" || !UUID_RE.test(body.dispute_id))
      ) {
        return badId(res, "dispute");
      }

      const correction = await recordCorrection(db, {
        targetTable: body.target_table,
        targetId: body.target_id,
        field: body.field,
        newValue: typeof body.new_value === "string" ? body.new_value : null,
        reason: body.reason,
        actor: actorOf(req),
        disputeId: typeof body.dispute_id === "string" ? body.dispute_id : null,
      });

      // 201: a correction appends. Nothing was replaced.
      res.status(201).json(correction);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

export default router;
