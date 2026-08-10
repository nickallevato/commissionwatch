import { Router, type Request, type Response } from "express";
import db from "../config/database";
import { DisputeError, submitDispute } from "../services/disputes";
import { listPublicCorrections } from "../services/public-corrections";

/**
 * B3 — `/api/corrections`, public and unauthenticated.
 *
 * Two things live here, and they are the last gate before this site can be
 * reached from outside the operator's own address:
 *
 *  - `GET /` — the corrections log. Only corrections to records that are public
 *    right now, routed through `services/publication.ts`. See
 *    `services/public-corrections.ts` for the rule and why it is per table.
 *  - `POST /disputes` — a person named in a record contests it. The submission
 *    lands in the operator queue, is never published, and edits nothing.
 *
 * `POST /disputes` is the only unauthenticated write in this product, so it is
 * the only route with a rate limit. The limits are in `services/disputes.ts`
 * rather than here, because two of the three are database queries that have to
 * run inside the insert's transaction — a limit enforced in middleware and a
 * limit enforced in the transaction are two different limits, and only the
 * second one holds under concurrency.
 *
 * **Nothing is emailed.** The reference is returned in this response and that
 * is the submitter's copy of it. The page says so; a route that silently
 * depended on an email nobody sends would leave a wronged person waiting.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, err: unknown, next: (e?: unknown) => void): void {
  if (err instanceof DisputeError) {
    if (err.retryAfterSeconds !== undefined) {
      res.set("Retry-After", String(err.retryAfterSeconds));
    }
    res.status(err.statusCode).json({ error: err.message, statusCode: err.statusCode });
    return;
  }
  next(err);
}

interface LogQuery {
  limit?: string;
  offset?: string;
}

router.get("/", async (req: Request<unknown, unknown, unknown, LogQuery>, res, next) => {
  try {
    const { limit, offset } = req.query;
    const listing = await listPublicCorrections(db, {
      ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) || 50 }),
      ...(offset === undefined ? {} : { offset: Number.parseInt(offset, 10) || 0 }),
    });
    res.json(listing);
  } catch (err) {
    next(err);
  }
});

interface DisputeBody {
  target_table?: unknown;
  target_id?: unknown;
  contested?: unknown;
  account?: unknown;
  contact?: unknown;
}

/**
 * The client key for the per-client window.
 *
 * `req.ip` under `trust proxy = 1` (see `app.ts`) is the address Caddy appended
 * to `X-Forwarded-For`, not one a client wrote. It is counted in memory and
 * never stored — `record_disputes` has no column for it, deliberately.
 */
function clientKeyOf(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

router.post("/disputes", async (req: Request<Record<string, string>, unknown, DisputeBody>, res, next) => {
  try {
    const body = req.body ?? {};
    if (typeof body.target_table !== "string" || body.target_table === "") {
      res.status(400).json({ error: "target_table is required", statusCode: 400 });
      return;
    }
    if (typeof body.target_id !== "string" || !UUID_RE.test(body.target_id)) {
      res.status(400).json({ error: "Invalid target id", statusCode: 400 });
      return;
    }
    // Checked one at a time rather than in a loop: a loop over field names
    // does not narrow `body[field]` to `string`, and the only way to make it
    // compile would be a cast — which is the thing this project does not do to
    // quiet a compiler that is telling the truth.
    const { contested, account, contact } = body;
    if (typeof contested !== "string") {
      res.status(400).json({ error: "contested is required", statusCode: 400 });
      return;
    }
    if (typeof account !== "string") {
      res.status(400).json({ error: "account is required", statusCode: 400 });
      return;
    }
    if (typeof contact !== "string") {
      res.status(400).json({ error: "contact is required", statusCode: 400 });
      return;
    }

    const receipt = await submitDispute(db, {
      targetTable: body.target_table,
      targetId: body.target_id,
      contested,
      account,
      contact,
      clientKey: clientKeyOf(req),
    });

    // 201: a dispute is a new record of a contest, not a change to anything.
    res.status(201).json(receipt);
  } catch (err) {
    fail(res, err, next);
  }
});

export default router;
