/**
 * Locating the governor's unsupported fragments inside the quote.
 *
 * Not a component, so not in a `.tsx`: exporting a plain function beside a
 * component breaks React Fast Refresh, which is what `citation-source.ts` exists
 * for too.
 *
 * ## What the backend actually stores, which is not what you would guess
 *
 * A verdict carries two different things and only one of them is positional.
 *
 * `relied_on` is `{start, end}` offsets **the backend located itself** — see
 * `services/governor/verdict.ts`, which refuses a reply whose cited sentence is
 * not in the bytes. Those offsets index the ±2,000-character *governor window*,
 * and that window is not served to this screen. So they cannot be drawn here
 * without inventing a coordinate system, and this file does not try.
 *
 * `unsupported_fragments` is the part that has to reach the operator, and it is
 * a list of **free-text strings**. The judge is asked to "name the part of the
 * claim the window does not support — the person, the action, or the matter — in
 * a few words", so a fragment is often a phrase copied out of the quote and is
 * sometimes a description of one ("the action"). Both arrive as strings and the
 * shape does not distinguish them.
 *
 * That is why this returns two lists rather than one. A fragment found in the
 * quote is marked in place, which is the whole value of making the model point
 * rather than opine. A fragment that is not in the quote is still shown, as
 * text, beside it — dropping it because it did not match would silently discard
 * the judge's actual objection, and an operator would read an unmarked quote as
 * an unchallenged one.
 *
 * Matching is whitespace-insensitive for `verify.ts`'s reason: the quote came out
 * of a PDF whose line breaks are reconstructed from glyph positions, so byte
 * equality would fail on a phrase that is plainly there.
 */

/** One run of the quote, and whether the judge named it. */
export interface QuoteSegment {
  text: string;
  unsupported: boolean;
}

export interface MarkedQuote {
  /** The whole quote, in order, split at the marked runs. */
  segments: QuoteSegment[];
  /** Fragments that are not wording of the quote. Shown, never dropped. */
  unlocated: string[];
}

interface Span {
  start: number;
  end: number;
}

/**
 * The quote with runs of whitespace collapsed, plus where each surviving
 * character sat in the original. Mirrors `buildNormalisedIndex` in
 * `backend/src/services/extraction/verify.ts`; the two must agree about what
 * counts as the same wording, or the screen would mark a span the backend would
 * not have found.
 */
function normalisedIndex(source: string): { normalised: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (previousWasSpace) continue;
      chars.push(" ");
      offsets.push(index);
      previousWasSpace = true;
      continue;
    }
    chars.push(char);
    offsets.push(index);
    previousWasSpace = false;
  }

  return { normalised: chars.join(""), offsets };
}

function normaliseQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Overlapping and adjacent marks joined, so one phrase is one `<mark>`. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * The quote split at the fragments the judge said the record does not support.
 *
 * Case-sensitive on purpose. The fragments are supposed to be the claim's own
 * wording, and a case-insensitive match would let "the motion" mark a different
 * "the Motion" further along — marking the wrong span of a document an operator
 * is about to approve a sentence from is worse than marking none, because they
 * would read the mark as the finding.
 */
export function markUnsupported(quote: string, fragments: string[]): MarkedQuote {
  const { normalised, offsets } = normalisedIndex(quote);
  const spans: Span[] = [];
  const unlocated: string[] = [];

  for (const fragment of fragments) {
    const needle = normaliseQuery(fragment);
    if (needle === "") continue;
    const at = normalised.indexOf(needle);
    const start = at === -1 ? undefined : offsets[at];
    const end = at === -1 ? undefined : offsets[at + needle.length - 1];
    if (start === undefined || end === undefined) {
      unlocated.push(fragment.trim());
      continue;
    }
    spans.push({ start, end: end + 1 });
  }

  const merged = merge(spans);
  const segments: QuoteSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) {
      segments.push({ text: quote.slice(cursor, span.start), unsupported: false });
    }
    segments.push({ text: quote.slice(span.start, span.end), unsupported: true });
    cursor = span.end;
  }
  if (cursor < quote.length) {
    segments.push({ text: quote.slice(cursor), unsupported: false });
  }

  return { segments, unlocated };
}
