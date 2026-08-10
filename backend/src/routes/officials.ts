import { Router } from "express";
import db from "../config/database";
import { financeCoverage } from "../services/finance/coverage";
import { getOfficialProfile } from "../services/officials";

/**
 * Officials as first-class subjects of the site.
 *
 * `/api/members` already exists and stays: it is the roster, and it also
 * carries the write routes the seeder and the admin tooling use. This router is
 * the *reader's* view of one person — the voting record, attendance, patterns
 * over time and the donor overlay — and everything it returns is filtered to
 * published records inside `services/officials.ts`.
 *
 * Read-only by construction. There is no POST, PUT or DELETE here, and there
 * should never be one: the surface a reader reaches and the surface that edits
 * the roster are different surfaces, and the second one is already elsewhere.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What campaign finance this site has consulted, and what it has not.
 *
 * A route of its own so the caveat is reachable without loading anybody's
 * profile — the officials page renders it whether or not the official has a
 * finding, and a page that only received the sentence alongside a finding would
 * be silent in exactly the case where it matters most.
 */
router.get("/finance-coverage", (_req, res) => {
  res.json(financeCoverage());
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      const error = new Error("Invalid official ID format") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }

    const profile = await getOfficialProfile(db, id);
    if (!profile) {
      res.status(404).json({ error: "Official not found", statusCode: 404 });
      return;
    }

    res.json(profile);
  } catch (err) {
    next(err);
  }
});

export default router;
