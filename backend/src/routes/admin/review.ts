import { Router, type Request, type Response } from "express";
import db from "../../config/database";
import {
  decideDispute,
  DisputeError,
  getDispute,
  listDisputes,
  type DisputeStatus,
} from "../../services/disputes";
import { CorrectionError } from "../../services/pressroom/corrections";
import {
  isSeverity,
  loadPolicy,
  ReviewPolicyError,
  updatePolicy,
  type Severity,
} from "../../services/review/policy";
import {
  approveFinding,
  editFinding,
  getQueueItem,
  listQueue,
  rejectFinding,
  ReviewError,
  type RequestStatus,
} from "../../services/review/queue";

/**
 * `/api/admin/review` — the operator queue.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so every path here
 * 401s without a live session. That matters more here than anywhere else in the
 * console: `POST /queue/:id/approve` is the only route in this product that
 * makes a generated claim about a named person public.
 *
 * Every decision carries a reason and is appended to `record_corrections` with
 * the operator's id and email. There is no route that decides anything without
 * one.
 *
 * **B3's disputes live here too, and that is the point.** A dispute is not a
 * finding — it is a stranger's contest of a record, not a claim this project
 * makes — so it has its own table, its own two decisions and its own section of
 * the console. What it shares with the queue is the surface and the audit log,
 * because an operator should have one place they review things and the project
 * should have one place it records what was decided. A second console and a
 * second log would be two things to keep in step, and they would not stay in
 * step.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUEST_STATUSES: readonly RequestStatus[] = ["pending_review", "approved", "rejected"];

/**
 * `CorrectionError` is handled here as of B3.
 *
 * It could not reach this router before: nothing on the review path threw one.
 * It can now, because `appendCorrectionRow` scans every stated reason for
 * motive — a correction describes the record, never the motive, and B3 puts the
 * log on a public page, so an approve-with-a-reason that asserts intent is a
 * 400 rather than a published sentence. Without this line that 400 would have
 * surfaced as a 500.
 */
function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (
    err instanceof ReviewError ||
    err instanceof ReviewPolicyError ||
    err instanceof DisputeError ||
    err instanceof CorrectionError
  ) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

function actorOf(req: Request): { id: string | null; email: string | null } {
  return { id: req.operator?.id ?? null, email: req.operator?.email ?? null };
}

function badId(res: Response): void {
  res.status(400).json({ error: "Invalid finding id", statusCode: 400 });
}

interface QueueQuery {
  status?: string;
  severity?: string;
  limit?: string;
  offset?: string;
}

router.get("/queue", async (req: Request<unknown, unknown, unknown, QueueQuery>, res, next) => {
  try {
    const { status, severity, limit, offset } = req.query;
    if (status !== undefined && !(REQUEST_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ error: "Invalid status", statusCode: 400 });
      return;
    }
    if (severity !== undefined && !isSeverity(severity)) {
      res.status(400).json({ error: "Invalid severity", statusCode: 400 });
      return;
    }

    const listing = await listQueue(db, {
      ...(status === undefined ? {} : { status: status as RequestStatus }),
      ...(severity === undefined ? {} : { severity: severity as Severity }),
      ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) || 50 }),
      ...(offset === undefined ? {} : { offset: Number.parseInt(offset, 10) || 0 }),
    });
    res.json(listing);
  } catch (err) {
    fail(res, err, next);
  }
});

router.get("/queue/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res);

    const item = await getQueueItem(db, id);
    if (item === null) {
      res.status(404).json({ error: "Finding not found", statusCode: 404 });
      return;
    }
    res.json(item);
  } catch (err) {
    fail(res, err, next);
  }
});

interface DecisionBody {
  reason?: unknown;
}

function reasonOf(body: DecisionBody | undefined): string {
  return typeof body?.reason === "string" ? body.reason : "";
}

router.post(
  "/queue/:id/approve",
  async (req: Request<{ id: string }, unknown, DecisionBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res);
      const item = await approveFinding(db, {
        flagId: id,
        reason: reasonOf(req.body),
        actor: actorOf(req),
      });
      res.json(item);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

router.post(
  "/queue/:id/reject",
  async (req: Request<{ id: string }, unknown, DecisionBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res);
      const item = await rejectFinding(db, {
        flagId: id,
        reason: reasonOf(req.body),
        actor: actorOf(req),
      });
      res.json(item);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

interface EditBody extends DecisionBody {
  field?: unknown;
  new_value?: unknown;
}

router.post(
  "/queue/:id/edit",
  async (req: Request<{ id: string }, unknown, EditBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res);
      const body = req.body ?? {};
      if (typeof body.field !== "string" || body.field === "") {
        res.status(400).json({ error: "field is required", statusCode: 400 });
        return;
      }
      if (typeof body.new_value !== "string") {
        res.status(400).json({ error: "new_value must be a string", statusCode: 400 });
        return;
      }

      const item = await editFinding(db, {
        flagId: id,
        field: body.field,
        newValue: body.new_value,
        reason: reasonOf(body),
        actor: actorOf(req),
      });
      res.json(item);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Disputes — B3. The same operator, the same log, a different kind of thing.
// ---------------------------------------------------------------------------

const DISPUTE_STATUSES: readonly DisputeStatus[] = ["received", "upheld", "declined"];

interface DisputeQuery {
  status?: string;
  limit?: string;
  offset?: string;
}

router.get(
  "/disputes",
  async (req: Request<unknown, unknown, unknown, DisputeQuery>, res, next) => {
    try {
      const { status, limit, offset } = req.query;
      if (status !== undefined && !(DISPUTE_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "Invalid status", statusCode: 400 });
        return;
      }

      const listing = await listDisputes(db, {
        ...(status === undefined ? {} : { status: asDisputeStatus(status) }),
        ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) || 50 }),
        ...(offset === undefined ? {} : { offset: Number.parseInt(offset, 10) || 0 }),
      });
      res.json(listing);
    } catch (err) {
      fail(res, err, next);
    }
  },
);

/** Narrows a value the guard above has already checked. No cast. */
function asDisputeStatus(value: string): DisputeStatus {
  return value === "upheld" || value === "declined" ? value : "received";
}

router.get("/disputes/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid dispute id", statusCode: 400 });
      return;
    }
    const item = await getDispute(db, id);
    if (item === null) {
      res.status(404).json({ error: "Dispute not found", statusCode: 404 });
      return;
    }
    res.json(item);
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * Uphold, and decline. Neither writes to the record.
 *
 * Upholding says the contest looks right; the correction that follows is a
 * separate act through `/api/admin/pressroom/corrections`, carrying this
 * dispute's id. Doing both in one call would leave the log unable to say which
 * of the two a person actually decided, and would put an unauthenticated
 * stranger's text one route away from changing the published record.
 */
function disputeDecision(decision: "upheld" | "declined") {
  return async (
    req: Request<{ id: string }, unknown, DecisionBody>,
    res: Response,
    next: (e?: unknown) => void,
  ): Promise<void> => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        res.status(400).json({ error: "Invalid dispute id", statusCode: 400 });
        return;
      }
      const item = await decideDispute(db, {
        id,
        decision,
        reason: reasonOf(req.body),
        actor: actorOf(req),
      });
      res.json(item);
    } catch (err) {
      fail(res, err, next);
    }
  };
}

router.post("/disputes/:id/uphold", disputeDecision("upheld"));
router.post("/disputes/:id/decline", disputeDecision("declined"));

// ---------------------------------------------------------------------------
// The threshold — B-b's replacement. One row, not a workflow engine.
// ---------------------------------------------------------------------------

router.get("/policy", async (_req, res, next) => {
  try {
    res.json(await loadPolicy(db));
  } catch (err) {
    fail(res, err, next);
  }
});

interface PolicyBody extends DecisionBody {
  hold_at_or_above?: unknown;
  review_window_hours?: unknown;
}

router.put("/policy", async (req: Request<Record<string, string>, unknown, PolicyBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (body.hold_at_or_above !== undefined && !isSeverity(body.hold_at_or_above)) {
      res.status(400).json({
        error: "hold_at_or_above must be one of low, medium, high, critical",
        statusCode: 400,
      });
      return;
    }
    if (
      body.review_window_hours !== undefined &&
      typeof body.review_window_hours !== "number"
    ) {
      res.status(400).json({ error: "review_window_hours must be a number", statusCode: 400 });
      return;
    }

    const policy = await updatePolicy(
      db,
      {
        ...(body.hold_at_or_above === undefined
          ? {}
          : { holdAtOrAbove: body.hold_at_or_above }),
        ...(body.review_window_hours === undefined
          ? {}
          : { reviewWindowHours: body.review_window_hours }),
      },
      reasonOf(body),
      actorOf(req),
    );
    res.json(policy);
  } catch (err) {
    fail(res, err, next);
  }
});

export default router;
