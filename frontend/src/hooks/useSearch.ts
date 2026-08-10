import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { SearchResponse } from "@/types";

/**
 * P6 · `GET /api/search`.
 *
 * `fetchJson` rather than `fetchList`: the response carries `query` alongside
 * `data` and `total`, so it is not the bare list envelope `fetchList` verifies.
 *
 * A blank query issues no request at all — `enabled` is false — and the page
 * renders its guidance instead. Asking the API what matches nothing is a round
 * trip whose answer is already known.
 */
export function useSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["search", trimmed],
    queryFn: () => fetchJson<SearchResponse>(`/search?q=${encodeURIComponent(trimmed)}&limit=50`),
    enabled: trimmed.length > 0,
  });
}

/** The delimiters `ts_headline` wraps a match in. Control characters, not markup. */
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_END = "";

export interface SnippetSegment {
  text: string;
  match: boolean;
}

/**
 * Splits a snippet into plain and matched segments.
 *
 * The alternative is `dangerouslySetInnerHTML` over server-rendered `<b>` tags,
 * which would mean injecting text scraped out of third-party PDFs as HTML. This
 * is the whole reason the API marks matches with control characters instead.
 *
 * An unterminated marker — truncation, a document that genuinely contains one —
 * yields the remainder as plain text rather than swallowing it.
 */
export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) break;
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    if (end === -1) break;
    if (start > 0) segments.push({ text: rest.slice(0, start), match: false });
    segments.push({ text: rest.slice(start + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  if (rest.length > 0) segments.push({ text: rest, match: false });
  return segments;
}
