import { Router, type Request, type Response } from "express";
import db from "../../config/database";
import type { IngestionQueue } from "../../services/ingestion/queue";
import type { SourceScheduler } from "../../services/ingestion/scheduler";
import {
  CorrectionError,
  listCorrections,
  publishMeeting,
  recordCorrection,
  unpublishMeeting,
} from "../../services/pressroom/corrections";
import { getMeetingDetail } from "../../services/pressroom/meetings";
import { getRun, ReparseError, reparseMeeting, reparseRun } from "../../services/pressroom/runs";
import { listSources } from "../../services/pressroom/sources";

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

/**
 * Sweep now. Distinct from re-parse, which touches no network at all.
 *
 * 202 rather than 200: the sweep has run by the time this returns, but the
 * queue it filled has not drained, so the work is accepted rather than done.
 */
router.post("/sources/:id/sweep", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "source");
    const live = requireStack(res);
    if (live === null) return;

    const outcome = await live.scheduler.sweepSource(id);
    if (outcome.kind === "skipped" && outcome.reason === "locked") {
      res.status(409).json({
        error: "A sweep of this source is already running",
        statusCode: 409,
        outcome,
      });
      return;
    }
    res.status(202).json({ outcome });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

router.get("/runs/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "run");

    const detail = await getRun(db, id);
    if (detail === null) {
      res.status(404).json({ error: "Run not found", statusCode: 404 });
      return;
    }
    res.json(detail);
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

router.post(
  "/meetings/:id/publish",
  async (req: Request<{ id: string }, unknown, PublishBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "meeting");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      const result = await publishMeeting(db, id, reason, actorOf(req));
      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

router.post(
  "/meetings/:id/unpublish",
  async (req: Request<{ id: string }, unknown, PublishBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "meeting");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      const result = await unpublishMeeting(db, id, reason, actorOf(req));
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
