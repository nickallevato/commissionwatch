import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../services/logging/logger";
import { recordError } from "../services/logging/error-metrics";

/**
 * A request id, available to anything logging during that request, and one
 * structured line per completed request.
 *
 * ## Where this sits in `app.ts`, and why
 *
 * `app.ts` documents a deliberate order for CORS, the rate limiter and the
 * body parser — CORS first so a preflight is answered rather than counted,
 * the rate limiter before `express.json()` so a request about to be refused
 * is never parsed. This middleware goes **before all three**, first in the
 * chain right after `app.set("trust proxy", 1)`.
 *
 * It has to: it assigns an id and opens the `finish` listener that produces
 * the one summary log line per request, including the ones the rate limiter
 * refuses with 429 and the ones a CORS preflight answers before reaching any
 * route. A request id that only existed for requests the rate limiter let
 * through would make the exact traffic an operator most wants to correlate —
 * a client tripping the limiter — the one traffic without one. Assigning an
 * id and reading the response header touch no state either of those two
 * orderings protect, so placing this first changes nothing about why they are
 * ordered as they are.
 */

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** The current request's id, or `undefined` outside a request (a boot script, a scheduler tick). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `requestContext`. Also echoed as the `X-Request-Id` response header. */
    id: string;
  }
}

/**
 * `req.route.path` is only populated once a router has matched, and is scoped
 * to that router — `/:id`, not `/api/matters/:id` — so `req.baseUrl` is
 * prepended to keep routes from different routers distinguishable. Falls back
 * to the raw path when nothing matched at all, which is exactly the case for
 * the `/api` 404 catch-all in `app.ts` and for a path Caddy never should have
 * forwarded.
 */
function routeLabel(req: Request): string {
  const matched = req.route && typeof req.route.path === "string" ? req.route.path : req.path;
  const combined = `${req.baseUrl}${matched}`;
  return combined === "" ? req.path : combined;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeLabel(req);

    if (res.statusCode >= 500) {
      recordError(route);
    }

    logger.info("request", {
      requestId,
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  });

  storage.run({ requestId }, next);
}
