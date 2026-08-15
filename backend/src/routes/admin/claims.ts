import { Router, type Request, type Response } from "express";
import db from "../../config/database";
import { CorrectionError } from "../../services/pressroom/corrections";
import {
  approveClaim,
  getClaimReview,
  isClaimQueueStatus,
  listClaimQueue,
  rejectClaim,
  retractClaim,
} from "../../services/review/claims";
import { ReviewError } from "../../services/review/queue";

/**
 * `/api/admin/claims` — the claims review screen's API.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so every path here
 * 401s without a live session. `POST /:id/approve` is the second route in this
 * product that publishes a generated sentence about a named person, and unlike
 * the first it publishes that sentence *verbatim* — so the guard matters here
 * exactly as much as it does on the findings queue.
 *
 * **There is no bulk approve and there must not be one.** Every route below
 * takes one claim id. A route taking an array would be a screen that publishes
 * forty unread sentences about named people in one click, and the answer to a
 * throughput problem is a better single-claim screen.
 *
 * Every decision carries a reason. `reason` is not optional on any of the three
 * actions, and the refusal is a 400 rather than a default, because the reason is
 * what a correction, a retraction and an approval all leave in the one audit log
 * this project has.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `CorrectionError` reaches this router the same way it reaches the review
 * queue: `appendCorrectionRow` scans every stated reason for motive, so a
 * reject-with-a-reason that asserts intent is a 400. Without this line it would
 * surface as a 500.
 */
function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof ReviewError || err instanceof CorrectionError) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

function actorOf(req: Request): { id: string | null; email: string | null } {
  return { id: req.operator?.id ?? null, email: req.operator?.email ?? null };
}

function badId(res: Response, what: string): void {
  res.status(400).json({ error: `Invalid ${what} id`, statusCode: 400 });
}

/** The one body every action takes. */
interface DecisionBody {
  reason?: unknown;
}

function readReason(res: Response, body: DecisionBody | undefined): string | null {
  const reason = body?.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    res.status(400).json({
      error: "reason is required: a decision without one is not a decision anyone can review",
      statusCode: 400,
    });
    return null;
  }
  return reason;
}

interface QueueQuery {
  status?: string;
  meeting_id?: string;
  limit?: string;
  offset?: string;
}

router.get("/queue", async (req: Request<unknown, unknown, unknown, QueueQuery>, res, next) => {
  try {
    const { status, meeting_id, limit, offset } = req.query;
    if (status !== undefined && !isClaimQueueStatus(status)) {
      res.status(400).json({ error: "Invalid status", statusCode: 400 });
      return;
    }
    if (meeting_id !== undefined && !UUID_RE.test(meeting_id)) return badId(res, "meeting");

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isInteger(parsedLimit)) {
      res.status(400).json({ error: "limit must be an integer", statusCode: 400 });
      return;
    }
    const parsedOffset = offset === undefined ? undefined : Number(offset);
    if (parsedOffset !== undefined && !Number.isInteger(parsedOffset)) {
      res.status(400).json({ error: "offset must be an integer", statusCode: 400 });
      return;
    }

    res.json(
      await listClaimQueue(db, {
        ...(status === undefined ? {} : { status }),
        ...(meeting_id === undefined ? {} : { meeting_id }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(parsedOffset === undefined ? {} : { offset: parsedOffset }),
      }),
    );
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * One claim, with the quote in its artifact context.
 *
 * The context is the reason this route exists rather than the list serving the
 * screen: an operator approving a sentence they cannot see in situ is
 * rubber-stamping.
 */
router.get("/:id", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "claim");

    const item = await getClaimReview(db, id);
    if (item === null) {
      res.status(404).json({ error: "Claim not found", statusCode: 404 });
      return;
    }
    res.json(item);
  } catch (err) {
    fail(res, err, next);
  }
});

router.post(
  "/:id/approve",
  async (req: Request<{ id: string }, unknown, DecisionBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "claim");
      const reason = readReason(res, req.body);
      if (reason === null) return;

      res.json(await approveClaim(db, { claimId: id, reason, actor: actorOf(req) }));
    } catch (err) {
      fail(res, err, next);
    }
  },
);

router.post(
  "/:id/reject",
  async (req: Request<{ id: string }, unknown, DecisionBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "claim");
      const reason = readReason(res, req.body);
      if (reason === null) return;

      res.json(await rejectClaim(db, { claimId: id, reason, actor: actorOf(req) }));
    } catch (err) {
      fail(res, err, next);
    }
  },
);

/**
 * Withdraw a published claim. Not a delete, and not an edit.
 *
 * The row keeps its `rendered_text` and its approval, and the meeting page shows
 * a tombstone at the same anchor saying what it previously read. A transparency
 * project that quietly unpublishes is doing the thing it exists to detect.
 */
router.post(
  "/:id/retract",
  async (req: Request<{ id: string }, unknown, DecisionBody>, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return badId(res, "claim");
      const reason = readReason(res, req.body);
      if (reason === null) return;

      res.json(await retractClaim(db, { claimId: id, reason, actor: actorOf(req) }));
    } catch (err) {
      fail(res, err, next);
    }
  },
);

export default router;
