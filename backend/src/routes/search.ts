import { Router, Request } from "express";
import db from "../config/database";
import { clampLimit, clampOffset, search } from "../services/search";

/**
 * P6 · `GET /api/search?q=` — public, unauthenticated, over published records
 * only.
 *
 * Public because this is open data and the whole point of the archive is that
 * anyone can look. Restricted to published records because
 * `meetings.published_at` is what stops an ingested candidate reaching a reader
 * before an operator has approved it — see `services/publication.ts`, and
 * `services/search.ts` for how every branch of the query reaches that wall.
 *
 * A missing, blank or stopword-only `q` answers `200` with an empty list rather
 * than `400`. An empty search box is not a client error, and a transparency site
 * that returns a failure to someone who pressed enter early has told them
 * nothing about the record.
 */
const router = Router();

interface SearchQuery {
  q?: string;
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, SearchQuery>, res, next) => {
  try {
    // `?q=a&q=b` arrives as an array. Taking neither value beats concatenating
    // two searches into one nobody asked for.
    const raw = req.query.q;
    const q = typeof raw === "string" ? raw : "";

    const result = await search(db, {
      q,
      limit: clampLimit(req.query.limit),
      offset: clampOffset(req.query.offset),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
