import { Router } from "express";
import db from "../config/database";
import { collectMetrics } from "../services/metrics";

/**
 * `GET /api/metrics` — this project's own numbers.
 *
 * Unauthenticated, like `/status` and for the same reason: it describes this
 * site's collection rather than anybody's record, and a watchdog that publishes
 * its performance only to itself has published nothing.
 *
 * See `services/metrics.ts` for why aggregate counts of unpublished records do
 * not breach the publication wall, and for the line that must not be crossed —
 * counts and durations, never identifiers.
 */

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const metrics = await collectMetrics(db);
    // A short cache: these numbers move when an operator publishes something,
    // which is a few times a day at most, and the queries touch every large
    // table in the database.
    res.set("Cache-Control", "public, max-age=300").json(metrics);
  } catch (err) {
    next(err);
  }
});

export default router;
