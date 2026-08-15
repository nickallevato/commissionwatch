import { Router } from "express";
import db from "../config/database";
import { collectMetrics } from "../services/metrics";
import { rosterCoverage, rosterProvenance } from "../services/roster-coverage";

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

/**
 * The roster distribution rides alongside the metrics rather than inside them.
 *
 * `collectMetrics` sums `rosterCoverage` into three totals because the headline
 * figures want one number each, and a total cannot say whether the coverage is
 * even: one fully accounted body and one wholly unaccounted body add up to
 * figures that read as partial coverage in both. `rosterProvenance` answers that
 * without naming a body — see the note on it for why a per-body roll may not go
 * on this endpoint. Both come from the same `rosterCoverage` call, so there is
 * still exactly one implementation of the judgement; this is a second *view*,
 * not a second opinion.
 */
router.get("/", async (_req, res, next) => {
  try {
    const [metrics, coverage] = await Promise.all([collectMetrics(db), rosterCoverage(db)]);
    // A short cache: these numbers move when an operator publishes something,
    // which is a few times a day at most, and the queries touch every large
    // table in the database.
    res
      .set("Cache-Control", "public, max-age=300")
      .json({ ...metrics, roster: rosterProvenance(coverage) });
  } catch (err) {
    next(err);
  }
});

export default router;
