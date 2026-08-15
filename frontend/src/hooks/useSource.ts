import { useQuery } from "@tanstack/react-query";
import { fetchOne } from "@/lib/api";
import type { SourceWindow } from "@/types";

/**
 * `GET /api/source/:sha256` — the other end of every citation.
 *
 * The offset goes in the query string rather than the fragment because the
 * *server* picks the window. A fragment never leaves the browser, so a citation
 * that carried its offset after a `#` would open the head of a 300-page packet
 * and leave the reader to find the quote themselves.
 *
 * A bare object, not a `{ data, total }` envelope — see the endpoint table in
 * `lib/api.ts`.
 */
export function useSource(sha256: string | undefined, offset: number) {
  return useQuery({
    queryKey: ["source", sha256, offset],
    queryFn: () => fetchOne<SourceWindow>(`/source/${sha256}?offset=${offset}`),
    enabled: Boolean(sha256),
    // A content address is immutable by construction: the same hash cannot
    // answer with different bytes tomorrow. Refetching on every focus change
    // would ask a county's archive to prove that again for nothing.
    staleTime: Infinity,
  });
}

export interface HighlightSegments {
  before: string;
  match: string;
  after: string;
}

/**
 * Split a window's text around the cited quote.
 *
 * `position` is the quote's offset **within the window** — `offset -
 * window_start`, which the caller computes because only the caller has both.
 * `length` is how long the citation says its quote is.
 *
 * Returns `null` when the quote does not fall inside this slice. That is a real
 * case rather than a defensive one: `readSourceWindow` clamps an offset past
 * the end of a re-extracted document instead of 404ing, on the grounds that the
 * wrong part of the right file beats a page that reads as "we made this up". A
 * reader who lands there must be told the highlight is missing, not shown a
 * highlight over arbitrary text.
 */
export function highlightSegments(
  text: string,
  position: number,
  length: number,
): HighlightSegments | null {
  if (!Number.isFinite(position) || position < 0 || position >= text.length) return null;
  if (!Number.isFinite(length) || length <= 0) return null;
  const end = Math.min(text.length, position + length);
  return {
    before: text.slice(0, position),
    match: text.slice(position, end),
    after: text.slice(end),
  };
}

/** `12,345 bytes`, with the separators a body of numbers on this site uses. */
export function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}
