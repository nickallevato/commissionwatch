import { Router, type Request, type Response } from "express";
import db from "../config/database";
import { listGaps } from "../services/records/gaps";
import { generatePublicLetter, normaliseRequester } from "../services/records/generator";
import { RecordsError } from "../services/records/requests";

/**
 * P7 — the statutory route, unauthenticated.
 *
 * The project's scraping policy commits to offering the public-records route
 * alongside the vendor-robots exception. Until now that offer was a sentence on
 * the Methodology page; this is the sentence with a button on it. A reader picks
 * a gap in the record, supplies their own name and email, and gets the same
 * letter the operator console produces — theirs to send, under their own name.
 *
 * Three properties this router holds:
 *
 * - **It writes nothing.** No `records_requests` row, no analytics row, no
 *   record of who asked for what. `public-records.test.ts` counts the table
 *   either side.
 * - **It sends nothing.** Neither does anything it calls. The letter is
 *   returned to the browser and that is the end of it.
 * - **It cannot name an unpublished meeting.** Gaps are listed in `public`
 *   scope, which routes every meeting-anchored query through the publication
 *   wall — and the gap id a caller hands back to `POST /letter` is re-resolved
 *   in the same scope, so an operator-scope id is not a way in.
 */

const router = Router();

function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof RecordsError) {
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

interface GapsQuery {
  meeting_id?: string;
  limit?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/gaps", async (req: Request<unknown, unknown, unknown, GapsQuery>, res, next) => {
  try {
    const meetingId = req.query.meeting_id;
    if (meetingId !== undefined && !UUID_RE.test(meetingId)) {
      res.status(400).json({ error: "Invalid meeting_id format", statusCode: 400 });
      return;
    }

    const data = await listGaps(db, "public", {
      meetingId,
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
    });
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

interface LetterBody {
  gap_id?: unknown;
  requester?: unknown;
}

router.post("/letter", async (req: Request<unknown, unknown, LetterBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (typeof body.gap_id !== "string" || body.gap_id.trim() === "") {
      res.status(400).json({ error: "gap_id is required", statusCode: 400 });
      return;
    }

    const requester = normaliseRequester(body.requester);
    const generated = await generatePublicLetter(db, { gapId: body.gap_id, requester });

    // `request` is null here and stays null. Returned rather than stripped, so
    // the shape is the same on both surfaces and the difference is visible.
    res.json({
      letter: generated.letter,
      gap: generated.gap,
      law: generated.law,
      warnings: generated.warnings,
      request: generated.request,
    });
  } catch (err) {
    fail(res, err, next);
  }
});

export default router;
