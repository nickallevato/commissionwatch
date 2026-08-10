/**
 * Turning a database row into a line of an export file.
 *
 * Both formats are written by hand rather than by a library, because both are
 * small enough that a dependency would be more surface than saving, and because
 * the two rules that actually matter here — a stable column order and a
 * timestamp that means the same thing to every reader — are ours to hold rather
 * than a package's.
 */

/**
 * One cell, as text.
 *
 * The interesting cases are the ones a naive `String(value)` gets wrong:
 *
 *  - **`Date`** becomes ISO 8601 in UTC with a `Z`. The pg driver hands back a
 *    `Date` for every timestamp column, and `toString()` on one renders in
 *    whatever zone the export process happens to run in, with a spelled-out
 *    timezone abbreviation no parser reads back.
 *  - **`null` and `undefined`** become the empty string. In CSV that is the
 *    only representation of absence there is; in JSON they stay `null`, which is
 *    why this function is used for CSV and not for both.
 *  - **objects** — `metadata`, `field_confidence` — become compact JSON, so a
 *    jsonb column survives the round trip into a spreadsheet as something a
 *    reader can still parse rather than as `[object Object]`.
 */
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

/**
 * RFC 4180 field quoting.
 *
 * A field is quoted when it holds a comma, a quote, a carriage return or a
 * newline, and an embedded quote is doubled. Agenda item titles routinely carry
 * commas and occasionally carry both quote characters, so this is the ordinary
 * path rather than the edge case.
 */
export function csvField(value: unknown): string {
  const text = cellToText(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV record, CRLF-terminated as RFC 4180 requires. */
export function csvRow(columns: readonly string[], row: Record<string, unknown>): string {
  return `${columns.map((column) => csvField(row[column])).join(",")}\r\n`;
}

/**
 * A row narrowed to the dataset's declared columns, in the declared order.
 *
 * The column list is the published contract on `/data`; a query that grows a
 * column must grow the list in the same commit or the two disagree, and the
 * export is the one place where a reader has no way to notice.
 */
export function projectRow(
  columns: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column];
    projected[column] = value === undefined ? null : value;
  }
  return projected;
}
