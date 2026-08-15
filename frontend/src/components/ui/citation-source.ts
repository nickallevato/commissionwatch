import type { CitationRef } from "./Citation";

/**
 * Helpers that are not components, kept out of `Citation.tsx`.
 *
 * Not a style preference: exporting a plain function beside a component breaks
 * React Fast Refresh, which silently degrades to a full reload during
 * development. The lint rule that says so is the only reason this file exists.
 */

/**
 * Whether `/source/{sha}` exists yet.
 *
 * It does. `SourcePage` shipped on 2026-08-15 against
 * `GET /api/source/:sha256`, so a citation's address is now a link rather than
 * inert text. The constant stays because the reasoning it recorded is still
 * live: linking at a route that does not exist renders the 404 page inside the
 * site chrome, which reads as a broken record rather than a missing feature. If
 * the viewer is ever withdrawn, this is the single line that takes every
 * citation back to plain text instead of leaving the site full of dead links.
 */
export const SOURCE_VIEWER_EXISTS = true;

/**
 * A query string, not a fragment.
 *
 * The server picks the window: `readSourceWindow` centres 2,000 characters on
 * the offset it is given. A `#offset-…` fragment — which is what this returned
 * before the viewer existed — never leaves the browser, so it would have opened
 * the head of a 300-page packet and left the reader to find the quote.
 *
 * `len` is the quote's own length, which only the citation knows. Without it
 * the page can locate where the quote starts and cannot mark how far it runs,
 * and guessing an end would be marking text the citation never claimed.
 */
export function sourceHref(ref: CitationRef): string | null {
  if (!SOURCE_VIEWER_EXISTS) return null;
  const params = new URLSearchParams({
    offset: String(ref.quote_offset),
    len: String(ref.quote.length),
  });
  return `/source/${ref.artifact_sha256}?${params.toString()}`;
}

/** First and last six characters. Enough to compare by eye, short enough to read. */
export function abbreviateSha(sha: string): string {
  return sha.length <= 16 ? sha : `${sha.slice(0, 6)}…${sha.slice(-6)}`;
}
