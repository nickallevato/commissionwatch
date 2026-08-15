import { Router, type Request } from "express";
import db from "../../config/database";
import { rosterRoll } from "../../services/roster-coverage";

/**
 * `/api/admin/roster` — the per-body roster roll.
 *
 * `rosterCoverage` has computed this since it was written and nothing
 * operator-facing read it. `/api/metrics` reads the *aggregate* —
 * `rosterProvenance`, a distribution over bodies with no body and no person
 * named — and it must stay that way: a per-body list on a public, id-less
 * endpoint tells a stranger which counties we hold withheld records for, which
 * is precisely the enumeration the 404-not-403 publication design exists to
 * prevent. `metrics.test.ts` asserts the public payload contains no name from
 * any row of `jurisdictions`.
 *
 * This route names bodies, and names the unmatched officeholders too. It is
 * mounted after `requireOperator` in `routes/admin/index.ts`, so it 401s
 * without a live session, and naming things is the entire point of it: the
 * operator is the person who has to go and source the roster, and "which body,
 * and which names" is the whole of the next action.
 *
 * **It is a GET and there is nothing else here.** No route on this path writes
 * a member row. A screen that let an operator type in the missing names would
 * manufacture exactly the unsourced roster the provenance columns exist to
 * refuse — the writer is `src/scripts/roster-load.ts`, which requires bytes,
 * a URL and a fetch time for every row it inserts.
 */

const router = Router();

interface RosterQuery {
  /** `YYYY-MM-DD`. Which day's terms to count; defaults to today. */
  as_of?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/", async (req: Request<unknown, unknown, unknown, RosterQuery>, res, next) => {
  try {
    const { as_of } = req.query;

    let asOf: Date | undefined;
    if (as_of !== undefined) {
      // Refused rather than silently treated as today. A screen showing last
      // year's roll because a typo parsed to `Invalid Date` is worse than an
      // error, and `new Date("nonsense")` is exactly that shape.
      if (!DAY_RE.test(as_of)) {
        res.status(400).json({ error: "as_of must be YYYY-MM-DD", statusCode: 400 });
        return;
      }
      const parsed = new Date(`${as_of}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "as_of is not a real date", statusCode: 400 });
        return;
      }
      asOf = parsed;
    }

    res.json(await rosterRoll(db, asOf === undefined ? {} : { asOf }));
  } catch (err) {
    next(err);
  }
});

export default router;
