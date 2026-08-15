import { Router, type Request, type Response } from "express";
import db from "../../config/database";
import { CorrectionError } from "../../services/pressroom/corrections";
import { PLACE_SUBJECT_KINDS, type PlaceSubjectKind } from "../../services/places";
import {
  approvePlaceLink,
  getPlaceLinkReview,
  isPlaceLinkStatus,
  listPlaceLinkQueue,
  rejectPlaceLink,
} from "../../services/review/place-links";
import { ReviewError } from "../../services/review/queue";

/**
 * `/api/admin/place-links` — the pin review screen's API.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so every path here
 * 401s without a live session. `POST /:id/approve` is the only thing in this
 * product that puts a location on the public map, and until it existed
 * `wherePlaceLinkPublic` could never match a row.
 *
 * **There is no bulk approve and there must not be one.** Every route below
 * takes one link id. A route taking an array would be a screen that publishes
 * forty unread addresses in one click.
 *
 * Every decision carries a reason, and the refusal is a 400 rather than a
 * default: the reason is what the one audit log records about why a street is on
 * a public map.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `CorrectionError` reaches this router the same way it reaches the claims
 * screen: `appendCorrectionRow` scans every stated reason for motive, so a
 * decision whose reason asserts intent is a 400. Without this line it would
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

function isSubjectKind(value: string): value is PlaceSubjectKind {
  return (PLACE_SUBJECT_KINDS as readonly string[]).includes(value);
}

interface QueueQuery {
  status?: string;
  subject_kind?: string;
  place_id?: string;
  limit?: string;
  offset?: string;
}

router.get("/queue", async (req: Request<unknown, unknown, unknown, QueueQuery>, res, next) => {
  try {
    const { status, subject_kind, place_id, limit, offset } = req.query;
    if (status !== undefined && !isPlaceLinkStatus(status)) {
      res.status(400).json({ error: "Invalid status", statusCode: 400 });
      return;
    }
    if (subject_kind !== undefined && !isSubjectKind(subject_kind)) {
      res.status(400).json({ error: "Invalid subject_kind", statusCode: 400 });
      return;
    }
    if (place_id !== undefined && !UUID_RE.test(place_id)) return badId(res, "place");

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
      await listPlaceLinkQueue(db, {
        ...(status === undefined ? {} : { status }),
        ...(subject_kind === undefined || !isSubjectKind(subject_kind)
          ? {}
          : { subject_kind }),
        ...(place_id === undefined ? {} : { place_id }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(parsedOffset === undefined ? {} : { offset: parsedOffset }),
      }),
    );
  } catch (err) {
    fail(res, err, next);
  }
});

/**
 * One link, with the quote in its artifact context and the coordinate's
 * precision spelled out.
 *
 * Those two things are why this route exists rather than the list alone: an
 * operator approving an address they cannot see in the line that names it, at a
 * precision nobody told them about, is rubber-stamping a pin.
 */
router.get("/:id", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badId(res, "place link");

    const item = await getPlaceLinkReview(db, id);
    if (item === null) {
      res.status(404).json({ error: "Place link not found", statusCode: 404 });
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
      if (!UUID_RE.test(id)) return badId(res, "place link");
      const reason = readReason(res, req.body);
      if (reason === null) return;

      res.json(await approvePlaceLink(db, { linkId: id, reason, actor: actorOf(req) }));
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
      if (!UUID_RE.test(id)) return badId(res, "place link");
      const reason = readReason(res, req.body);
      if (reason === null) return;

      res.json(await rejectPlaceLink(db, { linkId: id, reason, actor: actorOf(req) }));
    } catch (err) {
      fail(res, err, next);
    }
  },
);

export default router;
