import type { PaginatedResponse } from "@/types";

const API_BASE = "/api";

/**
 * The list envelope every collection endpoint on the API returns.
 *
 * Re-exported here so callers can reach for the envelope type from the same
 * module as the fetchers that produce it.
 */
export type { PaginatedResponse };

/**
 * Response shapes, per endpoint, as of backend/src/routes. They are not
 * uniform, so pick the fetcher that matches:
 *
 *   `{ data, total }` envelope — use `fetchList`
 *     GET  /jurisdictions
 *     GET  /meetings
 *     GET  /meetings/:id/agenda-items
 *     GET  /meetings/:id/documents
 *     GET  /meetings/:id/votes
 *     GET  /meetings/:id/anomalies
 *     GET  /members
 *     GET  /votes            POST /votes/bulk
 *     GET  /anomalies        GET  /anomalies/meeting/:id
 *     POST /anomalies/meeting/:id/detect
 *     GET  /subscriptions    GET  /notifications
 *
 *   bare object — use `fetchOne`
 *     GET  /health
 *     GET  /meetings/:id             (the row plus `agenda_items`, `documents`)
 *     GET  /meetings/:id/rundown
 *     GET  /members/:id              POST/PUT /members[/:id]
 *     GET  /anomalies/:id            POST /anomalies
 *     POST /anomalies/detect-batch
 *     GET/PATCH /subscriptions/:id   POST /subscriptions
 *     PATCH /notifications/:id/read
 *
 *   neither — one-off shapes, use `fetchJson` with an explicit type
 *     POST /meetings/:id/detect-anomalies  →  { data, count }  (note: `count`,
 *                                             not `total`)
 *     GET  /notifications/count            →  { unread }
 *     PATCH /notifications/read-all        →  { updated }
 *     GET  /subscriptions/verify/:token    →  { message }
 *
 * No endpoint returns a bare array. A hook that types one as `T[]` hands
 * components an object, and every `.map` over it throws.
 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Narrow an unknown body to the list envelope. The element type is not — and
 * cannot be — checked at runtime; only the envelope around it is.
 */
function isPaginatedResponse<T>(body: unknown): body is PaginatedResponse<T> {
  return (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    Array.isArray(body.data) &&
    "total" in body &&
    typeof body.total === "number"
  );
}

/**
 * Fetch a collection endpoint and return its `{ data, total }` envelope.
 *
 * The envelope is verified at runtime: if an endpoint ever goes back to
 * returning a bare array — or an error page, or anything else — this throws at
 * the fetch boundary and names the offending path, instead of resolving to a
 * value that only explodes later inside a component's `.map`.
 */
export async function fetchList<T>(
  path: string,
  init?: RequestInit,
): Promise<PaginatedResponse<T>> {
  const body = await fetchJson<unknown>(path, init);
  if (!isPaginatedResponse<T>(body)) {
    throw new Error(
      `API contract error: ${path} did not return a { data, total } envelope`,
    );
  }
  return body;
}

/** Fetch an endpoint that returns a single bare object rather than an envelope. */
export function fetchOne<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchJson<T>(path, init);
}
