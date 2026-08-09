/**
 * Entity extraction from a public-records document.
 *
 * Ported from the archive's `document-digger.ts`, whose regexes are sound, with
 * one addition it lacked: a confidence per field. The operator surface has to
 * show one, and a pattern that matched an ISO date is a much better guess than
 * one that matched two capitalised words in a row.
 *
 * **The person heuristic is weak, and deliberately so.** "Commission Room"
 * matches a two-capitalised-word pattern exactly as readily as a name does.
 * That is why extraction output is never published, always operator-reviewed,
 * and why the correction path exists. Making the regex cleverer would not
 * change the requirement; it would only make the failure rarer and therefore
 * less expected.
 */

export const EXTRACTOR_VERSION = '1.0';

/** How much to trust one extracted value. A heuristic, and labelled as one. */
export type Confidence = 'high' | 'medium' | 'low';

export interface ExtractedValue {
  value: string;
  confidence: Confidence;
  /** Which pattern produced it, so a reviewer can judge the guess. */
  pattern: string;
}

export interface ExtractedEntities {
  people: ExtractedValue[];
  organizations: ExtractedValue[];
  amounts: ExtractedValue[];
  dates: ExtractedValue[];
}

const AMOUNT_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const LONG_DATE_RE =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/gi;
const PERSON_RE = /\b[A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z]+){1,2}\b/g;
const ORG_RE =
  /\b(?:[A-Z][a-zA-Z&.-]*(?:\s+[A-Z][a-zA-Z&.-]*)*\s+(?:Department|Agency|Office|Commission|Council|County|City|Authority|District|Board|LLC|Inc\.?|Corp\.?))\b/g;

function matches(text: string, pattern: RegExp): string[] {
  return text.match(pattern) ?? [];
}

function dedupe(values: ExtractedValue[]): ExtractedValue[] {
  const seen = new Set<string>();
  const out: ExtractedValue[] = [];
  for (const item of values) {
    const value = item.value.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push({ ...item, value });
  }
  return out;
}

export function extractEntities(text: string): ExtractedEntities {
  const organizations = dedupe(
    matches(text, ORG_RE).map((value) => ({
      value,
      // An explicit organisational suffix is a strong signal.
      confidence: 'high' as const,
      pattern: 'organisational suffix',
    })),
  );
  const orgValues = new Set(organizations.map((org) => org.value));

  const people = dedupe(
    matches(text, PERSON_RE)
      // Anything already claimed as an organisation is not also a person.
      .filter((value) => !orgValues.has(value))
      .filter((value) => ![...orgValues].some((org) => org.includes(value)))
      .map((value) => ({
        value,
        // Two or three capitalised words. This catches names and it catches
        // "Commission Room"; the reviewer decides which one it is.
        confidence: 'low' as const,
        pattern: 'capitalised word sequence',
      })),
  );

  const amounts = dedupe(
    matches(text, AMOUNT_RE).map((value) => ({
      value,
      confidence: (value.trim().startsWith('$') ? 'high' : 'medium') as Confidence,
      pattern: value.trim().startsWith('$') ? 'currency-marked amount' : 'grouped number',
    })),
  );

  const dates = dedupe([
    ...matches(text, ISO_DATE_RE).map((value) => ({
      value,
      confidence: 'high' as const,
      pattern: 'ISO 8601 date',
    })),
    ...matches(text, LONG_DATE_RE).map((value) => ({
      value,
      confidence: 'high' as const,
      pattern: 'long-form date',
    })),
    ...matches(text, SLASH_DATE_RE).map((value) => ({
      value,
      // 3/4/2026 is ambiguous between conventions, so it is never "high".
      confidence: 'medium' as const,
      pattern: 'slash-separated date',
    })),
  ]);

  return { people, organizations, amounts, dates };
}

/** True when the extraction names anyone. Such a document never auto-publishes. */
export function namesAPerson(entities: ExtractedEntities): boolean {
  return entities.people.length > 0;
}

export function parseAmount(value: string): number {
  return Number(value.replace(/[$,\s]/g, ''));
}

export function parseExtractedDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
