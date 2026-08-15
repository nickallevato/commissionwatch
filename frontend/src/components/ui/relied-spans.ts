/**
 * The sentences the governor relied on, pulled out of the review window.
 *
 * The verdict's `relied_on_document` offsets are in document coordinates and the
 * review screen shows a ±500-character slice, while the governor judged ±2,000.
 * **Most spans will therefore fall outside what the operator is looking at**,
 * and that is not a failure — it is the two windows being different sizes on
 * purpose. What would be a failure is showing four spans and silently rendering
 * two, so the count held back is returned rather than dropped.
 *
 * They are returned as quoted text rather than as marks nested inside the quote
 * highlight. Overlapping marks would have to decide what to do where a relied-on
 * sentence contains the quote, and the answer a reader needs is "here is what
 * the judge read", which reads better as a list than as a second colour.
 */

export interface ReliedSpan {
  start: number;
  end: number;
}

export interface ReliedInWindow {
  /** Verbatim text of each span that falls inside the window, in order. */
  quotes: string[];
  /** Spans the judge relied on that this window does not reach. */
  outside: number;
}

export function reliedInWindow(
  spans: readonly ReliedSpan[],
  windowText: string,
  windowOffset: number,
): ReliedInWindow {
  const quotes: string[] = [];
  let outside = 0;

  for (const span of spans) {
    const start = span.start - windowOffset;
    const end = span.end - windowOffset;
    // Wholly inside, or it is not shown. A span clipped at the window edge would
    // be a half-sentence presented as the thing the judge relied on, which
    // misrepresents the evidence in the direction of looking thinner than it is.
    if (start < 0 || end > windowText.length || end <= start) {
      outside += 1;
      continue;
    }
    const text = windowText.slice(start, end).trim();
    if (text.length === 0) {
      outside += 1;
      continue;
    }
    quotes.push(text);
  }

  return { quotes, outside };
}
