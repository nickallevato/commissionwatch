import { Request, Response, NextFunction } from "express";
import { logger } from "../services/logging/logger";
import { getRequestId } from "./requestContext";

interface AppError extends Error {
  statusCode?: number;
}

/**
 * The last thing between a thrown exception and a stranger's screen.
 *
 * Two rules, and the first is the reason this file exists. **A 500 never
 * carries its own message.** What throws here is routinely a database driver or
 * an HTTP client, and their messages carry connection strings, internal
 * addresses and — because a Granicus URL puts the meeting title in its query
 * string — occasionally a fragment of a record an operator has not published.
 * A 4xx message is ours, written by `badRequest()` and its siblings to be read
 * by the caller, so it passes through.
 *
 * The fourth parameter is what makes Express treat this as error middleware
 * (`fn.length === 4`); dropping it turns this into ordinary middleware and
 * errors stop being handled at all. It is now genuinely used, for the reason
 * below.
 */
export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // A route that has already begun writing — a bulk export, the sitemap — and
  // then throws leaves headers sent. `res.status()` throws in that state, so
  // the old code turned a handled error into an unhandled one *inside the
  // error handler*, and the caller got a truncated body with a 200 on it.
  // Express's own final handler delegates here and destroys the socket, which
  // is the only honest ending: the response is already wrong and cannot be
  // unsaid, so it must not be allowed to look complete.
  //
  // Deliberately no logging added on this path. `next(err)` must return
  // synchronously and must not touch `res` beyond what it already does — this
  // branch exists because the previous code called `res.status()` from here
  // and turned a handled error into an unhandled one. A structured log call
  // touches neither, but the failure mode this branch guards against is
  // exactly "one more thing done in here that turns out to throw", so nothing
  // is added beyond the delegation. The `finish` handler in
  // `middleware/requestContext.ts` still logs the request and its final
  // status code once the response actually ends, so the event is not silent —
  // it is just not logged from inside this function.
  if (res.headersSent) {
    next(err);
    return;
  }

  const raw = typeof err?.statusCode === "number" ? err.statusCode : 500;
  // A status outside what HTTP has is still an error. `res.status(1200)` throws
  // a RangeError, which would surface to the caller as a socket hang-up rather
  // than a response, so an unusable value is answered as the 500 it really is.
  const statusCode = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;

  const message = statusCode === 500 ? "Internal server error" : err.message;

  if (statusCode === 500) {
    // The requestId correlates this line with the one `finish` produces in
    // `middleware/requestContext.ts` — that one carries the route and status,
    // this one carries what actually threw. Still exactly one console.error
    // call per 500, same as before this logger existed; `error-handler.test.ts`
    // depends on that count.
    logger.error(err.message, { requestId: getRequestId(), stack: err.stack });
  }

  res.status(statusCode).json({ error: message, statusCode });
}
