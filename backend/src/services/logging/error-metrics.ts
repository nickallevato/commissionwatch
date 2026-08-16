/**
 * In-process counts of 5xx responses, by route.
 *
 * Coarse and honest, the same discipline `routes/health.ts` follows for
 * `resources` (see `c2ce56a`, roadmap 6.3): a route label and a count, never
 * a raw error message or a stack — those already go to stdout as a
 * structured log line via `services/logging/logger.ts`, and belong there,
 * not in a counter a second process reads over HTTP.
 *
 * **In-memory, and that is a deliberate, bounded promise.** This project runs
 * one backend container behind Caddy (`docs/spec/architecture.md`,
 * `app.set("trust proxy", 1)`'s own comment), so "since this process last
 * restarted" already covers the deployment's actual failure window — a
 * restart is the same event that would lose an in-memory queue depth or a
 * scheduler's `lastRun`, both of which this codebase already accepts as
 * process-lifetime facts (`services/ingestion/scheduler.ts`,
 * `services/digest-scheduler.ts`). A counter that outlived a restart would
 * need a database table and a migration for a number whose only consumer is
 * an operator glancing at "is anything on fire right now" — not worth it
 * unless multi-instance ever happens, at which point this needs to move
 * behind the database anyway so instances agree.
 *
 * Exposed at `/api/admin/errors`, behind `requireOperator` — never at
 * `/api/health`, which is public. Health merely says the process can serve a
 * correct response *right now* (see the doc comment in `routes/health.ts`);
 * error counts say how often it has *not*, per route, which is enough for an
 * attacker mapping which endpoints are fragile to treat as a probe result.
 * `resources` on `/api/health` gets away with coarse states (`ok`/`low`/
 * `critical`) for the same reason a fire alarm can say "smoke detected"
 * without publishing the floor plan; a per-route error tally is closer to the
 * floor plan.
 */

/** Route label to 5xx count, since process start. */
const counts = new Map<string, number>();

/** Process start, so a reader can tell "quiet route" from "young process". */
const startedAt = new Date();

/**
 * Record one 5xx response against its route.
 *
 * Called once per response from `middleware/requestContext.ts`'s `finish`
 * handler — after the status code is final, so this counts every 5xx
 * regardless of whether it was thrown (and passed through `errorHandler`) or
 * set directly by a route. Calling it from `errorHandler` as well would
 * double-count the thrown case.
 */
export function recordError(route: string): void {
  counts.set(route, (counts.get(route) ?? 0) + 1);
}

export interface ErrorCountsSnapshot {
  since: string;
  total: number;
  byRoute: Record<string, number>;
}

/** A snapshot for `/api/admin/errors`. Never mutated by the reader. */
export function errorCountsSnapshot(): ErrorCountsSnapshot {
  const byRoute: Record<string, number> = {};
  let total = 0;
  for (const [route, count] of counts.entries()) {
    byRoute[route] = count;
    total += count;
  }
  return { since: startedAt.toISOString(), total, byRoute };
}

/** Test-only: back to zero, as if the process had just started. */
export function resetErrorCountsForTest(): void {
  counts.clear();
}
