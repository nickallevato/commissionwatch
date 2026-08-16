import { Router } from "express";
import { errorCountsSnapshot } from "../../services/logging/error-metrics";

/**
 * `/api/admin/errors` — 5xx counts by route, since this process started.
 *
 * Mounted after `requireOperator` in `routes/admin/index.ts`, so this 401s
 * without a live session, for the reason `services/logging/error-metrics.ts`
 * gives: a public per-route error tally is close to a map of which endpoints
 * are fragile, and `/api/health`'s own `resources` field gets to be public
 * only by staying coarse (`ok`/`low`/`critical`, never raw bytes — see
 * `c2ce56a`). A route-keyed count is more specific than that, so it goes
 * behind the operator line instead of onto the public health check.
 *
 * `scripts/external-monitor.ts` is deliberately **not** wired to this route:
 * it runs unauthenticated, from outside the process, over HTTP with no
 * stored credential (see its module doc on why it stays import-free and
 * dependency-free) — adding an operator session to it would be a second kind
 * of secret for a script whose entire design goal is running with none. An
 * operator who wants this reads it by hand, or a future change teaches the
 * monitor an authenticated probe deliberately, as its own decision.
 */

const router = Router();

router.get("/", (_req, res) => {
  res.json(errorCountsSnapshot());
});

export default router;
