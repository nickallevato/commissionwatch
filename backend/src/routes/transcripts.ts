import { Router } from "express";
import db from "../config/database";
import { transcriptCoverage } from "../services/transcript-coverage";

/**
 * `GET /api/transcripts/coverage` — public, unauthenticated, published meetings
 * only.
 *
 * A sibling of the public status page rather than part of it:
 * `buildPublicStatus` is per *source* and describes our sweeps, while transcript
 * coverage is per *body and year* and describes the custodian's record. Different
 * subject, different wall — this one is inside `whereMeetingPublished`.
 *
 * The four counts are reported separately on purpose. `absent` says the city
 * served an empty caption file; `unavailable` says we could not get an answer;
 * `unchecked` says we have not asked yet. A reader can only judge the archive if
 * those three stay apart, and no error text is exposed here at all.
 */
const router = Router();

router.get("/coverage", async (_req, res, next) => {
  try {
    res.json({ coverage: await transcriptCoverage(db) });
  } catch (err) {
    next(err);
  }
});

export default router;
