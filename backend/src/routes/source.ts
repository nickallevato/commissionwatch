import { Router } from "express";
import type { Request } from "express";
import db from "../config/database";
import { readSourceWindow } from "../services/source-viewer";

/**
 * `GET /api/source/:sha256` — the other end of every citation.
 *
 * Unauthenticated and public, but only for documents attached to a published
 * meeting. See `services/source-viewer.ts` for the wall and for why an
 * unattached artifact is not served.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;

const router = Router();

router.get("/:sha256", async (req: Request<{ sha256: string }>, res, next) => {
  try {
    const { sha256 } = req.params;
    // Lowercase hex only. A 400 here rather than a 404 because a malformed hash
    // is a caller mistake, not a withheld record — and conflating the two would
    // make the 404 above less informative than it is.
    if (!SHA256_RE.test(sha256)) {
      res.status(400).json({ error: "Invalid artifact hash", statusCode: 400 });
      return;
    }

    const raw = req.query.offset;
    const parsed = typeof raw === "string" ? Number(raw) : 0;
    const offset = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;

    const window = await readSourceWindow(db, sha256, offset);
    if (!window) {
      // "No such artifact", "not attached to a meeting" and "its meeting is
      // withheld" answer identically. Distinguishing them would let anyone
      // enumerate what has been ingested and not published.
      res.status(404).json({ error: "Source not found", statusCode: 404 });
      return;
    }

    res.set("Cache-Control", "public, max-age=3600").json(window);
  } catch (err) {
    next(err);
  }
});

export default router;
