/**
 * Escaping, for a document assembled out of third-party bytes.
 *
 * Every string that reaches a prerendered page came out of a county PDF, a
 * CivicPlus page, or a model reading one of those. `services/search.ts` already
 * drew this line for its own domain — `ts_headline` is given control characters
 * as delimiters rather than `<b>`, so nothing scraped is ever returned as
 * markup — and this file is the same rule one layer up. Nothing here builds
 * HTML out of a record's text without going through `escapeHtml`, and the page
 * model in `document.ts` is a tree of typed blocks precisely so a page builder
 * has no way to hand the renderer a raw fragment.
 *
 * The two functions differ, and the difference is not cosmetic. `escapeHtml` is
 * for element content and attribute values alike, which is why it escapes the
 * quotes as well; a title interpolated into `content="…"` is an attribute, and
 * an unescaped `"` there ends the attribute and starts a new one.
 * `jsonLdScript` is a *different* grammar with a different hazard, and the
 * escape that works for HTML is invalid inside JSON.
 */

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

/**
 * Element content and attribute values. `&` first is handled by the single
 * pass — a chained `.replace` would re-escape the ampersands it just wrote.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES.get(character) ?? character);
}

/** JSON-LD only accepts a subset of what a page might hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * A `<script type="application/ld+json">` block whose content cannot break out
 * of it.
 *
 * `JSON.stringify` escapes nothing for HTML — `DataLicensePage.tsx` says the
 * same thing about the React version of this block — so a value containing
 * `</script>` closes the element and everything after it is parsed as markup.
 * The React component patches that one sequence. This does not patch a
 * sequence: it escapes `<`, `>` and `&` to their `\u00XX` forms *after*
 * serialising, which is still valid JSON (a parser reads `<` as `<`) and
 * leaves no character in the output that an HTML tokeniser reacts to at all.
 * Neutralising the character class rather than the one known string is what
 * keeps this correct against `<!--`, `<script`, and whatever the next tokeniser
 * quirk turns out to be.
 *
 * U+2028 and U+2029 are escaped for the same reason they always are: legal in
 * JSON, illegal in a JavaScript string literal, and a page whose JSON-LD is
 * ever copied into a script body would break there and nowhere else.
 */
export function jsonLdScript(payload: JsonObject): string {
  const serialised = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${serialised}</script>`;
}

/**
 * Collapses whitespace and clips at a word boundary.
 *
 * Used for `<meta name="description">`, which is assembled deterministically
 * from the record and never generated. Clipping matters because the text is
 * frequently an agenda item title copied verbatim out of a PDF, and those run
 * to several hundred characters.
 */
export function clip(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
