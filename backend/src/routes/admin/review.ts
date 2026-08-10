import { Router, type Request, type Response } from "express";
import db from "../../config/database";
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
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUEST_STATUSES: readonly RequestStatus[] = ["pending_review", "approved", "rejected"];

function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof ReviewError || err instanceof ReviewPolicyError) {
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
