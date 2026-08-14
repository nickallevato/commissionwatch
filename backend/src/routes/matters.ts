import { Router, Request } from "express";
import db from "../config/database";
import {
  MATTER_STATES,
  findMatter,
  isMatterState,
  listMatters,
} from "../services/matters";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

interface MattersQuery {
  jurisdiction_id?: string;
  state?: string;
  limit?: string;
  offset?: string;
}

/**
 * The matters list. Public and unauthenticated like the rest of the read API,
 * and restricted to the published record inside `services/matters.ts`.
 *
 * An unrecognised `state` is a 400 rather than an empty page. The four values
 * are derived, so a typo would otherwise return `{data: [], total: 0}` — a
 * confident, wrong answer about a jurisdiction, which is the worst thing this
 * API can say.
 */
router.get("/", async (req: Request<unknown, unknown, unknown, MattersQuery>, res, next) => {
  try {
    const { jurisdiction_id: jurisdiction, state, limit: rawLimit, offset: rawOffset } = req.query;

    if (jurisdiction && !UUID_RE.test(jurisdiction))
      throw badRequest("Invalid jurisdiction_id format");
    if (state && !isMatterState(state))
      throw badRequest(`state must be one of: ${MATTER_STATES.join(", ")}`);

    // The clamping `/api/meetings` applies. Two pagination policies on one API
    // is a defect.
    const limit = Math.min(Math.max(parseInt(rawLimit || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset || "0", 10) || 0, 0);

    const result = await listMatters(db, {
      jurisdictionId: jurisdiction,
      state: isMatterState(state) ? state : undefined,
      limit,
      offset,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * One matter and its timeline.
 *
 * 404, never 403, when every appearance sits on an unpublished meeting — see
 * `findMatter`. A matter is a *subject*, so confirming one exists would disclose
 * what a body is considering before an operator has published anything saying
 * so.
 */
router.get("/:id", async (req: Request<{ id: string }>, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid matter ID format");

    const matter = await findMatter(db, id);
    if (!matter) {
      res.status(404).json({ error: "Matter not found", statusCode: 404 });
      return;
    }

    res.json(matter);
  } catch (err) {
    next(err);
  }
});

export default router;
